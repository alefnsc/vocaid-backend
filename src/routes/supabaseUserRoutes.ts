/**
 * Supabase User Sync Routes
 * 
 * Handles user synchronization between Supabase Auth and the database.
 * Replaces Clerk webhook sync functionality.
 * 
 * @module routes/supabaseUserRoutes
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireSupabaseAuth, optionalSupabaseAuth } from '../middleware/supabaseAuthMiddleware';
import { supabaseAdmin } from '../providers/supabaseProvider';
import logger from '../utils/logger';
import config from '../config/env';

const router = Router();
const prisma = new PrismaClient();

// ========================================
// VALIDATION SCHEMAS
// ========================================

const SyncUserSchema = z.object({
  supabaseUserId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  imageUrl: z.string().url().optional().nullable(),
  preferredLanguage: z.string().max(10).optional(),
  countryCode: z.string().length(2).default('BR'),
  authProvider: z.string().max(30).optional(),
  phoneNumber: z.string().max(20).optional().nullable(),
  phoneVerified: z.boolean().default(false),
});

// ========================================
// USER SYNC ENDPOINT
// ========================================

/**
 * POST /api/users/sync
 * 
 * Called by frontend after Supabase auth sign-in/sign-up.
 * Creates or updates user in database.
 * 
 * Note: During migration, this replaces Clerk webhooks
 */
router.post('/sync', optionalSupabaseAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';

  try {
    const validationResult = SyncUserSchema.safeParse(req.body);
    
    if (!validationResult.success) {
      logger.warn('User sync: Invalid payload', { 
        requestId, 
        errors: validationResult.error.errors 
      });
      return res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Invalid sync payload',
          details: validationResult.error.errors,
        },
      });
    }

    const data = validationResult.data;

    // Upsert user in database
    const user = await prisma.user.upsert({
      where: { supabaseUserId: data.supabaseUserId },
      create: {
        supabaseUserId: data.supabaseUserId,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        imageUrl: data.imageUrl,
        preferredLanguage: data.preferredLanguage || 'pt-BR',
        countryCode: data.countryCode,
        authProviders: data.authProvider ? [data.authProvider] : ['email'],
        lastAuthProvider: data.authProvider || 'email',
        phoneNumber: data.phoneNumber,
        phoneVerified: data.phoneVerified,
        phoneVerifiedAt: data.phoneVerified ? new Date() : null,
        userType: 'PERSONAL',
        credits: 0, // Will be handled by credits service
      },
      update: {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        imageUrl: data.imageUrl,
        preferredLanguage: data.preferredLanguage,
        lastAuthProvider: data.authProvider,
        phoneNumber: data.phoneNumber,
        phoneVerified: data.phoneVerified,
        phoneVerifiedAt: data.phoneVerified ? new Date() : undefined,
        // Append auth provider if not already in list
        authProviders: data.authProvider ? {
          push: data.authProvider,
        } : undefined,
      },
      include: {
        creditsWallet: true,
        userConsent: true,
      },
    });

    // Create credits wallet if doesn't exist
    if (!user.creditsWallet) {
      await prisma.creditsWallet.create({
        data: {
          userId: user.id,
          balance: config.credits.freeTrialCredits,
          totalGranted: config.credits.freeTrialCredits,
        },
      });

      // Record the trial credit grant in ledger
      await prisma.creditLedger.create({
        data: {
          userId: user.id,
          type: 'GRANT',
          amount: config.credits.freeTrialCredits,
          balanceAfter: config.credits.freeTrialCredits,
          description: 'Welcome trial credits',
          idempotencyKey: `welcome_trial_${user.id}`,
        },
      });

      logger.info('User sync: Created credits wallet with trial credits', {
        requestId,
        userId: user.id,
        credits: config.credits.freeTrialCredits,
      });
    }

    logger.info('User sync: Success', { 
      requestId, 
      userId: user.id,
      isNew: !user.creditsWallet,
    });

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        preferredLanguage: user.preferredLanguage,
        countryCode: user.countryCode,
        phoneVerified: user.phoneVerified,
        onboardingComplete: user.onboardingComplete,
        hasConsent: !!user.userConsent,
      },
    });
  } catch (error: any) {
    logger.error('User sync: Failed', { requestId, error: error.message });
    return res.status(500).json({
      ok: false,
      error: {
        code: 'SYNC_FAILED',
        message: 'Failed to sync user',
      },
    });
  }
});

