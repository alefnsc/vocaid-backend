/**
 * Consent Routes
 * 
 * Handles user consent for Terms of Use, Privacy Policy,
 * and communication preferences.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { ConsentSource } from '@prisma/client';
import * as consentService from '../services/consentService';
import logger from '../utils/logger';

const router = Router();
const consentLogger = logger.child({ route: 'consent' });

// ========================================
// MIDDLEWARE
// ========================================

/**
 * Verify user authentication from header
 */
const verifyAuth = (req: Request, res: Response, next: NextFunction) => {
  const userId = req.headers['x-user-id'] as string;
  
  if (!userId || !userId.startsWith('user_')) {
    return res.status(401).json({
      ok: false,
      error: 'Authentication required',
      code: 'UNAUTHORIZED',
    });
  }
  
  (req as any).userId = userId;
  next();
};

/**
 * Zod validation middleware
 */
function validate<T extends z.ZodSchema>(schema: T) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        consentLogger.warn('Validation failed', { errors: error.errors });
        return res.status(400).json({
          ok: false,
          error: 'Validation failed',
          details: error.errors,
        });
      }
      next(error);
    }
  };
}

// ========================================
// SCHEMAS
// ========================================

const submitConsentSchema = z.object({
  acceptTerms: z.boolean(),
  acceptPrivacy: z.boolean(),
  marketingOptIn: z.boolean().default(false),
  source: z.enum(['FORM', 'OAUTH']).optional(),
});

const updateMarketingSchema = z.object({
  marketingOptIn: z.boolean(),
});

// ========================================
// ROUTES
// ========================================

/**
 * GET /api/consent/requirements
 * Public endpoint - returns current consent requirements and versions
 */
router.get('/requirements', (_req: Request, res: Response) => {
  try {
    const requirements = consentService.getRequirements();
    
    res.json({
      ok: true,
      data: requirements,
    });
  } catch (error) {
    consentLogger.error('Failed to get consent requirements', { error });
    res.status(500).json({
      ok: false,
      error: 'Failed to get consent requirements',
    });
  }
});

/**
 * GET /api/consent/status
 * Auth required - returns user's consent status
 */
router.get('/status', verifyAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const status = await consentService.getConsentStatus(userId);
    
    res.json({
      ok: true,
      data: status,
    });
  } catch (error) {
    consentLogger.error('Failed to get consent status', { error });
    res.status(500).json({
      ok: false,
      error: 'Failed to get consent status',
    });
  }
});

/**
 * POST /api/consent/submit
 * Auth required - submits user consent
 */
router.post(
  '/submit',
  verifyAuth,
  validate(submitConsentSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { acceptTerms, acceptPrivacy, marketingOptIn, source } = req.body;
      
      // Get IP and User Agent for audit
      const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() 
        || req.socket.remoteAddress 
        || undefined;
      const userAgent = req.headers['user-agent'] || undefined;
      
      // Determine source - try to infer from context if not provided
      let consentSource: ConsentSource = ConsentSource.FORM;
      if (source === 'OAUTH') {
        consentSource = ConsentSource.OAUTH;
      }
      
      const result = await consentService.submitConsent({
        userId,
        acceptTerms,
        acceptPrivacy,
        marketingOptIn,
        source: consentSource,
        ipAddress,
        userAgent,
      });
      
      if (!result.success) {
        return res.status(400).json({
          ok: false,
          error: 'Required consents not accepted',
          code: 'CONSENT_REQUIRED',
        });
      }
      
      res.json({
        ok: true,
        data: {
          hasRequiredConsents: result.hasRequiredConsents,
          marketingOptIn: result.marketingOptIn,
          onboardingCompletedAt: result.onboardingCompletedAt,
        },
      });
    } catch (error) {
      consentLogger.error('Failed to submit consent', { error });
      res.status(500).json({
        ok: false,
        error: 'Failed to submit consent',
      });
    }
  }
);

/**
 * PATCH /api/consent/marketing
 * Auth required - updates marketing preference only
 */
router.patch(
  '/marketing',
  verifyAuth,
  validate(updateMarketingSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { marketingOptIn } = req.body;
      
      const result = await consentService.updateMarketingPreference(userId, marketingOptIn);
      
      res.json({
        ok: true,
        data: result,
      });
    } catch (error) {
      consentLogger.error('Failed to update marketing preference', { error });
      res.status(500).json({
        ok: false,
        error: 'Failed to update marketing preference',
      });
    }
  }
);

export default router;
