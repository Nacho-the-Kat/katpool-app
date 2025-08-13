import Denque from 'denque';
import Monitoring from '../monitoring';
import { type Miner, type MinerData, type WorkerStats } from '../types';
import type { SharesManager } from './sharesManager';
import { DEBUG, WINDOW_SIZE } from '../constants';
import { activeMinerGuage, workerHashRateGauge } from '../prometheus';
import { metrics } from '../..';
import {
  debugHashrateCalculation,
  getAverageHashrateGHs,
  stringifyHashrate,
  getSocketLogData,
} from './utils';
import logger from '../monitoring/datadog';
import type { Socket } from 'bun';
import JsonBig from 'json-bigint';

export class Stats {
  private monitoring: Monitoring;
  private sharesManager: SharesManager;
  private stratumInitDiff: number;

  constructor(sharesManager: SharesManager, stratumInitDiff: number) {
    this.sharesManager = sharesManager;
    this.stratumInitDiff = stratumInitDiff;
    this.monitoring = new Monitoring();
  }

  getOrCreateWorkerStats(workerName: string, minerData: MinerData): WorkerStats {
    if (!minerData.workerStats.has(workerName)) {
      let varDiffStatus = false;
      if (this.sharesManager.port === 8888) {
        varDiffStatus = true;
        this.monitoring.debug(
          `Stats ${this.sharesManager.port}: New worker stats created for ${workerName}, defaulting to enabled var-diff due to connection to the port 8888.`
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
          `Stats ${this.sharesManager.port}: Created new worker stats for ${workerName}`
        );
    }
    return minerData.workerStats.get(workerName)!;
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

      this.sharesManager.miners.forEach((minerData, address) => {
        let rate = 0;
        minerData.workerStats.forEach((stats, workerName) => {
          // Update active status metrics
          let workerRate = 0;
          const status = this.sharesManager.checkWorkerStatus(stats);
          metrics.updateGaugeValue(
            activeMinerGuage,
            [workerName, address, stats.asicType, this.sharesManager.port.toString()],
            status
          );
          if (status) {
            workerRate = getAverageHashrateGHs(stats, address);
            debugHashrateCalculation(stats, address, workerRate);
          } else {
            logger.warn(
              `Stats ${this.sharesManager.port}: Worker ${address}.${workerName} is inactive, setting hashrate to 0`
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
                    `Stats ${this.sharesManager.port}: Closing inactive socket for worker: ${workerName}, address: ${address}`
                  );
                  skt.data.closeReason = 'Inactive worker timeout - 10 Minute';
                  skt.end(); // This will trigger the close event and deleteSocket method
                  found = true;
                }
              });
              if (!found) {
                this.monitoring.debug(
                  `Stats ${this.sharesManager.port}: ERROR - No socket found for deletion for worker: ${workerName}, address: ${address}`
                );
                logger.warn(
                  `Stats ${this.sharesManager.port}: No socket found for deletion for worker: ${workerName}, address: ${address}`
                );
              }
            }
          } catch (error) {
            this.monitoring.error(
              `Stats ${this.sharesManager.port}: Could not delete inactive worker: ${workerName}, address: ${address} - `,
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

  cleanWorkerStats() {
    setInterval(async () => {
      this.sharesManager.miners.forEach(async (minerData, address) => {
        minerData.workerStats.forEach(async (stats, workerName) => {
          // Update active status metrics
          const status = this.sharesManager.checkWorkerStatus(stats);
          if (status) {
            const workerRate = getAverageHashrateGHs(stats, address);

            // Query Prometheus for historical hashrate data
            try {
              const hashrateHistory = await metrics.queryWorkerHashrateHistory(
                workerName,
                address,
                3
              );
              logger.warn('hashrate-history', hashrateHistory);
              // Check if we have enough data points and if all are exactly the same
              if (
                hashrateHistory.length >= 3 &&
                hashrateHistory.every(rate => rate === hashrateHistory[0])
              ) {
                // Clean up worker data - hashrate stagnant for 5 consecutive measurements
                this.monitoring.error(
                  `Stats ${this.sharesManager.port}: Cleaning up worker ${workerName}@${address} - hashrate stagnant at ${workerRate} for 5 consecutive measurements`
                );

                minerData.sockets.forEach(skt => {
                  if (skt.data.workers.has(workerName)) {
                    skt.data.closeReason = 'Inactive worker timeout - 10 Minute';
                    skt.end();
                  }
                });
              }
            } catch (error) {
              this.monitoring.error(
                `Stats ${this.sharesManager.port}: Failed to query hashrate history for worker ${workerName}@${address}:`,
                error
              );
            }
          }
        });
      });
    }, 1000);
  }

  // Helper method for stats calculation
  private calculateOverallStats() {
    return Array.from(this.sharesManager.miners.values()).reduce(
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

  // Add this method to your SharesManager class
  cleanupSocket(socket: Socket<Miner>) {
    socket.data.workers.forEach((worker, workerName) => {
      const minerData = this.sharesManager.miners.get(worker.address);
      if (minerData) {
        // Remove the socket from the sockets set
        minerData.sockets.delete(socket);
        this.monitoring.debug(
          `Stats ${this.sharesManager.port}: Deleted socket for: ${workerName}@${worker.address}`
        );
        logger.warn(`deleteSocket, ${socket.data.closeReason}`, getSocketLogData(socket));

        // If no more sockets for this address, clean up the entire miner data
        if (minerData.sockets.size === 0) {
          this.sharesManager.miners.delete(worker.address);
          const msg = `Stats ${this.sharesManager.port}: Cleaned up all data for address ${worker.address}`;
          if (DEBUG) {
            this.monitoring.debug(msg);
          }
          logger.warn(msg);
        }
      }
    });
  }

  logData(minerData: MinerData) {
    minerData.workerStats.forEach((stats, workerName) => {
      this.monitoring.log(
        `Stats ${this.sharesManager.port}: stats: ${JsonBig.stringify(stats)}, name: ${workerName}`
      );
    });
  }
}