// ========================================
// GET CURRENT USER
// ========================================

/**
 * GET /api/users/me
 * 
 * Returns current authenticated user's profile
 */
router.get('/me', requireSupabaseAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';

  try {
    if (!req.dbUser) {
      return res.status(404).json({
        ok: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }

    // Fetch full user profile with relations
    const user = await prisma.user.findUnique({
      where: { id: req.dbUser.id },
      include: {
        creditsWallet: true,
        userConsent: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        preferredLanguage: user.preferredLanguage,
        countryCode: user.countryCode,
        userType: user.userType,
        credits: user.creditsWallet?.balance || 0,
        phoneNumber: user.phoneNumber,
        phoneVerified: user.phoneVerified,
        onboardingComplete: user.onboardingComplete,
        hasConsent: !!user.userConsent,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    logger.error('Get user: Failed', { requestId, error: error.message });
    return res.status(500).json({
      ok: false,
      error: { code: 'FETCH_FAILED', message: 'Failed to fetch user' },
    });
  }
});

// ========================================
// UPDATE USER PROFILE
// ========================================

const UpdateProfileSchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  preferredLanguage: z.string().max(10).optional(),
  currentRole: z.string().max(50).optional(),
  currentSeniority: z.string().max(30).optional(),
});

/**
 * PATCH /api/users/me
 * 
 * Updates current user's profile
 */
router.patch('/me', requireSupabaseAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';

  try {
    const validationResult = UpdateProfileSchema.safeParse(req.body);
    
    if (!validationResult.success) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Invalid update payload',
          details: validationResult.error.errors,
        },
      });
    }

    const data = validationResult.data;

    const user = await prisma.user.update({
      where: { id: req.dbUser!.id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        preferredLanguage: data.preferredLanguage,
        currentRole: data.currentRole,
        currentSeniority: data.currentSeniority,
      },
    });

    logger.info('Update profile: Success', { requestId, userId: user.id });

    return res.json({
      ok: true,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        preferredLanguage: user.preferredLanguage,
        currentRole: user.currentRole,
        currentSeniority: user.currentSeniority,
      },
    });
  } catch (error: any) {
    logger.error('Update profile: Failed', { requestId, error: error.message });
    return res.status(500).json({
      ok: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update profile' },
    });
  }
});

// ========================================
// DELETE ACCOUNT
// ========================================

/**
 * DELETE /api/users/me
 * 
 * Soft-deletes user account (marks as inactive, removes from Supabase Auth)
 */
router.delete('/me', requireSupabaseAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';

  try {
    const userId = req.dbUser!.id;
    const supabaseUserId = req.dbUser!.supabaseUserId;

    // Soft delete in database
    await prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        deletedAt: new Date(),
        email: `deleted_${userId}@vocaid.ai`, // Anonymize email
        firstName: null,
        lastName: null,
        imageUrl: null,
        phoneNumber: null,
      },
    });

    // Delete from Supabase Auth
    try {
      await supabaseAdmin.auth.admin.deleteUser(supabaseUserId);
    } catch (authError: any) {
      // Log but don't fail - user is already soft-deleted in our DB
      logger.warn('Delete account: Supabase Auth deletion failed', {
        requestId,
        userId,
        error: authError.message,
      });
    }

    logger.info('Delete account: Success', { requestId, userId });

    return res.json({
      ok: true,
      message: 'Account deleted successfully',
    });
  } catch (error: any) {
    logger.error('Delete account: Failed', { requestId, error: error.message });
    return res.status(500).json({
      ok: false,
      error: { code: 'DELETE_FAILED', message: 'Failed to delete account' },
    });
  }
});

export default router;
