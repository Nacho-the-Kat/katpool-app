import { Pool } from 'pg';

type Miner = {
  balance: bigint;
};

type MinerBalanceRow = {
  miner_id: string;
  wallet: string;
  balance: string;
};

const defaultMiner: Miner = {
  balance: 0n,
};

export default class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString: connectionString,
    });
  }

  async addBalance(minerId: string, wallet: string, balance: bigint, nacho_rebate_kas: bigint) {
    const client = await this.pool.connect();
    const key = `${minerId}_${wallet}`;

    try {
      await client.query('BEGIN');
      
      // Update miners_balance table
      const res = await client.query('SELECT balance FROM miners_balance WHERE id = $1', [key]);
      let minerBalance = res.rows[0] ? BigInt(res.rows[0].balance) : 0n;
      minerBalance += balance;

      // Update miners_balance table
      const resNK = await client.query('SELECT nacho_rebate_kas FROM miners_balance WHERE id = $1', [key]);
      let minerNachoKas = resNK.rows[0] ? BigInt(resNK.rows[0].nacho_rebate_kas) : 0n;
      minerNachoKas += nacho_rebate_kas;

      await client.query('INSERT INTO miners_balance (id, miner_id, wallet, balance, nacho_rebate_kas) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance, nacho_rebate_kas = EXCLUDED.nacho_rebate_kas', [
        key,
        minerId,
        wallet,
        minerBalance,
        minerNachoKas,
      ]);

      // Update wallet_total table
      const resTotal = await client.query('SELECT total FROM wallet_total WHERE address = $1', [wallet]);
      let walletTotal = resTotal.rows[0] ? BigInt(resTotal.rows[0].total) : 0n;
      walletTotal += balance;

      await client.query('INSERT INTO wallet_total (address, total) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET total = EXCLUDED.total', [
        wallet,
        walletTotal,
      ]);

      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async resetBalanceByAddress(wallet: string) {
    const client = await this.pool.connect();
    try {
      await client.query('UPDATE miners_balance SET balance = $1 WHERE wallet = $2', [0n, wallet]);
    } finally {
      client.release();
    }
  }

  async getAllBalances() {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT miner_id, wallet, balance FROM miners_balance');
      return res.rows.map((row: MinerBalanceRow) => ({
        minerId: row.miner_id,
        address: row.wallet,
        balance: BigInt(row.balance)
      }));
    } finally {
      client.release();
    }
  }

  async getUser(minerId: string, wallet: string) {
    const client = await this.pool.connect();
    const key = `${minerId}_${wallet}`;
    try {
      const res = await client.query('SELECT balance FROM miners_balance WHERE id = $1', [key]);
      if (res.rows.length === 0) {
        return { balance: 0n };
      }
      return { balance: BigInt(res.rows[0].balance) };
    } finally {
      client.release();
    }
  }

  async addBlockDetails(mined_block_hash: string, miner_id: string, reward_block_hash: string, wallet: string, daaScore: string, pool_address: string, minerReward : bigint) {
    const client = await this.pool.connect();
    const key = `${mined_block_hash}`;

    try {
      await client.query('BEGIN');
      
      await client.query('INSERT INTO block_details (mined_block_hash, miner_id, pool_address, reward_block_hash, wallet, daa_score, miner_reward, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) ON CONFLICT (mined_block_hash) DO UPDATE SET reward_block_hash = EXCLUDED.reward_block_hash, miner_reward = EXCLUDED.miner_reward', [
        key,
        miner_id,
        pool_address,
        reward_block_hash,
        wallet,
        daaScore,
        minerReward,        
      ]);

      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {      
      client.release();
    }
  }

  async getPaymentsByWallet(wallet: string) {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT * FROM payments WHERE $1 = ANY(wallet_address) ORDER BY timestamp DESC', [wallet]);
      return res.rows;
    } finally {
      client.release();
    }
  }
}