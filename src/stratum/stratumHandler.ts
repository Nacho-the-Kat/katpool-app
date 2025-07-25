import type { Socket } from 'bun';
import { activeMinerGuage, jobsNotFound, varDiff } from '../prometheus';
import { Encoding, type Miner, type Worker } from '../types';
import { metrics } from '../..';
import logger from '../monitoring/datadog';
import Denque from 'denque';
import { getDifficulty, getSocketLogData } from './utils';
import Monitoring from '../monitoring';
import { DEBUG, minerRegexes } from '../constants';
import { type Request, type Response, type Event, StratumError } from './server/protocol';
import type { SharesManager } from './sharesManager';
import { Address } from '../../wasm/kaspa/kaspa';
import config from '../../config/config.json';
import type Templates from './templates';
import { randomBytes } from 'crypto';

const DEFAULT_DIFF = config.stratum[0].difficulty || 2048;

export class StratumHandler {
  private monitoring: Monitoring;
  private sharesManager: SharesManager;
  private difficulty: number;
  private templates: Templates;
  private extraNonceSize: number;

  constructor(
    sharesManager: SharesManager,
    templates: Templates,
    difficulty: number,
    extraNonceSize: number
  ) {
    this.monitoring = new Monitoring();
    this.sharesManager = sharesManager;
    this.templates = templates;
    this.difficulty = difficulty;
    this.extraNonceSize = extraNonceSize;
  }

  subscribe(
    socket: Socket<Miner>,
    request: Request,
    response: Response,
    subscriptors: Set<Socket<Miner>>
  ) {
    response.id = request.id;

    if (subscriptors.has(socket)) throw Error('Already subscribed');
    if (subscriptors.has(socket)) {
      logger.warn('miner-already-subscribed', getSocketLogData(socket));
      throw Error('Already subscribed');
    }
    const minerType = request.params[0]?.toLowerCase() ?? '';
    response.result = [true, 'EthereumStratum/1.0.0'];

    // Format extranonce as a hexadecimal string with padding
    if (this.extraNonceSize > 0) {
      socket.data.extraNonce = randomBytes(2).toString('hex');
    }
    if (minerRegexes.bitMain.test(minerType)) {
      socket.data.encoding = Encoding.Bitmain;
      response.result = [
        null,
        socket.data.extraNonce,
        8 - Math.floor(socket.data.extraNonce.length / 2),
      ];
    }
    socket.data.asicType = request.params[0] || '';
    subscriptors.add(socket);
    this.monitoring.log(
      `StratumHandler ${this.sharesManager.port}: Miner subscribed from ${socket.remoteAddress}`
    );

    // Log miner subscription
    logger.info('miner-subscribed', getSocketLogData(socket));

    return;
  }

  authorize(socket: Socket<Miner>, request: Request) {
    let varDiffStatus = false;
    const [address, name] = request.params[0].split('.');
    let userDiff = this.difficulty; // Defaults to the ports default difficulty
    const userDiffInput = request.params[1];
    if (this.sharesManager.port === 8888 && (userDiffInput != '' || /\d/.test(userDiffInput))) {
      // Only when they connect to this port, allow user defined diff
      userDiff = getDifficulty(userDiffInput);
      if (userDiff == -1) {
        // Incorrectly set difficulty.
        userDiff = DEFAULT_DIFF;
        varDiffStatus = true;
      }
      this.monitoring.debug(
        `StratumHandler: Mining authorize request with: ${request.params[0]} - ${userDiffInput}`
      );
      this.monitoring.log(`StratumHandler: Extracted user diff value: ${userDiff}`);
    }

    if (!Address.validate(address))
      throw Error(`Invalid address, parsed address: ${address}, request: ${request.params[0]}`);
    if (!name) throw Error(`Worker name is not set. Request: ${request.params[0]}`);

    const worker: Worker = { address, name: name };
    if (socket.data.workers.has(worker.name)) {
      logger.warn('miner-duplicate-worker', getSocketLogData(socket, { address, name }));
      throw Error(`Worker with duplicate name: ${name} for address: ${address}.`);
    }
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
        nonce: bigint;
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
    metrics.updateGaugeValue(
      varDiff,
      [worker.name, this.sharesManager.port.toString()],
      workerStats.minDiff
    );

    if (DEBUG)
      this.monitoring.debug(
        `StratumHandler ${this.sharesManager.port}: Authorizing worker - Address: ${address}, Worker Name: ${name}`
      );

    // Log miner authorization
    logger.info('miner-authorize', getSocketLogData(socket, { address, name }));

    metrics.updateGaugeValue(
      activeMinerGuage,
      [name, address, socket.data.asicType, socket.data.port.toString()],
      Math.floor(Date.now() / 1000)
    );
  }

