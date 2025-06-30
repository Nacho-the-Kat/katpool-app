import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import Server, { type Miner, type Worker } from './server';
import { type Request, type Response, type Event, StratumError } from './server/protocol';
import type Templates from './templates/index.ts';
import { Address, type IRawHeader } from '../../wasm/kaspa';
import { Encoding, encodeJob } from './templates/jobs/encoding.ts';
import { SharesManager } from './sharesManager';
import { jobsNotFound, activeMinerGuage, varDiff } from '../prometheus';
import Monitoring from '../monitoring/index.ts';
import { DEBUG } from '../../index';
import { Mutex } from 'async-mutex';
import { metrics } from '../../index';
import Denque from 'denque';
import JsonBig from 'json-bigint';
import config from '../../config/config.json';
import logger from '../monitoring/datadog';

const bitMainRegex = new RegExp('.*(GodMiner).*', 'i');
const iceRiverRegex = new RegExp('.*(IceRiverMiner).*', 'i');
const goldShellRegex = new RegExp('.*(BzMiner).*', 'i');

export enum AsicType {
  IceRiver = 'IceRiver',
  Bitmain = 'Bitmain',
  GoldShell = 'GoldShell',
  Unknown = '',
}

const MIN_DIFF = config.stratum[0].minDiff || 64;
const MAX_DIFF = config.stratum[0].maxDiff || 131072;
const DEFAULT_DIFF = config.stratum[0].difficulty || 2048;

export default class Stratum extends EventEmitter {
  server: Server;
  private templates: Templates;
  private difficulty: number;
  private subscriptors: Set<Socket<Miner>> = new Set();
  private monitoring: Monitoring;
  sharesManager: SharesManager;
  private minerDataLock = new Mutex();
  private extraNonceSize: number;
  private clampPow2: boolean;
  private varDiff: boolean;
  private extraNonce: number;
  public port: number;

  constructor(
    templates: Templates,
    initialDifficulty: number,
    poolAddress: string,
    sharesPerMin: number,
    clampPow2: boolean,
    varDiff: boolean,
    extraNonce: number,
    stratumMinDiff: number,
    stratumMaxDiff: number
  ) {
    super();
    this.monitoring = new Monitoring();
    this.port = templates.port;
    this.sharesManager = new SharesManager(
      poolAddress,
      initialDifficulty,
      stratumMinDiff,
      stratumMaxDiff,
      templates.port
    );
    this.server = new Server(
      templates.port,
      initialDifficulty,
      this.onMessage.bind(this),
      this.sharesManager
    );
    this.difficulty = initialDifficulty;
    this.templates = templates;
    this.clampPow2 = clampPow2;
    this.varDiff = varDiff;
    this.extraNonce = extraNonce;
    this.templates.register((id, hash, timestamp, header) =>
      this.announceTemplate(id, hash, timestamp, header)
    );
    this.monitoring.log(`Stratum ${this.port}: Initialized with difficulty ${this.difficulty}`);

    // Start the VarDiff thread
    this.clampPow2 = clampPow2 || true; // Enable clamping difficulty to powers of 2
    this.varDiff = varDiff || false; // Enable variable difficulty
    if (this.varDiff) {
      this.sharesManager
        .startVardiffThread(sharesPerMin, this.clampPow2)
        .then(() => {
          this.monitoring.log(`Stratum ${this.port}: VarDiff thread started successfully.`);
        })
        .catch(err => {
          this.monitoring.error(`Stratum ${this.port}: Failed to start VarDiff thread: ${err}`);
        });
    }

    this.extraNonceSize = Math.min(Number(this.extraNonce), 3) || 0;
  }

