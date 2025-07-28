import { calculateTarget } from '../../wasm/kaspa';
import Monitoring from '../monitoring';
import { minerAddedShares, minerInvalidShares, minerDuplicatedShares } from '../prometheus';
import { metrics } from '../../index';
import Denque from 'denque';
import type Templates from './templates';
import Jobs from './templates/jobs';
import logger from '../monitoring/datadog';
import type { Contribution, MinerData, WorkerStats } from '../types';
import { DEBUG, WINDOW_SIZE } from '../constants';
import { Stats } from './stats';

export class SharesManager {
  public miners: Map<string, MinerData> = new Map();
  private monitoring: Monitoring;
  private shareWindow: Denque<Contribution>;
  private lastAllocationTime: number;
  private lastAllocationDaaScore: bigint;
  private stratumMinDiff: number;
  public port: number;
  public stats: Stats;

  constructor(stratumInitDiff: number, stratumMinDiff: number, port: number) {
    this.stratumMinDiff = stratumMinDiff;
    this.monitoring = new Monitoring();
    this.stats = new Stats(this, stratumInitDiff);
    this.stats.startStatsThread(); // Start the stats logging thread
    this.shareWindow = new Denque();
    this.lastAllocationTime = Date.now();
    this.lastAllocationDaaScore = 0n;
    this.port = port;
  }

  async addShare(
    minerId: string,
    address: string,
    hash: string,
    difficulty: number,
    nonce: bigint,
    templates: Templates,
    id: string
  ) {
    let minerData = this.miners.get(address);
    if (!minerData) {
      minerData = {
        sockets: new Set(),
        workerStats: new Map(),
      };
      this.miners.set(address, minerData);
    }

    const workerStats = this.stats.getOrCreateWorkerStats(minerId, minerData);
    // Critical Section: Check and Add Share
    for (let i = 0; i < workerStats.recentShares.size(); i++) {
      const share = workerStats.recentShares.get(i);
      if (share?.nonce === nonce) {
        metrics.updateGaugeInc(minerDuplicatedShares, [minerId, address]);
        this.monitoring.log(`SharesManager ${this.port}: Duplicate share for miner - ${minerId}`);
        logger.warn('Duplicate share detected', {
          minerId,
          address,
          port: this.port,
          nonce: nonce.toString(),
        });
        return;
      }
    }

    const timestamp = Date.now();
    const currentDifficulty = workerStats.minDiff || difficulty;

    if (DEBUG)
      this.monitoring.debug(
        `SharesManager ${this.port}: Share added for ${minerId} - Address: ${address} - Nonce: ${nonce}`
      );

    const state = templates.getPoW(hash);
    if (!state) {
      if (DEBUG)
        this.monitoring.debug(
          `SharesManager ${this.port}: Stale header for miner ${minerId} and hash: ${hash}`
        );
      workerStats.staleShares++; // Add this to track stale shares in worker stats
      logger.warn('Stale share detected', {
        minerId,
        address,
        port: this.port,
        jobId: id,
      });
      return;
    }

    const [isBlock, target] = state.checkWork(nonce);
    const validity = target <= calculateTarget(currentDifficulty);
    if (!validity) {
      if (DEBUG)
        this.monitoring.debug(
          `SharesManager ${this.port}: Invalid share for target: ${target} for miner ${minerId}`
        );
      metrics.updateGaugeInc(minerInvalidShares, [minerId, address]);
      workerStats.invalidShares++;
      logger.warn('Invalid share detected', {
        minerId,
        address,
        port: this.port,
        target: target.toString(),
        difficulty: currentDifficulty,
      });
      return;
    }

    // Share is valid at this point, increment the valid share metric
    metrics.updateGaugeInc(minerAddedShares, [minerId, address]);

    if (DEBUG)
      this.monitoring.debug(
        `Pool: - SharesManager ${this.port}: Contributed block share added from: ${minerId} with address ${address} for nonce: ${nonce}`
      );

    const daaScore = Jobs.getDaaScoreFromJobId(id);
    const share: Contribution = {
      minerId,
      address,
      difficulty,
      timestamp: Date.now(),
      jobId: id,
      daaScore,
    };
    this.shareWindow.push(share);
    if (isBlock) {
      if (DEBUG)
        this.monitoring.debug(
          `SharesManager ${this.port}: Work found for ${minerId} and target: ${target}`
        );

      // Log block discovery - this is a critical event
      logger.info('Block found!', {
        minerId,
        address,
        port: this.port,
        target: target.toString(),
        difficulty: currentDifficulty,
        hash: hash.substring(0, 16) + '...',
        nonce: nonce.toString(),
        jobId: id,
        daaScore: daaScore.toString(),
      });

      const report = await templates.submit(minerId, address, hash, nonce);
      if (report === 'success') {
        workerStats.blocksFound++;
        logger.info('Block submission successful', {
          minerId,
          address,
          port: this.port,
          hash: hash.substring(0, 16) + '...',
        });
      } else {
        logger.error('Block submission failed', {
          minerId,
          address,
          port: this.port,
          hash: hash.substring(0, 16) + '...',
          report,
        });
      }
    }

    workerStats.sharesFound++;
    workerStats.varDiffSharesFound++;
    workerStats.lastShare = timestamp;
    workerStats.minDiff = currentDifficulty;

    // Update recentShares with the new share
    workerStats.recentShares.push({ timestamp: Date.now(), difficulty: currentDifficulty, nonce });

    while (
      workerStats.recentShares.length > 0 &&
      Date.now() - workerStats.recentShares.peekFront()!.timestamp > WINDOW_SIZE
    ) {
      workerStats.recentShares.shift();
    }
  }

