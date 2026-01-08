/**
 * Account Routes
 * 
 * Manages connected OAuth provider accounts.
 * Provides status, connect, and disconnect functionality for Google, Microsoft, X, and LinkedIn.
 * 
 * @module routes/accountRoutes
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireSession } from '../middleware/sessionAuthMiddleware';

const router = Router();
const prisma = new PrismaClient();

// Logger
const accountLogger = {
  info: (msg: string, data?: any) => console.log(`[ACCOUNT] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: any) => console.error(`[ACCOUNT] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: any) => console.warn(`[ACCOUNT] ${msg}`, data ? JSON.stringify(data) : ''),
};

// Provider keys (normalized)
type ProviderKey = 'google' | 'microsoft' | 'x' | 'linkedin';
const VALID_PROVIDERS: ProviderKey[] = ['google', 'microsoft', 'x', 'linkedin'];

/**
 * Connection status for a provider
 */
interface ProviderConnection {
  connected: boolean;
  email?: string;
  name?: string;
  username?: string;
  pictureUrl?: string;
  profileUrl?: string;
  connectedAt?: string;
  providerId?: string;
}

/**
 * Get all connected account statuses
 * GET /api/account/connections
 * 
 * Returns connection status for all supported OAuth providers.
 * Requires authentication.
 */
router.get('/connections', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Fetch user with all provider profiles in parallel
    const [user, googleProfile, microsoftProfile, xProfile, linkedInProfile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          authProviders: true,
          googleId: true,
          email: true,
          firstName: true,
          lastName: true,
          imageUrl: true,
        },
      }),
      prisma.googleProfile.findUnique({
        where: { userId },
        select: {
          googleId: true,
          email: true,
          name: true,
          pictureUrl: true,
          createdAt: true,
        },
      }),
      prisma.microsoftProfile.findUnique({
        where: { userId },
        select: {
          msUserId: true,
          email: true,
          name: true,
          pictureUrl: true,
          createdAt: true,
        },
      }),
      prisma.xProfile.findUnique({
        where: { userId },
        select: {
          xUserId: true,
          username: true,
          name: true,
          pictureUrl: true,
          createdAt: true,
        },
      }),
      prisma.linkedInProfile.findUnique({
        where: { userId },
        select: {
          linkedinMemberId: true,
          email: true,
          name: true,
          pictureUrl: true,
          profileUrl: true,
          createdAt: true,
        },
      }),
    ]);

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    // Build connection status for each provider
    const connections: Record<ProviderKey, ProviderConnection> = {
      google: googleProfile
        ? {
            connected: true,
            email: googleProfile.email || undefined,
            name: googleProfile.name || undefined,
            pictureUrl: googleProfile.pictureUrl || undefined,
            connectedAt: googleProfile.createdAt.toISOString(),
            providerId: googleProfile.googleId,
          }
        : user.googleId
          ? {
              // Legacy: googleId on User but no GoogleProfile yet
              connected: true,
              email: user.email,
              name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
              pictureUrl: user.imageUrl || undefined,
              providerId: user.googleId,
            }
          : { connected: false },

      microsoft: microsoftProfile
        ? {
            connected: true,
            email: microsoftProfile.email || undefined,
            name: microsoftProfile.name || undefined,
            pictureUrl: microsoftProfile.pictureUrl || undefined,
            connectedAt: microsoftProfile.createdAt.toISOString(),
            providerId: microsoftProfile.msUserId,
          }
        : { connected: false },

      x: xProfile
        ? {
            connected: true,
            username: xProfile.username || undefined,
            name: xProfile.name || undefined,
            pictureUrl: xProfile.pictureUrl || undefined,
            connectedAt: xProfile.createdAt.toISOString(),
            providerId: xProfile.xUserId,
          }
        : { connected: false },

      linkedin: linkedInProfile
        ? {
            connected: true,
            email: linkedInProfile.email || undefined,
            name: linkedInProfile.name || undefined,
            pictureUrl: linkedInProfile.pictureUrl || undefined,
            profileUrl: linkedInProfile.profileUrl || undefined,
            connectedAt: linkedInProfile.createdAt.toISOString(),
            providerId: linkedInProfile.linkedinMemberId || undefined,
          }
        : { connected: false },
    };

    accountLogger.info('Fetched connections', { userId, providers: Object.keys(connections) });

    return res.json({
      status: 'success',
      data: connections,
    });
  } catch (error: any) {
    accountLogger.error('Failed to fetch connections', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch connected accounts',
    });
  }
});

