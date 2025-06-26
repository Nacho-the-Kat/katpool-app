import type { IBlock, RpcClient, IRawHeader } from '../../../wasm/kaspa';
import { Header, PoW } from '../../../wasm/kaspa';
import Jobs from './jobs';
import Monitoring from '../../monitoring';
import { DEBUG } from '../../../index';
import Database from '../../pool/database';
import redis, { type RedisClientType } from 'redis';
import config from '../../../config/config.json';

export default class Templates {
  private rpc: RpcClient;
  private address: string;
  private templates: Map<string, [IBlock, PoW]> = new Map();
  private jobs: Jobs = new Jobs();
  private cacheSize: number;
  private monitoring: Monitoring;
  private subscriber: RedisClientType;
  public port: number;

  constructor(rpc: RpcClient, address: string, cacheSize: number, port: number) {
    this.monitoring = new Monitoring();
    this.rpc = rpc;
    this.address = address;
    this.cacheSize = cacheSize;
    this.port = port;
    this.subscriber = redis.createClient({
      url: 'redis://' + config.redis_address,
    });
    this.connectRedis();
  }

  connectRedis() {
    try {
      this.subscriber.connect();
      this.monitoring.log(`Templates ${this.port}: Connection to redis established`);
    } catch (err) {
      this.monitoring.error(`Templates ${this.port}: Error connecting to redis : ${err}`);
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

    const report = await this.rpc.submitBlock({
      block: template,
      allowNonDAABlocks: false,
    });

    if (report.report.type === 'success') {
      const database = new Database(process.env.DATABASE_URL || '');
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
          `Templates ${this.port}: the block with daaScore: ${template.header.daaScore} and nonce: ${nonce} by miner ${minerId} has been accepted with hash : ${newHash}`
        );
    } else {
      // Failed
      if (DEBUG)
        this.monitoring.debug(
          `Templates ${this.port}: the block by ${minerId} has been rejected, reason: ${report.report.reason}`
        );
    }

    // this.templates.delete(hash)
    return report.report.type;
  }

  async register(
    callback: (id: string, hash: string, timestamp: bigint, header: IRawHeader) => void
  ) {
    this.monitoring.log(`Templates ${this.port}: Registering new template callback`);
    // --- Begin: Default template fetching logic ---
    this.rpc.addEventListener('new-block-template', async () => {
      const template = (await this.rpc.getBlockTemplate({
        payAddress: this.address,
        extraData: `${config.miner_info}`
      })).block as any; // TODO: Replace 'any' with the correct type (IRawBlock) when available
      const header = new Header(template.header);
      const headerHash = header.finalize();

      if (this.templates.has(headerHash)) return;

      const proofOfWork = new PoW(header);
      this.templates.set(headerHash, [template as IBlock, proofOfWork]);
      const id = this.jobs.deriveId(headerHash);
      Jobs.setJobIdDaaScoreMapping(id, template.header.daaScore);

      //if (DEBUG) this.monitoring.debug(`Templates ${this.port}: templates.size: ${this.templates.size}, cacheSize: ${this.cacheSize}`)

      if (this.templates.size > this.cacheSize) {
        this.templates.delete(this.templates.entries().next().value![0]);
        this.jobs.expireNext();
      }

      callback(id, proofOfWork.prePoWHash, header.timestamp, template.header);
    });
    // --- End: Default template fetching logic ---

    /*
    // --- Begin: Redis-based template subscription (disabled) ---
    const templateChannel = config.redis_channel;
    this.subscriber.subscribe(templateChannel, message => {
      // ... Redis template logic ...
    });
    // --- End: Redis-based template subscription (disabled) ---
    */

    await this.rpc.subscribeNewBlockTemplate();
  }
}
