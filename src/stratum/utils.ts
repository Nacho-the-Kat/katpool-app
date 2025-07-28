import { WINDOW_SIZE } from '../constants';
import type { Socket } from 'bun';
import Monitoring from '../monitoring';
import logger from '../monitoring/datadog';
import type { WorkerStats, Miner } from '../types';
import config from '../../config/config.json';

const MIN_DIFF = config.stratum[0].minDiff || 64;
const MAX_DIFF = config.stratum[0].maxDiff || 131072;
const DEFAULT_DIFF = config.stratum[0].difficulty || 2048;

const bigGig = Math.pow(10, 9);
const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
const minHash = (BigInt(1) << BigInt(256)) / maxTarget;
const monitoring = new Monitoring();

export function stringifyHashrate(ghs: number): string {
  const unitStrings = ['M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
  let unit = unitStrings[0];
  let hr = ghs * 1000; // Default to MH/s

  for (const u of unitStrings) {
    if (hr < 1000) {
      unit = u;
      break;
    }
    hr /= 1000;
  }

  return `${hr.toFixed(2)}${unit}H/s`;
}

export function getAverageHashrateGHs(
  stats: WorkerStats,
  address: string,
  windowSize = WINDOW_SIZE
): number {
  // if (!stats.recentShares || stats.recentShares.isEmpty()) return 0;
  const relevantShares: { timestamp: number; difficulty: number }[] = [];

  // Use Denque's toArray() method to filter relevant shares
  stats.recentShares.toArray().forEach(share => {
    if (Date.now() - share.timestamp <= windowSize) {
      relevantShares.push(share);
    }
  });

  if (relevantShares.length === 0) {
    logger.warn(
      `Utils ${address}.${stats.workerName}: No relevant shares in the last ${windowSize / 1000} seconds`
    );
    return 0;
  }

  const avgDifficulty =
    relevantShares.reduce((acc, share) => acc + diffToHash(share.difficulty), 0) /
    relevantShares.length;
  const timeDifference = (Date.now() - relevantShares[0].timestamp) / 1000; // in seconds

  return (avgDifficulty * relevantShares.length) / timeDifference;
}

// Function to convert difficulty to hash
export function diffToHash(diff: number): number {
  const hashVal = Number(minHash) * diff;
  const result = hashVal / bigGig;

  return result;
}

export function getSocketLogData(socket: Socket<Miner>, additionalData?: Record<string, any>) {
  return {
    port: socket.data.port,
    difficulty: socket.data.difficulty,
    remoteAddress: socket?.remoteAddress || 'unknown',
    workers: socket?.data?.workers ? Array.from(socket.data.workers.keys()) : [],
    connectedAt: socket.data.connectedAt,
    duration: Date.now() - socket.data.connectedAt,
    ...additionalData,
  };
}

// Debug function to log hashrate calculation details
export function debugHashrateCalculation(
  stats: WorkerStats,
  address: string,
  workerRate: number,
  windowSize = WINDOW_SIZE
): void {
  if (!stats.recentShares || stats.recentShares.isEmpty()) {
    monitoring.debug(`[DEBUG] No recent shares for worker ${stats.workerName}`);
    return;
  }

  const relevantShares: { timestamp: number; difficulty: number }[] = [];
  stats.recentShares.toArray().forEach(share => {
    if (Date.now() - share.timestamp <= windowSize) {
      relevantShares.push(share);
    }
  });

  if (relevantShares.length === 0) {
    monitoring.debug(`[DEBUG] No relevant shares in window for worker ${stats.workerName}`);
    return;
  }

  // Improved method calculation
  relevantShares.sort((a, b) => a.timestamp - b.timestamp);

  const timeSpan =
    relevantShares.length > 1
      ? (relevantShares[relevantShares.length - 1].timestamp - relevantShares[0].timestamp) / 1000
      : 1;

  const totalWork = relevantShares.reduce((acc, share) => acc + diffToHash(share.difficulty), 0);
  const improvedHashrate = totalWork / Math.max(timeSpan, 1);

  monitoring.debug(
    `[DEBUG] Hashrate calculation for address ${address} and worker ${stats.workerName}:`
  );
  monitoring.debug(`  - Shares in window: ${relevantShares.length}`);
  monitoring.debug(`  - Time span: ${timeSpan.toFixed(2)}s`);
  monitoring.debug(`  - Total work: ${totalWork.toFixed(2)}`);
  monitoring.debug(`  - Improved hashrate: ${improvedHashrate.toFixed(2)} GH/s`);
  monitoring.debug(`  - Current hashrate: ${workerRate} GH/s`);
  monitoring.debug(`  - Last share: ${new Date(stats.lastShare).toISOString()}`);
}

// Function to check if a number is power of 2
function isPowerOf2(num: number): boolean {
  return (num & (num - 1)) === 0 && num > 0;
}

// Function to round to the nearest power of 2
function roundToNearestPowerOf2(num: number): number {
  if (num < MIN_DIFF || num > MAX_DIFF) return DEFAULT_DIFF;

  let pow = 1;
  while (pow < num) {
    pow *= 2;
  }

  const lower = pow / 2;
  const upper = pow;

  // Choose the nearest power of 2
  return num - lower < upper - num ? lower : upper;
}

// Function to extract and validate difficulty
function parseDifficulty(input: string): number | null {
  const validPattern = /^(d=|diff=)?\d+$/i;

  if (!validPattern.test(input)) {
    return null;
  }

  const match = input.match(/(\d+)/);
  if (match) {
    const diff = Number(match[0]);
    if (!isNaN(diff)) {
      return diff;
    }
  }
  return null;
}

// Function to apply clamping logic
export function getDifficulty(input: string): number {
  const diff = parseDifficulty(input);

  if (diff === null || diff < MIN_DIFF || diff > MAX_DIFF) {
    monitoring.debug(`Stratum: Invalid difficulty input: ${input}. Using default: ${DEFAULT_DIFF}`);
    return -1;
  }

  // Clamp to range
  const clampedDiff = Math.min(Math.max(diff, MIN_DIFF), MAX_DIFF);

  // Ensure power-of-2 clamping
  const finalDiff = isPowerOf2(clampedDiff) ? clampedDiff : roundToNearestPowerOf2(clampedDiff);

  monitoring.log(`Stratum: User requested: ${diff}, applied: ${finalDiff}`);
  return finalDiff;
}