  getMiners() {
    return this.miners;
  }

  getSharesSinceLastAllocation(daaScore: bigint): Contribution[] {
    const currentTime = Date.now();
    const shares = [];
    while (
      this.shareWindow.length > 0 &&
      Jobs.getDaaScoreFromJobId(this.shareWindow.peekFront()?.jobId!) <= daaScore
    ) {
      shares.push(this.shareWindow.shift()!);
    }
    this.lastAllocationDaaScore = daaScore;
    return shares;
  }

  getDifficultyAndTimeSinceLastAllocation() {
    const currentTime = Date.now();
    const shares = [];
    const localData: Map<string, MinerData> = this.miners; // Take a local copy, as time can change during processing
    for (const [address, minerData] of localData) {
      if (!minerData || !minerData.workerStats) {
        if (DEBUG)
          this.monitoring.debug(
            `SharesManager ${this.port}: Invalid miner data for address ${address}`
          );
        continue;
      }

      for (const [workerName, workerStats] of minerData.workerStats) {
        if (!workerStats || !workerStats.workerName) {
          if (DEBUG)
            this.monitoring.debug(
              `SharesManager ${this.port}: Invalid worker stats or worker name for worker ${workerName}`
            );
          continue;
        }

        const timeSinceLastShare = Date.now() - (workerStats.lastShare ?? 0);
        if (timeSinceLastShare < 0) {
          if (DEBUG)
            this.monitoring.debug(
              `SharesManager ${this.port}: Skipping share due to negative timestamp for worker ${workerStats.workerName}`
            );
          continue;
        }

        const MAX_ELAPSED_MS = 5 * 60 * 1000; // 5 minutes
        const cappedTime = Math.min(timeSinceLastShare, MAX_ELAPSED_MS);

        // Normalize weight: 0 to 1 (smooth ramp-up for new connections)
        const timeWeight = cappedTime / MAX_ELAPSED_MS;

        // Scaled difficulty with weighted time factor
        let rawDifficulty = Math.round((workerStats.minDiff ?? 0) * timeWeight);
        if (rawDifficulty === 0) {
          const fallback = Math.max(
            1,
            Math.floor((workerStats.minDiff ?? this.stratumMinDiff) * 0.1)
          );
          if (DEBUG)
            this.monitoring.debug(
              `SharesManager ${this.port}: Scaled difficulty for ${workerStats.workerName} was 0, fallback to ${fallback}`
            );
          rawDifficulty = fallback;
        }
        const scaledDifficulty = rawDifficulty;

        // Add to shares array
        shares.push({
          address,
          minerId: workerStats.workerName,
          difficulty: scaledDifficulty,
          timestamp: cappedTime,
          jobId: '',
          daaScore: BigInt(0),
        });
      }
    }
    this.monitoring.debug(
      `SharesManager ${this.port}: Retrieved ${shares.length} shares. Last allocation time: ${this.lastAllocationTime}, Current time: ${currentTime}`
    );
    this.lastAllocationTime = currentTime;
    return shares;
  }

  checkWorkerStatus(stats: WorkerStats) {
    return Date.now() - stats.lastShare <= WINDOW_SIZE ? Math.floor(stats.lastShare / 1000) : 0;
  }
}
