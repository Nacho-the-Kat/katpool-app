export interface RequestMappings {
  'mining.subscribe': [string, string]; // miner identifier & protocol
  'mining.authorize': [string, string]; // address.name & passwd
  'mining.submit': [string, string, string]; // address.name of worker & jobid & nonce
}

export interface RequestMessage<M extends keyof ResponseMappings = keyof ResponseMappings> {
  id: number;
  method: M;
  params: RequestMappings[M];
}

export type Request<M extends keyof ResponseMappings = keyof ResponseMappings> = {
  [K in M]: RequestMessage<K>;
}[M];

export enum ErrorCodes {
  'unknown' = 20,
  'job-not-found' = 21,
  'duplicate-share' = 22,
  'low-difficulty-share' = 23,
  'unauthorized-worker' = 24,
  'not-subscribed' = 25,
}

export class StratumError extends Error {
  code: number;

  constructor(code: keyof typeof ErrorCodes) {
    super(code);
    this.code = ErrorCodes[code];

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StratumError);
    }
  }

  toDump(): [number, string, string | null] {
    // TODO: error type
    return [this.code, this.message, this.stack ?? null];
  }
}

export interface ResponseMappings {
  'mining.subscribe': [boolean | null, string, number?]; // !bitmain - EthereumStratum/1.0.0
  'mining.authorize': boolean; // TRUE
  'mining.submit': boolean; // TRUE
}

type Error = [
  number, // Error code
  string, // Human-readable explanation
  string | null, // Stack trace
];

export interface Response<M extends keyof RequestMappings = keyof RequestMappings> {
  id: number;
  result: ResponseMappings[M] | null;
  error: null | Error;
}

export interface EventMappings {
  'mining.set_extranonce': any[];
  'mining.set_difficulty': [number]; // difficulty
  'mining.notify': [string, string | bigint[], bigint?]; // jobid, bigpow && possibly timestamp on 4 u64 protocol
}

export interface Event<M extends keyof EventMappings = keyof EventMappings> {
  method: M;
  params: EventMappings[M];
}

export function validateRequest(request: any): request is Request {
  return (
    typeof request === 'object' &&
    typeof request.id === 'number' &&
    typeof request.method === 'string' &&
    Array.isArray(request.params)
  );
}

export function parseMessage(message: string, port: number) {
  try {
    const parsedMessage = JSON.parse(message);

    if (!validateRequest(parsedMessage)) {
      return undefined;
    }

    return parsedMessage;
  } catch (error) {
    return undefined;
  }
}
