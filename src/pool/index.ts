import type Treasury from '../treasury';
import type Stratum from '../stratum';
import Database from './database';
import Monitoring from '../monitoring';
import { sompiToKaspaStringWithSuffix } from '../../wasm/kaspa';
import { DEBUG } from "../../index"
import { SharesManager } from '../stratum/sharesManager'; // Import SharesManager
import { PushMetrics } from '../prometheus'; // Import the PushMetrics class
import { fetchBlockHashAndDaaScore } from './fetchBlockDetails';
import "./workerMain"; // Start the queue and worker system
import { addTransactionToQueue } from './workerMain';

export default class Pool {
  private treasury: Treasury;
  private stratum: Stratum;
  private database: Database;
  private monitoring: Monitoring;
  private sharesManager: SharesManager; // Add SharesManager property
  private pushMetrics: PushMetrics; // Add PushMetrics property
  private lastProcessedTimestamp = 0; // Add timestamp check
  private duplicateEventCount = 0;

  constructor(treasury: Treasury, stratum: Stratum, sharesManager: SharesManager) {
    this.treasury = treasury;
    this.stratum = stratum;

    const databaseUrl = process.env.DATABASE_URL; // Add this line
    if (!databaseUrl) { // Add this line
      throw new Error('Environment variable DATABASE_URL is not set.'); // Add this line
    }

    this.database = new Database(databaseUrl); // Change this line
    this.monitoring = new Monitoring();
    this.sharesManager = sharesManager; // Initialize SharesManager
    this.pushMetrics = new PushMetrics(process.env.PUSHGATEWAY || ''); // Initialize PushMetrics

    this.stratum.on('subscription', (ip: string, agent: string) => this.monitoring.log(`Pool: Miner ${ip} subscribed into notifications with ${agent}.`));
    this.treasury.on('coinbase', (minerReward: bigint, poolFee: bigint, txnId: string, daaScore: string) => {
      const currentTimestamp = Date.now();
      // if (currentTimestamp - this.lastProcessedTimestamp < 1000) { // 1 second cooldown
      //   this.duplicateEventCount++;
      //   this.monitoring.debug(`Pool: Skipping duplicate coinbase event. Last processed: ${this.lastProcessedTimestamp}, Current: ${currentTimestamp}, Duplicate count: ${this.duplicateEventCount}`);
      //   return;
      // }
      this.lastProcessedTimestamp = currentTimestamp;
      this.duplicateEventCount = 0;
      this.monitoring.log(`Pool: Processing coinbase event. Timestamp: ${currentTimestamp}`);
      this.allocate(minerReward, poolFee, txnId, daaScore).catch(console.error)
    });
    //this.treasury.on('revenue', (amount: bigint) => this.revenuize(amount));

    this.monitoring.log(`Pool: Pool is active on port ${this.stratum.server.socket.port}.`);
  }

  private async revenuize(amount: bigint) {
    const address = this.treasury.address; // Use the treasury address
    const minerId = 'pool'; // Use a fixed ID for the pool itself
    await this.database.addBalance(minerId, address, amount); // Use the total amount as the share
    this.monitoring.log(`Pool: Treasury generated ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} revenue over last coinbase.`);
  }

  private async allocate(minerReward: bigint, poolFee: bigint, txnId: string, daaScore: string) {
    this.monitoring.debug(`Pool: Starting allocation. Miner Reward: ${minerReward}, Pool Fee: ${poolFee}`);
    const works = new Map<string, { minerId: string, difficulty: number }>();
    let totalWork = 0;
    const walletHashrateMap = new Map<string, number>();

    // Get all shares since the last allocation
    const shares = this.sharesManager.getSharesSinceLastAllocation();
    this.monitoring.debug(`Pool: Retrieved ${shares.length} shares for allocation`);

    for (const share of shares) {
      const { address, difficulty, minerId } = share;

      // Aggregate work by address
      if (!works.has(address)) {
        works.set(address, { minerId, difficulty });
      } else {
        const currentWork = works.get(address)!;
        currentWork.difficulty += difficulty;
      }

      totalWork += difficulty;

      // Accumulate the hashrate by wallet address
      if (!walletHashrateMap.has(address)) {
        walletHashrateMap.set(address, difficulty);
      } else {
        walletHashrateMap.set(address, walletHashrateMap.get(address)! + difficulty);
      }

      // Update the gauge for shares added
      this.pushMetrics.updateMinerSharesGauge(minerId, difficulty);
    }

    // Update wallet hashrate gauge for all addresses
    for (const [walletAddress, hashrate] of walletHashrateMap) {
      this.pushMetrics.updateWalletHashrateGauge(walletAddress, hashrate);
    }

    // Ensure totalWork is greater than 0 to prevent division by zero
    if (totalWork === 0) {
      this.monitoring.debug(`Pool: No work found for allocation in the current cycle. Total shares: ${shares.length}`);
      return;
    }

    const scaledTotal = BigInt(totalWork * 100);

    let {reward_block_hash, block_hash, daaScoreF} = await fetchBlockHashAndDaaScore(txnId)
    if (reward_block_hash == '' && daaScoreF == '0') addTransactionToQueue(txnId, minerReward, this.treasury.address)
    if (daaScoreF === '0') daaScoreF = daaScore
    
    const database = new Database(process.env.DATABASE_URL || '');
    // We don't have miner_id and corresponding wallet address
    await database.addBlockDetails(block_hash, '',reward_block_hash, '', daaScoreF, this.treasury.address, minerReward); 

    // Allocate rewards proportionally based on difficulty
    for (const [address, work] of works) {
      const scaledWork = BigInt(work.difficulty * 100);
      const share = (scaledWork * minerReward) / scaledTotal;

      await this.database.addBalance(work.minerId, address, share);

      // Track rewards for the miner
      this.pushMetrics.updateMinerRewardGauge(address, work.minerId, block_hash, daaScoreF);

      if (DEBUG) {
        this.monitoring.debug(`Pool: Reward of ${sompiToKaspaStringWithSuffix(share, this.treasury.processor.networkId!)} was ALLOCATED to ${work.minerId} with difficulty ${work.difficulty}`);
      }
    }

    // Handle pool fee revenue
    if (works.size > 0 && poolFee > 0) this.revenuize(poolFee);
  }
}