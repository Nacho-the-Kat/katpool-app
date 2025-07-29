import type { IBlock, RpcClient, IRawHeader, ISubmitBlockResponse } from '../../../wasm/kaspa';
import { Header, PoW } from '../../../wasm/kaspa';
import Jobs from './jobs';
import Monitoring from '../../monitoring';
import Database from '../../pool/database';
import redis, { type RedisClientType } from 'redis';
import config from '../../../config/config.json';
import logger from '../../monitoring/datadog';
import { databaseUrl, DEBUG } from '../../constants';

export default class Templates {
  private rpc: RpcClient;
  private address: string;
  private templates: Map<string, [IBlock, PoW]> = new Map();
  private jobs: Jobs = new Jobs();
  private cacheSize: number;
  private monitoring: Monitoring;
  private subscriber: RedisClientType;
  private callbacks: Set<
    (id: string, hash: string, timestamp: bigint, header: IRawHeader) => void
  > = new Set();
  private isSubscribed: boolean = false;

  constructor(rpc: RpcClient, address: string, cacheSize: number) {
    this.monitoring = new Monitoring();
    this.rpc = rpc;
    this.address = address;
    this.cacheSize = cacheSize;
    this.subscriber = redis.createClient({
      url: 'redis://' + config.redis_address,
    });
    this.connectRedis();
  }

  connectRedis() {
    const reconnect = async (delay = 1000) => {
      this.monitoring.error(`Templates: Reconnecting to Redis in ${delay}ms...`);

      // Ensure existing connection is closed
      if (this.subscriber) {
        try {
          await this.subscriber.quit();
          this.monitoring.error('Templates: Closed existing Redis connection before reconnecting');
        } catch (error) {
          this.monitoring.error(`Templates: Error closing Redis connection: `, error);
        }
      }

      // Create new client
      this.subscriber = redis.createClient({
        url: 'redis://' + config.redis_address,
      });

      setTimeout(() => this.connectRedis(), delay);
    };

    try {
      this.subscriber.connect();
      this.subscriber.on('ready', () => {
        this.monitoring.log(`Templates: Connection to redis established`);
      });
      this.subscriber.on('error', error => {
        this.monitoring.error(`Templates: Redis client error: `, error);
        reconnect();
      });
    } catch (error) {
      this.monitoring.error(`Templates: Error connecting to redis : `, error);
      reconnect();
    }
  }

  getHash(id: string) {
    return this.jobs.getHash(id);
  }

  getPoW(hash: string) {
    return this.templates.get(hash)?.[1];
  }

  async submit(minerId: string, miner_address: string, hash: string, nonce: bigint) {
    const template = this.templates.get(hash)![0];
    const header = new Header(template.header);

    header.nonce = nonce;
    const newHash = header.finalize();

    template.header.nonce = nonce;
    template.header.hash = newHash;

    let report: ISubmitBlockResponse;
    const traceId = Math.random().toString(36).substring(2, 15);
    try {
      await logger.info('before rpc.submitBlock', { traceId });
      report = await this.rpc.submitBlock({
        block: template,
        allowNonDAABlocks: false,
      });
    } catch (error) {
      const stack = error instanceof Error ? error.stack : undefined;
      await logger.error('after rpc.submitBlock', {
        traceId,
        error,
        stack,
      });
      this.monitoring.debug(
        `Templates: ERROR - Block submit : ${error} - ${stack ? ' - ' + stack : ''}`
      );
      return;
    }

    if (report.report.type === 'success') {
      const database = new Database(databaseUrl || '');
      // The reward_block_hash and miner_reward will be updated on maturity coinbase event in pool.allocate().
      await database.addBlockDetails(
        newHash,
        minerId,
        '',
        miner_address,
        template.header.daaScore.toString(),
        this.address,
        0n
      );

      if (DEBUG)
        this.monitoring.debug(
          `Templates: the block with daaScore: ${template.header.daaScore} and nonce: ${nonce} by miner ${minerId} has been accepted with hash : ${newHash}`
        );
    } else {
      if (DEBUG)
        this.monitoring.debug(
          `Templates: the block by ${minerId} has been rejected, reason: ${report.report.reason}`
        );
    }

    // this.templates.delete(hash)
    return report.report.type;
  }

  async register(
    callback: (id: string, hash: string, timestamp: bigint, header: IRawHeader) => void
  ) {
    this.monitoring.log(`Templates: Registering new template callback`);
    // this.rpc.addEventListener('new-block-template', async () => {
    // const template = (await this.rpc.getBlockTemplate({
    //   payAddress: this.address,
    //   extraData: `${config.miner_info}`
    // })).block as IRawBlock;

    // if no block template is received within a timeout, trigger error log
    this.callbacks.add(callback);
    this.monitoring.log(`Templates: Total callbacks registered: ${this.callbacks.size}`);

    // Only set up Redis subscription on first callback
    if (!this.isSubscribed) {
      this.monitoring.log(`Templates: Setting up Redis subscription`);
      await this.setupRedisSubscription();
      this.isSubscribed = true;
    }
  }

