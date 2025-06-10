import type { Socket, TCPSocketListener } from 'bun';
import { parseMessage, StratumError, type Request, type Response } from './protocol';
import { Encoding } from '../templates/jobs/encoding';
import Monitoring from '../../monitoring';
import { AsicType } from '..';
import type { SharesManager } from '../sharesManager';
import { markServerUp, updateMinerActivity } from '../../shared/heartbeat';

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
  connectedAt: number;
  _isClosing?: boolean;
  port: number;
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
          try {
            this.monitoring.error(
              `server ${this.port}: Opening socket ${error} ${socket.data?.workers}`
            );
          } catch (err) {
            this.monitoring.error(`server ${this.port}: Opening socket ${error}`);
          }
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

    markServerUp(this.port);
  }

  private onConnect(socket: Socket<Miner>) {
    socket.data = {
      extraNonce: '',
      difficulty: this.difficulty,
      workers: new Map(),
      encoding: Encoding.BigHeader,
      cachedBytes: '',
      asicType: AsicType.Unknown,
      _isClosing: false,
      connectedAt: Date.now(),
      port: this.port,
    };

    updateMinerActivity(this.port);
  }

  private onData(socket: Socket<Miner>, data: Buffer) {
    updateMinerActivity(this.port); // Any connection

    if (socket.data._isClosing) {
      return;
    }

    socket.data.cachedBytes += data;

    const messages = socket.data.cachedBytes.split('\n');

    while (messages.length > 1) {
      const message = parseMessage(messages.shift()!, this.port);

      if (message) {
        this.onMessage(socket, message)
          .then(response => {
            socket.write(JSON.stringify(response) + '\n');
          })
          .catch(error => {
            const response: Response = {
              id: message.id,
              result: false,
              error: new StratumError('unknown').toDump(),
            };

            if (error instanceof StratumError) {
              response.error = error.toDump();
              socket.write(JSON.stringify(response) + '\n');
            } else if (error instanceof Error) {
              response.error![1] = error.message;
              try {
                this.monitoring.error(
                  `server ${this.port}: Ending socket: ${error.message} ${socket.data.workers}`
                );
              } catch (err) {
                this.monitoring.error(`server ${this.port}: Ending socket: ${error.message}`);
              }

              socket.data._isClosing = true;
              socket.data.cachedBytes = '';
              socket.write(JSON.stringify(response));
              this.sharesManager.sleep(1 * 1000);
              this.sharesManager.deleteSocket(socket);
              return;
            } else throw error;
          });
      } else {
        try {
          this.monitoring.error(
            `server ${this.port}: Ending socket invalid message: ${socket.data.workers}`
          );
        } catch (err) {
          this.monitoring.error(`server ${this.port}: Ending socket invalid message`);
        }

        socket.data._isClosing = true;
        socket.data.cachedBytes = '';
        this.sharesManager.deleteSocket(socket);
        return;
      }
    }

    socket.data.cachedBytes = messages[0];

    if (socket.data.cachedBytes.length > 512) {
      try {
        this.monitoring.error(
          `server ${this.port}: Ending socket as socket.data.cachedBytes.length > 512 ${socket.data.workers}`
        );
      } catch (err) {
        this.monitoring.error(
          `server ${this.port}: Ending socket as socket.data.cachedBytes.length > 512`
        );
      }

      socket.data._isClosing = true;
      socket.data.cachedBytes = '';
      this.sharesManager.deleteSocket(socket);
    }
  }
}