  announceTemplate(id: string, hash: string, timestamp: bigint, header: IRawHeader) {
    this.monitoring.log(`Stratum ${this.port}: Announcing new template ${id}`);
    const tasksData: { [key in Encoding]?: string } = {};
    Object.values(Encoding)
      .filter(value => typeof value !== 'number')
      .forEach(value => {
        const encoding = Encoding[value as keyof typeof Encoding];
        const encodedParams = encodeJob(hash, timestamp, encoding, header);
        const task: Event<'mining.notify'> = {
          method: 'mining.notify',
          params: [id, encodedParams],
        };
        if (encoding === Encoding.Bitmain) {
          task.params.push(timestamp);
        }
        tasksData[encoding] = JsonBig.stringify(task);
      });
    this.subscriptors.forEach(socket => {
      if (socket.readyState === 'closed') {
        this.monitoring.debug(
          `Stratum ${this.port}: Deleting socket on closed stats for: ${socket.data.workers}`
        );
        this.subscriptors.delete(socket);
      } else {
        socket.data.workers.forEach((worker, _) => {
          if (this.varDiff) {
            const workerStats =
              this.sharesManager.getMiners().get(worker.address)?.workerStats?.get(worker.name) ??
              null;
            let check = true;
            if (workerStats) {
              check = workerStats.varDiffEnabled;
            } else {
              this.monitoring.log(`Stratum ${this.port}: Worker stat not found for ${worker.name}`);
            }
            if (check) {
              let varDiff = this.sharesManager.getClientVardiff(worker);
              // Store current difficulty before any updates
              const currentDifficulty = socket.data.difficulty;
              if (varDiff != currentDifficulty && varDiff != 0) {
                this.monitoring.debug(
                  `Stratum ${this.port}: Updating difficulty for worker ${worker.name} from ${currentDifficulty} to ${varDiff}`
                );
                this.sharesManager.updateSocketDifficulty(worker.address, worker.name, varDiff);
                this.reflectDifficulty(socket, worker.name);
                this.sharesManager.startClientVardiff(worker);
              }
            }
          }
        });

        socket.write(tasksData[socket.data.encoding] + '\n');
      }
    });
  }

