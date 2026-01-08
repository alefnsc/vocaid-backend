/**
 * Beta Feedback Routes
 * 
 * Handles closed beta feedback submissions (bugs and feature requests).
 * Persists to Postgres via Prisma.
 * Includes admin endpoints for listing/viewing feedback.
 * 
 * This route is feature-flagged and can be disabled post-beta.
 */

import { Router, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { apiLogger } from '../utils/logger';
import {
  createBetaFeedback,
  getBetaFeedbackByRefId,
  listBetaFeedback,
  updateBetaFeedbackStatus,
  type BetaFeedbackInput,
} from '../services/betaFeedbackService';

const router = Router();

// ============================================================================
// FEATURE FLAG
// ============================================================================

const isBetaFeedbackEnabled = (): boolean => {
  const flag = process.env.BETA_FEEDBACK_ENABLED;
  // Default to true during closed beta
  return flag !== 'false';
};

// ============================================================================
// ADMIN AUTH MIDDLEWARE
// ============================================================================

const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || process.env.ADMIN_SECRET_KEY;

function requireAdminAuth(req: Request, res: Response, next: () => void) {
  if (!ADMIN_API_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'Admin authentication not configured',
    });
  }

  const providedSecret = req.headers['x-admin-secret'] as string;

  if (!providedSecret || providedSecret !== ADMIN_API_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
    });
  }

  next();
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const bugSeveritySchema = z.enum(['low', 'medium', 'high', 'blocking']);
const bugFrequencySchema = z.enum(['always', 'sometimes', 'once']);
const featurePrioritySchema = z.enum(['nice-to-have', 'important', 'critical']);
const featureTargetUserSchema = z.enum(['self', 'recruiters', 'other']);

const baseFeedbackSchema = z.object({
  type: z.enum(['bug', 'feature']),
  title: z.string().min(5).max(200).trim(),
  description: z.string().min(10).max(5000).trim(),
  pageUrl: z.string().url().max(500),
  userEmail: z.string().email().max(255),
  userId: z.string().max(100).optional(),
  language: z.string().max(10).default('en'),
  appEnv: z.string().max(20).default('development'),
  appVersion: z.string().max(20).default('0.0.0'),
  userAgent: z.string().max(500).default(''),
  allowFollowUp: z.boolean().default(false),
  refId: z.string().uuid().optional(),
  recaptchaToken: z.string().optional(),
});

const bugReportSchema = baseFeedbackSchema.extend({
  type: z.literal('bug'),
  severity: bugSeveritySchema,
  stepsToReproduce: z.array(z.string().max(500)).max(10).optional(),
  expectedBehavior: z.string().max(2000).optional(),
  actualBehavior: z.string().max(2000).optional(),
  frequency: bugFrequencySchema.optional(),
});

const featureSuggestionSchema = baseFeedbackSchema.extend({
  type: z.literal('feature'),
  goal: z.string().max(2000).optional(),
  targetUser: featureTargetUserSchema.optional(),
  priority: featurePrioritySchema.optional(),
  alternativesTried: z.string().max(2000).optional(),
});

const betaFeedbackSchema = z.discriminatedUnion('type', [
  bugReportSchema,
  featureSuggestionSchema,
]);

type BetaFeedbackPayload = z.infer<typeof betaFeedbackSchema>;

// ============================================================================
// IP ADDRESS EXTRACTION
// ============================================================================

function getClientIpAddress(req: Request): string | undefined {
  // Check x-forwarded-for first (for proxied requests)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const firstIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
    return firstIp;
  }

  // Fall back to direct connection
  return req.ip || req.socket?.remoteAddress;
}

// ============================================================================
// PUBLIC ROUTES
// ============================================================================

/**
 * POST /api/feedback/beta
 * Submit beta feedback (bug report or feature suggestion)
 */
