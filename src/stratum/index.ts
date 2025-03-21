import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import Server, { type Miner, type Worker } from './server';
import { type Request, type Response, type Event, StratumError } from './server/protocol';
import type Templates from './templates/index.ts';
import { Address, type IRawHeader } from "../../wasm/kaspa";
import { Encoding, encodeJob } from './templates/jobs/encoding.ts';
import { SharesManager } from './sharesManager';
import { minerjobSubmissions, jobsNotFound, activeMinerGuage, varDiff } from '../prometheus'
import Monitoring from '../monitoring/index.ts';
import { DEBUG } from '../../index'
import { Mutex } from 'async-mutex';
import { metrics } from '../../index';
import Denque from 'denque';
import JsonBig from 'json-bigint';
import config from "../../config/config.json";

const bitMainRegex = new RegExp(".*(GodMiner).*", "i")
const iceRiverRegex = new RegExp(".*(IceRiverMiner).*", "i")
const goldShellRegex = new RegExp(".*(BzMiner).*", "i")

export enum AsicType {
  IceRiver = "IceRiver",
  Bitmain = "Bitmain",
  GoldShell = "GoldShell",
  Unknown = ""
}

const workerCounters = new Map<string, number>();

export default class Stratum extends EventEmitter {
  server: Server;
  private templates: Templates;
  private difficulty: number;
  private subscriptors: Set<Socket<Miner>> = new Set();
  private monitoring: Monitoring
  sharesManager: SharesManager;
  private minerDataLock = new Mutex();
  private extraNonceSize:number;

  constructor(templates: Templates, port: number, initialDifficulty: number, poolAddress: string, sharesPerMin: number) {
    super();
    this.monitoring = new Monitoring
    this.sharesManager = new SharesManager(poolAddress);
    this.server = new Server(port, initialDifficulty, this.onMessage.bind(this));
    this.difficulty = initialDifficulty;
    this.templates = templates;
    this.templates.register((id, hash, timestamp, header) => this.announceTemplate(id, hash, timestamp, header));
    this.monitoring.log(`Stratum: Initialized with difficulty ${this.difficulty}`);

    // Start the VarDiff thread
    const clampPow2 = config.stratum.clampPow2 || true; // Enable clamping difficulty to powers of 2
    const varDiff = config.stratum.varDiff || false; // Enable variable difficulty
    if (varDiff)
      this.sharesManager.startVardiffThread(sharesPerMin, clampPow2).then(() => {
        this.monitoring.log("VarDiff thread started successfully.");
      })
      .catch((err) => {
        this.monitoring.error(`Failed to start VarDiff thread: ${err}`);
      });;

    this.extraNonceSize = Math.min(Number(config.stratum.extraNonceSize), 3 ) || 0;
  }

  announceTemplate(id: string, hash: string, timestamp: bigint, header: IRawHeader) {
    this.monitoring.log(`Stratum: Announcing new template ${id}`);
    const tasksData: { [key in Encoding]?: string } = {};
    Object.values(Encoding).filter(value => typeof value !== 'number').forEach(value => {
      const encoding = Encoding[value as keyof typeof Encoding];
      const encodedParams = encodeJob(hash, timestamp, encoding, header)
      const task: Event<'mining.notify'> = {
        method: 'mining.notify',
        params: [id, encodedParams]
      };
      if(encoding === Encoding.Bitmain) {
        task.params.push(timestamp);
      }
      tasksData[encoding] = JsonBig.stringify(task);
    });
    this.subscriptors.forEach((socket) => {
      if (socket.readyState === "closed") {
        this.subscriptors.delete(socket);
      } else {      
        socket.data.workers.forEach((worker, _) => {
          let varDiff = this.sharesManager.getClientVardiff(worker)
				  if (varDiff != socket.data.difficulty && varDiff != 0) {
            this.monitoring.log(`Stratum: Updating VarDiff for ${worker.name} from ${socket.data.difficulty} to ${varDiff}`);
            this.sharesManager.updateSocketDifficulty(worker.address, worker.name, varDiff);
            this.reflectDifficulty(socket, worker.name);
            this.sharesManager.startClientVardiff(worker);
          }
        });

        socket.write(tasksData[socket.data.encoding] + '\n');
      }
    });
  }

