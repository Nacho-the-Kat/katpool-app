import type { Socket, TCPSocketListener } from 'bun';
import { parseMessage, StratumError, type Response } from './protocol';
import Monitoring from '../../monitoring';
import type { SharesManager } from '../sharesManager';
import { markServerUp, updateMinerActivity } from '../../shared/heartbeat';
import logger from '../../monitoring/datadog';
import { getSocketLogData } from '../utils';
import { Encoding, type MessageCallback, type Miner } from '../../types';

export default class Server {
  socket: TCPSocketListener<Miner>;
  difficulty: number;
  private onMessage: MessageCallback;
  private monitoring: Monitoring;
  private port: number;

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
            getSocketLogData(socket, {
              error: error.message,
            })
          );
        },
        close: socket => {
          const workers = Array.from(socket.data.workers.values());
          const closeReason = socket.data.closeReason || 'Client disconnected';
          if (workers.length === 0) {
            this.monitoring.debug(
              `server ${this.port}: Socket from ${socket.remoteAddress} disconnected before worker auth.`
            );
            logger.warn(
              'Socket Disconnected before worker auth',
              getSocketLogData(socket, {
                closeReason,
              })
            );
          } else {
            for (const worker of workers) {
              this.monitoring.debug(
                `server ${this.port}: Worker ${worker.name} disconnected from ${socket.remoteAddress}`
              );
              logger.warn(
                'Socket Worker disconnected',
                getSocketLogData(socket, {
                  closeReason,
                })
              );
            }
          }
        },
        connectError: (socket, error) => {
          this.monitoring.debug(
            `server ${this.port}: ERROR ${socket?.remoteAddress || 'unknown'} Connection error: ${error}`
          );
          logger.error(
            'Socket Connection error',
            getSocketLogData(socket, {
              error: error.message,
            })
          );
        },
        end: socket => {
          socket.data.closeReason = 'Socket connection ended gracefully';
          this.monitoring.debug(
            `server ${this.port}: Socket connection ended gracefully for ${socket?.remoteAddress || 'unknown'}`
          );
          logger.info('Socket connection ended gracefully', getSocketLogData(socket));
        },
        timeout: socket => {
          socket.data.closeReason = 'Connection timeout';
          this.monitoring.debug(
            `server ${this.port}: Connection timeout for ${socket?.remoteAddress || 'unknown'}`
          );
          logger.warn('Socket connection timeout', getSocketLogData(socket));
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
      asicType: '',
      connectedAt: Date.now(),
      port: this.port,
    };

    updateMinerActivity(this.port);
  }

  private onData(socket: Socket<Miner>, data: Buffer) {
    updateMinerActivity(this.port); // Any connection

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
              logger.warn(
                'SocketEnd, Socket error',
                getSocketLogData(socket, {
                  error: error.message,
                })
              );
              socket.data.closeReason = `Error: ${error.message}`;
              return socket.end(JSON.stringify(response));
            } else throw error;
          });
      } else {
        this.monitoring.debug(
          `server ${this.port}: ERROR Ending socket ${socket?.remoteAddress || 'unknown'} because of parseMessage failure`
        );
        logger.warn('SocketEnd, Socket parseMessage failed', getSocketLogData(socket));
        socket.data.closeReason = 'ParseMessage failure';
        socket.end();
      }
    }

    socket.data.cachedBytes = messages[0];

    if (socket.data.cachedBytes.length > 512) {
      this.monitoring.debug(
        `server ${this.port}: ERROR Ending socket ${socket?.remoteAddress || 'unknown'} as socket.data.cachedBytes.length > 512`
      );
      logger.warn('SocketEnd, Socket cachedBytes.length > 512', getSocketLogData(socket));
      socket.data.closeReason = 'CachedBytes length exceeded';
      socket.end();
    }
  }
}
