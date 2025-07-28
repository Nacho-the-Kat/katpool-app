import type Treasury from '../treasury';
import type Stratum from '../stratum';
import Database from './database';
import Monitoring from '../monitoring';
import { sompiToKaspaStringWithSuffix } from '../../wasm/kaspa';
import { sendConfig } from '../../index';
import axios, { AxiosError } from 'axios';
import config from '../../config/config.json';
import axiosRetry from 'axios-retry';
import JsonBig from 'json-bigint';
import logger from '../monitoring/datadog';
import type { Contribution } from '../types';
import { databaseUrl, DEBUG, getNetworkConfig } from '../constants';

const monitoring = new Monitoring();

axiosRetry(axios, {
  retries: 3,
  retryDelay: retryCount => {
    return retryCount * 1000;
  },
  retryCondition(error) {
    // Ensure error.response exists before accessing status
    if (!error.response) {
      monitoring.error(`Pool: axiosRetry - No response received: ${error.message}`);
      return false; // Do not retry if no response (e.g., network failure)
    }

    const retryableStatusCodes = [404, 422, 429, 500, 501, 503];
    return retryableStatusCodes.includes(error.response.status);
  },
});

const { apiBaseUrl: KASPA_BASE_URL } = getNetworkConfig(config.network);

export default class Pool {
  private treasury: Treasury;
  private stratum: Stratum[];
  private database: Database;
  private monitoring: Monitoring;
  private lastProcessedTimestamp = 0; // Add timestamp check
  private duplicateEventCount = 0;

  constructor(treasury: Treasury, stratum: Stratum[]) {
    this.treasury = treasury;
    this.stratum = stratum;

    this.database = new Database(databaseUrl);
    this.monitoring = monitoring;

    this.treasury.on(
      'coinbase',
      (
        minerReward: bigint,
        poolFee: bigint,
        reward_block_hash: string,
        txnId: string,
        daaScore: string
      ) => {
        const currentTimestamp = Date.now();
        // if (currentTimestamp - this.lastProcessedTimestamp < 1000) { // 1 second cooldown
        //   this.duplicateEventCount++;
        //   this.monitoring.debug(`Pool: Skipping duplicate coinbase event. Last processed: ${this.lastProcessedTimestamp}, Current: ${currentTimestamp}, Duplicate count: ${this.duplicateEventCount}`);
        //   return;
        // }
        this.lastProcessedTimestamp = currentTimestamp;
        this.duplicateEventCount = 0;
        this.monitoring.log(
          `Pool: Processing coinbase event. Timestamp: ${currentTimestamp}. Reward block hash: ${reward_block_hash}`
        );
        this.allocate(minerReward, poolFee, txnId, reward_block_hash, daaScore).catch(
          this.monitoring.error
        );
      }
    );

    sendConfig();
  }

  private async revenuize(amount: bigint, block_hash: string, reward_block_hash: string) {
    const address = this.treasury.address; // Use the treasury address
    const minerId = 'pool'; // Use a fixed ID for the pool itself
    await this.database.addBalance(minerId, address, amount, 0n); // Use the total amount as the share
    this.monitoring.log(
      `Pool: Treasury generated ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} revenue over last coinbase of: ${block_hash}. Received in ${reward_block_hash}.`
    );
  }

  private async allocate(
    minerReward: bigint,
    poolFee: bigint,
    txnId: string,
    reward_block_hash: string,
    daaScore: string
  ) {
    this.monitoring.debug(
      `Pool: Starting allocation. Miner Reward: ${minerReward}, Pool Fee: ${poolFee} received on block: ${reward_block_hash}`
    );
    const works = new Map<string, { minerId: string; difficulty: number }>();
    let totalWork = 0;

    // Get all shares since for the current maturity event.
    const database = new Database(databaseUrl || '');
    let block_hash = '',
      daaScoreF = '0';
    if (reward_block_hash != '') {
      const result = await this.fetchBlockHashAndDaaScore(reward_block_hash);
      block_hash = result.block_hash;
      daaScoreF = result.daaScoreF;
    }

    if (reward_block_hash != '' && daaScoreF != '0') {
      // We don't have miner_id and corresponding wallet address
      await database.addBlockDetails(
        block_hash,
        '',
        reward_block_hash,
        '',
        daaScoreF,
        this.treasury.address,
        minerReward + poolFee
      );
    }

    let shares: Contribution[] = [];
    if (daaScoreF != '0')
      shares = this.stratum.flatMap(stratum =>
        stratum.sharesManager.getSharesSinceLastAllocation(BigInt(daaScoreF))
      );

    if (shares.length === 0 || daaScoreF == '0') {
      shares = this.stratum.flatMap(stratum =>
        stratum.sharesManager.getDifficultyAndTimeSinceLastAllocation()
      );
      this.monitoring.debug(
        `Pool: Used fallback logic for txnId: ${txnId}. Using ${shares.length} fallback shares`
      );
      logger.warn(
        `Pool: Used fallback logic for txnId: ${txnId}. Using ${shares.length} fallback shares`
      );
    }

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
    }

