import { RpcClient, Encoding, Resolver, ConnectStrategy } from './wasm/kaspa';
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
import { WINDOW_SIZE } from './src/stratum/sharesManager';

export const poolStartTime = Date.now();
const monitoring = new Monitoring();
monitoring.log(`Main: Pool started at ${new Date(poolStartTime).toISOString()}`);

async function shutdown() {
  monitoring.log('\n\nMain: Gracefully shutting down the pool...');
  try {
    await rpc.unsubscribeBlockAdded();
    await rpc.unsubscribeNewBlockTemplate();
    await treasury.unregisterProcessor();
  } catch (error) {
    monitoring.error(`Main: Removing and unsubscribing events: ${error}`);
  }
  monitoring.log('Graceful shutdown completed.');
  process.exit();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('exit', code => {
  monitoring.log(`Main: 🛑 Process is exiting with code: ${code}`);
});

process.on('uncaughtException', err => {
  monitoring.error(`Main: Uncaught Exception: ${err}`);
});

process.on('unhandledRejection', (reason, promise) => {
  monitoring.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

export let DEBUG = 0;
if (process.env.DEBUG == '1') {
  DEBUG = 1;
}

const RPC_RETRY_INTERVAL = 5 * 100; // 500 MILI SECONDS
const RPC_TIMEOUT = 24 * 60 * 60 * 1000; // 24 HOURS

// Send config.json to API server
async function sendConfig() {
  if (DEBUG) monitoring.debug(`Main: Trying to send config to katpool-monitor`);
  try {
    const configPath = path.resolve('./config/config.json');
    const configData = fs.readFileSync(configPath, 'utf-8');

    const katpoolMonitor = process.env.MONITOR;
    if (!katpoolMonitor) {
      throw new Error('Environment variable MONITOR is not set.');
    }

    const response = await axios.post(`${katpoolMonitor}/postconfig`, {
      config: JSON.parse(configData),
    });

    monitoring.log(`Main: Config sent to API server. Response status: ${response.status}`);
  } catch (error) {
    monitoring.error(`Main: Error sending config: ${error}`);
  }
}

monitoring.log(`Main: Starting katpool App`);

dotenv.config();

monitoring.log(`Main: network: ${config.network}`);

const rpc = new RpcClient({
  resolver: new Resolver(),
  encoding: Encoding.Borsh,
  networkId: config.network,
});

try {
  rpc.addEventListener('connect', async () => {
    monitoring.debug('Main: RPC is reconnected');
    if (treasury && !treasury.reconnecting) {
      await treasury.reconnectBlockListener();
    }
  });
} catch (error) {
  monitoring.error(`Main: Error during RPC connect: ${error}`);
}

rpc.addEventListener('disconnect', async event => {
  monitoring.debug('Main: RPC is disconnected');
});

try {
  await rpc.connect({
    retryInterval: RPC_RETRY_INTERVAL, // timeinterval for reconnection
    timeoutDuration: RPC_TIMEOUT, // rpc timeout duration
    strategy: ConnectStrategy.Retry, // retry strategy for disconnection
  });
} catch (err) {
  monitoring.error(`Main: Error while connecting to rpc url : ${rpc.url} Error: ${err}`);
}

monitoring.log(`Main: RPC connection started`);

const serverInfo = await rpc.getServerInfo();
if (!serverInfo.isSynced || !serverInfo.hasUtxoIndex)
  throw Error('Provided node is either not synchronized or lacks the UTXO index.');

const treasuryPrivateKey = process.env.TREASURY_PRIVATE_KEY;
if (!treasuryPrivateKey) {
  throw new Error('Environment variable TREASURY_PRIVATE_KEY is not set.');
}

export const metrics = new PushMetrics();

sendConfig();

startMetricsServer();

const treasury = new Treasury(rpc, serverInfo.networkId, treasuryPrivateKey, config.treasury.fee);
// Array to hold multiple pools
export const stratums: Stratum[] = [];

for (const stratumConfig of config.stratum) {
  // Create Templates instance
  const templates = new Templates(
    rpc,
    treasury.address,
    stratumConfig.templates.cacheSize,
    stratumConfig.port
  );

  // Create Stratum instance
  const stratum = new Stratum(
    templates,
    stratumConfig.difficulty,
    treasury.address,
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

export const pool = new Pool(treasury, stratums);

// Function to calculate and update pool hash rate
export function calculatePoolHashrate() {
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
  metrics.updateGaugeValue(
    poolHashRateGauge,
    ['pool', stratums[0].sharesManager.poolAddress],
    poolHashRate
  );
  monitoring.log(`Main: Total pool hash rate updated to ${rateStr}`);
}

// Set interval for subsequent updates
setInterval(calculatePoolHashrate, WINDOW_SIZE);

// Now you have an array of `pools` for each stratum configuration
monitoring.log(`Main: ✅ Created ${stratums.length} stratums.`);

const allowedRunMinutes = new Set([2, 4, 6, 8]); // only these times allowed

const interval = setInterval(() => {
  const now = Date.now();
  const minutesSinceStart = Math.floor((now - poolStartTime) / (60 * 1000));

  if (allowedRunMinutes.has(minutesSinceStart)) {
    monitoring.debug(
      `Main: Estimating initial hashrates. After ${minutesSinceStart} minutes since pool start.`
    );
    calculatePoolHashrate();
    allowedRunMinutes.delete(minutesSinceStart); // ensure it runs only once per target minute
  }

  // Stop interval after 8 mins passed
  if (minutesSinceStart > 8 || allowedRunMinutes.size === 0) {
    monitoring.debug(`Main: Stopping interval after ${minutesSinceStart} minutes.`);
    clearInterval(interval);
  }
}, 60 * 1000); // check every minute
