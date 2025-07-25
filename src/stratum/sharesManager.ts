import type { Socket } from 'bun';
import { calculateTarget } from '../../wasm/kaspa';
import { type Miner, type Worker } from './server';
import {
  stringifyHashrate,
  getAverageHashrateGHs,
  debugHashrateCalculation,
  getSocketLogData,
} from './utils';
import Monitoring from '../monitoring';
import { DEBUG } from '../../index';
import {
  minerAddedShares,
  minerInvalidShares,
  minerDuplicatedShares,
  varDiff,
  workerHashRateGauge,
  activeMinerGuage,
} from '../prometheus';
import { metrics } from '../../index';
import Denque from 'denque';
import type Templates from './templates';
import Jobs from './templates/jobs';
import logger from '../monitoring/datadog';
import JsonBig from 'json-bigint';

export const WINDOW_SIZE = 10 * 60 * 1000; // 10 minutes window

export interface WorkerStats {
  blocksFound: number;
  sharesFound: number;
  sharesDiff: number;
  staleShares: number;
  invalidShares: number;
  workerName: string;
  startTime: number;
  lastShare: number;
  varDiffStartTime: number;
  varDiffSharesFound: number;
  varDiffWindow: number;
  minDiff: number;
  recentShares: Denque<{ timestamp: number; difficulty: number; nonce: bigint }>;
  hashrate: number;
  asicType: string;
  varDiffEnabled: boolean;
}

type MinerData = {
  sockets: Set<Socket<Miner>>;
  workerStats: Map<string, WorkerStats>;
};

const varDiffThreadSleep: number = 10;
const varDiffRejectionRateThreshold: number = 20; // If rejection rate exceeds threshold, set difficulty based on hash rate.
const zeroDateMillS: number = new Date(0).getMilliseconds();

export type Contribution = {
  address: string;
  difficulty: number;
  timestamp: number;
  minerId: string;
  jobId: string;
  daaScore: bigint;
};

export class SharesManager {
  private contributions: Map<bigint, Contribution> = new Map();
  private miners: Map<string, MinerData> = new Map();
  private monitoring: Monitoring;
  private shareWindow: Denque<Contribution>;
  private lastAllocationTime: number;
  private lastAllocationDaaScore: bigint;
  private stratumMinDiff: number;
  private stratumMaxDiff: number;
  private stratumInitDiff: number;
  private port: number;

  constructor(
    stratumInitDiff: number,
    stratumMinDiff: number,
    stratumMaxDiff: number,
    port: number
  ) {
    this.stratumMinDiff = stratumMinDiff;
    this.stratumMaxDiff = stratumMaxDiff;
    this.monitoring = new Monitoring();
    this.startStatsThread(); // Start the stats logging thread
    this.shareWindow = new Denque();
    this.lastAllocationTime = Date.now();
    this.lastAllocationDaaScore = 0n;
    this.stratumInitDiff = stratumInitDiff;
    this.port = port;
  }

