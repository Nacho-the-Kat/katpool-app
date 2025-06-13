import fs from 'fs';
import https from 'https';
import express, { type Request, type Response, Router } from 'express';
import {
  getUserInfo,
  getAccessToken,
  refreshJWT,
  verifyJWT,
  encryptToken,
  createJWT,
  decryptToken,
  UPHOLD_BASE_URL,
  type AccessTokenResponse,
} from './authorizationCodeFlow';
import Monitoring from '../monitoring';
import Database from '../pool/database';
import { OAUTH_SERVER_PORT } from '../..';

const state = process.env.OAUTH_STATE!;
const app: express.Application = express();
const router = Router();
const monitoring = new Monitoring();
const db = new Database(process.env.DATABASE_URL || '');

type FilteredCard = {
  name: string;
  type: string;
};

// Helper function to refresh access token using refresh token
async function refreshAccessToken(userId: string): Promise<string | null> {
  try {
    const userInfo = await db.getUserDetails(userId);
    if (!userInfo || !userInfo.refresh_token) {
      monitoring.error(`uphold: No refresh token found for user ${userId}`);
      return null;
    }

    const refreshToken = decryptToken(userInfo.refresh_token);

    // Call Uphold's token refresh endpoint
    const refreshResponse = await fetch(`${UPHOLD_BASE_URL}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!refreshResponse.ok) {
      monitoring.error(
        `uphold: Failed to refresh token for user ${userId}: ${refreshResponse.status}`
      );
      return null;
    }

    const tokenData = (await refreshResponse.json()) as AccessTokenResponse;
    const newAccessToken = tokenData?.access_token;
    const newRefreshToken = tokenData?.refresh_token || refreshToken; // Some APIs return new refresh token

    // Encrypt and update tokens in database
    const encryptedAccessToken = encryptToken(newAccessToken);
    const encryptedRefreshToken = encryptToken(newRefreshToken);

    const access_expiry = Math.floor(Date.now() / 1000) + tokenData.expires_in;
    await db.addorUpdateUserDetails(
      userInfo.uphold_id,
      encryptedAccessToken,
      access_expiry.toString(),
      encryptedRefreshToken
    );

    monitoring.log(`uphold: Successfully refreshed access token for user ${userId}`);
    return newAccessToken;
  } catch (error) {
    monitoring.error(
      `uphold: Error refreshing access token for user ${userId}: ${JSON.stringify(error)}`
    );
    return null;
  }
}

// Helper function to make authenticated API calls with automatic token refresh
export async function makeAuthenticatedUpholdRequest(
  userId: string,
  endpoint: string,
  options: RequestInit = {}
) {
  try {
    const userInfo = await db.getUserDetails(userId);
    if (!userInfo) {
      return null;
    }

    let accessToken = decryptToken(userInfo.access_token);

    // First attempt with current access token
    let response = await fetch(`${UPHOLD_BASE_URL}/${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    // If token is expired (401), try to refresh it
    if (response.status === 401) {
      monitoring.log(`uphold: Access token expired for user ${userId}, attempting refresh`);

      const newAccessToken = await refreshAccessToken(userId);
      if (!newAccessToken) {
        monitoring.error(`uphold: Failed to refresh token for user ${userId}`);
        return null;
      }

      // Retry the request with new access token
      response = await fetch(`${UPHOLD_BASE_URL}/${endpoint}`, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${newAccessToken}`,
        },
      });
    }

    return response;
  } catch (error) {
    monitoring.error(`uphold: Error making authenticated Uphold request: ${JSON.stringify(error)}`);
    return null;
  }
}

// Middleware
app.use(express.json());

router.get('/oauth/refresh', async (req: Request, res: Response): Promise<any> => {
  try {
    if (req.headers['x-internal-secret'] !== state) {
      return new Response('Forbidden', { status: 403 });
    }
    // Validate required parameter
    if (!req.query.userId) {
      monitoring.error('uphold: Missing user id');
      return res.status(400).json({ error: 'Missing user id.' });
    }

    const result = await refreshAccessToken(req.query.userId.toString());

    return res.status(200).json({
      access_token: result,
    });
  } catch (error) {
    monitoring.error(`uphold: get oauth/refresh - ${error}`);
    return res.status(500).json({ error: 'Internal server error during fetching refresh token.' });
  }
});

// OAuth Uphold endpoint - User authorization and JWT creation
router.post('/oauth/uphold', async (req: Request, res: Response): Promise<any> => {
  try {
    // Validate required parameters
    if (!req.query.code || req.query.state !== state) {
      monitoring.error('uphold: OAuth validation failed: Invalid or missing code/state');
      return res.status(400).json({ error: 'Invalid or missing code/state' });
    }

    monitoring.log(`uphold: OAuth request received: ${JSON.stringify(req.query)}`);

    const code = typeof req.query.code === 'string' ? req.query.code : '';

    // Step 1: Exchange authorization code for access token
    const tokenResponse = await getAccessToken(code);
    if (!tokenResponse?.access_token) {
      monitoring.error('uphold: Failed to get access token from Uphold');
      return res.status(500).json({ error: 'Failed to get access token' });
    }

    // Step 2: Encrypt and store access token
    const encryptedToken = encryptToken(tokenResponse.access_token);
    const refresh_token = tokenResponse.refresh_token ?? '';
    let encryptedRefreshToken = '';
    if (refresh_token) {
      encryptedRefreshToken = encryptToken(refresh_token);
    }
    monitoring.log(`uphold: Successfully exchanged authorization code ${req.query.code}`);

    // Step 3: Get user info from Uphold
    const userData = await getUserInfo(tokenResponse.access_token);
    if (!userData?.id) {
      monitoring.error('uphold: Failed to get user data from Uphold');
      return res.status(500).json({ error: 'Failed to get user data' });
    }

    monitoring.log(`uphold: Retrieved user data for Uphold user: ${userData.id}`);

    // Step 4: Store user data in database
    const access_expiry = Math.floor(Date.now() / 1000) + tokenResponse.expires_in;
    const internalUserId = await db.addorUpdateUserDetails(
      userData.id,
      encryptedToken,
      access_expiry.toString(),
      encryptedRefreshToken
    );

    if (!internalUserId) {
      monitoring.error('uphold: Failed to store user details in database');
      return res.status(500).json({ error: 'Failed to store user data' });
    }

    // Step 5: Create JWT with internal user ID
    const jwt = createJWT(internalUserId);
    if (!jwt) {
      monitoring.error('uphold: Failed to create JWT token');
      return res.status(500).json({ error: 'Failed to create authentication token' });
    }

    monitoring.log(`uphold: Successfully created user session for internal ID: ${internalUserId}`);

    // Step 6: Return both access token and refresh token to client
    return res.status(200).json({
      jwt: jwt,
      token_type: 'Bearer',
      expires_in: 3600, // 1 hour
      user_id: internalUserId,
      uphold_name: userData.name,
      uphold_userId: userData.id,
      message: 'Authentication successful',
    });
  } catch (error) {
    monitoring.error(`uphold: OAuth flow error: ${JSON.stringify(error)}`);
    return res.status(500).json({ error: 'Internal server error during authentication' });
  }
});

// Display users available cards - UPDATED WITH TOKEN REFRESH LOGIC
router.get('/api/users/me/cards', async (req: Request, res: Response): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyJWT(token);
    if (!decoded?.userId) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Fetch user info from DB
    const userInfo = await db.getUserDetails(decoded.userId);
    if (!userInfo) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Use helper function to make authenticated request with automatic token refresh
    const upholdRes = await makeAuthenticatedUpholdRequest(decoded.userId, 'v0/me/cards');

    if (!upholdRes) {
      return res.status(500).json({ error: 'Failed to fetch cards from Uphold' });
    }

    if (!upholdRes.ok) {
      monitoring.error(`uphold: API error: ${upholdRes.status} ${upholdRes.statusText}`);
      return res.status(502).json({ error: 'Failed to fetch cards from Uphold' });
    }

    const cards = (await upholdRes.json()) as any[];

    // Only return required card fields
    const filteredCards: FilteredCard[] = cards.map(card => ({
      name: card.label,
      type: card.currency,
    }));

    return res.status(200).json({
      user_id: decoded.userId,
      uphold_user_id: userInfo.uphold_id,
      created_at: userInfo.created_at,
      cards: filteredCards,
    });
  } catch (error) {
    monitoring.error(`uphold: Get user info error: ${JSON.stringify(error)}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Payment preferences endpoint - Store user payout preferences
router.post('/api/users/payment-preferences', async (req: Request, res: Response): Promise<any> => {
  try {
    // Step 1: Validate Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];

    // Step 2: Verify JWT and extract user ID
    const decoded = verifyJWT(token);
    if (!decoded || !decoded.userId) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    const userId = decoded.userId;

    // Step 3: Validate request body
    const { payoutNetwork, payoutAsset } = req.body;
    if (!payoutNetwork || !payoutAsset) {
      return res.status(400).json({
        error: 'Missing required fields: payoutNetwork and payoutAsset are required',
      });
    }

    // Step 4: Save preferences to database
    const success = await db.addOrUpdateUserPayoutPreference(userId, payoutNetwork, payoutAsset);
    if (!success) {
      monitoring.error(`uphold: Failed to save payment preferences for user ${userId}`);
      return res.status(500).json({ error: 'Failed to save payment preferences' });
    }

    monitoring.log(
      `uphold: Payment preferences saved for user ${userId}: Network=${payoutNetwork}, Asset=${payoutAsset}`
    );
    return res.status(200).json({
      message: 'Payment preferences saved successfully',
      preferences: {
        payoutNetwork,
        payoutAsset,
        userId,
      },
    });
  } catch (error) {
    monitoring.error(`uphold: Payment preferences error: ${JSON.stringify(error)}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Token refresh endpoint - Client sends refresh token in request body
router.post('/jwt/refresh', async (req: Request, res: Response): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const oldJWT = authHeader.split(' ')[1];
    const decoded = verifyJWT(oldJWT);
    if (decoded?.userId) {
      return res.status(403).json({ error: 'Token is not expired.' });
    }

    if (!oldJWT) {
      return res.status(401).json({ error: 'Missing oldJWT in request body' });
    }

    const newJWT = refreshJWT(oldJWT);

    return res.status(200).json({
      jwt: newJWT,
      token_type: 'Bearer',
      expires_in: 3600,
      message: 'Token refreshed successfully',
    });
  } catch (error) {
    monitoring.error(`uphold: Token refresh error: ${JSON.stringify(error)}`);
    return res.status(403).json({ error: 'Invalid or expired refresh token' });
  }
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  monitoring.error(`uphold: Unhandled error: ${JSON.stringify(err)}`);
  res.status(500).json({ error: 'Internal server error' });
});

// Start HTTPS server
export const server = https.createServer(
  {
    key: fs.readFileSync('./key.pem'),
    cert: fs.readFileSync('./cert.pem'),
    passphrase: 'test',
  },
  app
);

server.listen(OAUTH_SERVER_PORT, () => {
  monitoring.log(`uphold: Server running at https://localhost:${OAUTH_SERVER_PORT}`);
});

export default app;
