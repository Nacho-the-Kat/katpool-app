import Denque from 'denque';
import Monitoring from '../monitoring';
import { type MinerData, type WorkerStats } from '../types';
import type { SharesManager } from './sharesManager';
import { DEBUG, WINDOW_SIZE } from '../constants';
import { activeMinerGuage, workerHashRateGauge } from '../prometheus';
import { metrics } from '../..';
import { debugHashrateCalculation, getAverageHashrateGHs, stringifyHashrate } from './utils';
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
              let socket: Socket<any>;
              minerData.sockets.forEach(skt => {
                if (skt.data.workers.has(workerName) && !found) {
                  this.monitoring.debug(
                    `\nSharesManager ${this.sharesManager.port}: MinerData before - `
                  );
                  this.logData(minerData);
                  this.monitoring.debug(
                    `Stats ${this.sharesManager.port}: Status is inactive for worker: ${workerName}, address: ${address}`
                  );
                  minerData.workerStats.delete(workerName);
                  this.monitoring.debug(
                    `Stats ${this.sharesManager.port}: Deleted workerstats: ${workerName}, address: ${address}`
                  );
                  socket = skt;
                  this.monitoring.debug(
                    `Stats ${this.sharesManager.port}: Socket found for deletion: ${workerName}, address: ${address}`
                  );
                  found = true;
                  socket.end();
                  socket = skt;
                  minerData.sockets.delete(socket!);
                  this.monitoring.debug(
                    `Stats ${this.sharesManager.port}: Deleted socket for : ${workerName}, address: ${address}`
                  );
                  this.monitoring.debug(
                    `\nSharesManager ${this.sharesManager.port}: MinerData after - `
                  );
                  this.logData(minerData);
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

  logData(minerData: MinerData) {
    minerData.workerStats.forEach((stats, workerName) => {
      this.monitoring.log(
        `Stats ${this.sharesManager.port}: stats: ${JsonBig.stringify(stats)}, name: ${workerName}`
      );
    });
  }
}
