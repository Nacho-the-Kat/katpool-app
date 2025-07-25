import { EventEmitter } from 'events';
import Monitoring from '../monitoring';
import { UtxoProcessor, UtxoContext, type RpcClient } from '../../wasm/kaspa';
import Database from '../pool/database';
import { pool } from '../..';
import { databaseUrl, DEBUG } from '../constants';

const startTime = BigInt(Date.now());

UtxoProcessor.setCoinbaseTransactionMaturityDAA('mainnet', 1000n);
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-10', 1000n);

const db = new Database(databaseUrl || '');

export default class Treasury extends EventEmitter {
  address: string;
  processor: UtxoProcessor;
  context: UtxoContext;
  fee: number;
  rpc: RpcClient;
  private monitoring: Monitoring;
  private blockQueue: Map<string, any> = new Map();
  private lastBlockTimestamp: number = Date.now();
  private queueStarted = false;
  private watchdogStarted = false;
  reconnecting = false;

  constructor(rpc: RpcClient, networkId: string, address: string, fee: number) {
    super();

    this.rpc = rpc;
    this.address = address;
    this.processor = new UtxoProcessor({ rpc: this.rpc, networkId });
    this.context = new UtxoContext({ processor: this.processor });
    this.fee = fee;
    this.monitoring = new Monitoring();
    this.monitoring.log(`Treasury: Pool Wallet Address: " ${this.address}`);

    this.registerProcessor();
    try {
      this.rpc.subscribeBlockAdded();
    } catch (error) {
      this.monitoring.error(`Treasury: SUBSCRIBE ERROR: `, error);
    }
    try {
      this.listenToBlocks();
      this.startWatchdog();
    } catch (error) {
      this.monitoring.error(`Treasury: LISTEN ERROR: `, error);
    }
  }

  async listenToBlocks() {
    this.rpc.addEventListener('block-added', this.blockAddedHandler);

    if (!this.queueStarted) {
      this.queueStarted = true;
      this.startQueueProcessor();
    }
  }

  blockAddedHandler = async (eventData: any) => {
    try {
      const data = eventData.data;
      const reward_block_hash = data?.block?.header?.hash;
      if (!reward_block_hash) {
        this.monitoring.debug('Treasury: Block hash is undefined');
        return;
      }

      if (this.blockQueue.size > 1000) {
        this.monitoring.error('Treasury: Block queue overflow. Dropping oldest entries.');
        const keys = Array.from(this.blockQueue.keys()).slice(0, 100);
        for (const key of keys) {
          this.blockQueue.delete(key);
        }
      }

      this.lastBlockTimestamp = Date.now();
      if (!this.blockQueue.has(reward_block_hash)) {
        this.blockQueue.set(reward_block_hash, data);
      } else {
        this.monitoring.debug(`Treasury: Duplicate block ${reward_block_hash} ignored`);
      }
    } catch (error) {
      this.monitoring.error(`Treasury: Error in block-added handler: `, error);
    }
  };

  private startWatchdog() {
    if (this.watchdogStarted) return;
    this.watchdogStarted = true;

    setInterval(() => {
      const secondsSinceLastBlock = (Date.now() - this.lastBlockTimestamp) / 1000;
      if (secondsSinceLastBlock > 120) {
        this.monitoring.debug(
          'Treasury: Watchdog - No block received in 2 minutes. Reconnecting RPC...'
        );
        this.reconnectBlockListener();
      }
    }, 30000); // check every 30 seconds
  }

  private startQueueProcessor() {
    const MAX_PARALLEL_JOBS = 10;
    let activeJobs = 0;

    const processQueue = async () => {
      while (true) {
        while (activeJobs < MAX_PARALLEL_JOBS && this.blockQueue.size > 0) {
          const nextEntry = this.blockQueue.entries().next().value;
          if (!nextEntry) continue;

          const [hash, data] = nextEntry;
          this.blockQueue.delete(hash);
          activeJobs++;

          (async () => {
            try {
              await this.processBlockData(data);
            } catch (error) {
              this.monitoring.error(`Treasury: Error in parallel handler - `, error);
            } finally {
              activeJobs--;
            }
          })();
        }

        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    processQueue();
  }

  async reconnectBlockListener() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.rpc.removeEventListener('block-added', this.blockAddedHandler);
      this.rpc.unsubscribeBlockAdded();
      this.rpc.subscribeBlockAdded();
      await this.listenToBlocks();
      this.startWatchdog();
    } catch (error) {
      this.monitoring.error(`Treasury: Error during reconnectBlockListener: `, error);
      setTimeout(() => this.reconnectBlockListener(), 5000); // Retry after 5 seconds
    } finally {
      this.reconnecting = false;
    }
  }

