/**
 * Beta Feedback Service
 *
 * Handles persistence and retrieval of closed beta feedback (bugs & features).
 * Includes reCAPTCHA verification and user mapping.
 *
 * @module services/betaFeedbackService
 */

import { PrismaClient, BetaFeedbackType, BetaFeedbackStatus, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const feedbackLogger = logger.child({ component: 'beta-feedback' });

// ========================================
// TYPES
// ========================================

export interface BetaFeedbackInput {
  type: 'bug' | 'feature';
  title: string;
  description: string;
  // Bug-specific
  severity?: 'low' | 'medium' | 'high' | 'blocking';
  frequency?: 'always' | 'sometimes' | 'once';
  stepsToReproduce?: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  // Feature-specific
  priority?: 'nice-to-have' | 'important' | 'critical';
  targetUser?: 'self' | 'recruiters' | 'other';
  goal?: string;
  alternativesTried?: string;
  // Metadata
  pageUrl: string;
  userEmail: string;
  userId?: string; // Clerk userId
  language: string;
  appEnv: string;
  appVersion: string;
  userAgent?: string;
  allowFollowUp: boolean;
  refId?: string;
  // Request context
  ipAddress?: string;
  // reCAPTCHA
  recaptchaToken?: string;
}

export interface RecaptchaVerificationResult {
  success: boolean;
  score?: number;
  action?: string;
  challengeTs?: string;
  hostname?: string;
  errorCodes?: string[];
}

export interface BetaFeedbackResult {
  success: boolean;
  feedback?: {
    id: string;
    refId: string;
    type: string;
    title: string;
    status: string;
    createdAt: Date;
  };
  error?: string;
  isDuplicate?: boolean;
}

export interface BetaFeedbackListParams {
  type?: 'bug' | 'feature';
  status?: 'NEW' | 'TRIAGED' | 'DONE' | 'SPAM';
  from?: Date;
  to?: Date;
  q?: string;
  limit?: number;
  offset?: number;
}

// ========================================
// RECAPTCHA VERIFICATION
// ========================================

const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const RECAPTCHA_SPAM_THRESHOLD = 0.5;

/**
 * Verify reCAPTCHA token with Google
 * Returns null if verification is disabled or fails
 */
export async function verifyRecaptcha(token: string): Promise<RecaptchaVerificationResult | null> {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  if (!secretKey) {
    feedbackLogger.debug('reCAPTCHA verification skipped - no secret key configured');
    return null;
  }

  if (!token) {
    feedbackLogger.debug('reCAPTCHA verification skipped - no token provided');
    return null;
  }

  try {
    const params = new URLSearchParams({
      secret: secretKey,
      response: token,
    });

    const response = await fetch(RECAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      feedbackLogger.warn('reCAPTCHA API returned non-OK status', { status: response.status });
      return null;
    }

    const data = await response.json() as {
      success: boolean;
      score?: number;
      action?: string;
      challenge_ts?: string;
      hostname?: string;
      'error-codes'?: string[];
    };

    const result: RecaptchaVerificationResult = {
      success: data.success,
      score: data.score,
      action: data.action,
      challengeTs: data.challenge_ts,
      hostname: data.hostname,
      errorCodes: data['error-codes'],
    };

    feedbackLogger.debug('reCAPTCHA verification result', {
      success: result.success,
      score: result.score,
      action: result.action,
    });

    return result;
  } catch (error: any) {
    feedbackLogger.error('reCAPTCHA verification failed', { error: error.message });
    return null;
  }
}

// ========================================
// USER MAPPING
// ========================================

/**
 * Attempt to find Vocaid user by Clerk userId
 * Returns UUID if found, null otherwise
 */
async function mapClerkUserToVocaidUser(clerkUserId?: string): Promise<string | null> {
  if (!clerkUserId) return null;

  try {
    // Try to find user by googleId (Clerk typically uses this for OAuth)
    // or by checking authProviders array
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { googleId: clerkUserId },
          // If Clerk uses email-based lookup, we could also try that
        ],
      },
      select: { id: true },
    });

    if (user) {
      feedbackLogger.debug('Mapped Clerk user to Vocaid user', { clerkUserId, vocaidUserId: user.id });
      return user.id;
    }

    feedbackLogger.debug('No Vocaid user found for Clerk userId', { clerkUserId });
    return null;
  } catch (error: any) {
    feedbackLogger.warn('Failed to map Clerk user', { clerkUserId, error: error.message });
    return null;
  }
}

// ========================================
// ENUM MAPPING
// ========================================

function mapSeverity(severity?: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING' | undefined {
  if (!severity) return undefined;
  const map: Record<string, 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING'> = {
    low: 'LOW',
    medium: 'MEDIUM',
    high: 'HIGH',
    blocking: 'BLOCKING',
  };
  return map[severity.toLowerCase()];
}

