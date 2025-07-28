import { RpcClient, Encoding, Resolver, ConnectStrategy, PrivateKey } from './wasm/kaspa';
import Treasury from './src/treasury';
import Templates from './src/stratum/templates';
import Stratum from './src/stratum';
import Pool from './src/pool';
import config from './config/config.json';
import dotenv from 'dotenv';
import Monitoring from './src/monitoring';
import {
  minerHashRateGauge,
  poolHashRateGauge,
  PushMetrics,
  startMetricsServer,
} from './src/prometheus';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { stringifyHashrate } from './src/stratum/utils';
import {
  DEBUG,
  getNetworkConfig,
  katpoolMonitor,
  poolStartTime,
  RPC_RETRY_INTERVAL,
  RPC_TIMEOUT,
  treasuryPrivateKey,
  WINDOW_SIZE,
} from './src/constants';

const monitoring = new Monitoring();
monitoring.log(`Main: Pool started at ${new Date(poolStartTime).toISOString()}`);

let treasury: Treasury;

const { rpcUrl } = getNetworkConfig(config.network);

monitoring.log(`Main: rpc url: ${rpcUrl}`);

// Global reconnection state management
class RpcConnectionManager {
  private isReconnecting: boolean = false;
  private reconnectPromise: Promise<void> | null = null;
  private rpcClient: RpcClient;

  constructor() {
    this.rpcClient = new RpcClient({
      url: rpcUrl, // This is WRPC (borsh) end point
      // resolver: new Resolver(),
      encoding: Encoding.Borsh,
      networkId: config.network,
    });
  }

  setRpcClient(client: RpcClient) {
    this.rpcClient = client;
  }

  getRpcClient(): RpcClient {
    return this.rpcClient;
  }

  isCurrentlyReconnecting(): boolean {
    return this.isReconnecting;
  }

  rpcConnect() {
    if (!this.rpcClient) {
      throw new Error('RPC client not set');
    }

    return this.rpcClient.connect({
      retryInterval: RPC_RETRY_INTERVAL,
      timeoutDuration: RPC_TIMEOUT,
      strategy: ConnectStrategy.Retry,
    });
  }

  async handleReconnection(): Promise<void> {
    // If already reconnecting, wait for the existing reconnection to complete
    if (this.isReconnecting && this.reconnectPromise) {
      monitoring.debug('Main: Reconnection already in progress, waiting for completion...');
      await this.reconnectPromise;
      return;
    }

    // If not reconnecting, start the reconnection process
    if (!this.isReconnecting) {
      this.isReconnecting = true;
      this.reconnectPromise = this.performReconnection();

      try {
        await this.reconnectPromise;
      } finally {
        this.isReconnecting = false;
        this.reconnectPromise = null;
      }
    }
  }

  private async performReconnection(): Promise<void> {
    if (!this.rpcClient) {
      throw new Error('RPC client not set');
    }

    try {
      await this.rpcClient.disconnect();
      monitoring.error(`Main: RPC disconnected due to timeout`);

      await this.rpcConnect();

      monitoring.debug(`Main: RPC reconnected after timeout`);
    } catch (err) {
      monitoring.error(
        `Main: Error while reconnecting to rpc url: ${this.rpcClient.url} Error: ${err}`
      );
      throw err;
    }
  }
}

const rpcConnectionManager = new RpcConnectionManager();