/**
 * Disconnect a provider account
 * DELETE /api/account/connections/:provider
 * 
 * Removes the connection for the specified provider.
 * Returns 409 if this is the user's only sign-in method.
 * Idempotent: returns success if already disconnected.
 */
router.delete('/connections/:provider', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const provider = req.params.provider?.toLowerCase() as ProviderKey;

    // Validate provider
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    // Fetch user and check current auth methods
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        authProviders: true,
        lastAuthProvider: true,
        passwordHash: true,
        googleId: true,
        phoneVerified: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    // Check if provider is currently connected
    const isProviderConnected = user.authProviders.includes(provider);

    // Also check provider-specific profile existence
    let hasProviderProfile = false;
    switch (provider) {
      case 'google':
        hasProviderProfile = !!(user.googleId || await prisma.googleProfile.findUnique({ where: { userId } }));
        break;
      case 'microsoft':
        hasProviderProfile = !!(await prisma.microsoftProfile.findUnique({ where: { userId } }));
        break;
      case 'x':
        hasProviderProfile = !!(await prisma.xProfile.findUnique({ where: { userId } }));
        break;
      case 'linkedin':
        hasProviderProfile = !!(await prisma.linkedInProfile.findUnique({ where: { userId } }));
        break;
    }

    // If not connected, return success (idempotent)
    if (!isProviderConnected && !hasProviderProfile) {
      accountLogger.info('Provider already disconnected', { userId, provider });
      return res.json({
        status: 'success',
        data: { connected: false, provider },
        message: 'Provider is not connected',
      });
    }

    // Count remaining sign-in methods after disconnect
    // Sign-in methods: OAuth providers in authProviders + password + phone (if verified)
    const remainingProviders = user.authProviders.filter(p => p !== provider);
    const hasPassword = !!user.passwordHash;
    const hasPhone = user.phoneVerified;

    const remainingSignInMethods = remainingProviders.length + (hasPassword ? 1 : 0) + (hasPhone ? 1 : 0);

    if (remainingSignInMethods === 0) {
      accountLogger.warn('Cannot disconnect only sign-in method', { userId, provider });
      return res.status(409).json({
        status: 'error',
        message: 'Cannot disconnect your only sign-in method. Connect another provider first.',
        code: 'LAST_AUTH_METHOD',
      });
    }

    // Perform disconnect in transaction
    await prisma.$transaction(async (tx) => {
      // Remove from authProviders and clear lastAuthProvider if it matches
      await tx.user.update({
        where: { id: userId },
        data: {
          authProviders: remainingProviders,
          lastAuthProvider: user.lastAuthProvider === provider ? null : user.lastAuthProvider,
          // Clear googleId if disconnecting google
          ...(provider === 'google' ? { googleId: null } : {}),
        },
      });

      // Delete provider-specific profile
      switch (provider) {
        case 'google':
          await tx.googleProfile.deleteMany({ where: { userId } });
          break;
        case 'microsoft':
          await tx.microsoftProfile.deleteMany({ where: { userId } });
          break;
        case 'x':
          await tx.xProfile.deleteMany({ where: { userId } });
          break;
        case 'linkedin':
          await tx.linkedInProfile.deleteMany({ where: { userId } });
          // Also clear UserConsent LinkedIn fields if desired
          await tx.userConsent.updateMany({
            where: { userId },
            data: {
              linkedinConnectedAt: null,
              linkedinMemberId: null,
            },
          });
          break;
      }
    });

    accountLogger.info('Provider disconnected', { userId, provider, remainingProviders });

    return res.json({
      status: 'success',
      data: { connected: false, provider },
      message: `${provider} account disconnected successfully`,
    });
  } catch (error: any) {
    accountLogger.error('Failed to disconnect provider', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to disconnect provider',
    });
  }
});

export default router;
