/**
 * Authentication Routes
 * 
 * OAuth endpoints for PayPal and mock OAuth for local development.
 * PayPal OAuth is separate from Clerk since it's for payment account linking.
 * Mock endpoints enable local testing without provider dashboard configuration.
 * 
 * @module routes/authRoutes
 */

import { Router, Request, Response } from 'express';
import { PrismaClient, PaymentProvider } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Environment checks
const isDevelopment = process.env.NODE_ENV === 'development';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_SANDBOX = process.env.PAYPAL_SANDBOX === 'true';
const PAYPAL_BASE_URL = PAYPAL_SANDBOX 
  ? 'https://www.sandbox.paypal.com' 
  : 'https://www.paypal.com';
const PAYPAL_API_URL = PAYPAL_SANDBOX
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// Logger
const authLogger = {
  info: (msg: string, data?: any) => console.log(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: any) => console.error(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: any) => console.warn(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
};

// ========================================
// PAYPAL OAUTH ENDPOINTS
// ========================================

/**
 * Start PayPal OAuth flow
 * POST /api/auth/paypal/start
 * 
 * Returns the PayPal authorization URL for the frontend to redirect to.
 */
router.post('/paypal/start', async (req: Request, res: Response) => {
  try {
    const { redirectUrl, mode } = req.body;

    if (!PAYPAL_CLIENT_ID) {
      return res.status(500).json({
        status: 'error',
        message: 'PayPal is not configured',
      });
    }

    // Build PayPal OAuth URL
    const state = Buffer.from(JSON.stringify({
      timestamp: Date.now(),
      mode: mode || 'signIn',
    })).toString('base64');

    const scopes = [
      'openid',
      'email',
      'profile',
      // 'https://uri.paypal.com/services/paypalattributes', // Full name, verified info
    ].join(' ');

    const authUrl = new URL(`${PAYPAL_BASE_URL}/signin/authorize`);
    authUrl.searchParams.set('client_id', PAYPAL_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('flowEntry', 'static');

    authLogger.info('PayPal OAuth started', { redirectUrl, mode });

    res.json({
      status: 'success',
      authUrl: authUrl.toString(),
    });
  } catch (error: any) {
    authLogger.error('PayPal OAuth start failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to start PayPal authentication',
    });
  }
});

/**
 * Handle PayPal OAuth callback
 * POST /api/auth/paypal/callback
 * 
 * Exchanges the authorization code for tokens and stores the connection.
 */
router.post('/paypal/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, clerkUserId } = req.body;

    if (!code) {
      return res.status(400).json({
        status: 'error',
        message: 'Authorization code is required',
      });
    }

    if (!clerkUserId) {
      return res.status(400).json({
        status: 'error',
        message: 'User must be logged in to connect PayPal',
      });
    }

    // Parse state
    let stateData: any = {};
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      authLogger.warn('Failed to parse OAuth state', { state });
    }

    // Exchange code for tokens
    const tokenResponse = await fetch(`${PAYPAL_API_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      authLogger.error('PayPal token exchange failed', { error: errorData });
      throw new Error('Failed to exchange authorization code');
    }

    interface PayPalTokenResponse {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    }

    const tokens = await tokenResponse.json() as PayPalTokenResponse;
    const { access_token, refresh_token, expires_in, scope } = tokens;

    // Get user info from PayPal
    const userInfoResponse = await fetch(`${PAYPAL_API_URL}/v1/identity/openidconnect/userinfo?schema=openid`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
      },
    });

    let paypalUserInfo: any = {};
    if (userInfoResponse.ok) {
      paypalUserInfo = await userInfoResponse.json();
    }

    // Find the user in our database
    const user = await prisma.user.findUnique({
      where: { clerkId: clerkUserId },
    });

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    // Calculate token expiry (default to 1 hour if not provided)
    const tokenExpiresAt = new Date(Date.now() + ((expires_in || 3600) * 1000));

    // Upsert PayPal connection
    const connection = await prisma.paymentProviderConnection.upsert({
      where: {
        userId_provider: {
          userId: user.id,
          provider: PaymentProvider.PAYPAL,
        },
      },
      update: {
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiresAt,
        scopes: scope?.split(' ') || [],
        providerAccountId: paypalUserInfo.user_id || paypalUserInfo.payer_id,
        providerEmail: paypalUserInfo.email,
        isActive: true,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        userId: user.id,
        provider: PaymentProvider.PAYPAL,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiresAt,
        scopes: scope?.split(' ') || [],
        providerAccountId: paypalUserInfo.user_id || paypalUserInfo.payer_id,
        providerEmail: paypalUserInfo.email,
        isActive: true,
        connectedAt: new Date(),
      },
    });

    authLogger.info('PayPal account connected', {
      userId: user.id,
      paypalEmail: paypalUserInfo.email,
    });

    res.json({
      status: 'success',
      message: 'PayPal account connected successfully',
      connection: {
        provider: connection.provider,
        email: connection.providerEmail,
        connectedAt: connection.connectedAt,
      },
    });
  } catch (error: any) {
    authLogger.error('PayPal callback failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to complete PayPal authentication',
    });
  }
});

/**
 * Disconnect PayPal account
 * DELETE /api/auth/paypal/disconnect
 */
router.delete('/paypal/disconnect', async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.headers['x-user-id'] as string;

    if (!clerkUserId) {
      return res.status(401).json({
        status: 'error',
        message: 'Authentication required',
      });
    }

    const user = await prisma.user.findUnique({
      where: { clerkId: clerkUserId },
    });

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    // Soft delete - mark as inactive
    await prisma.paymentProviderConnection.updateMany({
      where: {
        userId: user.id,
        provider: PaymentProvider.PAYPAL,
      },
      data: {
        isActive: false,
        accessToken: null,
        refreshToken: null,
      },
    });

    authLogger.info('PayPal account disconnected', { userId: user.id });

    res.json({
      status: 'success',
      message: 'PayPal account disconnected',
    });
  } catch (error: any) {
    authLogger.error('PayPal disconnect failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to disconnect PayPal account',
    });
  }
});

// ========================================
// MOCK OAUTH ENDPOINTS (DEVELOPMENT ONLY)
// ========================================

if (isDevelopment) {
  authLogger.info('Mock OAuth endpoints enabled (development mode)');

  /**
   * Start mock OAuth flow
   * GET /api/auth/mock/oauth/start
   * 
   * Returns a mock redirect URL for testing OAuth UI flow.
   */
  router.get('/mock/oauth/start', (req: Request, res: Response) => {
    const { provider, redirectUrl } = req.query;

    if (!provider || !['microsoft', 'linkedin', 'apple', 'paypal', 'google'].includes(provider as string)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid provider. Use: microsoft, linkedin, apple, paypal, google',
      });
    }

    const mockState = Buffer.from(JSON.stringify({
      provider,
      timestamp: Date.now(),
      mock: true,
    })).toString('base64');

    const callbackUrl = `${redirectUrl || '/auth/callback'}?mock=1&provider=${provider}&state=${mockState}&code=mock_auth_code_${provider}`;

    authLogger.info('Mock OAuth started', { provider, callbackUrl });

    res.json({
      status: 'success',
      redirectUrl: callbackUrl,
      provider,
      mock: true,
    });
  });

  /**
   * Handle mock OAuth callback
   * POST /api/auth/mock/oauth/callback
   * 
   * Simulates successful OAuth by creating a mock user session.
   */
  router.post('/mock/oauth/callback', async (req: Request, res: Response) => {
    const { provider, code, clerkUserId } = req.body;

    if (!provider) {
      return res.status(400).json({
        status: 'error',
        message: 'Provider is required',
      });
    }

    // Generate mock user data
    const mockUser = {
      id: `mock_${provider}_${Date.now()}`,
      email: `mock.user.${provider}@example.com`,
      firstName: 'Mock',
      lastName: `${provider.charAt(0).toUpperCase() + provider.slice(1)} User`,
      provider,
      accessToken: `mock_access_token_${provider}_${Date.now()}`,
      refreshToken: `mock_refresh_token_${provider}_${Date.now()}`,
    };

    authLogger.info('Mock OAuth callback', { provider, mockUser: mockUser.email });

    // If clerkUserId provided, we can optionally upsert a mock connection
    if (clerkUserId) {
      try {
        const user = await prisma.user.findUnique({
          where: { clerkId: clerkUserId },
        });

        if (user) {
          // For PayPal mock, create an actual connection record
          if (provider === 'paypal') {
            await prisma.paymentProviderConnection.upsert({
              where: {
                userId_provider: {
                  userId: user.id,
                  provider: PaymentProvider.PAYPAL,
                },
              },
              update: {
                accessToken: mockUser.accessToken,
                refreshToken: mockUser.refreshToken,
                tokenExpiresAt: new Date(Date.now() + 3600000),
                providerAccountId: mockUser.id,
                providerEmail: mockUser.email,
                isActive: true,
                lastUsedAt: new Date(),
              },
              create: {
                userId: user.id,
                provider: PaymentProvider.PAYPAL,
                accessToken: mockUser.accessToken,
                refreshToken: mockUser.refreshToken,
                tokenExpiresAt: new Date(Date.now() + 3600000),
                scopes: ['openid', 'email', 'profile'],
                providerAccountId: mockUser.id,
                providerEmail: mockUser.email,
                isActive: true,
              },
            });
          }
        }
      } catch (e) {
        authLogger.warn('Mock user connection failed (non-blocking)', { error: (e as Error).message });
      }
    }

    res.json({
      status: 'success',
      mock: true,
      user: mockUser,
      message: `Mock ${provider} authentication successful`,
    });
  });
}

export default router;