router.post('/', async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || uuidv4();
  
  // Check feature flag
  if (!isBetaFeedbackEnabled()) {
    return res.status(404).json({
      ok: false,
      error: 'Beta feedback is not currently available',
      requestId,
    });
  }

  try {
    // Validate payload
    const validated = await betaFeedbackSchema.parseAsync(req.body);
    
    // Generate refId if not provided
    const refId = validated.refId || uuidv4();
    
    // Get client IP
    const ipAddress = getClientIpAddress(req);

    // Log feedback receipt (no sensitive data)
    apiLogger.info('Beta feedback received', {
      requestId,
      refId,
      type: validated.type,
      hasRecaptcha: !!validated.recaptchaToken,
    });

    // Build input for service
    const input: BetaFeedbackInput = {
      type: validated.type,
      title: validated.title,
      description: validated.description,
      pageUrl: validated.pageUrl,
      userEmail: validated.userEmail,
      userId: validated.userId,
      language: validated.language,
      appEnv: validated.appEnv,
      appVersion: validated.appVersion,
      userAgent: validated.userAgent,
      allowFollowUp: validated.allowFollowUp,
      refId,
      recaptchaToken: validated.recaptchaToken,
      ipAddress,
    };

    // Add bug-specific fields
    if (validated.type === 'bug') {
      input.severity = validated.severity;
      input.frequency = validated.frequency;
      input.stepsToReproduce = validated.stepsToReproduce;
      input.expectedBehavior = validated.expectedBehavior;
      input.actualBehavior = validated.actualBehavior;
    }

    // Add feature-specific fields
    if (validated.type === 'feature') {
      input.priority = validated.priority;
      input.targetUser = validated.targetUser;
      input.goal = validated.goal;
      input.alternativesTried = validated.alternativesTried;
    }

    // Create in database (idempotent by refId)
    const result = await createBetaFeedback(input);

    if (!result.success) {
      apiLogger.error('Failed to persist beta feedback', {
        requestId,
        refId,
        error: result.error,
      });
      return res.status(500).json({
        ok: false,
        error: 'Failed to save feedback',
        requestId,
      });
    }

    // Log success
    apiLogger.info('Beta feedback persisted', {
      requestId,
      refId,
      dbId: result.feedback?.id,
      isDuplicate: result.isDuplicate,
    });

    // Return success to user
    return res.status(result.isDuplicate ? 200 : 201).json({
      ok: true,
      refId,
      message: result.isDuplicate 
        ? 'Feedback already received' 
        : 'Thank you for your feedback!',
      requestId,
    });

  } catch (error: unknown) {
    // Handle Zod validation errors
    if (error instanceof ZodError) {
      const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
      const refIdFromBody = typeof body.refId === 'string' ? body.refId : undefined;
      const typeFromBody = typeof body.type === 'string' ? body.type : undefined;
      const titleLength = typeof body.title === 'string' ? body.title.trim().length : undefined;
      const descriptionLength = typeof body.description === 'string' ? body.description.trim().length : undefined;
      const userIdFromBody = typeof body.userId === 'string' ? body.userId : undefined;
      const userEmailFromBody = typeof body.userEmail === 'string' ? body.userEmail : undefined;
      const userEmailDomain = userEmailFromBody?.includes('@') ? userEmailFromBody.split('@').pop() : undefined;

      apiLogger.warn('Beta feedback validation failed', {
        requestId,
        method: req.method,
        path: req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`,
        refId: refIdFromBody,
        type: typeFromBody,
        titleLength,
        descriptionLength,
        userId: userIdFromBody,
        userEmailDomain,
        issues: error.issues.map(i => ({ path: i.path, message: i.message })),
      });
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        issues: error.issues.map(i => ({
          field: i.path.join('.'),
          message: i.message,
        })),
        requestId,
      });
    }

    // Handle unexpected errors
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    apiLogger.error('Beta feedback unexpected error', {
      requestId,
      error: errorMessage,
    });

    return res.status(500).json({
      ok: false,
      error: 'An unexpected error occurred',
      requestId,
    });
  }
});

/**
 * GET /api/feedback/beta/status
 * Check if beta feedback is enabled
 */
router.get('/status', (req: Request, res: Response) => {
  return res.json({
    ok: true,
    enabled: isBetaFeedbackEnabled(),
  });
});

// ============================================================================
// ADMIN ROUTES
// ============================================================================

/**
 * GET /api/feedback/beta/:refId
 * Get a specific feedback by refId (admin only)
 */
router.get('/:refId', requireAdminAuth, async (req: Request, res: Response) => {
  const { refId } = req.params;
  const requestId = uuidv4();

  try {
    // Service returns feedback directly (or null)
    const feedback = await getBetaFeedbackByRefId(refId);

    if (!feedback) {
      return res.status(404).json({
        ok: false,
        error: 'Feedback not found',
        requestId,
      });
    }

    return res.json({
      ok: true,
      feedback,
      requestId,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    apiLogger.error('Admin fetch feedback error', { requestId, refId, error: errorMessage });
    return res.status(500).json({
      ok: false,
      error: 'An unexpected error occurred',
      requestId,
    });
  }
});

/**
 * GET /api/feedback/beta
 * List feedback with optional filters (admin only)
 * 
 * Query params:
 * - type: 'bug' | 'feature'
 * - status: 'NEW' | 'TRIAGED' | 'DONE' | 'SPAM'
 * - startDate: ISO date string
 * - endDate: ISO date string
 * - search: text search in title/description
 * - limit: max results (default 50, max 200)
 * - offset: pagination offset
 */
router.get('/', requireAdminAuth, async (req: Request, res: Response) => {
  const requestId = uuidv4();

  try {
    const { type, status, startDate, endDate, search, limit, offset } = req.query;

    const filters: Parameters<typeof listBetaFeedback>[0] = {};

    if (type === 'bug' || type === 'feature') {
      filters.type = type;
    }

    if (status && typeof status === 'string') {
      const validStatuses = ['NEW', 'TRIAGED', 'DONE', 'SPAM'];
      if (validStatuses.includes(status.toUpperCase())) {
        filters.status = status.toUpperCase() as 'NEW' | 'TRIAGED' | 'DONE' | 'SPAM';
      }
    }

    // Service uses `from` and `to` for date range
    if (startDate && typeof startDate === 'string') {
      const date = new Date(startDate);
      if (!isNaN(date.getTime())) {
        filters.from = date;
      }
    }

    if (endDate && typeof endDate === 'string') {
      const date = new Date(endDate);
      if (!isNaN(date.getTime())) {
        filters.to = date;
      }
    }

    // Service uses `q` for text search
    if (search && typeof search === 'string') {
      filters.q = search;
    }

    if (limit && typeof limit === 'string') {
      const parsedLimit = parseInt(limit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        filters.limit = Math.min(parsedLimit, 200);
      }
    }

    if (offset && typeof offset === 'string') {
      const parsedOffset = parseInt(offset, 10);
      if (!isNaN(parsedOffset) && parsedOffset >= 0) {
        filters.offset = parsedOffset;
      }
    }

    // Service returns { items, total, limit, offset }
    const result = await listBetaFeedback(filters);

    return res.json({
      ok: true,
      feedback: result.items,
      total: result.total,
      requestId,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    apiLogger.error('Admin list feedback error', { requestId, error: errorMessage });
    return res.status(500).json({
      ok: false,
      error: 'An unexpected error occurred',
      requestId,
    });
  }
});

/**
 * PATCH /api/feedback/beta/:refId/status
 * Update feedback status (admin only)
 */
router.patch('/:refId/status', requireAdminAuth, async (req: Request, res: Response) => {
  const { refId } = req.params;
  const requestId = uuidv4();

  try {
    const statusSchema = z.object({
      status: z.enum(['NEW', 'TRIAGED', 'DONE', 'SPAM']),
    });

    const { status } = await statusSchema.parseAsync(req.body);

    // Service returns updated feedback directly (or null)
    const updatedFeedback = await updateBetaFeedbackStatus(refId, status);

    if (!updatedFeedback) {
      return res.status(404).json({
        ok: false,
        error: 'Feedback not found',
        requestId,
      });
    }

    apiLogger.info('Feedback status updated', { requestId, refId, status });

    return res.json({
      ok: true,
      feedback: updatedFeedback,
      requestId,
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid status value',
        issues: error.issues,
        requestId,
      });
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    apiLogger.error('Admin update status error', { requestId, refId, error: errorMessage });
    return res.status(500).json({
      ok: false,
      error: 'An unexpected error occurred',
      requestId,
    });
  }
});

export default router;
