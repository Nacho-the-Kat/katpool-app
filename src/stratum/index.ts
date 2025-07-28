import type { Socket } from 'bun';
import Server from './server';
import { type Request, type Response, type Event, StratumError } from './server/protocol';
import type Templates from './templates/index.ts';
import { type IRawHeader } from '../../wasm/kaspa';
import { encodeJob } from './templates/jobs/encoding.ts';
import { SharesManager } from './sharesManager';
import Monitoring from '../monitoring/index.ts';
import { Mutex } from 'async-mutex';
import JsonBig from 'json-bigint';
import { Encoding, type Miner } from '../types/index.ts';
import { StratumHandler } from './stratumHandler.ts';
import { VariableDifficulty } from './variableDifficulty.ts';
import { getSocketLogData } from './utils.ts';
import logger from '../monitoring/datadog.ts';

export default class Stratum {
  server: Server;
  public templates: Templates;
  private difficulty: number;
  private subscriptors: Set<Socket<Miner>> = new Set();
  private monitoring: Monitoring;
  sharesManager: SharesManager;
  private minerDataLock = new Mutex();
  private clampPow2: boolean;
  private varDiff: boolean;
  private extraNonce: number;
  public port: number;
  private stratumHandler: StratumHandler;
  private variableDiff: VariableDifficulty;

  constructor(
    templates: Templates,
    initialDifficulty: number,
    port: number,
    sharesPerMin: number,
    clampPow2: boolean,
    varDiff: boolean,
    extraNonce: number,
    stratumMinDiff: number,
    stratumMaxDiff: number
  ) {
    this.monitoring = new Monitoring();
    this.port = port;
    this.sharesManager = new SharesManager(initialDifficulty, stratumMinDiff, port);
    this.server = new Server(
      port,
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
    let extraNonceSize = Math.min(Number(this.extraNonce), 3) || 0;
    this.stratumHandler = new StratumHandler(
      this.sharesManager,
      templates,
      this.difficulty,
      extraNonceSize
    );
    this.monitoring.log(`Stratum ${this.port}: Initialized with difficulty ${this.difficulty}`);

    // Start the VarDiff thread
    this.variableDiff = new VariableDifficulty(this.sharesManager, stratumMinDiff, stratumMaxDiff);
    this.clampPow2 = clampPow2 || true; // Enable clamping difficulty to powers of 2
    this.varDiff = varDiff || false;
    if (this.varDiff) {
      this.variableDiff
        .startVardiffThread(sharesPerMin, this.clampPow2)
        .then(() => {
          this.monitoring.log(`Stratum ${this.port}: VarDiff thread started successfully.`);
        })
        .catch(error => {
          this.monitoring.error(`Stratum ${this.port}: Failed to start VarDiff thread: `, error);
        });
    }
  }

  announceTemplate(id: string, hash: string, timestamp: bigint, header: IRawHeader) {
    this.monitoring.log(`Stratum ${this.port}: Announcing new template ${id}, hash: ${hash}`);
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
        // this.monitoring.debug(
        //   `Stratum ${this.port}: Deleting socket on closed stats for: ${socket.data.workers}`
        // );
        logger.warn('miner-socket-state-detected', getSocketLogData(socket));
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
              let varDiff = this.variableDiff.getClientVardiff(worker);
              // Store current difficulty before any updates
              const currentDifficulty = socket.data.difficulty;
              if (varDiff != currentDifficulty && varDiff != 0) {
                const updated = this.variableDiff.updateSocketDifficulty(
                  worker.address,
                  worker.name,
                  varDiff
                );
                if (updated) {
                  this.monitoring.debug(
                    `Stratum ${this.port}: Updating difficulty for worker ${worker.name} from ${currentDifficulty} to ${varDiff}`
                  );
                  this.stratumHandler.reflectDifficulty(socket, worker.name);
                  this.variableDiff.startClientVardiff(worker);
                }
              }
            }
          }
        });

        socket.write(tasksData[socket.data.encoding] + '\n');
      }
    });
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
          this.stratumHandler.subscribe(socket, request, response, this.subscriptors);
          break;
        }
        case 'mining.authorize': {
          this.stratumHandler.authorize(socket, request);
          break;
        }
        case 'mining.submit': {
          this.stratumHandler.submit(socket, request, response);
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
