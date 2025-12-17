/**
 * Analytics and Performance Chat API Routes
 * Endpoints for analytics, chat, and enhanced abuse detection
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

// Services
import * as analyticsService from '../services/analyticsService';
import * as performanceChatService from '../services/performanceChatService';
import * as enhancedAbuseService from '../services/enhancedAbuseService';
import { dbLogger, apiLogger } from '../utils/logger';

// Create router
const router = Router();

// ========================================
// VALIDATION SCHEMAS
// ========================================

const clerkUserIdSchema = z.string().regex(/^user_[a-zA-Z0-9]+$/);

const analyticsQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  role: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(100).optional()
});

const timeSeriesQuerySchema = z.object({
  period: z.enum(['daily', 'weekly', 'monthly']).optional(),
  months: z.coerce.number().min(1).max(24).optional(),
  role: z.string().max(200).optional(),
  company: z.string().max(200).optional()
});

const chatMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  sessionId: z.string().uuid().optional(),
  filters: z.object({
    roleFilter: z.string().max(200).optional(),
    companyFilter: z.string().max(200).optional(),
    interviewIds: z.array(z.string().uuid()).max(10).optional()
  }).optional()
});

const abuseCheckSchema = z.object({
  email: z.string().email(),
  ipAddress: z.string().max(100).optional(),
  deviceFingerprint: z.string().max(500).optional(),
  userAgent: z.string().max(1000).optional(),
  captchaToken: z.string().max(2000).optional(),
  linkedInId: z.string().max(100).optional()
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
        apiLogger.warn('Validation failed', { 
          errors: error.errors,
          path: req.path
        });
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
 * Get Clerk user ID from request
 */
function getClerkUserId(req: Request): string | null {
  return (req.headers['x-user-id'] as string) || req.body?.userId || null;
}

/**
 * Require authenticated user middleware
 */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const clerkId = getClerkUserId(req);
  
  if (!clerkId) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }
  
  try {
    clerkUserIdSchema.parse(clerkId);
    (req as any).clerkUserId = clerkId;
    next();
  } catch (error) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid authentication'
    });
  }
}

// ========================================
// ANALYTICS ENDPOINTS
// ========================================

/**
 * GET /analytics/scores/by-role
 * Get user's scores grouped by role
 */
router.get(
  '/analytics/scores/by-role',
  requireAuth,
  validate(analyticsQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery || {};

      const scores = await analyticsService.getScoresByRole(clerkId, {
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
        role: query.role,
        limit: query.limit
      });

      res.json({
        status: 'success',
        data: { scores }
      });
    } catch (error: any) {
      apiLogger.error('Error getting scores by role', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get score analytics'
      });
    }
  }
);

/**
 * GET /analytics/scores/by-company
 * Get user's scores grouped by company
 */
router.get(
  '/analytics/scores/by-company',
  requireAuth,
  validate(analyticsQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery || {};

      const scores = await analyticsService.getScoresByCompany(clerkId, {
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
        company: query.company,
        limit: query.limit
      });

      res.json({
        status: 'success',
        data: { scores }
      });
    } catch (error: any) {
      apiLogger.error('Error getting scores by company', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get score analytics'
      });
    }
  }
);

/**
 * GET /analytics/scores/history
 * Get user's score history as time series
 */
router.get(
  '/analytics/scores/history',
  requireAuth,
  validate(timeSeriesQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery || {};

      const timeSeries = await analyticsService.getScoreTimeSeries(
        clerkId,
        query.period || 'weekly',
        {
          months: query.months,
          role: query.role,
          company: query.company
        }
      );

      res.json({
        status: 'success',
        data: { timeSeries }
      });
    } catch (error: any) {
      apiLogger.error('Error getting score history', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get score history'
      });
    }
  }
);

/**
 * GET /analytics/volume
 * Get user's interview volume over time
 */