  submit(socket: Socket<Miner>, request: Request, response: Response) {
    response.id = request.id;
    // Validate params array has required elements
    if (!request.params[2]) {
      throw Error('Missing required parameter: extranonce2');
    }

    const [address, name] = request.params[0].split('.');

    // development retention tag will override production retantion tag
    logger.info('miner-submit', {
      ddtags: 'retention:development',
      ...getSocketLogData(socket, { address, name }),
    });
    if (DEBUG)
      this.monitoring.debug(
        `StratumHandler ${this.sharesManager.port}: Submitting job for Worker Name: ${name}`
      );
    const worker = socket.data.workers.get(name);
    if (DEBUG)
      this.monitoring.debug(
        `StratumHandler ${this.sharesManager.port}: Checking worker data on socket for : ${name}`
      );
    if (!worker || worker.address !== address) {
      if (DEBUG)
        this.monitoring.debug(
          `StratumHandler ${this.sharesManager.port}: Mismatching worker details - worker.Addr: ${worker?.address}, Address: ${address}, Worker Name: ${name}`
        );

      // Log unauthorized share submission attempt
      logger.warn(
        'miner-unauthorized-share-submission',
        getSocketLogData(socket, { address, name })
      );

      throw Error(
        `Mismatching worker details - worker.Addr: ${worker?.address}, Address: ${address}, Worker Name: ${name}`
      );
    }
    const hash = this.templates.getHash(request.params[1]);
    if (!hash) {
      if (DEBUG)
        this.monitoring.debug(
          `StratumHandler ${this.sharesManager.port}: Job not found - Address: ${address}, Worker Name: ${name}`
        );
      metrics.updateGaugeInc(jobsNotFound, [name, address]);
      response.result = false;
      response.error = new StratumError('job-not-found').toDump();
      return;
    } else {
      const minerId = name;
      const minerData = this.sharesManager.getMiners().get(worker.address);
      const workerStats = minerData?.workerStats.get(worker.name);
      const workerDiff = workerStats?.minDiff;
      const socketDiff = socket.data.difficulty;
      if (DEBUG)
        this.monitoring.debug(
          `StratumHandler ${this.sharesManager.port}: Current difficulties , Worker Name: ${minerId} - Worker: ${workerDiff}, Socket: ${socketDiff}`
        );
      const currentDifficulty = workerDiff || socketDiff;
      if (DEBUG)
        this.monitoring.debug(
          `StratumHandler ${this.sharesManager.port}: Adding Share - Address: ${address}, Worker Name: ${name}, Hash: ${hash}, Difficulty: ${currentDifficulty}`
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
          request.params[1]
        );
      } catch (error: any) {
        logger.error('miner-error-share-processing', getSocketLogData(socket, { address, name }));

        if (!(error instanceof Error)) throw error;
        switch (error.message) {
          case 'Duplicate share':
            this.monitoring.debug(`StratumHandler ${this.sharesManager.port}: DUPLICATE_SHARE`);
            response.error = new StratumError('duplicate-share').toDump();
            break;
          case 'Stale header':
            this.monitoring.debug(
              `StratumHandler ${this.sharesManager.port}: Stale Header - JOB_NOT_FOUND`
            );
            response.error = new StratumError('job-not-found').toDump();
            break;
          case 'Invalid share':
            this.monitoring.debug(
              `StratumHandler ${this.sharesManager.port}: LOW_DIFFICULTY_SHARE`
            );
            response.error = new StratumError('low-difficulty-share').toDump();
            break;
          default:
            throw error;
        }
        response.result = false;
      }
      return;
    }
  }

  reflectDifficulty(socket: Socket<Miner>, workerName: string) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty],
    };
    socket.write(JSON.stringify(event) + '\n');
  }
}
