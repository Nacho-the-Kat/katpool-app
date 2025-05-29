import axios, { AxiosError } from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import Monitoring from '../monitoring';
import config from '../../config/config.json';
import Database from '../pool/database';

let AUTH_UPHOLD_BASE_URL = 'https://wallet.uphold.com/authorize';
if (config.network === 'testnet-10') {
  AUTH_UPHOLD_BASE_URL = 'https://wallet-sandbox.uphold.com/authorize';
}

export let UPHOLD_BASE_URL = 'https://api.uphold.com';
if (config.network === 'testnet-10') {
  UPHOLD_BASE_URL = 'https://api-sandbox.uphold.com';
}

const JWT_SECRET = process.env.JWT_SECRET!;
const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY!;
const IV_LENGTH = 16;

const monitoring = new Monitoring();
const db = new Database(process.env.DATABASE_URL || '');

const auth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString(
  'base64'
);

export interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

interface UpholdUser {
  id: string;
  name: string;
  email: string;
  country: string;
  status: string;
}

function formatError(error: AxiosError<any>): never {
  const responseStatus = `${error.response?.status} (${error.response?.statusText})`;

  monitoring.error(`Request failed with HTTP status code ${responseStatus} 
  ${JSON.stringify({ url: error.config?.url, response: error.response?.data }, null, 2)}`);
  throw error;
}

export async function getAccessToken(code: string): Promise<AccessTokenResponse> {
  try {
    const response = await axios.request<AccessTokenResponse>({
      method: 'POST',
      url: `${UPHOLD_BASE_URL}/oauth2/token`,
      data: `code=${encodeURIComponent(code)}&grant_type=authorization_code`,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return response.data;
  } catch (error) {
    formatError(error as AxiosError);
  }
}

export async function getUserInfo(accessToken: string): Promise<UpholdUser> {
  try {
    const response = await axios.request<UpholdUser>({
      method: 'GET',
      url: `${UPHOLD_BASE_URL}/v0/me`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return response.data;
  } catch (error) {
    formatError(error as AxiosError);
  }
}

export function encryptToken(token: string): string {
  const ivBuffer = crypto.randomBytes(IV_LENGTH);
  const iv = new Uint8Array(ivBuffer);
  const key = new Uint8Array(Buffer.from(ENCRYPTION_KEY, 'hex'));
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return ivBuffer.toString('hex') + ':' + encrypted;
}

export function decryptToken(encryptedToken: string): string {
  const [ivHex, encrypted] = encryptedToken.split(':');
  const iv = new Uint8Array(Buffer.from(ivHex, 'hex'));
  const key = new Uint8Array(Buffer.from(ENCRYPTION_KEY, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function createJWT(userId: number) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '2h' });
}

export function refreshJWT(refreshToken: string) {
  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (
      typeof payload === 'string' ||
      !payload ||
      typeof payload !== 'object' ||
      !('userId' in payload)
    ) {
      throw new Error('Invalid token payload');
    }

    const newAccessToken = jwt.sign({ userId: payload.userId }, JWT_SECRET, { expiresIn: '1h' });
    return newAccessToken;
  } catch (err) {
    throw err;
  }
}

export function verifyJWT(jwtToken: string): { userId: string } | null {
  try {
    const decoded = jwt.verify(jwtToken, JWT_SECRET) as { userId: string };
    return decoded;
  } catch (error) {
    throw error;
  }
}