  getOrCreateWorkerStats(workerName: string, minerData: MinerData): WorkerStats {
    if (!minerData.workerStats.has(workerName)) {
      let varDiffStatus = false;
      if (this.port === 8888) {
        varDiffStatus = true;
        this.monitoring.debug(
          `SharesManager ${this.port}: New worker stats created for ${workerName}, defaulting to enabled var-diff due to connection to the port 8888.`
        );
      }
      const workerStats: WorkerStats = {
        blocksFound: 0,
        sharesFound: 0,
        sharesDiff: 0,
        staleShares: 0,
        invalidShares: 0,
        workerName,
        startTime: Date.now(),
        lastShare: Date.now(),
        varDiffStartTime: Date.now(),
        varDiffSharesFound: 0,
        varDiffWindow: 0,
        minDiff: this.stratumInitDiff, // Initial difficulty
        recentShares: new Denque<{ timestamp: number; difficulty: number; nonce: bigint }>(),
        hashrate: 0,
        asicType: '',
        varDiffEnabled: varDiffStatus,
      };
      minerData.workerStats.set(workerName, workerStats);
      if (DEBUG)
        this.monitoring.debug(
          `SharesManager ${this.port}: Created new worker stats for ${workerName}`
        );
    }
    return minerData.workerStats.get(workerName)!;
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

    const workerStats = this.getOrCreateWorkerStats(minerId, minerData);
    // Critical Section: Check and Add Share
    let found = false;

    for (let i = 0; i < workerStats.recentShares.size(); i++) {
      const share = workerStats.recentShares.get(i);
      if (share?.nonce === nonce) {
        found = true;
        break;
      }
    }
    if (found) {
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
    // else {
    //   // this.contributions.set(nonce, { address, difficulty, timestamp: Date.now(), minerId });
    // }

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

  startStatsThread() {
    const start = Date.now();
    setInterval(() => {
      let str =
        '\n===============================================================================\n';
      str += '  worker name   |  avg hashrate  |   acc/stl/inv  |    blocks    |    uptime   \n';
      str += '-------------------------------------------------------------------------------\n';

      const lines: string[] = [];
      let totalRate = 0;

      this.miners.forEach((minerData, address) => {
        let rate = 0;
        minerData.workerStats.forEach((stats, workerName) => {
          // Update active status metrics
          let workerRate = 0;
          const status = this.checkWorkerStatus(stats);
          metrics.updateGaugeValue(
            activeMinerGuage,
            [workerName, address, stats.asicType, this.port.toString()],
            status
          );
          if (status) {
            workerRate = getAverageHashrateGHs(stats, address);
            debugHashrateCalculation(stats, address, workerRate);
          } else {
            logger.warn(
              `SharesManager ${this.port}: Worker ${address}.${workerName} is inactive, setting hashrate to 0`
            );
            workerRate = 0;
          }
          rate += workerRate;

          // Update hashrate - in metrics and workerStats
          stats.hashrate = workerRate;
          metrics.updateGaugeValue(workerHashRateGauge, [workerName, address], workerRate);

          const rateStr = stringifyHashrate(workerRate);
          const ratioStr = `${stats.sharesFound}/${stats.staleShares}/${stats.invalidShares}`;
          const uptime = (Date.now() - stats.startTime) / 1000;

          lines.push(
            ` ${stats.workerName.padEnd(15)}| ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${stats.blocksFound.toString().padEnd(12)} | ${uptime}s`
          );

          try {
            if (status === 0) {
              let found = false;
              // Find and close inactive sockets - let event cleanup handle the rest
              minerData.sockets.forEach(skt => {
                if (skt.data.workers.has(workerName) && !found) {
                  this.monitoring.debug(
                    `SharesManager ${this.port}: Closing inactive socket for worker: ${workerName}, address: ${address}`
                  );
                  skt.data.closeReason = 'Inactive worker timeout - 10 Minute';
                  skt.end(); // This will trigger the close event and deleteSocket method
                  found = true;
                }
              });
              if (!found) {
                this.monitoring.debug(
                  `SharesManager ${this.port}: ERROR - No socket found for deletion for worker: ${workerName}, address: ${address}`
                );
                logger.warn(
                  `SharesManager ${this.port}: No socket found for deletion for worker: ${workerName}, address: ${address}`
                );
              }
            }
          } catch (error) {
            this.monitoring.error(
              `SharesManager ${this.port}: Could not delete inactive worker: ${workerName}, address: ${address} - `,
              error
            );
          }
        });
        totalRate += rate;
      });

      lines.sort();
      str += lines.join('\n');

      const rateStr = stringifyHashrate(totalRate);
      const overallStats = this.calculateOverallStats();
      const ratioStr = `${overallStats.sharesFound}/${overallStats.staleShares}/${overallStats.invalidShares}`;

      str += '\n-------------------------------------------------------------------------------\n';
      str += `                | ${rateStr.padEnd(14)} | ${ratioStr.padEnd(14)} | ${overallStats.blocksFound.toString().padEnd(12)} | ${(Date.now() - start) / 1000}s`;
      str += '\n===============================================================================\n';

      this.monitoring.log(str);
    }, WINDOW_SIZE);
  }

  // Add this method to your SharesManager class
  cleanupSocket(socket: Socket<Miner>) {
    socket.data.workers.forEach((worker, workerName) => {
      const minerData = this.miners.get(worker.address);
      if (minerData) {
        // Remove the socket from the sockets set
        minerData.sockets.delete(socket);
        this.monitoring.debug(
          `SharesManager ${this.port}: Deleted socket for: ${workerName}@${worker.address}`
        );
        logger.warn(`deleteSocket, ${socket.data.closeReason}`, getSocketLogData(socket));

        // If no more sockets for this address, clean up the entire miner data
        if (minerData.sockets.size === 0) {
          this.miners.delete(worker.address);
          const msg = `SharesManager ${this.port}: Cleaned up all data for address ${worker.address}`;
          if (DEBUG) {
            this.monitoring.debug(msg);
          }
          logger.warn(msg);
        }
      }
    });
  }

  // Helper method for stats calculation
  private calculateOverallStats() {
    return Array.from(this.miners.values()).reduce(
      (acc: any, minerData: MinerData) => {
        minerData.workerStats.forEach(stats => {
          acc.sharesFound += stats.sharesFound;
          acc.staleShares += stats.staleShares;
          acc.invalidShares += stats.invalidShares;
          acc.blocksFound += stats.blocksFound;
        });
        return acc;
      },
      { sharesFound: 0, staleShares: 0, invalidShares: 0, blocksFound: 0 }
    );
  }

  getMiners() {
    return this.miners;
  }

  private getRecentContributions(windowMillis: number): Contribution[] {
    const now = Date.now();
    return Array.from(this.contributions.values()).filter(contribution => {
      return now - contribution.timestamp <= windowMillis;
    });
  }

  // Updated dumpContributions method
  dumpContributions(windowMillis: number = 10000): Contribution[] {
    const contributions = this.getRecentContributions(windowMillis);
    if (DEBUG)
      this.monitoring.debug(
        `SharesManager ${this.port}: Amount of contributions within the last ${windowMillis}ms: ${contributions.length}`
      );
    this.contributions.clear();
    return contributions;
  }

  resetContributions() {
    this.contributions.clear();
  }

  updateSocketDifficulty(address: string, workerName: string, newDifficulty: number) {
    const minerData = this.miners.get(address);
    if (!minerData) {
      this.monitoring.error(
        `SharesManager ${this.port}: No miner data found for address ${address} when updating difficulty`
      );
      return false;
    }

    let updated = false;
    minerData.sockets.forEach(socket => {
      if (socket.data.workers.has(workerName)) {
        const oldDiff = socket.data.difficulty;

        // Only update if difficulty actually changed
        if (oldDiff !== newDifficulty) {
          socket.data.difficulty = newDifficulty;
          updated = true;

          if (DEBUG) {
            this.monitoring.debug(
              `SharesManager ${this.port}: Socket difficulty updated for worker ${workerName} from ${oldDiff} to ${newDifficulty}`
            );
          }
        }
      }
    });

    // Also update worker stats only if we actually updated something
    if (updated) {
      const workerStats = minerData.workerStats.get(workerName);
      if (workerStats) {
        workerStats.minDiff = newDifficulty;
      }
    }
    return updated;
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

  async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async startVardiffThread(expectedShareRate: number, clamp: boolean): Promise<void> {
    let windows: number[] = [1, 3, 10, 30, 60, 240, 0];
    let tolerances: number[] = [1, 0.5, 0.25, 0.15, 0.1, 0.1, 0.1];

    const executeVardiff = async () => {
      await this.sleep(varDiffThreadSleep * 1000);

      let stats =
        '\n=== vardiff ===================================================================\n\n';
      stats += '  worker name  |    diff     |  window  |  elapsed   |    shares   |   rate    \n';
      stats += '-------------------------------------------------------------------------------\n';

      let statsLines: string[] = [];
      let toleranceErrs: string[] = [];

      for (const [address, minerData] of this.miners) {
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

          if (!workerStats.varDiffEnabled) {
            this.monitoring.debug(
              `SharesManager ${this.port}: Skipping var diff for user input diff : ${workerName}`
            );
            continue;
          }

          const status = this.checkWorkerStatus(workerStats);
          if (status === 0) {
            this.monitoring.debug(
              `SharesManager ${this.port}: Skipping var diff for inactive worker.: ${workerName}`
            );
            continue;
          }

          if (workerStats.varDiffStartTime === zeroDateMillS) {
            toleranceErrs.push(`${this.port} - no diff sent to client ${workerName}`);
            continue;
          }

          const diff = workerStats.minDiff;
          const shares = workerStats.varDiffSharesFound;
          const duration = (Date.now() - workerStats.varDiffStartTime) / 60000;
          const shareRate = shares / duration;
          const shareRateRatio = shareRate / expectedShareRate;
          const windowIndex = workerStats.varDiffWindow % windows.length;
          const window = windows[windowIndex];
          const tolerance = tolerances[windowIndex];

          statsLines.push(
            ` ${workerStats.workerName.padEnd(14)}| ${diff.toFixed(2).padStart(11)} | ${window.toString().padStart(8)} | ${duration.toFixed(2).padStart(10)} | ${shares.toString().padStart(11)} | ${shareRate.toFixed(2).padStart(9)}\n`
          );

          // check final stage first, as this is where majority of time spent
          if (window === 0) {
            if (Math.abs(1 - shareRateRatio) >= tolerance) {
              toleranceErrs.push(
                `${this.port} - ${workerName} final share rate ${shareRate} exceeded tolerance (+/- ${tolerance * 100}%)`
              );
              this.updateVarDiff(workerStats, diff * shareRateRatio, clamp);
            }
            continue;
          }

          // check all previously cleared windows
          let i: number = 1;
          for (; i <= windowIndex; ) {
            if (Math.abs(1 - shareRateRatio) >= tolerances[i]) {
              // breached tolerance of previously cleared window
              toleranceErrs.push(
                `${this.port} - ${workerName} share rate ${shareRate} exceeded tolerance (+/- ${tolerances[i] * 100}%) for ${windows[i]}m window`
              );
              this.updateVarDiff(workerStats, diff * shareRateRatio, clamp);
              break;
            }
            i++;
          }
          if (i < workerStats.varDiffWindow) {
            // should only happen if we broke previous loop
            continue;
          }

          // check for current window max exception
          if (shares >= window * expectedShareRate * (1 + tolerance)) {
            toleranceErrs.push(
              `${this.port} - ${workerName} share rate ${shareRate} exceeded upper tolerance (+/- ${tolerance * 100}%) for ${window}m window`
            );
            this.updateVarDiff(workerStats, diff * shareRateRatio, clamp);
            continue;
          }

          // check whether we've exceeded window length
          if (duration >= window) {
            // check for current window min exception
            if (shares <= window * expectedShareRate * (1 - tolerance)) {
              toleranceErrs.push(
                `${this.port} - ${workerName} share rate ${shareRate} exceeded lower tolerance (+/- ${tolerance * 100}%) for ${window}m window`
              );
              this.updateVarDiff(workerStats, diff * Math.max(shareRateRatio, 0.1), clamp);
            } else {
              workerStats.varDiffWindow++;
            }
          }
        }
      }

      statsLines.sort();
      stats += statsLines + '\n';
      stats += `\n\n===============================================================================\n`;
      stats += `\n${toleranceErrs.join('\n')}\n\n\n`;
      if (DEBUG) {
        this.monitoring.debug(stats);
      }

      // Schedule the next execution after the current one is complete
      setTimeout(executeVardiff, varDiffThreadSleep * 1000);
    };

    // Start the execution loop
    executeVardiff();
  }

  // (re)start vardiff tracker
  startVarDiff(stats: WorkerStats) {
    if (stats.varDiffStartTime === zeroDateMillS) {
      stats.varDiffSharesFound = 0;
      stats.varDiffStartTime = Date.now();
    }
  }

  // update vardiff with new mindiff, reset counters, and disable tracker until
  // client handler restarts it while sending diff on next block
  updateVarDiff(stats: WorkerStats, minDiff: number, clamp: boolean): number {
    if (clamp) {
      minDiff = Math.pow(2, Math.floor(Math.log2(minDiff)));
    }

    let previousMinDiff = stats.minDiff;
    let minimumDiff = this.stratumMinDiff;

    let newMinDiff = Math.max(minimumDiff, Math.min(this.stratumMaxDiff, minDiff));
    if (stats.invalidShares / stats.sharesFound >= varDiffRejectionRateThreshold / 100) {
      const OneGH = Math.pow(10, 9);
      if (stats.hashrate <= OneGH * 100) {
        newMinDiff = 64; // Iceriver KS0
      } else if (stats.hashrate >= OneGH * 101 && stats.hashrate <= OneGH * 200) {
        newMinDiff = 128; // Iceriver KS0 Pro
      } else if (stats.hashrate >= OneGH * 200 && stats.hashrate <= OneGH * 400) {
        newMinDiff = 256; // Iceriver KS0 Ultra
      } else if (stats.hashrate >= OneGH * 401 && stats.hashrate <= OneGH * 1000) {
        newMinDiff = 512; // Iceriver KS1
      } else if (stats.hashrate >= OneGH * 1001 && stats.hashrate <= OneGH * 2000) {
        newMinDiff = 1024; // Iceriver KS2 | Iceriver KS2 Lite | Goldshell KA-BOX | Goldshell KA-BOX Pro
      } else if (stats.hashrate >= OneGH * 2001 && stats.hashrate <= OneGH * 5000) {
        newMinDiff = 2048; // Iceriver KS3L/M
      } else if (stats.hashrate >= OneGH * 5001 && stats.hashrate <= OneGH * 8000) {
        newMinDiff = 4096; // Iceriver KS3 | Goldshell E-KA1M
      } else if (stats.hashrate >= OneGH * 8001 && stats.hashrate <= OneGH * 12000) {
        newMinDiff = 8192; // Iceriver KS5L | Bitmain KS3
      } else if (stats.hashrate >= OneGH * 12001 && stats.hashrate <= OneGH * 15000) {
        newMinDiff = 16384; // Iceriver KS5M
      } else if (stats.hashrate >= OneGH * 15001 && stats.hashrate <= OneGH * 21000) {
        newMinDiff = 32768; // Bitmain KS5/Pro
      }
      this.monitoring.debug(
        `SharesManager ${this.port}: varDiffRejectionRateThreshold - worker name: ${stats.workerName}, diff: ${stats.minDiff}, newDiff: ${newMinDiff}`
      );

      // Log difficulty adjustment due to high rejection rate
      logger.warn('Difficulty adjusted due to high rejection rate', {
        workerName: stats.workerName,
        port: this.port,
        oldDifficulty: stats.minDiff,
        newDifficulty: newMinDiff,
        hashrate: stats.hashrate,
        invalidShares: stats.invalidShares,
        totalShares: stats.sharesFound,
        rejectionRate: ((stats.invalidShares / stats.sharesFound) * 100).toFixed(2) + '%',
      });
    }

    if (newMinDiff != previousMinDiff) {
      this.monitoring.log(
        `SharesManager ${this.port}:  updating vardiff to ${newMinDiff} for client ${stats.workerName}`
      );
      stats.varDiffStartTime = zeroDateMillS;
      stats.varDiffWindow = 0;
      stats.minDiff = newMinDiff;
      metrics.updateGaugeValue(varDiff, [stats.workerName, this.port.toString()], stats.minDiff);
    }
    return previousMinDiff;
  }

  startClientVardiff(worker: Worker) {
    const stats = this.getOrCreateWorkerStats(worker.name, this.miners.get(worker.address)!);
    this.startVarDiff(stats);
  }

  getClientVardiff(worker: Worker): number {
    const minerData = this.miners.get(worker.address);
    if (!minerData) {
      if (DEBUG)
        this.monitoring.debug(
          `SharesManager ${this.port}: No miner data found for address ${worker.address}, returning default difficulty`
        );
      return 128; // Return default difficulty if no miner data exists
    }
    const stats = this.getOrCreateWorkerStats(worker.name, minerData);
    return stats.minDiff;
  }

  checkWorkerStatus(stats: WorkerStats) {
    return Date.now() - stats.lastShare <= WINDOW_SIZE ? Math.floor(stats.lastShare / 1000) : 0;
  }

  logData(minerData: MinerData) {
    minerData.workerStats.forEach((stats, workerName) => {
      this.monitoring.log(
        `SharesManager ${this.port}: stats: ${JsonBig.stringify(stats)}, name: ${workerName}`
      );
    });
  }
}