  private async processBlockData(data: any) {
    const transactions = data?.block?.transactions || [];
    const isChainBlock = data?.block?.verboseData?.isChainBlock;
    if (!Array.isArray(transactions) || transactions.length === 0) return;

    const TARGET_ADDRESS = this.address;

    txLoop: for (const tx of transactions) {
      for (const [index, vout] of (tx.outputs || []).entries()) {
        const addr = vout?.verboseData?.scriptPublicKeyAddress;
        if (addr === TARGET_ADDRESS) {
          try {
            const reward_block_hash = data?.block?.header?.hash;
            const txId = tx.verboseData?.transactionId;
            this.monitoring.debug(`Treasury: Reward hash: ${reward_block_hash} | TX: ${txId}`);
            const reward_block_hashDB = await db.getRewardBlockHash(txId.toString(), true);
            if (!reward_block_hashDB) {
              // No entry exists — insert new
              await db.addRewardDetails(reward_block_hash, txId);
            } else if (reward_block_hashDB !== reward_block_hash && isChainBlock) {
              // Entry exists with different block hash and is chain block — update
              await db.addRewardDetails(reward_block_hash, txId);
            }
            break txLoop;
          } catch (error) {
            this.monitoring.error(`Treasury: Adding reward details - `, error);
            break txLoop;
          }
        }
      }
    }
  }

  utxoProcStartHandler = async () => {
    await this.context.clear();
    await this.context.trackAddresses([this.address]);
  };

  maturityHandler = async (e: any) => {
    // this.monitoring.log(`Treasury: Maturity event data : ${JsonBig.stringify(e)}`)
    if (e?.data?.type === 'incoming') {
      // @ts-ignore
      if (!e?.data?.data?.utxoEntries?.some(element => element?.isCoinbase)) {
        this.monitoring.log(`Treasury: Not coinbase event. Skipping`);
        return;
      }
      const { timestamps } = await this.rpc.getDaaScoreTimestampEstimate({
        daaScores: [e.data.blockDaaScore],
      });
      if (timestamps[0] < startTime) {
        this.monitoring.log(`Treasury: Earlier event detected. Skipping`);
        return;
      }

      // @ts-ignore
      const reward = e.data.value;
      const txnId = e.data.id;
      const daaScore = e.data.blockDaaScore;
      this.monitoring.log(
        `Treasury: Maturity event received. Reward: ${reward}, Event timestamp: ${Date.now()}, TxnId: ${txnId}`
      );
      const poolFee = (reward * BigInt(this.fee * 100)) / 10000n;
      this.monitoring.log(`Treasury: Pool fees to retain on the coinbase cycle: ${poolFee}.`);
      let reward_block_hash = await pool.fetchRewardBlockHash(txnId.toString());
      if (!reward_block_hash)
        reward_block_hash = (await db.getRewardBlockHash(txnId.toString())) || '';
      if (reward_block_hash) {
        this.emit('coinbase', reward - poolFee, poolFee, reward_block_hash, txnId, daaScore);
      } else {
        this.emit('coinbase', reward - poolFee, poolFee, '', txnId, daaScore);
      }
    }
  };

  private registerProcessor() {
    this.processor.addEventListener('utxo-proc-start', this.utxoProcStartHandler);

    this.processor.addEventListener('maturity', this.maturityHandler);

    this.processor.start();
  }

  async unregisterProcessor() {
    if (DEBUG) this.monitoring.debug(`TrxManager: unregisterProcessor - this.context.clear()`);
    await this.context.clear();

    if (DEBUG) this.monitoring.debug(`TrxManager: Removing event listeners`);
    this.processor.removeEventListener('utxo-proc-start', this.utxoProcStartHandler);
    this.context.unregisterAddresses([this.address]);
    this.processor.removeEventListener('maturity', this.maturityHandler);

    await this.processor.stop();
  }
}