  reflectDifficulty(socket: Socket<Miner>, workerName: string) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty]
    };
    socket.write(JSON.stringify(event) + '\n');
  }

  private async onMessage(socket: Socket<Miner>, request: Request) {
    const release = await this.minerDataLock.acquire();
    try {
      let response: Response = {
        id: request.id,
        result: true,
        error: null
      };
      switch (request.method) {
        case 'mining.subscribe': {
          if (this.subscriptors.has(socket)) throw Error('Already subscribed');
          const minerType = request.params[0].toLowerCase();
          response.result = [true, "EthereumStratum/1.0.0"]

          // Format extranonce as a hexadecimal string with padding
          if (this.extraNonceSize > 0) {
            socket.data.extraNonce = randomBytes(2).toString('hex')
          }   
          if (bitMainRegex.test(minerType)) {
            socket.data.encoding = Encoding.Bitmain;
            socket.data.asicType = AsicType.Bitmain;
            response.result = [null, socket.data.extraNonce, 8 - Math.floor(socket.data.extraNonce.length / 2)];
          } else if (iceRiverRegex.test(minerType)) {
            socket.data.asicType = AsicType.IceRiver;
          } else if (goldShellRegex.test(minerType)) {
            socket.data.asicType = AsicType.GoldShell;
          }
          this.subscriptors.add(socket);        
          this.emit('subscription', socket.remoteAddress, request.params[0]);
          this.monitoring.log(`Stratum: Miner subscribed from ${socket.remoteAddress}`);
          break;
        }
        case 'mining.authorize': {
          const [address, name] = request.params[0].split('.');
          if (!Address.validate(address)) throw Error('Invalid address');
          if (!name) throw Error('Worker name is not set.');

          const worker: Worker = { address, name: name };
          if (socket.data.workers.has(worker.name)) throw Error('Worker with duplicate name');
          const sockets = this.sharesManager.getMiners().get(worker.address)?.sockets || new Set();
          socket.data.workers.set(worker.name, worker);
          sockets.add(socket);

          if (!this.sharesManager.getMiners().has(worker.address)) {
            this.sharesManager.getMiners().set(worker.address, {
              sockets,
              workerStats: new Map()
            });
          }
          
          const minerData = this.sharesManager.getMiners().get(worker.address)!;
          if (!minerData.workerStats.has(worker.name)) {
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
              minDiff: this.difficulty,
              recentShares: new Denque<{ timestamp: number, difficulty: number, workerName: string }>(),
              hashrate: 0,
              asicType: socket.data.asicType
            });
          }

          // Set extranonce
          let extraNonceParams: any[] = [socket.data.extraNonce];
          if (socket.data.encoding === Encoding.Bitmain && socket.data.extraNonce != "") {
            extraNonceParams = [socket.data.extraNonce, 8 - Math.floor(socket.data.extraNonce.length / 2)];
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
          
          if (DEBUG) this.monitoring.debug(`Stratum: Authorizing worker - Address: ${address}, Worker Name: ${name}`);

          metrics.updateGaugeValue(activeMinerGuage, [name, address, socket.data.asicType], Math.floor(Date.now() / 1000));
          break;
        }
        case 'mining.submit': {
          const [address, name] = request.params[0].split('.');
          metrics.updateGaugeInc(minerjobSubmissions, [name, address]);
          if (DEBUG) this.monitoring.debug(`Stratum: Submitting job for Worker Name: ${name}`);
          const worker = socket.data.workers.get(name);
          if (DEBUG) this.monitoring.debug(`Stratum: Checking worker data on socket for : ${name}`);
          if (!worker || worker.address !== address) {
            if (DEBUG) this.monitoring.debug(`Stratum: Mismatching worker details - Address: ${address}, Worker Name: ${name}`);
            throw Error('Mismatching worker details');
          }
          const hash = this.templates.getHash(request.params[1]);
          if (!hash) {
            if (DEBUG) this.monitoring.debug(`Stratum: Job not found - Address: ${address}, Worker Name: ${name}`);
            metrics.updateGaugeInc(jobsNotFound, [name, address]);
            response.result = false;
            response.error = new StratumError('job-not-found').toDump()
            return response;
          } else {
            const minerId = name;
            const minerData = this.sharesManager.getMiners().get(worker.address);
            const workerStats = minerData?.workerStats.get(worker.name);
            const workerDiff = workerStats?.minDiff;
            const socketDiff = socket.data.difficulty;
            if (DEBUG) this.monitoring.debug(`Stratum: Current difficulties , Worker Name: ${minerId} - Worker: ${workerDiff}, Socket: ${socketDiff}`);
            const currentDifficulty = workerDiff || socketDiff;
            if (DEBUG) this.monitoring.debug(`Stratum: Adding Share - Address: ${address}, Worker Name: ${name}, Hash: ${hash}, Difficulty: ${currentDifficulty}`);

            if (socket.data.extraNonce !== "") {
              const extranonce2Len = 16 - socket.data.extraNonce.length;
              if (request.params[2].length <= extranonce2Len) {
                request.params[2] = socket.data.extraNonce + request.params[2].padStart(extranonce2Len, "0");
              }
            }

            try {
              let nonce: bigint;
              if (socket.data.encoding === Encoding.Bitmain) {
                nonce = BigInt(request.params[2]);
              } else {
                nonce = BigInt('0x' + request.params[2]);
              }
              this.sharesManager.addShare(minerId, worker.address, hash, currentDifficulty, nonce, this.templates, socket.data.encoding);
            } catch(err: any) {
              if (!(err instanceof Error)) throw err;
              switch (err.message) {
                case 'Duplicate share':
                  this.monitoring.debug("DUPLICATE_SHARE");
                  response.error = new StratumError('duplicate-share').toDump();
                  break;
                case 'Stale header':
                  this.monitoring.debug("Stale Header : JOB_NOT_FOUND");
                  response.error = new StratumError('job-not-found').toDump();
                  break;
                case 'Invalid share':
                  this.monitoring.debug("LOW_DIFFICULTY_SHARE");
                  response.error = new StratumError('low-difficulty-share').toDump();
                  break;
                default:
                  throw err;
              }
              response.result = false;
            }
          }
          break;
        }

        default:
          throw new StratumError('unknown');
      }
      return response;
    } finally {
      release();
    }
  }
}