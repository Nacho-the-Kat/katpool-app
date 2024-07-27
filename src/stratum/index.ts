import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import Server, { type Miner, type Worker } from './server';
import { type Request, type Response, type Event, errors } from './server/protocol';
import type Templates from './templates/index.ts';
import { calculateTarget, Address } from "../../wasm/kaspa";
import { Encoding, encodeJob } from './templates/jobs/encoding.ts';
import { SharesManager, sharesGauge } from './sharesManager';

export default class Stratum extends EventEmitter {
  server: Server;
  private templates: Templates;
  private difficulty: number;
  private subscriptors: Set<Socket<Miner>> = new Set();
  private sharesManager: SharesManager;

  constructor(templates: Templates, port: number, initialDifficulty: number, pushGatewayUrl: string, poolAddress: string) {
    super();
    this.server = new Server(port, initialDifficulty, this.onMessage.bind(this));
    this.difficulty = initialDifficulty;
    this.templates = templates;
    this.sharesManager = new SharesManager(poolAddress, pushGatewayUrl);
    this.templates.register((id, hash, timestamp) => this.announceTemplate(id, hash, timestamp));
    console.log(`[${new Date().toISOString()}] Stratum: Initialized with difficulty ${this.difficulty}`);
  }

  announceTemplate(id: string, hash: string, timestamp: bigint) {
    const tasksData: { [key in Encoding]?: string } = {};
    Object.values(Encoding).filter(value => typeof value !== 'number').forEach(value => {
      const encoding = Encoding[value as keyof typeof Encoding];
      const task: Event<'mining.notify'> = {
        method: 'mining.notify',
        params: [id, ...encodeJob(hash, timestamp, encoding)]
      };
      tasksData[encoding] = JSON.stringify(task);
    });
    this.subscriptors.forEach((socket) => {
      if (socket.readyState === "closed") {
        this.subscriptors.delete(socket);
      } else {
        socket.write(tasksData[socket.data.encoding] + '\n');
      }
    });
  }

  reflectDifficulty(socket: Socket<Miner>) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty]
    };
    socket.write(JSON.stringify(event) + '\n');
  }

  private async onMessage(socket: Socket<Miner>, request: Request) {
    let response: Response = {
      id: request.id,
      result: true,
      error: null
    };
    switch (request.method) {
      case 'mining.subscribe': {
        if (this.subscriptors.has(socket)) throw Error('Already subscribed');
        this.subscriptors.add(socket);
        response.result = [true, 'EthereumStratum/1.0.0'];
        this.emit('subscription', socket.remoteAddress, request.params[0]);
        console.log(`[${new Date().toISOString()}] Stratum: Miner subscribed from ${socket.remoteAddress}`);
        break;
      }
      case 'mining.authorize': {
        const [address, name] = request.params[0].split('.');
        if (!Address.validate(address)) throw Error('Invalid address');
        const worker: Worker = { address, name };
        if (socket.data.workers.has(worker.name)) throw Error('Worker with duplicate name');
        const sockets = this.sharesManager.getMiners().get(worker.address)?.sockets || new Set();
        socket.data.workers.set(worker.name, worker);
        sockets.add(socket);

        if (!this.sharesManager.getMiners().has(worker.address)) {
          this.sharesManager.getMiners().set(worker.address, {
            sockets,
            shares: 0,
            hashRate: 0,
            lastShareTime: Date.now(),
            difficulty: this.difficulty,
            firstShareTime: Date.now(),
            accumulatedWork: 0,
            workerStats: new Map()
          });
        } else {
          const existingMinerData = this.sharesManager.getMiners().get(worker.address);
          existingMinerData!.sockets = sockets;
          this.sharesManager.getMiners().set(worker.address, existingMinerData!);
        }

        const event: Event<'set_extranonce'> = {
          method: 'set_extranonce',
          params: [randomBytes(4).toString('hex')]
        };
        socket.write(JSON.stringify(event) + '\n');
        this.reflectDifficulty(socket);
        console.log(`[${new Date().toISOString()}] Stratum: Worker authorized - Address: ${address}, Worker Name: ${name}`);
        break;
      }
      case 'mining.submit': {
        const [address, name] = request.params[0].split('.');
        sharesGauge.labels(address).inc();
        const worker = socket.data.workers.get(name);
        if (!worker || worker.address !== address) throw Error('Mismatching worker details');
        const hash = this.templates.getHash(request.params[1]);
        if (!hash) {
          response.error = errors['JOB_NOT_FOUND'];
          response.result = false;
        } else {
          const minerId = name; // Use the worker name as minerId or define your minerId extraction logic
          await this.sharesManager.addShare(minerId, worker.address, hash, socket.data.difficulty, BigInt('0x' + request.params[2]), this.templates).catch(err => {
            if (!(err instanceof Error)) throw err;
            switch (err.message) {
              case 'Duplicate share':
                response.error = errors['DUPLICATE_SHARE'];
                break;
              case 'Stale header':
                response.error = errors['JOB_NOT_FOUND'];
                break;
              case 'Invalid share':
                response.error = errors['LOW_DIFFICULTY_SHARE'];
                break;
              default:
                throw err;
            }
            response.result = false;
          });
        }
        console.log(`[${new Date().toISOString()}] Stratum: Share submitted - Address: ${address}, Worker Name: ${name}`);
        break;
      }
      default:
        throw errors['UNKNOWN'];
    }
    return response;
  }
}