router.get(
  '/analytics/volume',
  requireAuth,
  validate(timeSeriesQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery || {};

      const volume = await analyticsService.getInterviewVolume(
        clerkId,
        query.period || 'monthly',
        {
          months: query.months,
          role: query.role
        }
      );

      res.json({
        status: 'success',
        data: { volume }
      });
    } catch (error: any) {
      apiLogger.error('Error getting interview volume', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get interview volume'
      });
    }
  }
);

/**
 * GET /analytics/percentile
 * Get user's percentile ranking
 */
router.get(
  '/analytics/percentile',
  requireAuth,
  validate(analyticsQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery || {};

      const percentile = await analyticsService.getUserPercentile(clerkId, {
        role: query.role
      });

      res.json({
        status: 'success',
        data: percentile
      });
    } catch (error: any) {
      apiLogger.error('Error getting percentile', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get percentile'
      });
    }
  }
);

/**
 * GET /analytics/dashboard
 * Get comprehensive dashboard analytics
 */
router.get(
  '/analytics/dashboard',
  requireAuth,
  validate(timeSeriesQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery || {};

      const dashboard = await analyticsService.getDashboardAnalytics(
        clerkId,
        query.period || 'monthly'
      );

      res.json({
        status: 'success',
        data: dashboard
      });
    } catch (error: any) {
      apiLogger.error('Error getting dashboard analytics', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get dashboard analytics'
      });
    }
  }
);

/**
 * GET /analytics/filters
 * Get available filter options (roles, companies)
 */
router.get(
  '/analytics/filters',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const filters = await analyticsService.getAvailableFilters(clerkId);

      res.json({
        status: 'success',
        data: filters
      });
    } catch (error: any) {
      apiLogger.error('Error getting filters', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get filter options'
      });
    }
  }
);

// ========================================
// PERFORMANCE CHAT ENDPOINTS
// ========================================

/**
 * POST /chat/performance
 * Send a message to the performance analyst
 */
router.post(
  '/chat/performance',
  requireAuth,
  validate(chatMessageSchema, 'body'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { message, sessionId, filters } = req.body;

      const response = await performanceChatService.getChatCompletion(
        clerkId,
        message,
        sessionId,
        filters || {}
      );

      res.json({
        status: 'success',
        data: {
          message: response,
          sessionId: sessionId
        }
      });
    } catch (error: any) {
      apiLogger.error('Error in performance chat', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: error.message || 'Failed to generate response'
      });
    }
  }
);

/**
 * POST /chat/performance/stream
 * Stream a response from the performance analyst (SSE)
 */
router.post(
  '/chat/performance/stream',
  requireAuth,
  validate(chatMessageSchema, 'body'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { message, sessionId, filters } = req.body;

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      await performanceChatService.streamChatCompletion(
        clerkId,
        message,
        (chunk: string) => {
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        },
        sessionId,
        filters || {}
      );

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error: any) {
      apiLogger.error('Error in streaming chat', { error: error.message });
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
);

/**
 * GET /chat/context
 * Get performance context for chat
 */
router.get(
  '/chat/context',
  requireAuth,
  validate(analyticsQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery || {};

      const context = await performanceChatService.buildPerformanceContext(
        clerkId,
        {
          roleFilter: query.role,
          companyFilter: query.company
        }
      );

      // Return without full transcripts for context endpoint
      res.json({
        status: 'success',
        data: {
          interviews: context.interviews.map(i => ({
            id: i.id,
            role: i.role,
            company: i.company,
            score: i.score,
            date: i.date,
            hasTranscript: !!i.transcript
          })),
          aggregatedMetrics: context.aggregatedMetrics,
          filters: context.filters
        }
      });
    } catch (error: any) {
      apiLogger.error('Error getting chat context', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get chat context'
      });
    }
  }
);

/**
 * GET /chat/sessions
 * Get user's chat sessions
 */
router.get(
  '/chat/sessions',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

      const sessions = await performanceChatService.getUserChatSessions(
        clerkId,
        limit
      );

      res.json({
        status: 'success',
        data: { sessions }
      });
    } catch (error: any) {
      apiLogger.error('Error getting chat sessions', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get chat sessions'
      });
    }
  }
);

/**
 * GET /chat/session/:sessionId
 * Get a specific chat session with messages
 */
