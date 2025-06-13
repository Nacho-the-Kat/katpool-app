import type { Socket, TCPSocketListener } from 'bun';
import { parseMessage, StratumError, type Request, type Response } from './protocol';
import { Encoding } from '../templates/jobs/encoding';
import Monitoring from '../../monitoring';
import { AsicType } from '..';
import type { SharesManager } from '../sharesManager';

export type Worker = {
  address: string;
  name: string;
};

export type Miner = {
  difficulty: number;
  extraNonce: string;
  workers: Map<string, Worker>;
  encoding: Encoding;
  asicType: AsicType;
  cachedBytes: string;
  connectedAt?: number;
};

type MessageCallback = (socket: Socket<Miner>, request: Request) => Promise<Response>;

export default class Server {
  socket: TCPSocketListener<Miner>;
  difficulty: number;
  private onMessage: MessageCallback;
  private monitoring: Monitoring;
  private port: number;
  private sharesManager: SharesManager;

  constructor(
    port: number,
    difficulty: number,
    onMessage: MessageCallback,
    sharesManager: SharesManager
  ) {
    this.monitoring = new Monitoring();
    this.difficulty = difficulty;
    this.onMessage = onMessage;
    this.port = port;
    this.sharesManager = sharesManager;

    this.socket = Bun.listen({
      hostname: '0.0.0.0',
      port: port,
      socket: {
        open: this.onConnect.bind(this),
        data: this.onData.bind(this),
        error: (socket, error) => {
          this.monitoring.error(`server ${this.port}: Opennig socket ${error}`);
        },
        close: socket => {
          const workers = Array.from(socket.data.workers.values());
          if (workers.length === 0) {
            this.monitoring.debug(
              `server ${this.port}: Socket from ${socket.remoteAddress} disconnected before worker auth.`
            );
          } else {
            for (const worker of workers) {
              this.monitoring.debug(
                `server ${this.port}: Worker ${worker.name} disconnected from ${socket.remoteAddress}`
              );
              this.sharesManager.deleteSocket(socket);
            }
          }
        },
      },
    });
  }

  private onConnect(socket: Socket<Miner>) {
    socket.data = {
      extraNonce: '',
      difficulty: this.difficulty,
      workers: new Map(),
      encoding: Encoding.BigHeader,
      cachedBytes: '',
      asicType: AsicType.Unknown,
      connectedAt: Date.now(),
    };
  }

  private onData(socket: Socket<Miner>, data: Buffer) {
    socket.data.cachedBytes += data;

    const messages = socket.data.cachedBytes.split('\n');

    while (messages.length > 1) {
      const message = parseMessage(messages.shift()!);

      if (message) {
        this.onMessage(socket, message)
          .then(response => {
            socket.write(JSON.stringify(response) + '\n');
          })
          .catch(error => {
            let response: Response = {
              id: message.id,
              result: false,
              error: new StratumError('unknown').toDump(),
            };

            if (error instanceof StratumError) {
              response.error = error.toDump();
              socket.write(JSON.stringify(response) + '\n');
            } else if (error instanceof Error) {
              response.error![1] = error.message;
              this.monitoring.error(`server ${this.port}: Ending socket : ${error.message}`);
              return socket.end(JSON.stringify(response));
            } else throw error;
          });
      } else {
        this.monitoring.error(`server ${this.port}: Ending socket`);
        socket.end();
      }
    }

    socket.data.cachedBytes = messages[0];

    if (socket.data.cachedBytes.length > 512) {
      this.monitoring.error(
        `server ${this.port}: Ending socket as socket.data.cachedBytes.length > 512`
      );
      socket.end();
    }
  }
}
