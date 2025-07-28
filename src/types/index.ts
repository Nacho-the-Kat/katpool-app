import type { Socket } from 'bun';
import type Denque from 'denque';
import type { Request, Response } from '../stratum/server/protocol';

export type MinerBalanceRow = {
  miner_id: string;
  wallet: string;
  balance: string;
};

export type MinerData = {
  sockets: Set<Socket<Miner>>;
  workerStats: Map<string, WorkerStats>;
};

export type Contribution = {
  address: string;
  difficulty: number;
  timestamp: number;
  minerId: string;
  jobId: string;
  daaScore: bigint;
};

export interface WorkerStats {
  blocksFound: number;
  sharesFound: number;
  sharesDiff: number;
  staleShares: number;
  invalidShares: number;
  workerName: string;
  startTime: number;
  lastShare: number;
  varDiffStartTime: number;
  varDiffSharesFound: number;
  varDiffWindow: number;
  minDiff: number;
  recentShares: Denque<{ timestamp: number; difficulty: number; nonce: bigint }>;
  hashrate: number;
  asicType: string;
  varDiffEnabled: boolean;
}

export type Worker = {
  address: string;
  name: string;
};

export type Miner = {
  closeReason?: string;
  difficulty: number;
  extraNonce: string;
  workers: Map<string, Worker>;
  encoding: Encoding;
  asicType: string;
  cachedBytes: string;
  connectedAt: number;
  port: number;
};

export enum Encoding {
  BigHeader,
  Bitmain,
}

export type MessageCallback = (socket: Socket<Miner>, request: Request) => Promise<Response>;