    // Ensure totalWork is greater than 0 to prevent division by zero
    if (totalWork === 0) {
      this.monitoring.debug(
        `Pool: No work found for allocation in the current cycle. Total shares: ${shares.length}.`
      );
      this.monitoring.debug(`Pool: For No work found - ${JsonBig.stringify(shares, null, 4)}`);
      return;
    }

    const scaledTotal = BigInt(totalWork * 100);

    // Initially show NACHO rebate KAS as config.treasury.nachoRebate ~0.33% for all. If he holds 100M+ NACHO or 1 NFT he may get full rebate
    const rebate = (poolFee * BigInt(config.treasury.nachoRebate * 100)) / 10000n;
    // Allocate rewards proportionally based on difficulty
    for (const [address, work] of works) {
      const scaledWork = BigInt(work.difficulty * 100);
      const share = (scaledWork * minerReward) / scaledTotal;
      const nacho_rebate_kas = (scaledWork * rebate) / scaledTotal;

      await this.database.addBalance(work.minerId, address, share, nacho_rebate_kas);

      if (DEBUG) {
        this.monitoring.debug(
          `Pool: Reward of ${sompiToKaspaStringWithSuffix(share, this.treasury.processor.networkId!)} , rebate in KAS ${sompiToKaspaStringWithSuffix(nacho_rebate_kas, this.treasury.processor.networkId!)} was ALLOCATED to ${work.minerId} with difficulty ${work.difficulty}, block_hash: ${block_hash}`
        );
      }
    }

    // Handle pool fee revenue
    if (works.size > 0 && poolFee > 0) this.revenuize(poolFee, block_hash, reward_block_hash);
  }

  handleError(error: unknown, context: string) {
    if (error instanceof AxiosError) {
      this.monitoring.error(`Pool: API call failed - `, error);
      this.monitoring.error(`Pool: ${context}`);
      if (error.response) {
        this.monitoring.error(`Pool: Response status: ${error.response.status}`);
        if (DEBUG)
          this.monitoring.error(`Pool: Response data: ${JsonBig.stringify(error.response.data)}`);
      }
      return { reward_block_hash: '', block_hash: 'block_hash_placeholder', daaScoreF: '0' };
    } else {
      this.monitoring.error(`Pool: Unexpected error: `, error);
    }
  }

  async fetchBlockHashAndDaaScore(rewardHash: string) {
    let block_hash: string = 'block_hash_placeholder';
    let daaScoreF = '0'; // Needs to be removed later
    let reward_block_hash = rewardHash;
    try {
      const reward_block_hash_url = `${KASPA_BASE_URL}/blocks/${reward_block_hash}?includeColor=false`;
      const response = await axios.get(reward_block_hash_url, {});

      if (response?.status !== 200 && !response?.data) {
        this.monitoring.error(`Pool: Unexpected status code: ${response.status}`);
        this.monitoring.error(
          `Pool: Invalid or missing block hash in response data for reward block ${reward_block_hash}`
        );
      } else {
        let block_hashes = response.data.verboseData.mergeSetBluesHashes;
        for (const hash of block_hashes) {
          try {
            const block_hash_url = `${KASPA_BASE_URL}/blocks/${hash}?includeColor=false`;
            const response = await axios.get(block_hash_url, {});

            const targetPattern = `/${config.miner_info}`;
            if (response?.status !== 200 && !response?.data) {
              this.monitoring.error(`Pool: Unexpected status code: ${response.status}`);
              this.monitoring.error(
                `Pool: Invalid or missing block hash in response data for reward block ${reward_block_hash}`
              );
            } else if (
              response?.status === 200 &&
              response?.data &&
              response.data.extra.minerInfo.includes(targetPattern)
            ) {
              // Fetch details for the block hash where miner info matches
              block_hash = hash;
              daaScoreF = response?.data?.header?.daaScore;
              break;
            } else if (
              response?.status === 200 &&
              response?.data &&
              !response.data.extra.minerInfo.includes(targetPattern)
            ) {
              continue;
            } else {
              this.monitoring.error(
                `Pool: Non 200 status code for mined block hash - Fetching block hash for reward block ${reward_block_hash}`
              );
            }
          } catch (error) {
            this.handleError(
              error,
              `CATCH Fetching block hash for reward block ${reward_block_hash}`
            );
          }
        }
      }
    } catch (error) {
      this.handleError(
        error,
        `PARENT CATCH Fetching block hash for reward block ${reward_block_hash}`
      );
    }

    return { block_hash, daaScoreF };
  }

  async fetchRewardBlockHash(txnId: string) {
    let reward_block_hash = '';
    try {
      const response = await axios.get(
        `${KASPA_BASE_URL}/transactions/${txnId}?inputs=false&outputs=false&resolve_previous_outpoints=no`,
        {}
      );
      if (response?.status !== 200 && !response?.data) {
        this.monitoring.error(`Pool: Unexpected status code: ${response.status}`);
        this.monitoring.error(
          `Pool: Invalid or missing block hash in response data for transaction ${txnId}`
        );
      } else {
        reward_block_hash = response.data.block_hash[0]; // Reward block hash
      }
    } catch (error) {
      this.handleError(error, `Fetching reward block hash for transaction ${txnId}`);
      return reward_block_hash;
    }
    return reward_block_hash;
  }
}