async function shutdown() {
  monitoring.log('\n\nMain: Gracefully shutting down the pool...');
  try {
    if (rpc) {
      await rpc.unsubscribeBlockAdded();
      await rpc.unsubscribeNewBlockTemplate();
    }
    if (treasury) {
      await treasury.unregisterProcessor();
    }
  } catch (error) {
    monitoring.error(`Main: Removing and unsubscribing events: `, error);
  }
  monitoring.log('Graceful shutdown completed.');
  process.exit();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('exit', code => {
  monitoring.log(`Main: 🛑 Process is exiting with code: ${code}`);
});

async function handleError(source: string, error: unknown) {
  await checkRPCTimeoutError(error);
  monitoring.error(`Main: ${source}: ${error}`);
}

process.on('uncaughtException', error => {
  handleError('Uncaught Exception', error);
});

process.on('unhandledRejection', error => {
  handleError('Unhandled Rejection', error);
});

export async function checkRPCTimeoutError(error: unknown) {
  const isTimeoutError = (err: unknown): err is Error => {
    return err instanceof Error && err.message.includes('RPC request timeout');
  };

  if (isTimeoutError(error)) {
    // Use the global reconnection manager
    try {
      await rpcConnectionManager.handleReconnection();
    } catch (err) {
      monitoring.error(`Main: Failed to reconnect after timeout: ${err}`);
    }
    monitoring.debug(`Main: RPC reconnected after timeout`);
  }
}

// Send config.json to API server
export async function sendConfig() {
  if (DEBUG) monitoring.debug(`Main: Trying to send config to katpool-monitor`);
  try {
    const configPath = path.resolve('./config/config.json');
    const configData = fs.readFileSync(configPath, 'utf-8');

    const response = await axios.post(`${katpoolMonitor}/postconfig`, {
      config: JSON.parse(configData),
    });

    monitoring.log(`Main: Config sent to API server. Response status: ${response.status}`);
  } catch (error) {
    monitoring.error(`Main: Error sending config: `, error);
  }
}

monitoring.log(`Main: Starting KatPool App`);

dotenv.config();

monitoring.log(`Main: network: ${config.network}`);

const rpc = rpcConnectionManager.getRpcClient();

try {
  rpc.addEventListener('connect', async () => {
    monitoring.debug('Main: RPC is reconnected');
    if (treasury && !treasury.reconnecting) {
      await treasury.reconnectBlockListener();
    }
  });
} catch (error) {
  monitoring.error(`Main: Error during RPC connect: `, error);
}

rpc.addEventListener('disconnect', async event => {
  monitoring.debug('Main: RPC is disconnected');
});

try {
  await rpcConnectionManager.rpcConnect();
} catch (error) {
  monitoring.error(`Main: Error while connecting to rpc url : ${rpc.url} Error: `, error);
}

monitoring.log(`Main: RPC connection started`);

const serverInfo = await rpc.getServerInfo();
if (!serverInfo.isSynced || !serverInfo.hasUtxoIndex)
  throw Error('Provided node is either not synchronized or lacks the UTXO index.');

export const metrics = new PushMetrics();

startMetricsServer();

// Array to hold multiple stratums
export const stratums: Stratum[] = [];

const privateKey: PrivateKey = new PrivateKey(treasuryPrivateKey);
const address: string = privateKey.toAddress(config.network).toString();

// Create Templates instance
const templates = new Templates(rpc, address, config.templates.cacheSize);

for (const stratumConfig of config.stratum) {
  // Create Stratum instance
  const stratum = new Stratum(
    templates,
    stratumConfig.difficulty,
    stratumConfig.port,
    stratumConfig.sharesPerMinute,
    stratumConfig.clampPow2,
    stratumConfig.varDiff,
    stratumConfig.extraNonceSize,
    stratumConfig.minDiff,
    stratumConfig.maxDiff
  );

  // Store the stratums for later reference
  stratums.push(stratum);
}

treasury = new Treasury(rpc, serverInfo.networkId, address, config.treasury.fee);

export const pool = new Pool(treasury, stratums);

// Export the connection manager for use in Templates
export { rpcConnectionManager };

// Function to calculate and update pool hash rate
function calculatePoolHashrate() {
  const addressHashrates: Map<string, number> = new Map();
  let poolHashRate = 0;

  stratums.forEach(stratum => {
    stratum.sharesManager.getMiners().forEach((minerData, address) => {
      let rate = 0;
      minerData.workerStats.forEach(stats => {
        rate += stats.hashrate;
      });

      // Aggregate rate per wallet address
      const prevRate = addressHashrates.get(address) || 0;
      const newRate = prevRate + rate;
      addressHashrates.set(address, newRate);
    });
  });

  // Update metrics and compute pool total
  addressHashrates.forEach((rate, address) => {
    metrics.updateGaugeValue(minerHashRateGauge, [address], rate);
    poolHashRate += rate;
  });

  const rateStr = stringifyHashrate(poolHashRate);
  metrics.updateGaugeValue(poolHashRateGauge, ['pool', address], poolHashRate);
  monitoring.log(`Main: Total pool hash rate updated to ${rateStr}`);
}

// Set interval for subsequent updates
setInterval(calculatePoolHashrate, WINDOW_SIZE);

// Now you have an array of `pools` for each stratum configuration
monitoring.log(`Main: ✅ Created ${stratums.length} stratums.`);