function mapFrequency(frequency?: string): 'ALWAYS' | 'SOMETIMES' | 'ONCE' | undefined {
  if (!frequency) return undefined;
  const map: Record<string, 'ALWAYS' | 'SOMETIMES' | 'ONCE'> = {
    always: 'ALWAYS',
    sometimes: 'SOMETIMES',
    once: 'ONCE',
  };
  return map[frequency.toLowerCase()];
}

function mapPriority(priority?: string): 'NICE_TO_HAVE' | 'IMPORTANT' | 'CRITICAL' | undefined {
  if (!priority) return undefined;
  const map: Record<string, 'NICE_TO_HAVE' | 'IMPORTANT' | 'CRITICAL'> = {
    'nice-to-have': 'NICE_TO_HAVE',
    important: 'IMPORTANT',
    critical: 'CRITICAL',
  };
  return map[priority.toLowerCase()];
}

function mapTargetUser(targetUser?: string): 'SELF' | 'RECRUITERS' | 'OTHER' | undefined {
  if (!targetUser) return undefined;
  const map: Record<string, 'SELF' | 'RECRUITERS' | 'OTHER'> = {
    self: 'SELF',
    recruiters: 'RECRUITERS',
    other: 'OTHER',
  };
  return map[targetUser.toLowerCase()];
}

// ========================================
// CREATE FEEDBACK
// ========================================

/**
 * Create or retrieve beta feedback (idempotent by refId)
 */
export async function createBetaFeedback(input: BetaFeedbackInput): Promise<BetaFeedbackResult> {
  const refId = input.refId || uuidv4();

  feedbackLogger.info('Creating beta feedback', {
    refId,
    type: input.type,
    title: input.title,
    userEmail: input.userEmail,
  });

  try {
    // Check for existing feedback with same refId (idempotency)
    const existing = await prisma.betaFeedback.findUnique({
      where: { refId },
      select: {
        id: true,
        refId: true,
        type: true,
        title: true,
        status: true,
        createdAt: true,
      },
    });

    if (existing) {
      feedbackLogger.info('Duplicate feedback submission (idempotent)', { refId, existingId: existing.id });
      return {
        success: true,
        feedback: {
          id: existing.id,
          refId: existing.refId,
          type: existing.type,
          title: existing.title,
          status: existing.status,
          createdAt: existing.createdAt,
        },
        isDuplicate: true,
      };
    }

    // Verify reCAPTCHA if token provided
    let recaptchaResult: RecaptchaVerificationResult | null = null;
    let status: BetaFeedbackStatus = 'NEW';

    if (input.recaptchaToken) {
      recaptchaResult = await verifyRecaptcha(input.recaptchaToken);

      // If verification succeeded but score is below threshold, mark as SPAM
      if (recaptchaResult?.success && recaptchaResult.score !== undefined) {
        if (recaptchaResult.score < RECAPTCHA_SPAM_THRESHOLD) {
          feedbackLogger.info('Low reCAPTCHA score - marking as SPAM', {
            refId,
            score: recaptchaResult.score,
            threshold: RECAPTCHA_SPAM_THRESHOLD,
          });
          status = 'SPAM';
        }
      }
    }

    // Map Clerk user to Vocaid user (best effort)
    const vocaidUserId = await mapClerkUserToVocaidUser(input.userId);

    // Build feedback data
    const feedbackType: BetaFeedbackType = input.type === 'bug' ? 'BUG' : 'FEATURE';

    const data: Prisma.BetaFeedbackCreateInput = {
      refId,
      type: feedbackType,
      title: input.title.trim(),
      description: input.description,
      status,
      source: 'web',

      // Bug-specific fields
      severity: input.type === 'bug' ? mapSeverity(input.severity) : undefined,
      frequency: input.type === 'bug' ? mapFrequency(input.frequency) : undefined,
      stepsToReproduce: input.type === 'bug' && input.stepsToReproduce?.length
        ? input.stepsToReproduce
        : undefined,
      expectedBehavior: input.type === 'bug' ? input.expectedBehavior : undefined,
      actualBehavior: input.type === 'bug' ? input.actualBehavior : undefined,

      // Feature-specific fields
      priority: input.type === 'feature' ? mapPriority(input.priority) : undefined,
      targetUser: input.type === 'feature' ? mapTargetUser(input.targetUser) : undefined,
      goal: input.type === 'feature' ? input.goal : undefined,
      alternativesTried: input.type === 'feature' ? input.alternativesTried : undefined,

      // Metadata
      pageUrl: input.pageUrl,
      userEmail: input.userEmail.toLowerCase().trim(),
      clerkUserId: input.userId,
      language: input.language || 'en',
      appEnv: input.appEnv || 'development',
      appVersion: input.appVersion || '0.0.0',
      userAgent: input.userAgent?.substring(0, 500),
      allowFollowUp: input.allowFollowUp ?? false,
      ipAddress: input.ipAddress,

      // reCAPTCHA results (if available)
      recaptchaScore: recaptchaResult?.score,
      recaptchaAction: recaptchaResult?.action,
      recaptchaVerifiedAt: recaptchaResult?.success ? new Date() : undefined,
      recaptchaRaw: recaptchaResult ? {
        success: recaptchaResult.success,
        score: recaptchaResult.score,
        action: recaptchaResult.action,
        hostname: recaptchaResult.hostname,
        errorCodes: recaptchaResult.errorCodes,
      } : undefined,

      // User FK (if mapped)
      vocaidUser: vocaidUserId ? { connect: { id: vocaidUserId } } : undefined,
    };

    const feedback = await prisma.betaFeedback.create({
      data,
      select: {
        id: true,
        refId: true,
        type: true,
        title: true,
        status: true,
        createdAt: true,
      },
    });

    feedbackLogger.info('Beta feedback created successfully', {
      id: feedback.id,
      refId: feedback.refId,
      type: feedback.type,
      status: feedback.status,
    });

    return {
      success: true,
      feedback: {
        id: feedback.id,
        refId: feedback.refId,
        type: feedback.type,
        title: feedback.title,
        status: feedback.status,
        createdAt: feedback.createdAt,
      },
    };
  } catch (error: any) {
    // Handle unique constraint violation (concurrent duplicate)
    if (error.code === 'P2002' && error.meta?.target?.includes('ref_id')) {
      feedbackLogger.info('Concurrent duplicate feedback submission', { refId });
      const existing = await prisma.betaFeedback.findUnique({
        where: { refId },
        select: {
          id: true,
          refId: true,
          type: true,
          title: true,
          status: true,
          createdAt: true,
        },
      });

      if (existing) {
        return {
          success: true,
          feedback: {
            id: existing.id,
            refId: existing.refId,
            type: existing.type,
            title: existing.title,
            status: existing.status,
            createdAt: existing.createdAt,
          },
          isDuplicate: true,
        };
      }
    }

    feedbackLogger.error('Failed to create beta feedback', { refId, error: error.message });
    return {
      success: false,
      error: 'Failed to save feedback. Please try again.',
    };
  }
}

