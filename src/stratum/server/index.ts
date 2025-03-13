import type { Socket, TCPSocketListener } from 'bun';
import { parseMessage, StratumError, type Request, type Response } from './protocol';
import { Encoding } from '../templates/jobs/encoding';
import Monitoring from '../../monitoring';
import { AsicType } from '..';
import type { SharesManager } from '../sharesManager';
import { markServerUp, updateMinerActivity } from '../../shared/heartbeat';
import logger from '../../monitoring/datadog';

export type Worker = {
  address: string;
  name: string;
  canxiumAddr: string;
};

export type Miner = {
  closeReason?: string;
  difficulty: number;
  extraNonce: string;
  workers: Map<string, Worker>;
  encoding: Encoding;
  asicType: AsicType;
  cachedBytes: string;
  connectedAt: number;
  port: number;
  cleanupPerformed?: boolean;
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
          this.monitoring.debug(
            `server ${this.port}: ERROR ${socket?.remoteAddress || 'unknown'} Opening socket ${error}`
          );
          logger.error(
            'Socket error',
            this.getSocketLogData(socket, {
              error: error.message,
            })
          );
          this.performCleanup(socket, `Socket error: ${error.message}`);
        },
        close: socket => {
          const workers = Array.from(socket.data.workers.values());
          const closeReason = socket.data.closeReason || 'Client disconnected';
          if (workers.length === 0) {
            this.monitoring.debug(
              `server ${this.port}: Socket from ${socket.remoteAddress} disconnected before worker auth.`
            );
          } else {
            for (const worker of workers) {
              this.monitoring.debug(
                `server ${this.port}: Worker ${worker.name} disconnected from ${socket.remoteAddress}`
              );
              logger.info(
                'deleteSocket, Socket on close - worker-disconnected',
                this.getSocketLogData(socket, {
                  workerName: worker.name,
                  reason: closeReason,
                })
              );
            }
          }
          this.performCleanup(socket, closeReason);
        },
        connectError: (socket, error) => {
          this.monitoring.debug(
            `server ${this.port}: ERROR ${socket?.remoteAddress || 'unknown'} Connection error: ${error}`
          );
          logger.error(
            'Connection error',
            this.getSocketLogData(socket, {
              error: error.message,
            })
          );
          this.performCleanup(socket, `Connection error: ${error.message}`);
        },
        end: socket => {
          socket.data.closeReason = 'Socket connection ended gracefully';
          this.monitoring.debug(
            `server ${this.port}: Socket connection ended gracefully for ${socket?.remoteAddress || 'unknown'}`
          );
          logger.info('Socket connection ended gracefully', this.getSocketLogData(socket));
          this.performCleanup(socket, 'Socket connection ended gracefully');
        },
        timeout: socket => {
          socket.data.closeReason = 'Connection timeout';
          this.monitoring.debug(
            `server ${this.port}: Connection timeout for ${socket?.remoteAddress || 'unknown'}`
          );
          logger.warn('Socket connection timeout', this.getSocketLogData(socket));
          this.performCleanup(socket, 'Connection timeout');
        },
      },
    });

    markServerUp(this.port);
  }

  private getSocketLogData(socket: Socket<Miner>, additionalData?: Record<string, any>) {
    return {
      remoteAddress: socket?.remoteAddress || 'unknown',
      workers: socket?.data?.workers ? Array.from(socket.data.workers.keys()) : [],
      connectedAt: socket.data.connectedAt,
      duration: Date.now() - socket.data.connectedAt,
      port: this.port,
      ...additionalData,
    };
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
      port: this.port,
    };

    updateMinerActivity(this.port);
  }

  performCleanup(socket: Socket<Miner>, reason: string): boolean {
    // Atomic check-and-set to prevent race conditions
    if (socket.data.cleanupPerformed) {
      return false; // Already cleaned up
    }

    socket.data.cleanupPerformed = true;
    socket.data.closeReason = reason;

    try {
      this.sharesManager.deleteSocket(socket);
      return true; // Cleanup performed
    } catch (err) {
      this.monitoring.error(`Cleanup failed for ${socket.remoteAddress}: ${err}`);
      return false;
    }
  }

  private onData(socket: Socket<Miner>, data: Buffer) {
    // Skip processing if socket is already being cleaned up
    if (socket.data.cleanupPerformed) {
      return;
    }

    updateMinerActivity(this.port); // Any connection

    socket.data.cachedBytes += data;

    const messages = socket.data.cachedBytes.split('\n');

    while (messages.length > 1) {
      const message = parseMessage(messages.shift()!, this.port);

      if (message) {
        this.onMessage(socket, message)
          .then(response => {
            if (!socket.data.cleanupPerformed) {
              socket.write(JSON.stringify(response) + '\n');
            }
          })
          .catch(error => {
            if (socket.data.cleanupPerformed) {
              return;
            }

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
              this.monitoring.debug(
                `server ${this.port}: ERROR Ending socket ${socket?.remoteAddress || 'unknown'}: ${error.message}`
              );
              socket.write(JSON.stringify(response));
              this.sharesManager.sleep(1 * 1000);
              logger.warn(
                'deleteSocket, Socket error',
                this.getSocketLogData(socket, {
                  error: error.message,
                })
              );
              this.performCleanup(socket, `Error: ${error.message}`);
            } else throw error;
          });
      } else {
        this.monitoring.debug(
          `server ${this.port}: ERROR Ending socket ${socket?.remoteAddress || 'unknown'} because of parseMessage failure`
        );
        logger.warn('deleteSocket, Socket parseMessage failed', this.getSocketLogData(socket));
        this.performCleanup(socket, 'ParseMessage failure');
        return;
      }
    }

    socket.data.cachedBytes = messages[0];

    if (socket.data.cachedBytes.length > 512) {
      this.monitoring.debug(
        `server ${this.port}: ERROR Ending socket ${socket?.remoteAddress || 'unknown'} as socket.data.cachedBytes.length > 512`
      );
      logger.warn('deleteSocket, Socket cachedBytes.length > 512', this.getSocketLogData(socket));
      this.performCleanup(socket, 'CachedBytes length exceeded');
    }
  }
}
