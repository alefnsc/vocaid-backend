/**
 * User Routes
 * 
 * User profile management endpoints for B2C Personal users.
 * 
 * Endpoints:
 * - GET /api/users/me - Get current user profile
 * - PUT /api/users/me - Update current user profile (countryCode, preferredLanguage)
 * - POST /api/users/metadata - Legacy endpoint, proxies to PUT /api/users/me
 * 
 * @module routes/userRoutes
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient, UserType } from '@prisma/client';
import { requireAuth } from './apiRoutes';
import { isIdVerificationAvailable, isValidCountryCode, B2CErrorCodes } from '../middleware/b2cMiddleware';
import logger from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

// ========================================
// VALIDATION SCHEMAS
// ========================================

const updateProfileSchema = z.object({
  countryCode: z.string()
    .length(2, 'Country code must be 2 characters')
    .regex(/^[A-Z]{2}$/, 'Country code must be uppercase letters')
    .optional(),
  preferredLanguage: z.string()
    .min(2)
    .max(10)
    .optional(),
  role: z.enum(['Recruiter', 'Candidate', 'Manager']).optional(),
  marketingOptIn: z.boolean().optional(),
}).refine((data) => {
  // At least one field must be provided
  return data.countryCode !== undefined || 
         data.preferredLanguage !== undefined || 
         data.role !== undefined ||
         data.marketingOptIn !== undefined;
}, {
  message: 'At least one field must be provided',
});

// ========================================
// GET /api/users/me - Get current user profile
// ========================================
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;

  try {
    const user = await prisma.user.findUnique({
      where: { clerkId },
      select: {
        id: true,
        clerkId: true,
        email: true,
        firstName: true,
        lastName: true,
        imageUrl: true,
        credits: true,
        userType: true,
        countryCode: true,
        preferredLanguage: true,
        currentRole: true,
        currentSeniority: true,
        onboardingComplete: true,
        createdAt: true,
        updatedAt: true,
      }
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        status: 'error',
        error: {
          code: B2CErrorCodes.USER_NOT_FOUND,
          message: 'User not found',
          requestId
        }
      });
    }

    // Return user profile with B2C access info
    res.json({
      ok: true,
      status: 'success',
      data: {
        ...user,
        // Include B2C eligibility info
        b2cEligible: user.userType === UserType.PERSONAL,
        idVerificationAvailable: isIdVerificationAvailable(user.countryCode || ''),
      }
    });
  } catch (error: any) {
    logger.error('Error fetching user profile', { requestId, error: error.message });
    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to fetch user profile',
        requestId
      }
    });
  }
});

// ========================================
// PUT /api/users/me - Update current user profile
// ========================================
router.put('/me', requireAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;

  try {
    // Validate request body
    const result = updateProfileSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: result.error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          })),
          requestId
        }
      });
    }

    const { countryCode, preferredLanguage, role, marketingOptIn } = result.data;

    // Validate country code if provided
    if (countryCode) {
      if (!isValidCountryCode(countryCode)) {
        return res.status(400).json({
          ok: false,
          status: 'error',
          error: {
            code: 'INVALID_COUNTRY_CODE',
            message: 'Invalid country code format. Must be ISO 3166-1 alpha-2 (e.g., BR, US)',
            requestId
          }
        });
      }
      // All countries are supported for B2C interview flow
      // ID verification is only available for Brazil (handled separately)
    }

    // Build update data
    const updateData: Record<string, any> = {};
    
    if (countryCode !== undefined) {
      updateData.countryCode = countryCode;
    }
    if (preferredLanguage !== undefined) {
      updateData.preferredLanguage = preferredLanguage;
    }
    if (role !== undefined) {
      updateData.currentRole = role;
    }

    // Update user
    const user = await prisma.user.update({
      where: { clerkId },
      data: updateData,
      select: {
        id: true,
        clerkId: true,
        email: true,
        firstName: true,
        lastName: true,
        userType: true,
        countryCode: true,
        preferredLanguage: true,
        currentRole: true,
        updatedAt: true,
      }
    });

    // Update marketing consent if provided
    if (marketingOptIn !== undefined) {
      await prisma.userConsent.upsert({
        where: { userId: user.id },
        update: {
          marketingOptIn,
          marketingOptInAt: marketingOptIn ? new Date() : null,
        },
        create: {
          userId: user.id,
          termsAcceptedAt: new Date(),
          privacyAcceptedAt: new Date(),
          termsVersion: '1.0',
          privacyVersion: '1.0',
          marketingOptIn,
          marketingOptInAt: marketingOptIn ? new Date() : null,
        }
      });
    }

    logger.info('User profile updated', { 
      requestId, 
      userId: user.id,
      fields: Object.keys(updateData)
    });

    res.json({
      ok: true,
      status: 'success',
      data: {
        ...user,
        b2cEligible: user.userType === UserType.PERSONAL && user.countryCode === 'BR',
      }
    });
  } catch (error: any) {
    logger.error('Error updating user profile', { requestId, error: error.message });
    
    if (error.code === 'P2025') {
      return res.status(404).json({
        ok: false,
        status: 'error',
        error: {
          code: B2CErrorCodes.USER_NOT_FOUND,
          message: 'User not found',
          requestId
        }
      });
    }

    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to update user profile',
        requestId
      }
    });
  }
});

// ========================================
// POST /api/users/metadata - Legacy endpoint
// Proxies to PUT /api/users/me for backward compatibility
// ========================================
router.post('/metadata', requireAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;

  try {
    // Map old fields to new format
    const { role, preferredLanguage, countryCode, marketingOptIn } = req.body;
    
    const updateData: Record<string, any> = {};
    
    if (role) updateData.currentRole = role;
    if (preferredLanguage) updateData.preferredLanguage = preferredLanguage;
    if (countryCode) {
      // All countries are now supported
      updateData.countryCode = countryCode;
    }

    // Skip if no fields to update
    if (Object.keys(updateData).length === 0 && marketingOptIn === undefined) {
      return res.json({
        ok: true,
        status: 'success',
        data: { message: 'No fields to update' }
      });
    }

    const user = await prisma.user.update({
      where: { clerkId },
      data: updateData,
      select: {
        id: true,
        clerkId: true,
        userType: true,
        countryCode: true,
        preferredLanguage: true,
        currentRole: true,
      }
    });

    // Update marketing consent if provided
    if (marketingOptIn !== undefined) {
      await prisma.userConsent.upsert({
        where: { userId: user.id },
        update: {
          marketingOptIn,
          marketingOptInAt: marketingOptIn ? new Date() : null,
        },
        create: {
          userId: user.id,
          termsAcceptedAt: new Date(),
          privacyAcceptedAt: new Date(),
          termsVersion: '1.0',
          privacyVersion: '1.0',
          marketingOptIn,
          marketingOptInAt: marketingOptIn ? new Date() : null,
        }
      });
    }

    logger.info('User metadata updated (legacy endpoint)', { 
      requestId, 
      userId: user.id 
    });

    res.json({
      ok: true,
      status: 'success',
      data: user
    });
  } catch (error: any) {
    logger.error('Error updating user metadata', { requestId, error: error.message });
    
    if (error.code === 'P2025') {
      return res.status(404).json({
        ok: false,
        status: 'error',
        error: {
          code: B2CErrorCodes.USER_NOT_FOUND,
          message: 'User not found',
          requestId
        }
      });
    }

    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to update user metadata',
        requestId
      }
    });
  }
});

// ========================================
// GET /api/users/me/b2c-status - Get B2C access status
// ========================================
router.get('/me/b2c-status', requireAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;

  try {
    const user = await prisma.user.findUnique({
      where: { clerkId },
      select: {
        userType: true,
        countryCode: true,
        onboardingComplete: true,
      }
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        status: 'error',
        error: {
          code: B2CErrorCodes.USER_NOT_FOUND,
          message: 'User not found',
          requestId
        }
      });
    }

    const isPersonal = user.userType === UserType.PERSONAL;
    const hasCountry = !!user.countryCode;
    const canUseIdVerification = isIdVerificationAvailable(user.countryCode || '');

    res.json({
      ok: true,
      status: 'success',
      data: {
        b2cEligible: isPersonal,
        userType: user.userType,
        countryCode: user.countryCode,
        idVerificationAvailable: canUseIdVerification,
        needsCountrySelection: !hasCountry,
        onboardingComplete: user.onboardingComplete,
        restrictions: {
          canCreateInterview: isPersonal,
          canPurchaseCredits: isPersonal,
          canAccessDashboard: isPersonal,
          canUseIdVerification: canUseIdVerification,
        }
      }
    });
  } catch (error: any) {
    logger.error('Error fetching B2C status', { requestId, error: error.message });
    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to fetch B2C status',
        requestId
      }
    });
  }
});

export default router;
export { requireAuth };
