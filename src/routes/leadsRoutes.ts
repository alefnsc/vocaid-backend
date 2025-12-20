/**
 * Leads Routes
 * API endpoints for lead capture (demo requests, early access signups)
 * These endpoints are PUBLIC - no authentication required
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { LeadType, LeadSource } from '@prisma/client';
import * as leadsService from '../services/leadsService';
import logger from '../utils/logger';

const router = Router();
const leadsLogger = logger.child({ component: 'leads-routes' });

// ========================================
// VALIDATION SCHEMAS
// ========================================

const createDemoRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Valid email is required'),
  company: z.string().min(1, 'Company is required').max(100),
  teamSize: z.string().optional(),
  useCase: z.string().optional(),
});

const createEarlyAccessSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Valid email is required'),
  company: z.string().max(100).optional(),
  phone: z.string().max(20).optional(),
  interestedModules: z.array(z.string()).optional().default([]),
});

// ========================================
// MIDDLEWARE
// ========================================

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
        return res.status(400).json({
          status: 'error',
          message: 'Validation failed',
          errors: error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      next(error);
    }
  };
}

/**
 * Extract tracking info from request
 */
function getTrackingInfo(req: Request): {
  ipAddress: string | undefined;
  userAgent: string | undefined;
  referrer: string | undefined;
} {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedIp = typeof forwardedFor === 'string' 
    ? forwardedFor.split(',')[0]?.trim() 
    : Array.isArray(forwardedFor) 
      ? forwardedFor[0]?.split(',')[0]?.trim() 
      : undefined;
      
  const refererHeader = req.headers['referer'] || req.headers['referrer'];
  
  return {
    ipAddress: forwardedIp || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    referrer: typeof refererHeader === 'string' ? refererHeader : Array.isArray(refererHeader) ? refererHeader[0] : undefined,
  };
}

// ========================================
// ROUTES
// ========================================

/**
 * POST /leads/demo-request
 * Submit a demo request (B2B sales lead)
 */
router.post(
  '/demo-request',
  validate(createDemoRequestSchema),
  async (req: Request, res: Response) => {
    try {
      const { name, email, company, teamSize, useCase } = req.body;
      const tracking = getTrackingInfo(req);

      leadsLogger.info('Demo request received', {
        email,
        company,
      });

      const result = await leadsService.createLead({
        name,
        email,
        company,
        teamSize,
        useCase,
        type: LeadType.DEMO_REQUEST,
        source: LeadSource.LANDING_PAGE,
        ...tracking,
      });

      if (!result.success) {
        return res.status(500).json({
          status: 'error',
          message: result.error || 'Failed to submit demo request',
        });
      }

      // Return success (don't reveal if duplicate)
      res.status(201).json({
        status: 'success',
        message: 'Demo request submitted successfully. We will contact you within 24 hours.',
        data: {
          id: result.lead?.id,
        },
      });
    } catch (error: any) {
      leadsLogger.error('Error processing demo request', {
        error: error.message,
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to submit demo request',
      });
    }
  }
);

/**
 * POST /leads/early-access
 * Submit early access signup for B2B modules
 */
router.post(
  '/early-access',
  validate(createEarlyAccessSchema),
  async (req: Request, res: Response) => {
    try {
      const { name, email, company, phone, interestedModules } = req.body;
      const tracking = getTrackingInfo(req);

      leadsLogger.info('Early access request received', {
        email,
        interestedModules,
      });

      const result = await leadsService.createLead({
        name,
        email,
        company,
        phone,
        interestedModules,
        type: LeadType.EARLY_ACCESS,
        source: LeadSource.PLATFORM_SHOWCASE,
        ...tracking,
      });

      if (!result.success) {
        return res.status(500).json({
          status: 'error',
          message: result.error || 'Failed to submit early access request',
        });
      }

      res.status(201).json({
        status: 'success',
        message: "You're on the list! We'll notify you when early access opens.",
        data: {
          id: result.lead?.id,
        },
      });
    } catch (error: any) {
      leadsLogger.error('Error processing early access request', {
        error: error.message,
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to submit early access request',
      });
    }
  }
);

/**
 * GET /leads/stats
 * Get lead statistics (protected - for internal dashboards)
 * TODO: Add admin authentication
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await leadsService.getLeadStats();
    
    res.json({
      status: 'success',
      data: stats,
    });
  } catch (error: any) {
    leadsLogger.error('Error fetching lead stats', {
      error: error.message,
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch lead statistics',
    });
  }
});

export default router;
