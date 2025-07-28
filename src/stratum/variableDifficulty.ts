import { metrics } from '../..';
import { DEBUG } from '../constants';
import Monitoring from '../monitoring';
import logger from '../monitoring/datadog';
import { varDiff } from '../prometheus';
import type { WorkerStats, Worker } from '../types';
import type { SharesManager } from './sharesManager';

const varDiffThreadSleep: number = 10;
const varDiffRejectionRateThreshold: number = 20; // If rejection rate exceeds threshold, set difficulty based on hash rate.
const zeroDateMillS: number = new Date(0).getMilliseconds();

export class VariableDifficulty {
  private monitoring: Monitoring;
  private sharesManager: SharesManager;
  private stratumMinDiff: number;
  private stratumMaxDiff: number;

  constructor(sharesManager: SharesManager, stratumMinDiff: number, stratumMaxDiff: number) {
    this.monitoring = new Monitoring();
    this.sharesManager = sharesManager;
    this.stratumMinDiff = stratumMinDiff;
    this.stratumMaxDiff = stratumMaxDiff;
  }

  updateSocketDifficulty(address: string, workerName: string, newDifficulty: number) {
    const minerData = this.sharesManager.miners.get(address);
    if (!minerData) {
      this.monitoring.error(
        `VariableDifficulty ${this.sharesManager.port}: No miner data found for address ${address} when updating difficulty`
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
              `VariableDifficulty ${this.sharesManager.port}: Socket difficulty updated for worker ${workerName} from ${oldDiff} to ${newDifficulty}`
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

      for (const [address, minerData] of this.sharesManager.miners) {
        if (!minerData || !minerData.workerStats) {
          if (DEBUG)
            this.monitoring.debug(
              `VariableDifficulty ${this.sharesManager.port}: Invalid miner data for address ${address}`
            );
          continue;
        }

        for (const [workerName, workerStats] of minerData.workerStats) {
          if (!workerStats || !workerStats.workerName) {
            if (DEBUG)
              this.monitoring.debug(
                `VariableDifficulty ${this.sharesManager.port}: Invalid worker stats or worker name for worker ${workerName}`
              );
            continue;
          }

          if (!workerStats.varDiffEnabled) {
            this.monitoring.debug(
              `VariableDifficulty ${this.sharesManager.port}: Skipping var diff for user input diff : ${workerName}`
            );
            continue;
          }

          const status = this.sharesManager.checkWorkerStatus(workerStats);
          if (status === 0) {
            this.monitoring.debug(
              `VariableDifficulty ${this.sharesManager.port}: Skipping var diff for inactive worker.: ${workerName}`
            );
            continue;
          }

          if (workerStats.varDiffStartTime === zeroDateMillS) {
            toleranceErrs.push(`${this.sharesManager.port} - no diff sent to client ${workerName}`);
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
                `${this.sharesManager.port} - ${workerName} final share rate ${shareRate} exceeded tolerance (+/- ${tolerance * 100}%)`
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
                `${this.sharesManager.port} - ${workerName} share rate ${shareRate} exceeded tolerance (+/- ${tolerances[i] * 100}%) for ${windows[i]}m window`
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
              `${this.sharesManager.port} - ${workerName} share rate ${shareRate} exceeded upper tolerance (+/- ${tolerance * 100}%) for ${window}m window`
            );
            this.updateVarDiff(workerStats, diff * shareRateRatio, clamp);
            continue;
          }

          // check whether we've exceeded window length
          if (duration >= window) {
            // check for current window min exception
            if (shares <= window * expectedShareRate * (1 - tolerance)) {
              toleranceErrs.push(
                `${this.sharesManager.port} - ${workerName} share rate ${shareRate} exceeded lower tolerance (+/- ${tolerance * 100}%) for ${window}m window`
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
        `VariableDifficulty ${this.sharesManager.port}: varDiffRejectionRateThreshold - worker name: ${stats.workerName}, diff: ${stats.minDiff}, newDiff: ${newMinDiff}`
      );

      // Log difficulty adjustment due to high rejection rate
      logger.warn('Difficulty adjusted due to high rejection rate', {
        workerName: stats.workerName,
        port: this.sharesManager.port,
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
        `VariableDifficulty ${this.sharesManager.port}:  updating vardiff to ${newMinDiff} for client ${stats.workerName}`
      );
      stats.varDiffStartTime = zeroDateMillS;
      stats.varDiffWindow = 0;
      stats.minDiff = newMinDiff;
      metrics.updateGaugeValue(
        varDiff,
        [stats.workerName, this.sharesManager.port.toString()],
        stats.minDiff
      );
    }
    return previousMinDiff;
  }

  startClientVardiff(worker: Worker) {
    const stats = this.sharesManager.stats.getOrCreateWorkerStats(
      worker.name,
      this.sharesManager.miners.get(worker.address)!
    );
    this.startVarDiff(stats);
  }

  getClientVardiff(worker: Worker): number {
    const minerData = this.sharesManager.miners.get(worker.address);
    if (!minerData) {
      if (DEBUG)
        this.monitoring.debug(
          `VariableDifficulty ${this.sharesManager.port}: No miner data found for address ${worker.address}, returning default difficulty`
        );
      return 128; // Return default difficulty if no miner data exists
    }
    const stats = this.sharesManager.stats.getOrCreateWorkerStats(worker.name, minerData);
    return stats.minDiff;
  }
}