// ========================================
// GET FEEDBACK BY REFID
// ========================================

export async function getBetaFeedbackByRefId(refId: string) {
  try {
    const feedback = await prisma.betaFeedback.findUnique({
      where: { refId },
    });
    return feedback;
  } catch (error: any) {
    feedbackLogger.error('Failed to get beta feedback', { refId, error: error.message });
    return null;
  }
}

// ========================================
// LIST FEEDBACK (ADMIN)
// ========================================

export async function listBetaFeedback(params: BetaFeedbackListParams = {}) {
  const { type, status, from, to, q, limit = 50, offset = 0 } = params;

  try {
    const where: Prisma.BetaFeedbackWhereInput = {};

    if (type) {
      where.type = type === 'bug' ? 'BUG' : 'FEATURE';
    }

    if (status) {
      where.status = status;
    }

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { userEmail: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.betaFeedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
        select: {
          id: true,
          refId: true,
          type: true,
          title: true,
          description: true,
          severity: true,
          priority: true,
          status: true,
          userEmail: true,
          pageUrl: true,
          appEnv: true,
          recaptchaScore: true,
          allowFollowUp: true,
          createdAt: true,
        },
      }),
      prisma.betaFeedback.count({ where }),
    ]);

    return { items, total, limit: Math.min(limit, 100), offset };
  } catch (error: any) {
    feedbackLogger.error('Failed to list beta feedback', { error: error.message });
    return { items: [], total: 0, limit, offset };
  }
}

// ========================================
// UPDATE FEEDBACK STATUS (ADMIN)
// ========================================

export async function updateBetaFeedbackStatus(
  refId: string,
  status: 'NEW' | 'TRIAGED' | 'DONE' | 'SPAM'
) {
  try {
    const feedback = await prisma.betaFeedback.update({
      where: { refId },
      data: { status },
      select: {
        id: true,
        refId: true,
        status: true,
        updatedAt: true,
      },
    });

    feedbackLogger.info('Beta feedback status updated', { refId, status });
    return feedback;
  } catch (error: any) {
    feedbackLogger.error('Failed to update beta feedback status', { refId, error: error.message });
    return null;
  }
}

export default {
  createBetaFeedback,
  getBetaFeedbackByRefId,
  listBetaFeedback,
  updateBetaFeedbackStatus,
  verifyRecaptcha,
};
