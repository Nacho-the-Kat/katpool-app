// Network and RPC Configuration
export const RPC_RETRY_INTERVAL = 5000; // milliseconds
export const RPC_TIMEOUT = 30000; // milliseconds

// Pool Configuration
export const poolStartTime = Date.now();
export const WINDOW_SIZE = 10 * 60 * 1000; // 10 minutes window

// Ports
export const OAUTH_SERVER_PORT = 1818;
export const PROMETHEUS_METRICS_SERVER = 9999;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set.`);
  }
  return value;
}

// Monitoring and API
export const katpoolMonitor = getRequiredEnv('MONITOR');

// Treasury Configuration
export const treasuryPrivateKey = getRequiredEnv('TREASURY_PRIVATE_KEY');

// Database Configuration
export const databaseUrl = getRequiredEnv('DATABASE_URL');

// Datadog Configuration
export const DATADOG_SECRET = getRequiredEnv('DATADOG_SECRET');
export const DATADOG_LOG_URL = getRequiredEnv('DATADOG_LOG_URL');
export const DATADOG_SERVICE_NAME = process.env.DATADOG_SERVICE_NAME || 'dev-katpool-app';

// Uphold configuration environment variables
getRequiredEnv('UPHOLD_CLIENT_ID');
getRequiredEnv('UPHOLD_CLIENT_SECRET');
export const TOKEN_ENCRYPTION_KEY = getRequiredEnv('TOKEN_ENCRYPTION_KEY');
export const state = getRequiredEnv('OAUTH_STATE');
export const JWT_SECRET = getRequiredEnv('JWT_SECRET');

// Debug Configuration
export const DEBUG = process.env.DEBUG === '1' ? 1 : 0;

export const NETWORK_CONFIG = {
  mainnet: {
    rpcUrl: 'kaspad:17110',
    apiBaseUrl: 'https://api.kaspa.org',
  },
  'testnet-10': {
    rpcUrl: 'kaspad-test10:17210',
    apiBaseUrl: 'https://api-tn10.kaspa.org',
  },
} as const;

export type NetworkName = keyof typeof NETWORK_CONFIG;

export function getNetworkConfig(network: string) {
  const net = NETWORK_CONFIG[network as NetworkName];
  if (!net) throw new Error(`Unsupported network: ${network}`);
  return net;
}

// Regex for ASIC type
export const minerRegexes = {
  bitMain: /.*(GodMiner).*/i,
} as const;
