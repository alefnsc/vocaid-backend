/**
 * Leads Routes
 *
 * Lead capture backed by Prisma Lead model.
 * Handles early access signups and demo requests.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { CompanySizeTier } from '@prisma/client';
import { createLead, getLeadStats } from '../services/leadsService';
import logger from '../utils/logger';

const router = Router();
const leadsLogger = logger.child({ component: 'leads-routes' });

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function extractLeadReferrer(req: Request): string | undefined {
  const rawQueryRef: unknown = (req.query as any)?.ref;
  let queryRef: string | undefined;

  if (typeof rawQueryRef === 'string') {
    queryRef = rawQueryRef;
  } else if (Array.isArray(rawQueryRef) && typeof rawQueryRef[0] === 'string') {
    queryRef = rawQueryRef[0];
  }

  const trimmedQueryRef = queryRef?.trim();
  if (trimmedQueryRef) return trimmedQueryRef.slice(0, 500);

  const referer = normalizeHeaderValue(req.headers['referer'] as string | string[] | undefined);
  const trimmedReferer = referer?.trim();

  if (trimmedReferer) {
    try {
      const url = new URL(trimmedReferer);
      const refFromReferer = url.searchParams.get('ref')?.trim();
      if (refFromReferer) return refFromReferer.slice(0, 500);
    } catch {
      // ignore invalid URL
    }

    return trimmedReferer.slice(0, 500);
  }

  return undefined;
}

// ========================================
// VALIDATION SCHEMAS
// ========================================

const earlyAccessSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Invalid email address').max(320),
  companyName: z.string().max(200).optional(),
  companySizeTier: z.enum(['STARTUP', 'SMALL', 'MEDIUM', 'ENTERPRISE']).optional(),
  phoneE164: z.string().max(20).optional().refine(
    (val) => !val || /^\+[1-9]\d{6,14}$/.test(val),
    'Invalid phone number format'
  ),
  interestedModules: z.array(z.string()).min(1, 'At least one interest is required'),
});

const demoRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Invalid email address').max(320),
  company: z.string().max(200).optional(),
  teamSize: z.string().max(50).optional(),
  useCase: z.string().max(500).optional(),
});

// ========================================
// ROUTES
// ========================================

/**
 * POST /api/leads/early-access
 * Submit early access waitlist signup
 */
router.post('/early-access', async (req: Request, res: Response) => {
  const parsed = earlyAccessSchema.safeParse(req.body);

  if (!parsed.success) {
    const errorMessages = parsed.error.errors.map((e) => e.message).join(', ');
    leadsLogger.warn('Early access validation failed', { errors: errorMessages });
    return res.status(400).json({
      status: 'error',
      message: errorMessages,
    });
  }

  const { name, email, companyName, companySizeTier, phoneE164, interestedModules } = parsed.data;

  const result = await createLead({
    type: 'EARLY_ACCESS',
    name,
    email,
    companyName,
    companySizeTier: companySizeTier as CompanySizeTier | undefined,
    phoneE164,
    interestedModules,
    source: 'website_waitlist',
    ipAddress: req.ip || req.headers['x-forwarded-for']?.toString(),
    userAgent: req.headers['user-agent'],
    referrer: extractLeadReferrer(req),
  });

  if (!result.success) {
    return res.status(500).json({
      status: 'error',
      message: result.error || 'Failed to submit. Please try again.',
    });
  }

  leadsLogger.info('Early access lead submitted', { email, modules: interestedModules });

  return res.json({
    status: 'success',
    message: 'Successfully joined the waitlist!',
    data: { id: result.lead?.id },
  });
});

/**
 * POST /api/leads/demo-request
 * Submit a demo request (B2B sales lead)
 */
router.post('/demo-request', async (req: Request, res: Response) => {
  const parsed = demoRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    const errorMessages = parsed.error.errors.map((e) => e.message).join(', ');
    leadsLogger.warn('Demo request validation failed', { errors: errorMessages });
    return res.status(400).json({
      status: 'error',
      message: errorMessages,
    });
  }

  const { name, email, company, teamSize, useCase } = parsed.data;

  const result = await createLead({
    type: 'DEMO_REQUEST',
    name,
    email,
    companyName: company,
    interestedModules: useCase ? [useCase] : [],
    source: 'website_demo',
    ipAddress: req.ip || req.headers['x-forwarded-for']?.toString(),
    userAgent: req.headers['user-agent'],
    referrer: extractLeadReferrer(req),
  });

  if (!result.success) {
    return res.status(500).json({
      status: 'error',
      message: result.error || 'Failed to submit. Please try again.',
    });
  }

  leadsLogger.info('Demo request lead submitted', { email, company });

  return res.json({
    status: 'success',
    message: 'Demo request submitted successfully!',
    data: { id: result.lead?.id },
  });
});

/**
 * GET /api/leads/stats
 * Get lead statistics (internal/admin use)
 */
router.get('/stats', async (_req: Request, res: Response) => {
  const stats = await getLeadStats();
  return res.json({
    status: 'success',
    data: stats,
  });
});

export default router;