  private async setupRedisSubscription() {
    const templateChannel = config.redis_channel;
    let templateReceivedTimeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = 10000; // 10 seconds

    const resetTemplateTimeout = () => {
      if (templateReceivedTimeout) clearTimeout(templateReceivedTimeout);
      templateReceivedTimeout = setTimeout(() => {
        // TODO: change log to fallback logic
        this.monitoring.error(
          `Templates: No block template received after ${timeoutMs / 1000} seconds`
        );
      }, timeoutMs);
    };

    resetTemplateTimeout();
    this.subscriber.subscribe(templateChannel, message => {
      resetTemplateTimeout();
      try {
        const fetchedTemplate = JSON.parse(message);
        const blockTemplate = {
          header: fetchedTemplate.Block.Header,
          transactions: fetchedTemplate.Block.Transactions,
        };
        function convertJson(data: any) {
          // Recursively traverse and transform keys
          function transformKeys(obj: any): any {
            if (Array.isArray(obj)) {
              return obj.map((item: any) => transformKeys(item)); // Process arrays
            } else if (obj !== null && typeof obj === 'object') {
              let newObj: any = {};
              for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                  const newKey = key.toLowerCase(); // Convert key to lowercase
                  newObj[newKey] = transformKeys(obj[key]); // Recursively call for nested objects
                }
              }
              return newObj;
            }
            return obj; // Return the value if it's neither an array nor an object
          }

          // First, transform all keys to lowercase
          const transformedKeysData = transformKeys(data);
          const parents = transformedKeysData.header.parents;
          delete transformedKeysData.header.parents;

          let parentsByLevel: any[] = [];
          parents.map((item: any, i: number) => {
            parentsByLevel[i] = item.parenthashes;
          });

          transformedKeysData.header['parentsByLevel'] = parentsByLevel;

          return transformedKeysData;
        }
        const converted = convertJson(blockTemplate);
        const tHeader: IRawHeader = {
          version: converted.header.version,
          parentsByLevel: converted.header.parentsByLevel,
          hashMerkleRoot: converted.header.hashmerkleroot,
          acceptedIdMerkleRoot: converted.header.acceptedidmerkleroot,
          utxoCommitment: converted.header.utxocommitment,
          timestamp: BigInt(converted.header.timestamp),
          bits: converted.header.bits,
          nonce: BigInt(converted.header.nonce),
          daaScore: BigInt(converted.header.daascore),
          blueWork: converted.header.bluework,
          blueScore: BigInt(converted.header.bluescore),
          pruningPoint: converted.header.pruningpoint,
        };
        const tTransactions = converted.transactions.map((tx: any) => ({
          version: tx.version,
          inputs:
            tx.inputs.length > 0
              ? tx.inputs.map((inputItem: any) => ({
                  previousOutpoint: {
                    transactionId: inputItem.previousoutpoint.transactionid,
                    index: inputItem.previousoutpoint.index,
                  },
                  signatureScript: inputItem.signaturescript,
                  sequence: BigInt(inputItem.sequence),
                  sigOpCount: inputItem.sigopcount,
                  verboseData: inputItem.verbosedata,
                }))
              : tx.inputs,
          outputs:
            tx.outputs.length > 0
              ? tx.outputs.map((outputItem: any) => ({
                  value: BigInt(outputItem.amount),
                  scriptPublicKey: outputItem.scriptpublickey,
                  verboseData: outputItem.verbosedata,
                }))
              : tx.outputs,
          lockTime: BigInt(tx.locktime),
          subnetworkId: tx.subnetworkid,
          gas: BigInt(tx.gas),
          payload: tx.payload,
          mass: BigInt(tx.mass || 0),
          verboseData: tx.verbosedata,
        }));
        const template = {
          header: tHeader,
          transactions: tTransactions,
        };
        if ((template.header.blueWork as string).length % 2 !== 0) {
          template.header.blueWork = '0' + template.header.blueWork;
        }

        const header = new Header(template.header);
        const headerHash = header.finalize();

        if (this.templates.has(headerHash)) return;

        const proofOfWork = new PoW(header);
        this.templates.set(headerHash, [template as IBlock, proofOfWork]);
        const id = this.jobs.deriveId(headerHash);
        Jobs.setJobIdDaaScoreMapping(id, template.header.daaScore);

        if (this.templates.size > this.cacheSize) {
          // this.monitoring.debug(
          //   `Templates: this.templates.size > this.cacheSize - ${this.templates.size} > ${this.cacheSize}`
          // );
          this.templates.delete(this.templates.entries().next().value![0]);
          this.jobs.expireNext();
        }

        // Notify all registered callbacks
        this.monitoring.log(
          `Templates: Notifying ${this.callbacks.size} callbacks about new template`
        );
        this.callbacks.forEach(callback => {
          try {
            callback(id, proofOfWork.prePoWHash, header.timestamp, template.header);
          } catch (error) {
            this.monitoring.error(`Templates: Error in callback: `, error);
          }
        });
      } catch (error) {
        this.monitoring.error(`Templates: Error processing template: `, error);
      }
    });
    // })

    await this.rpc.subscribeNewBlockTemplate();
  }
}