  reflectDifficulty(socket: Socket<Miner>, workerName: string) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty],
    };
    socket.write(JSON.stringify(event) + '\n');
  }

  // Function to check if a number is power of 2
  isPowerOf2(num: number): boolean {
    return (num & (num - 1)) === 0 && num > 0;
  }

  // Function to round to the nearest power of 2
  roundToNearestPowerOf2(num: number): number {
    if (num < MIN_DIFF || num > MAX_DIFF) return DEFAULT_DIFF;

    let pow = 1;
    while (pow < num) {
      pow *= 2;
    }

    const lower = pow / 2;
    const upper = pow;

    // Choose the nearest power of 2
    return num - lower < upper - num ? lower : upper;
  }

  // Function to extract and validate difficulty
  parseDifficulty(input: string): number | null {
    const validPattern = /^(d=|diff=)?\d+$/i;

    if (!validPattern.test(input)) {
      return null; // Invalid pattern, return null
    }

    const match = input.match(/(\d+)/);
    if (match) {
      const diff = Number(match[0]);
      if (!isNaN(diff)) {
        return diff;
      }
    }
    return null;
  }

  // Function to apply clamping logic
  getDifficulty(input: string): number {
    const diff = this.parseDifficulty(input);

    if (diff === null || diff < MIN_DIFF || diff > MAX_DIFF) {
      this.monitoring.debug(
        `Stratum: Invalid difficulty input: ${input}. Using default: ${DEFAULT_DIFF}`
      );
      return -1;
    }

    // Clamp to range
    const clampedDiff = Math.min(Math.max(diff, MIN_DIFF), MAX_DIFF);

    // Ensure power-of-2 clamping
    const finalDiff = this.isPowerOf2(clampedDiff)
      ? clampedDiff
      : this.roundToNearestPowerOf2(clampedDiff);

    this.monitoring.log(`Stratum: User requested: ${diff}, applied: ${finalDiff}`);
    return finalDiff;
  }

  private async onMessage(socket: Socket<Miner>, request: Request) {
    const release = await this.minerDataLock.acquire();
    try {
      let response: Response = {
        id: request.id,
        result: true,
        error: null,
      };
      switch (request.method) {
        case 'mining.subscribe': {
          if (this.subscriptors.has(socket)) throw Error('Already subscribed');
          const minerType = request.params[0]?.toLowerCase() ?? '';
          response.result = [true, 'EthereumStratum/1.0.0'];

          // Format extranonce as a hexadecimal string with padding
          if (this.extraNonceSize > 0) {
            socket.data.extraNonce = randomBytes(2).toString('hex');
          }
          if (bitMainRegex.test(minerType)) {
            socket.data.encoding = Encoding.Bitmain;
            socket.data.asicType = AsicType.Bitmain;
            response.result = [
              null,
              socket.data.extraNonce,
              8 - Math.floor(socket.data.extraNonce.length / 2),
            ];
          } else if (iceRiverRegex.test(minerType)) {
            socket.data.asicType = AsicType.IceRiver;
          } else if (goldShellRegex.test(minerType)) {
            socket.data.asicType = AsicType.GoldShell;
          }
          this.subscriptors.add(socket);
          this.emit('subscription', socket.remoteAddress, request.params[0]);
          this.monitoring.log(
            `Stratum ${this.port}: Miner subscribed from ${socket.remoteAddress}`
          );
          
          // Log miner subscription
          logger.info('Miner subscribed', {
            port: this.port,
            remoteAddress: socket.remoteAddress,
            minerType: request.params[0] || 'unknown',
            asicType: socket.data.asicType,
            extraNonce: socket.data.extraNonce || '',
          });
          break;
        }
        case 'mining.authorize': {
          let varDiffStatus = false;
          const [address, name] = request.params[0].split('.');
          let userDiff = this.difficulty; // Defaults to the ports default difficulty
          const userDiffInput = request.params[1];
          if (this.port === 8888 && (userDiffInput != '' || /\d/.test(userDiffInput))) {
            // Only when they connect to this port, allow user defined diff
            userDiff = this.getDifficulty(userDiffInput);
            if (userDiff == -1) {
              // Incorrectly set difficulty.
              userDiff = DEFAULT_DIFF;
              varDiffStatus = true;
            }
            this.monitoring.debug(
              `Stratum: Mining authorize request with: ${request.params[0]} - ${userDiffInput}`
            );
            this.monitoring.log(`Stratum: Extracted user diff value: ${userDiff}`);
          }

          if (!Address.validate(address))
            throw Error(
              `Invalid address, parsed address: ${address}, request: ${request.params[0]}`
            );
          if (!name) throw Error(`Worker name is not set. ${request.params[0]}`);

          this.sharesManager.registerSocket(socket, address, name);

          const worker: Worker = { address, name: name };
          if (socket.data.workers.has(worker.name))
            throw Error(`Worker with duplicate name: ${name}`);
          const sockets = this.sharesManager.getMiners().get(worker.address)?.sockets || new Set();
          socket.data.workers.set(worker.name, worker);
          sockets.add(socket);

          if (!this.sharesManager.getMiners().has(worker.address)) {
            this.sharesManager.getMiners().set(worker.address, {
              sockets,
              workerStats: new Map(),
            });
          }

          const minerData = this.sharesManager.getMiners().get(worker.address)!;
          // if (!minerData.workerStats.has(worker.name)) {
          minerData.workerStats.set(worker.name, {
            blocksFound: 0,
            sharesFound: 0,
            sharesDiff: 0,
            staleShares: 0,
            invalidShares: 0,
            workerName: worker.name,
            startTime: Date.now(),
            lastShare: Date.now(),
            varDiffStartTime: Date.now(),
            varDiffSharesFound: 0,
            varDiffWindow: 0,
            minDiff: userDiff,
            recentShares: new Denque<{
              timestamp: number;
              difficulty: number;
              workerName: string;
            }>(),
            hashrate: 0,
            asicType: socket.data.asicType,
            varDiffEnabled: varDiffStatus,
          });
          // }

          // Set extranonce
          let extraNonceParams: any[] = [socket.data.extraNonce];
          if (socket.data.encoding === Encoding.Bitmain && socket.data.extraNonce != '') {
            extraNonceParams = [
              socket.data.extraNonce,
              8 - Math.floor(socket.data.extraNonce.length / 2),
            ];
          }
          const event: Event<'mining.set_extranonce'> = {
            method: 'mining.set_extranonce',
            params: extraNonceParams,
          };
          socket.write(JSON.stringify(event) + '\n');

          // Set initial difficulty for this worker
          const workerStats = minerData.workerStats.get(worker.name)!;
          socket.data.difficulty = workerStats.minDiff;
          this.reflectDifficulty(socket, worker.name);
          varDiff.labels(worker.name).set(workerStats.minDiff);

          if (DEBUG)
            this.monitoring.debug(
              `Stratum ${this.port}: Authorizing worker - Address: ${address}, Worker Name: ${name}`
            );

          // Log miner authorization
          logger.info('Miner authorized', {
            port: this.port,
            address,
            workerName: name,
            initialDifficulty: userDiff,
            asicType: socket.data.asicType,
            varDiffEnabled: varDiffStatus,
            remoteAddress: socket.remoteAddress,
            extraNonce: socket.data.extraNonce || '',
          });

          metrics.updateGaugeValue(
            activeMinerGuage,
            [name, address, socket.data.asicType],
            Math.floor(Date.now() / 1000)
          );
          break;
        }
        case 'mining.submit': {
          const [address, name] = request.params[0].split('.');
          if (DEBUG)
            this.monitoring.debug(`Stratum ${this.port}: Submitting job for Worker Name: ${name}`);
          const worker = socket.data.workers.get(name);
          if (DEBUG)
            this.monitoring.debug(
              `Stratum ${this.port}: Checking worker data on socket for : ${name}`
            );
          if (!worker || worker.address !== address) {
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Mismatching worker details - worker.Addr: ${worker?.address}, Address: ${address}, Worker Name: ${name}`
              );
            
            // Log unauthorized share submission attempt
            logger.warn('Unauthorized share submission attempt', {
              port: this.port,
              address,
              workerName: name,
              workerAddress: worker?.address,
              remoteAddress: socket.remoteAddress,
            });
            
            throw Error(
              `Mismatching worker details request: worker.Addr: ${worker?.address}, ${request.params[0]}`
            );
          }
          const hash = this.templates.getHash(request.params[1]);
          if (!hash) {
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Job not found - Address: ${address}, Worker Name: ${name}`
              );
            metrics.updateGaugeInc(jobsNotFound, [name, address]);
            
            // Log job not found
            logger.warn('Job not found for share submission', {
              port: this.port,
              address,
              workerName: name,
              jobId: request.params[1],
              remoteAddress: socket.remoteAddress,
            });
            
            response.result = false;
            response.error = new StratumError('job-not-found').toDump();
            return response;
          } else {
            const minerId = name;
            const minerData = this.sharesManager.getMiners().get(worker.address);
            const workerStats = minerData?.workerStats.get(worker.name);
            const workerDiff = workerStats?.minDiff;
            const socketDiff = socket.data.difficulty;
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Current difficulties , Worker Name: ${minerId} - Worker: ${workerDiff}, Socket: ${socketDiff}`
              );
            const currentDifficulty = workerDiff || socketDiff;
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Adding Share - Address: ${address}, Worker Name: ${name}, Hash: ${hash}, Difficulty: ${currentDifficulty}`
              );

            if (socket.data.extraNonce !== '') {
              const extranonce2Len = 16 - socket.data.extraNonce.length;
              if (request.params[2].length <= extranonce2Len) {
                request.params[2] =
                  socket.data.extraNonce + request.params[2].padStart(extranonce2Len, '0');
              }
            }

            try {
              let nonce: bigint;
              if (socket.data.encoding === Encoding.Bitmain) {
                nonce = BigInt(request.params[2]);
              } else {
                nonce = BigInt('0x' + request.params[2]);
              }
              this.sharesManager.addShare(
                minerId,
                worker.address,
                hash,
                currentDifficulty,
                nonce,
                this.templates,
                socket.data.encoding,
                request.params[1]
              );
            } catch (err: any) {
              // Log share processing error
              logger.error('Share processing error', {
                port: this.port,
                address,
                workerName: name,
                jobId: request.params[1],
                nonce: request.params[2],
                error: err instanceof Error ? err.message : String(err),
              });
              
              if (!(err instanceof Error)) throw err;
              switch (err.message) {
                case 'Duplicate share':
                  this.monitoring.debug(`Stratum ${this.port}: DUPLICATE_SHARE`);
                  response.error = new StratumError('duplicate-share').toDump();
                  break;
                case 'Stale header':
                  this.monitoring.debug(`Stratum ${this.port}: Stale Header - JOB_NOT_FOUND`);
                  response.error = new StratumError('job-not-found').toDump();
                  break;
                case 'Invalid share':
                  this.monitoring.debug(`Stratum ${this.port}: LOW_DIFFICULTY_SHARE`);
                  response.error = new StratumError('low-difficulty-share').toDump();
                  break;
                default:
                  logger.error('Unknown share processing error', {
                    port: this.port,
                    address,
                    workerName: name,
                    jobId: request.params[1],
                    nonce: request.params[2],
                    error: err.toString(),
                  });
                  throw err;
              }
              response.result = false;
            }
          }
          break;
        }
        default: {
          throw new StratumError('unknown');
        }
      }
      return response;
    } finally {
      release();
    }
  }
}
