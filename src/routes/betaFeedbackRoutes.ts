/**
 * Beta Feedback Routes
 * 
 * Handles closed beta feedback submissions (bugs and feature requests).
 * Forwards validated data to Formspree for collection.
 * 
 * This route is feature-flagged and can be disabled post-beta.
 */

import { Router, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { apiLogger } from '../utils/logger';

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
// FORMSPREE SUBMISSION
// ============================================================================

interface FormspreePayload {
  _subject: string;
  feedbackType: string;
  title: string;
  description: string;
  email: string;
  refId: string;
  metadata: string;
  details: string;
}

async function submitToFormspree(
  payload: BetaFeedbackPayload,
  refId: string,
  requestId: string
): Promise<{ success: boolean; error?: string }> {
  const formspreeUrl = process.env.FORMSPREE_BETA_FEEDBACK_URL;
  
  if (!formspreeUrl) {
    apiLogger.warn('Formspree URL not configured, logging feedback only', { requestId, refId });
    return { success: true }; // Log-only mode
  }

  // Build the _subject with clear [Bug] or [Feature] prefix
  // Format: [Bug] <Title> OR [Feature] <Title>
  const tag = payload.type === 'bug' ? '[Bug]' : '[Feature]';
  const subject = `${tag} ${payload.title.trim()}`;
  
  // Dev logging for diagnostics (non-PII)
  if (process.env.NODE_ENV === 'development') {
    apiLogger.debug('Formspree submission payload', {
      requestId,
      refId,
      type: payload.type,
      subjectPrefix: tag,
      hasTitle: !!payload.title,
    });
  }
  
  // Build details section based on type
  let detailsMarkdown = '';
  if (payload.type === 'bug') {
    detailsMarkdown = [
      `**Severity:** ${payload.severity}`,
      payload.frequency ? `**Frequency:** ${payload.frequency}` : '',
      payload.stepsToReproduce?.length 
        ? `**Steps to Reproduce:**\n${payload.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n')}` 
        : '',
      payload.expectedBehavior ? `**Expected Behavior:**\n${payload.expectedBehavior}` : '',
      payload.actualBehavior ? `**Actual Behavior:**\n${payload.actualBehavior}` : '',
    ].filter(Boolean).join('\n\n');
  } else {
    detailsMarkdown = [
      payload.priority ? `**Priority:** ${payload.priority}` : '',
      payload.targetUser ? `**Target User:** ${payload.targetUser}` : '',
      payload.goal ? `**Goal/Problem it Solves:**\n${payload.goal}` : '',
      payload.alternativesTried ? `**Alternatives Tried:**\n${payload.alternativesTried}` : '',
    ].filter(Boolean).join('\n\n');
  }

  // Build metadata
  const metadata = [
    `**Reference ID:** ${refId}`,
    `**Submitted At:** ${new Date().toISOString()}`,
    `**Page URL:** ${payload.pageUrl}`,
    `**User Email:** ${payload.userEmail}`,
    payload.userId ? `**User ID:** ${payload.userId}` : '',
    `**Language:** ${payload.language}`,
    `**Environment:** ${payload.appEnv}`,
    `**App Version:** ${payload.appVersion}`,
    `**Allow Follow-up:** ${payload.allowFollowUp ? 'Yes' : 'No'}`,
    `**User Agent:** ${payload.userAgent}`,
  ].filter(Boolean).join('\n');

  const formspreePayload: FormspreePayload = {
    _subject: subject,
    feedbackType: payload.type,
    title: payload.title,
    description: payload.description,
    email: payload.userEmail,
    refId,
    metadata,
    details: detailsMarkdown,
  };

  try {
    const response = await fetch(formspreeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(formspreePayload),
    });

    if (response.ok) {
      return { success: true };
    }

    const errorData = await response.json().catch(() => ({})) as { error?: string };
    apiLogger.error('Formspree submission failed', { 
      requestId, 
      refId, 
      status: response.status,
      error: errorData 
    });
    return { success: false, error: errorData.error || 'Formspree submission failed' };
  } catch (error) {
    apiLogger.error('Formspree network error', { requestId, refId, error });
    return { success: false, error: 'Network error during submission' };
  }
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * POST /api/feedback/beta
 * Submit beta feedback (bug report or feature suggestion)
 */
router.post('/', async (req: Request, res: Response) => {
  const requestId = uuidv4();
  
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
    
    // Generate or use provided refId
    const refId = validated.refId || uuidv4();
    
    // Log the feedback (always, regardless of Formspree)
    apiLogger.info('Beta feedback received', {
      requestId,
      refId,
      type: validated.type,
      title: validated.title,
      severity: validated.type === 'bug' ? validated.severity : undefined,
      priority: validated.type === 'feature' ? validated.priority : undefined,
      userEmail: validated.userEmail,
      userId: validated.userId,
      pageUrl: validated.pageUrl,
      appEnv: validated.appEnv,
    });

    // Submit to Formspree
    const formspreeResult = await submitToFormspree(validated, refId, requestId);

    if (!formspreeResult.success) {
      // Log error but still return success (we have the feedback logged)
      apiLogger.warn('Formspree failed but feedback logged', { 
        requestId, 
        refId, 
        error: formspreeResult.error 
      });
    }

    return res.status(200).json({
      ok: true,
      refId,
      message: 'Thank you for your feedback!',
      requestId,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      apiLogger.warn('Beta feedback validation failed', { 
        requestId, 
        errors: error.errors 
      });
      return res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
        requestId,
      });
    }

    apiLogger.error('Beta feedback submission error', { requestId, error });
    return res.status(500).json({
      ok: false,
      error: 'Failed to submit feedback. Please try again.',
      requestId,
    });
  }
});

/**
 * GET /api/feedback/beta/status
 * Check if beta feedback is enabled
 */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    enabled: isBetaFeedbackEnabled(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
