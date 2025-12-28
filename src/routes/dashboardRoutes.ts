/**
 * Dashboard Routes
 * 
 * Unified dashboard endpoints for B2C candidates.
 * Provides a single endpoint that returns all dashboard data
 * with filtering support.
 * 
 * @module routes/dashboardRoutes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as candidateDashboardService from '../services/candidateDashboardService';
import * as resumeRepositoryService from '../services/resumeRepositoryService';
import { apiLogger } from '../utils/logger';

const router = Router();

// ========================================
// VALIDATION SCHEMAS
// ========================================

const dashboardQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  roleTitle: z.string().optional(),
  seniority: z.string().optional(),
  resumeId: z.string().uuid().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
});

// Clerk user ID schema (matches format: user_xxxxx)
const clerkUserIdSchema = z.string().regex(/^user_[a-zA-Z0-9]+$/, 'Invalid Clerk user ID format');

// ========================================
// MIDDLEWARE
// ========================================

/**
 * Extract Clerk user ID from request headers
 */
function getClerkUserId(req: Request): string | null {
  return (req.headers['x-user-id'] as string) || null;
}

/**
 * Require authentication middleware
 * Extracts and validates the Clerk user ID from headers
 */
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const clerkId = getClerkUserId(req);
  
  // Debug logging
  apiLogger.info('Dashboard auth check', {
    requestId: (req as any).requestId,
    clerkId: clerkId ? `${clerkId.slice(0, 15)}...` : null,
    hasXUserId: !!req.headers['x-user-id'],
    allHeaders: Object.keys(req.headers),
  });
  
  if (!clerkId) {
    apiLogger.warn('Dashboard auth failed - no user ID', {
      requestId: (req as any).requestId,
      headers: Object.keys(req.headers),
    });
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  
  // Validate Clerk ID format
  try {
    clerkUserIdSchema.parse(clerkId);
    (req as any).clerkUserId = clerkId;
    next();
  } catch (error) {
    apiLogger.warn('Dashboard auth failed - invalid user ID format', {
      requestId: (req as any).requestId,
      clerkIdPrefix: clerkId.slice(0, 10),
    });
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Invalid user ID format',
    });
  }
}

// ========================================
// ROUTES
// ========================================

/**
 * GET /api/dashboard/candidate
 * 
 * Unified dashboard endpoint for B2C candidates.
 * Returns all dashboard data in a single response with optional filtering.
 * 
 * Query params:
 * - startDate: ISO date string for filter start
 * - endDate: ISO date string for filter end
 * - roleTitle: Filter by role/job title
 * - seniority: Filter by seniority level
 * - resumeId: Filter by resume used
 * - limit: Max number of recent interviews (default 10)
 */
router.get('/candidate', requireAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;

  try {
    // Validate query parameters
    const parseResult = dashboardQuerySchema.safeParse(req.query);
    
    if (!parseResult.success) {
      apiLogger.warn('Invalid dashboard query params', {
        requestId,
        errors: parseResult.error.errors,
      });
      return res.status(400).json({
        status: 'error',
        code: 'VALIDATION_ERROR',
        message: 'Invalid query parameters',
        errors: parseResult.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const { startDate, endDate, roleTitle, seniority, resumeId, limit } = parseResult.data;

    apiLogger.info('Fetching candidate dashboard', {
      requestId,
      clerkId: clerkId.slice(0, 15),
      hasFilters: !!(startDate || endDate || roleTitle || seniority || resumeId),
    });

    const filters = {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      roleTitle,
      seniority,
      resumeId,
    };

    const dashboard = await candidateDashboardService.getCandidateDashboard(
      clerkId,
      filters,
      limit || 10
    );

    if (!dashboard) {
      return res.status(404).json({
        status: 'error',
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    res.json({
      status: 'success',
      data: dashboard,
    });
  } catch (error: any) {
    apiLogger.error('Dashboard fetch failed', {
      requestId,
      error: error.message,
    });
    res.status(500).json({
      status: 'error',
      code: 'DASHBOARD_ERROR',
      message: 'Failed to fetch dashboard data',
      requestId,
    });
  }
});

/**
 * GET /api/dashboard/candidate/spending
 * 
 * Get spending history by month.
 * 
 * Query params:
 * - months: Number of months to include (default 6)
 */
router.get('/candidate/spending', requireAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;

  try {
    const months = parseInt(req.query.months as string) || 6;

    const spendingHistory = await candidateDashboardService.getSpendingHistory(clerkId, months);

    res.json({
      status: 'success',
      data: spendingHistory,
    });
  } catch (error: any) {
    apiLogger.error('Spending history fetch failed', {
      requestId,
      error: error.message,
    });
    res.status(500).json({
      status: 'error',
      code: 'SPENDING_ERROR',
      message: 'Failed to fetch spending history',
      requestId,
    });
  }
});

/**
 * GET /api/resumes/:resumeId/download
 * 
 * Download a resume file.
 * Returns the resume file for download.
 */
router.get('/resumes/:resumeId/download', requireAuth, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;
  const { resumeId } = req.params;

  try {
    // Get resume with data
    const resume = await resumeRepositoryService.getResumeById(clerkId, resumeId, true);

    if (!resume) {
      return res.status(404).json({
        status: 'error',
        code: 'RESUME_NOT_FOUND',
        message: 'Resume not found',
      });
    }

    // Return as downloadable file
    res.json({
      status: 'success',
      data: {
        fileName: resume.fileName,
        mimeType: resume.mimeType,
        base64: resume.base64Data,
      },
    });
  } catch (error: any) {
    apiLogger.error('Resume download failed', {
      requestId,
      resumeId,
      error: error.message,
    });
    res.status(500).json({
      status: 'error',
      code: 'DOWNLOAD_ERROR',
      message: 'Failed to download resume',
      requestId,
    });
  }
});

export default router;
