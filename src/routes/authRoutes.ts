/**
 * Authentication Routes
 * 
 * Mock OAuth endpoints for local development testing.
 * Enables testing OAuth UI flows without provider dashboard configuration.
 * Production OAuth is handled entirely by Clerk (Google, Apple, Microsoft).
 * 
 * @module routes/authRoutes
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Environment checks
const isDevelopment = process.env.NODE_ENV === 'development';

// Logger
const authLogger = {
  info: (msg: string, data?: any) => console.log(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: any) => console.error(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: any) => console.warn(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
};

// ========================================
// AUTH PROVIDER TRACKING
// ========================================

/**
 * Track auth provider used for login
 * POST /api/auth/track-provider
 * 
 * Called after successful OAuth to track which provider was used.
 */
router.post('/track-provider', async (req: Request, res: Response) => {
  try {
    const { clerkUserId, provider } = req.body;

    if (!clerkUserId || !provider) {
      return res.status(400).json({
        status: 'error',
        message: 'clerkUserId and provider are required',
      });
    }

    const validProviders = ['google', 'apple', 'microsoft', 'email'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid provider. Use: google, apple, microsoft, email',
      });
    }

    // Find and update user
    const user = await prisma.user.findUnique({
      where: { clerkId: clerkUserId },
    });

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    // Update auth providers array (add if not present)
    const currentProviders = user.authProviders || [];
    const updatedProviders = currentProviders.includes(provider)
      ? currentProviders
      : [...currentProviders, provider];

    await prisma.user.update({
      where: { id: user.id },
      data: {
        authProviders: updatedProviders,
        lastAuthProvider: provider,
      },
    });

    authLogger.info('Auth provider tracked', { userId: user.id, provider });

    res.json({
      status: 'success',
      message: 'Auth provider tracked',
    });
  } catch (error: any) {
    authLogger.error('Track provider failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to track auth provider',
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
    const providerStr = provider as string;

    if (!providerStr || !['microsoft', 'apple', 'google'].includes(providerStr)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid provider. Use: microsoft, apple, google',
      });
    }

    const mockState = Buffer.from(JSON.stringify({
      provider: providerStr,
      timestamp: Date.now(),
      mock: true,
    })).toString('base64');

    const baseRedirect = redirectUrl || '/auth/callback';
    const callbackUrl = baseRedirect + '?mock=1&provider=' + providerStr + '&state=' + mockState + '&code=mock_auth_code_' + providerStr;

    authLogger.info('Mock OAuth started', { provider: providerStr, callbackUrl });

    res.json({
      status: 'success',
      redirectUrl: callbackUrl,
      provider: providerStr,
      mock: true,
    });
  });

  /**
   * Handle mock OAuth callback
   * POST /api/auth/mock/oauth/callback
   * 
   * Simulates successful OAuth by returning mock user data.
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
      id: 'mock_' + provider + '_' + Date.now(),
      email: 'mock.user.' + provider + '@example.com',
      firstName: 'Mock',
      lastName: provider.charAt(0).toUpperCase() + provider.slice(1) + ' User',
      provider,
      accessToken: 'mock_access_token_' + provider + '_' + Date.now(),
    };

    authLogger.info('Mock OAuth callback', { provider, mockUser: mockUser.email });

    // If clerkUserId provided, track the provider
    if (clerkUserId) {
      try {
        const user = await prisma.user.findUnique({
          where: { clerkId: clerkUserId },
        });

        if (user) {
          const currentProviders = user.authProviders || [];
          const updatedProviders = currentProviders.includes(provider)
            ? currentProviders
            : [...currentProviders, provider];

          await prisma.user.update({
            where: { id: user.id },
            data: {
              authProviders: updatedProviders,
              lastAuthProvider: provider,
            },
          });
        }
      } catch (e) {
        authLogger.warn('Mock user update failed (non-blocking)', { error: (e as Error).message });
      }
    }

    res.json({
      status: 'success',
      mock: true,
      user: mockUser,
      message: 'Mock ' + provider + ' authentication successful',
    });
  });
}

export default router;
