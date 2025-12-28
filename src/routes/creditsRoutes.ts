/**
 * Credits Routes
 * 
 * API endpoints for credit wallet operations:
 * - Get wallet balance and summary
 * - Get transaction history
 * - Spend credits (for interviews)
 * - Restore credits (early quit)
 * 
 * @module routes/creditsRoutes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import * as creditsWalletService from '../services/creditsWalletService';
import { getTrialStatus, isPromoActive, getPromoRemainingDays, PROMO_END_DATE } from '../services/trialPolicyService';
import { apiLogger } from '../utils/logger';
import { prisma } from '../services/databaseService';

const router = Router();

// ========================================
// VALIDATION SCHEMAS
// ========================================

const clerkUserIdSchema = z.string().min(1, 'User ID is required');

const spendCreditsSchema = z.object({
  amount: z.number().int().positive().default(1),
  interviewId: z.string().uuid().optional(),
  description: z.string().max(255).optional()
});

const restoreCreditsSchema = z.object({
  amount: z.number().int().positive().default(1),
  interviewId: z.string().uuid().optional(),
  reason: z.string().max(255).optional()
});

const transactionHistorySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  type: z.enum(['PURCHASE', 'GRANT', 'SPEND', 'REFUND', 'RESTORE', 'ADMIN', 'PROMO', 'REFERRAL', 'EXPIRE']).optional()
});

// ========================================
// MIDDLEWARE
// ========================================

/**
 * Validation middleware factory
 */
function validate<T extends z.ZodSchema>(
  schema: T,
  source: 'body' | 'params' | 'query' = 'body'
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = source === 'body' ? req.body : 
                   source === 'params' ? req.params : req.query;
      const validated = await schema.parseAsync(data);
      
      if (source === 'body') req.body = validated;
      else if (source === 'params') (req as any).validatedParams = validated;
      else (req as any).validatedQuery = validated;
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          status: 'error',
          message: 'Validation failed',
          errors: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      next(error);
    }
  };
}

/**
 * Get Clerk user ID from request headers
 */
function getClerkUserId(req: Request): string | null {
  return (req.headers['x-user-id'] as string) || null;
}

/**
 * Get internal user ID from Clerk ID
 */
async function getUserId(req: Request, res: Response, next: NextFunction) {
  const clerkId = getClerkUserId(req);
  
  if (!clerkId) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }
  
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId },
      select: { id: true }
    });
    
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    (req as any).userId = user.id;
    next();
  } catch (error) {
    next(error);
  }
}

// ========================================
// ROUTES
// ========================================

/**
 * GET /api/credits/balance
 * Get current wallet balance
 */
router.get('/balance', getUserId, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const balance = await creditsWalletService.getWalletBalance(userId);
    
    res.json({
      status: 'success',
      data: balance
    });
  } catch (error: any) {
    apiLogger.error('Failed to get wallet balance', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get balance'
    });
  }
});

/**
 * GET /api/credits/summary
 * Get detailed wallet summary with recent transactions
 */
router.get('/summary', getUserId, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const summary = await creditsWalletService.getCreditsSummary(userId);
    
    res.json({
      status: 'success',
      data: summary
    });
  } catch (error: any) {
    apiLogger.error('Failed to get wallet summary', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get summary'
    });
  }
});

/**
 * GET /api/credits/history
 * Get transaction history with pagination
 */
router.get(
  '/history',
  getUserId,
  validate(transactionHistorySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const query = (req as any).validatedQuery;
      
      const history = await creditsWalletService.getTransactionHistory(userId, {
        limit: query.limit,
        offset: query.offset,
        type: query.type
      });
      
      res.json({
        status: 'success',
        data: history
      });
    } catch (error: any) {
      apiLogger.error('Failed to get transaction history', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get history'
      });
    }
  }
);

/**
 * POST /api/credits/spend
 * Spend credits (typically for starting an interview)
 */
router.post(
  '/spend',
  getUserId,
  validate(spendCreditsSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { amount, interviewId, description } = req.body;
      
      const result = await creditsWalletService.spendCredits(
        userId,
        amount,
        description || 'Interview credit',
        interviewId ? 'interview' : undefined,
        interviewId,
        interviewId ? `spend_interview_${interviewId}` : undefined
      );
      
      if (!result.success) {
        return res.status(400).json({
          status: 'error',
          message: result.error || 'Insufficient credits'
        });
      }
      
      res.json({
        status: 'success',
        data: {
          newBalance: result.newBalance,
          ledgerEntryId: result.ledgerEntryId
        }
      });
    } catch (error: any) {
      apiLogger.error('Failed to spend credits', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to spend credits'
      });
    }
  }
);

/**
 * POST /api/credits/restore
 * Restore credits (e.g., when user quits interview early)
 */
router.post(
  '/restore',
  getUserId,
  validate(restoreCreditsSchema),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { amount, interviewId, reason } = req.body;
      
      const result = await creditsWalletService.restoreCredits(
        userId,
        amount,
        reason || 'Credit restored',
        interviewId ? 'interview' : undefined,
        interviewId
      );
      
      if (!result.success) {
        return res.status(400).json({
          status: 'error',
          message: result.error || 'Failed to restore credits'
        });
      }
      
      res.json({
        status: 'success',
        data: {
          newBalance: result.newBalance,
          ledgerEntryId: result.ledgerEntryId
        }
      });
    } catch (error: any) {
      apiLogger.error('Failed to restore credits', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to restore credits'
      });
    }
  }
);

/**
 * GET /api/credits/check
 * Check if user has sufficient credits (for pre-interview check)
 */
router.get('/check', getUserId, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const amount = parseInt(req.query.amount as string) || 1;
    
    const hasCredits = await creditsWalletService.hasCredits(userId, amount);
    const balance = await creditsWalletService.getWalletBalance(userId);
    
    res.json({
      status: 'success',
      data: {
        hasCredits,
        balance: balance.balance,
        required: amount
      }
    });
  } catch (error: any) {
    apiLogger.error('Failed to check credits', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to check credits'
    });
  }
});

/**
 * GET /api/credits/trial-status
 * Get trial credits status for current user
 * Returns info about trial grant, promo period, and current balance
 */
router.get('/trial-status', getUserId, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const status = await getTrialStatus(userId);
    
    res.json({
      status: 'success',
      data: {
        trialCreditsGranted: status.trialCreditsGranted,
        trialCreditsAmount: status.trialCreditsAmount,
        trialCreditsGrantedAt: status.trialCreditsGrantedAt?.toISOString() || null,
        isPromoActive: status.isPromoActive,
        promoEndsAt: status.promoEndsAt.toISOString(),
        promoRemainingDays: getPromoRemainingDays(),
        currentBalance: status.currentBalance,
        riskLevel: status.riskLevel
      }
    });
  } catch (error: any) {
    apiLogger.error('Failed to get trial status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get trial status'
    });
  }
});

/**
 * GET /api/credits/promo-info
 * Get current promo information (public endpoint)
 */
router.get('/promo-info', async (req: Request, res: Response) => {
  try {
    res.json({
      status: 'success',
      data: {
        isPromoActive: isPromoActive(),
        promoEndsAt: PROMO_END_DATE.toISOString(),
        promoRemainingDays: getPromoRemainingDays(),
        promoCredits: isPromoActive() ? 5 : 1,
        standardCredits: 1
      }
    });
  } catch (error: any) {
    apiLogger.error('Failed to get promo info', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get promo info'
    });
  }
});

export default router;