router.get(
  '/chat/session/:sessionId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const session = await performanceChatService.getChatSession(sessionId);

      if (!session) {
        return res.status(404).json({
          status: 'error',
          message: 'Session not found'
        });
      }

      res.json({
        status: 'success',
        data: { session }
      });
    } catch (error: any) {
      apiLogger.error('Error getting chat session', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get chat session'
      });
    }
  }
);

/**
 * GET /chat/insights
 * Get quick performance insights
 */
router.get(
  '/chat/insights',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const insights = await performanceChatService.generateQuickInsights(clerkId);

      res.json({
        status: 'success',
        data: { insights }
      });
    } catch (error: any) {
      apiLogger.error('Error generating insights', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to generate insights'
      });
    }
  }
);

// ========================================
// ENHANCED ABUSE DETECTION ENDPOINTS
// ========================================

/**
 * POST /abuse/check
 * Check signup for potential abuse
 */
router.post(
  '/abuse/check',
  validate(abuseCheckSchema, 'body'),
  async (req: Request, res: Response) => {
    try {
      const signupInfo = req.body;

      const result = await enhancedAbuseService.performEnhancedAbuseCheck(signupInfo);

      res.json({
        status: 'success',
        data: {
          allowed: result.allowed,
          creditTier: result.creditTier,
          creditsToGrant: result.creditsToGrant,
          requiredActions: result.requiredActions,
          riskScore: result.riskScore
        }
      });
    } catch (error: any) {
      apiLogger.error('Error in abuse check', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to perform abuse check'
      });
    }
  }
);

/**
 * POST /abuse/record
 * Record signup information after user creation
 */
router.post(
  '/abuse/record',
  requireAuth,
  validate(abuseCheckSchema, 'body'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const signupInfo = req.body;

      // First perform the check
      const abuseResult = await enhancedAbuseService.performEnhancedAbuseCheck(signupInfo);

      // Get user's UUID
      const { prisma } = await import('../services/databaseService');
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

      // Record the signup
      await enhancedAbuseService.recordEnhancedSignup(
        user.id,
        signupInfo,
        abuseResult
      );

      res.json({
        status: 'success',
        data: {
          recorded: true,
          creditTier: abuseResult.creditTier,
          creditsToGrant: abuseResult.creditsToGrant
        }
      });
    } catch (error: any) {
      apiLogger.error('Error recording signup', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to record signup'
      });
    }
  }
);

/**
 * POST /abuse/verify
 * Update verification status for a user
 */
router.post(
  '/abuse/verify',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { verificationType, verificationData } = req.body;

      if (!['phone', 'captcha', 'linkedin'].includes(verificationType)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid verification type'
        });
      }

      // Get user's UUID
      const { prisma } = await import('../services/databaseService');
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

      await enhancedAbuseService.updateSignupVerification(
        user.id,
        verificationType,
        verificationData
      );

      res.json({
        status: 'success',
        message: 'Verification updated'
      });
    } catch (error: any) {
      apiLogger.error('Error updating verification', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to update verification'
      });
    }
  }
);

/**
 * GET /abuse/stats (Admin only)
 * Get abuse prevention statistics
 */
router.get(
  '/abuse/stats',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      // TODO: Add admin role check
      const stats = await enhancedAbuseService.getEnhancedAbuseStats();

      res.json({
        status: 'success',
        data: stats
      });
    } catch (error: any) {
      apiLogger.error('Error getting abuse stats', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get abuse stats'
      });
    }
  }
);

/**
 * POST /abuse/cleanup
 * Clean up expired subnet trackers (Admin/Cron)
 */
router.post(
  '/abuse/cleanup',
  async (req: Request, res: Response) => {
    try {
      // TODO: Add API key/secret verification for cron jobs
      const cleanedCount = await enhancedAbuseService.cleanupExpiredSubnetTrackers();

      res.json({
        status: 'success',
        data: { cleanedCount }
      });
    } catch (error: any) {
      apiLogger.error('Error cleaning up trackers', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to cleanup trackers'
      });
    }
  }
);

export default router;
