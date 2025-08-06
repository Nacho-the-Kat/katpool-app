import { Pool } from 'pg';
import Monitoring from '../../monitoring';
import JsonBig from 'json-bigint';
import type { MinerBalanceRow } from '../../types';

const monitoring = new Monitoring();

export default class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString: connectionString,
    });
  }
  async addRewardDetails(reward_block_hash: string, reward_txn_id: string) {
    const client = await this.pool.connect();
    try {
      await client.query(
        'INSERT INTO reward_block_details (reward_block_hash, reward_txn_id) VALUES ($1, $2) ON CONFLICT (reward_txn_id) DO UPDATE SET reward_block_hash = EXCLUDED.reward_block_hash',
        [reward_block_hash, reward_txn_id]
      );
    } catch (error) {
      monitoring.error(`database: addRewardDetails - `, JsonBig.stringify(error));
    } finally {
      client.release();
    }
  }

  async addorUpdateUserDetails(
    uphold_id: string,
    access_token: string,
    access_expiry: string,
    refresh_token: string
  ) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO uphold_connections (
          uphold_id,
          access_token,
          access_expiry,
          refresh_token
        ) VALUES ($1, $2, $3, $4) ON CONFLICT (uphold_id) 
        DO UPDATE SET
          access_token = EXCLUDED.access_token,
          access_expiry = EXCLUDED.access_expiry,
          refresh_token = EXCLUDED.refresh_token
        RETURNING *`,
        [uphold_id, access_token, access_expiry, refresh_token]
      );
      // Return the generated id
      return result.rows[0]?.id || null;
    } catch (error) {
      monitoring.error(`database: addUserDetails - ${JsonBig.stringify(error)}`);
      return null;
    } finally {
      client.release();
    }
  }

  // async addUserAvailableCurrency(
  //   user_id: number,
  //   currency_code: string,
  //   currency_name: string
  // ): Promise<boolean> {
  //   const client = await this.pool.connect();
  //   try {
  //     await client.query(
  //       `INSERT INTO user_available_currencies (
  //         user_id,
  //         currency_code,
  //         currency_name
  //       ) VALUES ($1, $2, $3)
  //       ON CONFLICT (user_id, currency_code)
  //       DO NOTHING`, // Or use UPDATE if you want to update name, etc.
  //       [user_id, currency_code, currency_name]
  //     );
  //     return true;
  //   } catch (error) {
  //     monitoring.error(`database: addUserAvailableCurrency - ${JsonBig.stringify(error)}`);
  //     return false;
  //   } finally {
  //     client.release();
  //   }
  // }

  async addOrUpdateUserPayoutPreference(
    user_id: string,
    asset_code: string,
    network: string
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO uphold_payout_preferences (user_id, asset_code, network)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET
          asset_code = EXCLUDED.asset_code,
          network = EXCLUDED.network`,
        [user_id, asset_code, network]
      );
      return true;
    } catch (error) {
      monitoring.error(`database: addOrUpdateUserPayoutPreference - ${JsonBig.stringify(error)}`);
      return false;
    } finally {
      client.release();
    }
  }

  async getUserDetails(uphold_id: string) {
    const client = await this.pool.connect();
    try {
      const res = await client.query(`SELECT * FROM uphold_connections WHERE uphold_id = $1`, [
        uphold_id,
      ]);

      if (res.rows.length === 0) {
        return null; // Indicates user not found. Caller handles logic based on null return.
      }
      return res.rows[0];
    } catch (error) {
      monitoring.error(`database: getUserDetails: ${error}`);
      return null;
    } finally {
      client.release();
    }
  }

  // async addUserAvailableCurrency(
  //   user_id: number,
  //   currency_code: string,
  //   currency_name: string
  // ): Promise<boolean> {
  //   const client = await this.pool.connect();
  //   try {
  //     await client.query(
  //       `INSERT INTO user_available_currencies (
  //         user_id,
  //         currency_code,
  //         currency_name
  //       ) VALUES ($1, $2, $3)
  //       ON CONFLICT (user_id, currency_code)
  //       DO NOTHING`, // Or use UPDATE if you want to update name, etc.
  //       [user_id, currency_code, currency_name]
  //     );
  //     return true;
  //   } catch (error) {
  //     monitoring.error(`database: addUserAvailableCurrency - ${JsonBig.stringify(error)}`);
  //     return false;
  //   } finally {
  //     client.release();
  //   }
  // }

  async addOrUpdateUserPayoutPreference(
    user_id: string,
    asset_code: string,
    network: string
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO uphold_payout_preferences (user_id, asset_code, network)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET
          asset_code = EXCLUDED.asset_code,
          network = EXCLUDED.network`,
        [user_id, asset_code, network]
      );
      return true;
    } catch (error) {
      monitoring.error(`database: addOrUpdateUserPayoutPreference - ${JsonBig.stringify(error)}`);
      return false;
    } finally {
      client.release();
    }
  }

  async getUserDetails(uphold_id: string) {
    const client = await this.pool.connect();
    try {
      const res = await client.query(`SELECT * FROM uphold_connections WHERE uphold_id = $1`, [
        uphold_id,
      ]);

      if (res.rows.length === 0) {
        return null; // Indicates user not found. Caller handles logic based on null return.
      }
      return res.rows[0];
    } catch (error) {
      monitoring.error(`database: getUserDetails: ${error}`);
      return null;
    } finally {
      client.release();
    }
  }

  async getRewardBlockHash(
    reward_txn_id: string,
    checkForInsert?: boolean
  ): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT reward_block_hash FROM reward_block_details WHERE reward_txn_id = $1',
        [reward_txn_id]
      );

      if (result.rows.length === 0) {
        if (!checkForInsert)
          monitoring.debug(`database: No reward_block_hash found for txn ID: ${reward_txn_id}`);
        return '';
      }
      return result.rows[0].reward_block_hash;
    } catch (error) {
      monitoring.error(`database: getRewardBlockHash - `, error);

      // Optional: handle duplicate entry
      const err = error as { code?: string; message?: string }; // Now 'error' is explicitly defined
      monitoring.error(`database: addRewardDetails - `, JsonBig.stringify(error));

      if (err?.code === '23505') {
        monitoring.debug(`database: Reward entry already exists for txn: ${reward_txn_id}`);
      }

      return '';
    } finally {
      client.release();
    }
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
      const resNK = await client.query(
        'SELECT nacho_rebate_kas FROM miners_balance WHERE id = $1',
        [key]
      );
      let minerNachoKas = resNK.rows[0] ? BigInt(resNK.rows[0].nacho_rebate_kas) : 0n;
      minerNachoKas += nacho_rebate_kas;

      await client.query(
        'INSERT INTO miners_balance (id, miner_id, wallet, balance, nacho_rebate_kas) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance, nacho_rebate_kas = EXCLUDED.nacho_rebate_kas',
        [key, minerId, wallet, minerBalance, minerNachoKas]
      );

      // Update wallet_total table
      const resTotal = await client.query('SELECT total FROM wallet_total WHERE address = $1', [
        wallet,
      ]);
      let walletTotal = resTotal.rows[0] ? BigInt(resTotal.rows[0].total) : 0n;
      walletTotal += balance;

      await client.query(
        'INSERT INTO wallet_total (address, total) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET total = EXCLUDED.total',
        [wallet, walletTotal]
      );

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
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
        balance: BigInt(row.balance),
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

  async addBlockDetails(
    mined_block_hash: string,
    miner_id: string,
    reward_block_hash: string,
    wallet: string,
    daaScore: string,
    pool_address: string,
    minerReward: bigint
  ) {
    const client = await this.pool.connect();
    const key = `${mined_block_hash}`;

    try {
      await client.query('BEGIN');

      await client.query(
        'INSERT INTO block_details (mined_block_hash, miner_id, pool_address, reward_block_hash, wallet, daa_score, miner_reward, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) ON CONFLICT (mined_block_hash) DO UPDATE SET reward_block_hash = EXCLUDED.reward_block_hash, miner_reward = EXCLUDED.miner_reward',
        [key, miner_id, pool_address, reward_block_hash, wallet, daaScore, minerReward]
      );

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPaymentsByWallet(wallet: string) {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        'SELECT * FROM payments WHERE $1 = ANY(wallet_address) ORDER BY timestamp DESC',
        [wallet]
      );
      return res.rows;
    } finally {
      client.release();
    }
  }
}
