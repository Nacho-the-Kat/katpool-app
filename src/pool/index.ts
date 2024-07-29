import type Treasury from '../treasury';
import type Stratum from '../stratum';
import Database from './database';
import Monitoring from './monitoring';
import { sompiToKaspaStringWithSuffix, type IPaymentOutput } from '../../wasm/kaspa';
import { SharesManager } from '../stratum/sharesManager'; // Import SharesManager


export default class Pool {
  private treasury: Treasury;
  private stratum: Stratum;
  private database: Database;
  private monitoring: Monitoring;
  private sharesManager: SharesManager; // Add SharesManager property  

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

    this.stratum.on('subscription', (ip: string, agent: string) => this.monitoring.log(`Pool: Miner ${ip} subscribed into notifications with ${agent}.`));
    this.treasury.on('coinbase', (amount: bigint) => this.allocate(amount));
    this.treasury.on('revenue', (amount: bigint) => this.revenuize(amount));

    this.monitoring.log(`Pool: Pool is active on port ${this.stratum.server.socket.port}.`);

  }

  private async revenuize(amount: bigint) {
    const address = this.treasury.address; // Use the treasury address
    const minerId = 'pool'; // Use a fixed ID for the pool itself
    await this.database.addBalance(minerId, address, amount); // Use the total amount as the share
    this.monitoring.log(`Pool: Treasury generated ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} revenue over last coinbase.`);
  }

  private async allocate(amount: bigint) {
    let works = new Map<string, { minerId: string, difficulty: number }>();
    let totalWork = 0;
  
    for (const contribution of this.sharesManager.dumpContributions()) {
      const { address, difficulty, minerId } = contribution;
      const currentWork = works.get(address) ?? { minerId, difficulty: 0 };
      
      works.set(address, { minerId, difficulty: currentWork.difficulty + difficulty });
      totalWork += difficulty;
    }  
    this.monitoring.log(`Pool: Reward with ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} is getting ALLOCATED into ${works.size} miners.`);
  
    const scaledTotal = BigInt(totalWork * 100);
  
    for (const [address, work] of works) {
      const scaledWork = BigInt(work.difficulty * 100);
      const share = (scaledWork * amount) / scaledTotal;
  
      const user = await this.database.getUser(work.minerId, address);
  
      await this.database.addBalance(work.minerId, address, share);
    }
  }
  
}