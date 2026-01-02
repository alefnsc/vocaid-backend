/**
 * API Routes for Database Operations
 * RESTful endpoints for users, interviews, and payments
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

// Services
import * as userService from '../services/userService';
import * as interviewService from '../services/interviewService';
import * as paymentService from '../services/paymentService';
import * as analyticsService from '../services/analyticsService';
import { updateUserMetadata } from '../services/clerkService';
import { sendFeedbackEmail, sendAutomatedFeedbackEmail, shouldSendAutomatedEmail } from '../services/emailService';
import * as resumeRepositoryService from '../services/resumeRepositoryService';
import * as recordingPlaybackService from '../services/recordingPlaybackService';
import { dbLogger, prisma } from '../services/databaseService';
import { apiLogger } from '../utils/logger';

// Schemas
import {
  clerkUserIdSchema,
  uuidSchema,
  createInterviewSchema,
  updateInterviewSchema,
  interviewQuerySchema,
  paymentQuerySchema,
  dashboardQuerySchema
} from '../schemas/validation';

// Create router
const router = Router();

// ========================================
// HEALTH CHECK
// ========================================

/**
 * GET /api/health - API health check
 * Returns JSON to confirm API is working
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'vocaid-api'
  });
});

// ========================================
// MIDDLEWARE
// ========================================

/**
 * Zod validation middleware factory
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
      
      // Attach validated data
      if (source === 'body') req.body = validated;
      else if (source === 'params') (req as any).validatedParams = validated;
      else (req as any).validatedQuery = validated;
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        dbLogger.warn('Validation failed', { 
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
 * Extract Clerk user ID from request
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
  
  // Validate Clerk ID format
  try {
    clerkUserIdSchema.parse(clerkId);
    (req as any).clerkUserId = clerkId;
    next();
  } catch (error) {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid user ID format'
    });
  }
}

// ========================================
// USER ROUTES
// ========================================

/**
 * GET /api/users/me - Get current user profile
 */
router.get('/users/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    
    // Find or create user (syncs with Clerk)
    const user = await userService.findOrCreateUser(clerkId);
    
    res.json({
      status: 'success',
      data: user
    });
  } catch (error: any) {
    dbLogger.error('Error fetching user profile', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch user profile'
    });
  }
});

/**
 * POST /api/users/sync - Sync user from Clerk to database
 * Called by frontend on login to ensure user exists in database
 */
router.post('/users/sync', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const requestId = (req as any).requestId || 'N/A';
    
    apiLogger.info('User sync requested', { requestId, clerkId: clerkId.slice(0, 15) });
    
    // Find or create user (syncs with Clerk)
    const user = await userService.findOrCreateUser(clerkId);
    
    apiLogger.info('User synced successfully', { 
      requestId, 
      clerkId: clerkId.slice(0, 15),
      dbUserId: user.id 
    });
    
    res.json({
      status: 'success',
      message: 'User synced successfully',
      user: {
        id: user.id,
        clerkId: user.clerkId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        credits: user.credits,
        createdAt: user.createdAt
      }
    });
  } catch (error: any) {
    dbLogger.error('Error syncing user', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to sync user'
    });
  }
});

/**
 * POST /api/users/metadata - Update user public metadata (role, preferredLanguage)
 */
const userMetadataSchema = z.object({
  role: z.enum(['Recruiter', 'Candidate', 'Manager']).optional(),
  preferredLanguage: z.string().min(2).max(10).optional(),
}).refine((data) => data.role || data.preferredLanguage, {
  message: 'At least one field (role or preferredLanguage) must be provided',
});

router.post('/users/metadata', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    
    // Validate request body
    const result = userMetadataSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: result.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }
    
    const { role, preferredLanguage } = result.data;
    
    const updateResult = await updateUserMetadata(clerkId, { role, preferredLanguage });
    
    apiLogger.info('User metadata updated', { clerkId: clerkId.slice(0, 15), role, preferredLanguage });
    
    res.json({
      status: 'success',
      data: updateResult
    });
  } catch (error: any) {
    dbLogger.error('Error updating user metadata', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update user metadata'
    });
  }
});

/**
 * GET /api/users/me/dashboard - Get user dashboard data
 */
router.get('/users/me/dashboard', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    
    const dashboardStats = await userService.getUserDashboardStats(clerkId);
    
    if (!dashboardStats) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    res.json({
      status: 'success',
      data: dashboardStats
    });
  } catch (error: any) {
    dbLogger.error('Error fetching dashboard', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch dashboard data'
    });
  }
});

// ========================================
// INTERVIEW ROUTES
// ========================================

/**
 * GET /api/interviews - Get user's interviews
 */
router.get(
  '/interviews',
  requireAuth,
  validate(interviewQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery;
      const requestId = (req as any).requestId || 'N/A';
      
      apiLogger.info('Fetching interviews list', { 
        requestId, 
        userId: clerkId.slice(0, 15), 
        page: query.page, 
        limit: query.limit 
      });
      
      const result = await interviewService.getUserInterviews(clerkId, query);
      
      apiLogger.info('Interviews fetched successfully', {
        requestId,
        count: result.interviews.length,
        total: result.pagination.total,
        page: result.pagination.page
      });
      
      res.json({
        status: 'success',
        data: result.interviews,
        pagination: result.pagination
      });
    } catch (error: any) {
      apiLogger.error('Error fetching interviews', { 
        error: error.message,
        requestId: (req as any).requestId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch interviews'
      });
    }
  }
);

/**
 * GET /api/interviews/:interviewId - Get interview details
 */
router.get(
  '/interviews/:interviewId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const clerkId = (req as any).clerkUserId;
      const requestId = (req as any).requestId || 'N/A';
      
      apiLogger.info('Fetching interview details', { 
        requestId, 
        interviewId: interviewId.slice(0, 8) + '...',
        userId: clerkId.slice(0, 15)
      });
      
      // Validate UUID
      try {
        uuidSchema.parse(interviewId);
      } catch {
        apiLogger.warn('Invalid interview ID format', { requestId, interviewId });
        return res.status(400).json({
          status: 'error',
          message: 'Invalid interview ID format'
        });
      }
      
      const interview = await interviewService.getInterviewById(interviewId);
      
      if (!interview) {
        apiLogger.warn('Interview not found', { requestId, interviewId });
        return res.status(404).json({
          status: 'error',
          message: 'Interview not found'
        });
      }
      
      // Verify ownership
      if (interview.user.clerkId !== clerkId) {
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      // Transform interview data to frontend expected format
      const transformedInterview = {
        ...interview,
        // Build structured feedback object from metrics and feedbackText
        feedback: interview.score !== null ? {
          overallScore: interview.score || 0,
          // Extract category scores from metrics or use overall score as fallback
          contentScore: interview.metrics?.find(m => m.category === 'content')?.score ?? interview.score ?? 0,
          communicationScore: interview.metrics?.find(m => m.category === 'communication')?.score ?? interview.score ?? 0,
          confidenceScore: interview.metrics?.find(m => m.category === 'confidence')?.score ?? interview.score ?? 0,
          technicalScore: interview.metrics?.find(m => m.category === 'technical')?.score ?? interview.score ?? 0,
          summary: interview.feedbackText?.split('\n')[0] || 'Interview completed.',
          // Parse strengths, improvements, recommendations from feedbackText if available
          strengths: parseFeedbackSection(interview.feedbackText, 'Strengths'),
          improvements: parseFeedbackSection(interview.feedbackText, 'Areas for Improvement') || 
                       parseFeedbackSection(interview.feedbackText, 'Improvements'),
          recommendations: parseFeedbackSection(interview.feedbackText, 'Recommendations')
        } : null
      };
      
      apiLogger.info('Interview details fetched', {
        requestId,
        interviewId: interviewId.slice(0, 8) + '...',
        hasScore: interview.score !== null,
        hasFeedback: interview.feedbackText !== null,
        status: interview.status
      });
      
      res.json({
        status: 'success',
        data: transformedInterview
      });
    } catch (error: any) {
      apiLogger.error('Error fetching interview', { 
        error: error.message,
        requestId: (req as any).requestId
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch interview'
      });
    }
  }
);

/**
 * Helper function to parse feedback sections from markdown text
 */
function parseFeedbackSection(feedbackText: string | null, sectionName: string): string[] {
  if (!feedbackText) return [];
  
  const regex = new RegExp(`##\\s*${sectionName}[\\s\\S]*?(?=##|$)`, 'i');
  const match = feedbackText.match(regex);
  
  if (!match) return [];
  
  // Extract bullet points
  const items = match[0]
    .split('\n')
    .filter(line => line.trim().startsWith('-'))
    .map(line => line.replace(/^-\s*/, '').trim())
    .filter(item => item.length > 0);
  
  return items;
}

/**
 * POST /api/interviews - Create new interview
 */
router.post(
  '/interviews',
  requireAuth,
  validate(createInterviewSchema),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const data = req.body;
      const requestId = (req as any).requestId || 'N/A';
      
      apiLogger.info('Creating interview', {
        requestId,
        userId: clerkId,
        jobTitle: data.jobTitle,
        company: data.companyName,
        seniority: data.seniority,
        language: data.language,
        hasResume: !!data.resumeData,
        jobDescriptionLength: data.jobDescription?.length || 0
      });
      
      // Ensure user exists in database
      await userService.findOrCreateUser(clerkId);
      
      const interview = await interviewService.createInterview({
        ...data,
        userId: clerkId
      });
      
      apiLogger.info('Interview created successfully', {
        requestId,
        interviewId: interview.id,
        status: interview.status
      });
      
      res.status(201).json({
        status: 'success',
        data: interview
      });
    } catch (error: any) {
      const requestId = (req as any).requestId || 'N/A';
      apiLogger.error('Error creating interview', { 
        requestId,
        error: error.message,
        stack: error.stack,
        body: {
          jobTitle: req.body?.jobTitle,
          company: req.body?.companyName,
          seniority: req.body?.seniority,
          language: req.body?.language,
          jobDescriptionLength: req.body?.jobDescription?.length || 0
        }
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to create interview',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * PATCH /api/interviews/:interviewId - Update interview
 */
router.patch(
  '/interviews/:interviewId',
  requireAuth,
  validate(updateInterviewSchema),
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const clerkId = (req as any).clerkUserId;
      
      // Verify ownership
      const interview = await interviewService.getInterviewById(interviewId);
      if (!interview || interview.user.clerkId !== clerkId) {
        return res.status(404).json({
          status: 'error',
          message: 'Interview not found'
        });
      }
      
      const updated = await interviewService.updateInterview(interviewId, req.body);
      
      res.json({
        status: 'success',
        data: updated
      });
    } catch (error: any) {
      dbLogger.error('Error updating interview', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to update interview'
      });
    }
  }
);

/**
 * GET /api/interviews/:interviewId/download/feedback - Download interview feedback PDF
 */
router.get(
  '/interviews/:interviewId/download/feedback',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const clerkId = (req as any).clerkUserId;
      
      const interview = await interviewService.getInterviewForDownload(interviewId, clerkId);
      
      if (!interview) {
        return res.status(404).json({
          status: 'error',
          message: 'Interview not found'
        });
      }
      
      if (!interview.feedbackPdf) {
        return res.status(404).json({
          status: 'error',
          message: 'Feedback not available for this interview'
        });
      }
      
      // Return base64 PDF data
      res.json({
        status: 'success',
        data: {
          fileName: `vocaid-feedback-${interview.companyName}-${interview.jobTitle}.pdf`,
          contentType: 'application/pdf',
          base64: interview.feedbackPdf
        }
      });
    } catch (error: any) {
      dbLogger.error('Error downloading feedback', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to download feedback'
      });
    }
  }
);

/**
 * GET /api/interviews/:interviewId/download/resume - Download interview resume
 */
router.get(
  '/interviews/:interviewId/download/resume',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const clerkId = (req as any).clerkUserId;
      
      const interview = await interviewService.getInterviewForDownload(interviewId, clerkId);
      
      if (!interview) {
        return res.status(404).json({
          status: 'error',
          message: 'Interview not found'
        });
      }
      
      if (!interview.resumeData) {
        return res.status(404).json({
          status: 'error',
          message: 'Resume not available for this interview'
        });
      }
      
      res.json({
        status: 'success',
        data: {
          fileName: interview.resumeFileName || 'resume.pdf',
          contentType: interview.resumeMimeType || 'application/pdf',
          base64: interview.resumeData
        }
      });
    } catch (error: any) {
      dbLogger.error('Error downloading resume', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to download resume'
      });
    }
  }
);

/**
 * GET /api/interviews/stats - Get interview statistics
 */
router.get(
  '/interviews/stats',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      
      const stats = await interviewService.getInterviewStats(clerkId);
      
      if (!stats) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }
      
      res.json({
        status: 'success',
        data: stats
      });
    } catch (error: any) {
      dbLogger.error('Error fetching interview stats', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch statistics'
      });
    }
  }
);

// ========================================
// PAYMENT ROUTES
// ========================================

/**
 * GET /api/payments - Get user's payments
 */
router.get(
  '/payments',
  requireAuth,
  validate(paymentQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const query = (req as any).validatedQuery;
      
      const result = await paymentService.getUserPayments(clerkId, query);
      
      res.json({
        status: 'success',
        data: result.payments,
        pagination: result.pagination
      });
    } catch (error: any) {
      dbLogger.error('Error fetching payments', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch payments'
      });
    }
  }
);

/**
 * GET /api/payments/stats - Get payment statistics
 */
router.get(
  '/payments/stats',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      
      const stats = await paymentService.getPaymentStats(clerkId);
      
      if (!stats) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }
      
      res.json({
        status: 'success',
        data: stats
      });
    } catch (error: any) {
      dbLogger.error('Error fetching payment stats', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch payment statistics'
      });
    }
  }
);

// ========================================
// DASHBOARD API ROUTES (Used by Frontend)
// ========================================

/**
 * GET /api/users/:userId/stats - Get user dashboard stats (matches frontend API)
 */
router.get(
  '/users/:userId/stats',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const clerkId = (req as any).clerkUserId;
      const requestId = (req as any).requestId || 'N/A';
      
      apiLogger.info('Fetching dashboard stats', { 
        requestId, 
        userId: userId.slice(0, 15) 
      });
      
      // Verify user is accessing their own data
      if (userId !== clerkId) {
        apiLogger.warn('Access denied - user mismatch', { 
          requestId, 
          requestedUser: userId.slice(0, 15),
          actualUser: clerkId.slice(0, 15)
        });
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      const stats = await userService.getUserDashboardStats(clerkId);
      
      if (!stats) {
        apiLogger.warn('User not found for stats', { requestId, userId: userId.slice(0, 15) });
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }
      
      const responseData = {
        totalInterviews: stats.totalInterviews,
        completedInterviews: stats.totalInterviews,
        averageScore: stats.averageScore,
        totalSpent: stats.totalSpent,
        creditsRemaining: stats.credits,
        scoreChange: 0, // TODO: Calculate actual change
        interviewsThisMonth: 0 // TODO: Calculate
      };
      
      apiLogger.info('Dashboard stats fetched', {
        requestId,
        totalInterviews: stats.totalInterviews,
        avgScore: stats.averageScore,
        credits: stats.credits
      });
      
      // Format response for frontend
      res.json({
        status: 'success',
        data: responseData
      });
    } catch (error: any) {
      apiLogger.error('Error fetching user stats', { 
        error: error.message,
        requestId: (req as any).requestId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch user statistics'
      });
    }
  }
);

/**
 * GET /api/users/:userId/interviews - Get user's interviews (matches frontend API)
 */
router.get(
  '/users/:userId/interviews',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const clerkId = (req as any).clerkUserId;
      const { page = '1', limit = '10' } = req.query;
      const requestId = (req as any).requestId || 'N/A';
      
      apiLogger.info('Fetching user interviews list', { 
        requestId, 
        userId: userId.slice(0, 15),
        page,
        limit
      });
      
      // Verify user is accessing their own data
      if (userId !== clerkId) {
        apiLogger.warn('Access denied - user mismatch', { requestId });
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      const result = await interviewService.getUserInterviews(clerkId, {
        page: parseInt(page as string),
        limit: parseInt(limit as string)
      });
      
      // Format for frontend - include both field names for compatibility
      const formattedInterviews = result.interviews.map(i => ({
        id: i.id,
        // Primary field names (match InterviewSummary interface)
        jobTitle: i.jobTitle,
        companyName: i.companyName,
        // Legacy aliases for backward compatibility
        position: i.jobTitle,
        company: i.companyName,
        createdAt: i.createdAt,
        callDuration: i.callDuration, // Keep in milliseconds for frontend
        duration: Math.round((i.callDuration || 0) / 1000 / 60), // Legacy: minutes
        score: i.score,
        overallScore: i.score, // Legacy alias
        status: i.status,
        seniority: i.seniority,
        language: i.language,
        hasFeedback: i.hasFeedback
      }));
      
      apiLogger.info('User interviews fetched', {
        requestId,
        count: formattedInterviews.length,
        total: result.pagination.total
      });
      
      res.json({
        status: 'success',
        data: formattedInterviews,
        pagination: result.pagination
      });
    } catch (error: any) {
      apiLogger.error('Error fetching user interviews', { 
        error: error.message,
        requestId: (req as any).requestId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch interviews'
      });
    }
  }
);

/**
 * GET /api/users/:userId/payments - Get user's payments (matches frontend API)
 */
router.get(
  '/users/:userId/payments',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const clerkId = (req as any).clerkUserId;
      
      // Verify user is accessing their own data
      if (userId !== clerkId) {
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      const result = await paymentService.getUserPayments(clerkId, { limit: 50 });
      
      res.json({
        status: 'success',
        data: result.payments
      });
    } catch (error: any) {
      dbLogger.error('Error fetching user payments', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch payments'
      });
    }
  }
);

/**
 * GET /api/users/:userId/score-evolution - Get score evolution data
 */
router.get(
  '/users/:userId/score-evolution',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const clerkId = (req as any).clerkUserId;
      const { months = '6' } = req.query;
      const requestId = (req as any).requestId || 'N/A';
      
      apiLogger.info('Fetching score evolution', { 
        requestId, 
        userId: userId.slice(0, 15),
        months 
      });
      
      // Verify user is accessing their own data
      if (userId !== clerkId) {
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      const monthsAgo = new Date();
      monthsAgo.setMonth(monthsAgo.getMonth() - parseInt(months as string));
      
      const stats = await userService.getUserDashboardStats(clerkId);
      
      if (!stats) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found'
        });
      }
      
      // Filter score evolution within the time range
      const scoreEvolution = stats.scoreEvolution
        .filter(s => new Date(s.date) >= monthsAgo)
        .map(s => ({
          date: s.date,
          score: s.score,
          interviewId: '' // TODO: Include interview ID
        }));
      
      apiLogger.info('Score evolution fetched', {
        requestId,
        dataPoints: scoreEvolution.length
      });
      
      res.json({
        status: 'success',
        data: scoreEvolution
      });
    } catch (error: any) {
      apiLogger.error('Error fetching score evolution', { 
        error: error.message,
        requestId: (req as any).requestId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch score evolution'
      });
    }
  }
);

/**
 * GET /api/users/:userId/spending - Get spending history
 */
router.get(
  '/users/:userId/spending',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const clerkId = (req as any).clerkUserId;
      const { months = '6' } = req.query;
      
      // Verify user is accessing their own data
      if (userId !== clerkId) {
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      const result = await paymentService.getUserPayments(clerkId, {
        limit: 100 // Get all recent payments
      });
      
      // Group by month
      const monthsAgo = new Date();
      monthsAgo.setMonth(monthsAgo.getMonth() - parseInt(months as string));
      
      const monthlySpending: Record<string, number> = {};
      
      result.payments
        .filter(p => p.status === 'APPROVED' && new Date(p.createdAt) >= monthsAgo)
        .forEach(p => {
          const monthKey = new Date(p.createdAt).toLocaleDateString('en-US', { 
            month: 'short',
            year: '2-digit'
          });
          monthlySpending[monthKey] = (monthlySpending[monthKey] || 0) + p.amountUSD;
        });
      
      // Convert to array format
      const spendingData = Object.entries(monthlySpending).map(([month, amount]) => ({
        month,
        amount
      }));
      
      res.json({
        status: 'success',
        data: spendingData
      });
    } catch (error: any) {
      dbLogger.error('Error fetching spending history', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch spending history'
      });
    }
  }
);

// ========================================
// EMAIL ROUTES
// ========================================

/**
 * POST /api/interviews/:interviewId/send-feedback-email
 * Send interview feedback email to user
 */
router.post(
  '/interviews/:interviewId/send-feedback-email',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const clerkId = (req as any).clerkUserId;
      
      // Validate UUID
      try {
        uuidSchema.parse(interviewId);
      } catch {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid interview ID format'
        });
      }
      
      // Get interview with user data
      const interview = await interviewService.getInterviewById(interviewId);
      
      if (!interview) {
        return res.status(404).json({
          status: 'error',
          message: 'Interview not found'
        });
      }
      
      // Verify ownership
      if (interview.user.clerkId !== clerkId) {
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      // Check if interview has feedback
      if (!interview.score && !interview.feedbackText) {
        return res.status(400).json({
          status: 'error',
          message: 'No feedback available for this interview'
        });
      }
      
      // Send feedback email
      const result = await sendFeedbackEmail({
        toEmail: interview.user.email || '',
        candidateName: `${interview.user.firstName || ''} ${interview.user.lastName || ''}`.trim() || 'Candidate',
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        score: interview.score || 0,
        interviewId: interview.id,
        feedbackPdfBase64: interview.feedbackPdf,
        resumeBase64: interview.resumeData,
        resumeFileName: interview.resumeFileName,
        feedbackSummary: interview.feedbackText?.split('\n')[0] || undefined
      });
      
      if (!result.success) {
        dbLogger.error('Failed to send feedback email', { 
          interviewId, 
          error: result.error 
        });
        return res.status(500).json({
          status: 'error',
          message: result.error || 'Failed to send email'
        });
      }
      
      dbLogger.info('Feedback email sent', { 
        interviewId, 
        messageId: result.messageId 
      });
      
      res.json({
        status: 'success',
        message: 'Feedback email sent successfully',
        messageId: result.messageId
      });
    } catch (error: any) {
      dbLogger.error('Error sending feedback email', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to send feedback email'
      });
    }
  }
);

/**
 * POST /api/interviews/:interviewId/send-automated-feedback
 * Send automated interview feedback email with detailed insights
 * Called automatically after interview completion
 */
router.post(
  '/interviews/:interviewId/send-automated-feedback',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const clerkId = (req as any).clerkUserId;
      
      // Validate UUID
      try {
        uuidSchema.parse(interviewId);
      } catch {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid interview ID format'
        });
      }
      
      // Get interview with user data and feedback
      const interview = await interviewService.getInterviewById(interviewId);
      
      if (!interview) {
        return res.status(404).json({
          status: 'error',
          message: 'Interview not found'
        });
      }
      
      // Verify ownership
      if (interview.user.clerkId !== clerkId) {
        return res.status(403).json({
          status: 'error',
          message: 'Access denied'
        });
      }
      
      // Check if interview has feedback
      if (!interview.score && !interview.feedbackText) {
        return res.status(400).json({
          status: 'error',
          message: 'No feedback available for this interview'
        });
      }
      
      // Check user preferences for automated emails (safe access since publicMetadata may not be in schema)
      const userPreferences = (interview.user as any)?.publicMetadata || {};
      if (!shouldSendAutomatedEmail(userPreferences as Record<string, any>)) {
        dbLogger.info('User has disabled automated feedback emails', { 
          interviewId, 
          clerkId 
        });
        return res.json({
          status: 'skipped',
          message: 'User has disabled automated feedback emails'
        });
      }
      
      // Parse feedback data from feedbackText
      const strengths = parseFeedbackSection(interview.feedbackText, 'Strengths') || [];
      const improvements = parseFeedbackSection(interview.feedbackText, 'Areas for Improvement') || 
                          parseFeedbackSection(interview.feedbackText, 'Improvements') || [];
      const recommendations = parseFeedbackSection(interview.feedbackText, 'Recommendations') || [];
      
      // Calculate call duration in minutes
      const callDurationMinutes = interview.callDuration 
        ? interview.callDuration / 60000 
        : interview.endedAt && interview.startedAt 
          ? (new Date(interview.endedAt).getTime() - new Date(interview.startedAt).getTime()) / 60000
          : 10; // Default 10 minutes
      
      // Get user's preferred language
      const userLanguage = (userPreferences as any).preferredLanguage || 
                          (userPreferences as any).language ||
                          'en-US';
      
      // Send automated feedback email
      const result = await sendAutomatedFeedbackEmail({
        toEmail: interview.user.email || '',
        candidateName: `${interview.user.firstName || ''} ${interview.user.lastName || ''}`.trim() || 'Candidate',
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        score: interview.score || 0,
        interviewId: interview.id,
        strengths,
        improvements,
        recommendations,
        technicalScore: 3, // Default - could be extracted from metrics
        communicationScore: 3,
        problemSolvingScore: 3,
        callDurationMinutes: Math.round(callDurationMinutes),
        feedbackPdfBase64: interview.feedbackPdf,
        language: userLanguage
      });
      
      if (!result.success) {
        dbLogger.error('Failed to send automated feedback email', { 
          interviewId, 
          error: result.error 
        });
        return res.status(500).json({
          status: 'error',
          message: result.error || 'Failed to send email'
        });
      }
      
      dbLogger.info('Automated feedback email sent', { 
        interviewId, 
        messageId: result.messageId 
      });
      
      res.json({
        status: 'success',
        message: 'Automated feedback email sent successfully',
        messageId: result.messageId
      });
    } catch (error: any) {
      dbLogger.error('Error sending automated feedback email', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to send automated feedback email'
      });
    }
  }
);

// ==================== Analytics Routes ====================

// Get interview transcript segments
router.get(
  '/interviews/:interviewId/transcript',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      
      if (!interviewId) {
        return res.status(400).json({
          status: 'error',
          message: 'Interview ID is required'
        });
      }
      
      const segments = await analyticsService.getTranscriptSegments(interviewId);
      
      if (!segments || segments.length === 0) {
        return res.status(404).json({
          status: 'error',
          message: 'Transcript not found for this interview'
        });
      }
      
      res.json({
        status: 'success',
        data: { segments }
      });
    } catch (error: any) {
      dbLogger.error('Error fetching transcript', { 
        error: error.message,
        interviewId: req.params.interviewId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch transcript'
      });
    }
  }
);

// Get interview analytics dashboard data
router.get(
  '/interviews/:interviewId/analytics',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const clerkId = (req as any).clerkUserId;
      
      if (!interviewId) {
        return res.status(400).json({
          status: 'error',
          message: 'Interview ID is required'
        });
      }
      
      // Get dashboard analytics which includes score data
      const analytics = await analyticsService.getDashboardAnalytics(clerkId, 'monthly');
      
      res.json({
        status: 'success',
        data: analytics
      });
    } catch (error: any) {
      dbLogger.error('Error fetching interview analytics', { 
        error: error.message,
        interviewId: req.params.interviewId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch interview analytics'
      });
    }
  }
);

// Get benchmark data by role title (standalone endpoint)
// Used by InterviewDetails page for role comparison
router.get(
  '/benchmarks/:roleTitle',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { roleTitle } = req.params;
      const { userScore } = req.query;
      
      if (!roleTitle) {
        return res.status(400).json({
          status: 'error',
          message: 'Role title is required'
        });
      }
      
      const decodedRoleTitle = decodeURIComponent(roleTitle);
      const score = userScore ? parseFloat(userScore as string) : 0;
      
      // Look up benchmark data directly by role title
      const normalizedRole = decodedRoleTitle.toLowerCase().trim();
      const benchmark = await prisma.rolePerformanceBenchmark.findUnique({
        where: { roleTitle: normalizedRole },
      });
      
      if (!benchmark) {
        // Return fallback response when no benchmark exists
        return res.json({
          status: 'success',
          data: {
            hasData: false,
            roleTitle: decodedRoleTitle,
            message: `No benchmark data available for ${decodedRoleTitle} yet. Complete more interviews to contribute!`,
            sampleSize: 0,
            avgScore: null,
            p25Score: null,
            medianScore: null,
            p75Score: null,
            topScore: null,
            yourPercentile: null,
          }
        });
      }
      
      // Calculate user percentile if score provided
      let yourPercentile = null;
      if (score > 0 && benchmark.sampleSize >= 3) {
        if (score >= benchmark.p90Score) yourPercentile = 95;
        else if (score >= benchmark.p75Score) yourPercentile = 87.5;
        else if (score >= benchmark.medianScore) yourPercentile = 62.5;
        else if (score >= benchmark.p25Score) yourPercentile = 37.5;
        else if (score >= benchmark.p10Score) yourPercentile = 17.5;
        else yourPercentile = 5;
      }
      
      res.json({
        status: 'success',
        data: {
          hasData: true,
          roleTitle: benchmark.roleTitle,
          sampleSize: benchmark.sampleSize,
          avgScore: benchmark.avgScore,
          p25Score: benchmark.p25Score,
          medianScore: benchmark.medianScore,
          p75Score: benchmark.p75Score,
          topScore: benchmark.maxScore,
          yourPercentile,
          lastUpdated: benchmark.updatedAt,
        }
      });
    } catch (error: any) {
      dbLogger.error('Error fetching benchmark by role', { 
        error: error.message,
        roleTitle: req.params.roleTitle 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch benchmark data'
      });
    }
  }
);

// Get benchmark data for role comparison (by interview)
router.get(
  '/interviews/:interviewId/benchmark',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      const { roleTitle, userScore } = req.query;
      
      if (!interviewId || !roleTitle) {
        return res.status(400).json({
          status: 'error',
          message: 'Interview ID and role title are required'
        });
      }
      
      const score = userScore ? parseFloat(userScore as string) : 0;
      const benchmark = await analyticsService.getBenchmarkData(
        interviewId, 
        decodeURIComponent(roleTitle as string),
        score
      );
      
      if (!benchmark) {
        return res.status(404).json({
          status: 'error',
          message: 'Benchmark data not found for this role'
        });
      }
      
      res.json({
        status: 'success',
        data: benchmark
      });
    } catch (error: any) {
      dbLogger.error('Error fetching benchmark', { 
        error: error.message,
        interviewId: req.params.interviewId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch benchmark data'
      });
    }
  }
);

// Get stored study recommendations
router.get(
  '/interviews/:interviewId/recommendations',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { interviewId } = req.params;
      
      if (!interviewId) {
        return res.status(400).json({
          status: 'error',
          message: 'Interview ID is required'
        });
      }
      
      const recommendations = await analyticsService.getStudyRecommendations(interviewId);
      
      res.json({
        status: 'success',
        data: recommendations
      });
    } catch (error: any) {
      dbLogger.error('Error fetching recommendations', { 
        error: error.message,
        interviewId: req.params.interviewId 
      });
      res.status(500).json({
        status: 'error',
        message: 'Failed to fetch recommendations'
      });
    }
  }
);

// ========================================
// RESUME QUALITY SCORING ENDPOINTS
// ========================================

import { getResumeQualityService } from '../services/resumeQualityService';

/**
 * POST /resume/analyze
 * Full resume quality analysis with AI
 */
router.post(
  '/resume/analyze',
  async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({
          status: 'error',
          message: 'Authentication required'
        });
      }

      const { resumeText, jobTitle, jobDescription, targetCompany } = req.body;

      if (!resumeText || typeof resumeText !== 'string') {
        return res.status(400).json({
          status: 'error',
          message: 'resumeText is required'
        });
      }

      const service = getResumeQualityService();
      const metrics = await service.analyzeResume({
        resumeText,
        jobTitle,
        jobDescription,
        targetCompany
      });

      res.json({
        status: 'success',
        data: metrics
      });
    } catch (error: any) {
      apiLogger.error('Resume analysis failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to analyze resume'
      });
    }
  }
);

/**
 * POST /resume/quick-scan
 * Fast resume quality check without AI
 */
router.post(
  '/resume/quick-scan',
  async (req: Request, res: Response) => {
    try {
      const { resumeText } = req.body;

      if (!resumeText || typeof resumeText !== 'string') {
        return res.status(400).json({
          status: 'error',
          message: 'resumeText is required'
        });
      }

      const service = getResumeQualityService();
      const result = await service.quickScan(resumeText);

      res.json({
        status: 'success',
        data: result
      });
    } catch (error: any) {
      apiLogger.error('Resume quick scan failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to scan resume'
      });
    }
  }
);

/**
 * POST /resume/suggestions
 * Generate improvement suggestions based on job description
 */
router.post(
  '/resume/suggestions',
  async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({
          status: 'error',
          message: 'Authentication required'
        });
      }

      const { resumeText, jobDescription } = req.body;

      if (!resumeText || !jobDescription) {
        return res.status(400).json({
          status: 'error',
          message: 'Both resumeText and jobDescription are required'
        });
      }

      const service = getResumeQualityService();
      const suggestions = await service.generateImprovementSuggestions(resumeText, jobDescription);

      res.json({
        status: 'success',
        data: suggestions
      });
    } catch (error: any) {
      apiLogger.error('Resume suggestions failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to generate suggestions'
      });
    }
  }
);

// ==================== Phone Verification Routes ====================

import * as phoneVerificationService from '../services/phoneVerificationService';
import * as deviceFingerprintService from '../services/deviceFingerprintService';
import * as preAuthService from '../services/preAuthService';
import * as usageQuotaService from '../services/usageQuotaService';

/**
 * POST /api/phone/send-otp
 * Send OTP verification code to phone number
 */
router.post(
  '/phone/send-otp',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { phoneNumber, language } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({
          status: 'error',
          message: 'Phone number is required'
        });
      }

      // Validate and format phone number
      const formatted = phoneVerificationService.formatPhoneNumber(phoneNumber);
      if (!formatted.isValid) {
        return res.status(400).json({
          status: 'error',
          message: formatted.error || 'Invalid phone number format'
        });
      }

      // Check if phone is blocked
      const isBlocked = await phoneVerificationService.isPhoneBlocked(phoneNumber);
      if (isBlocked) {
        return res.status(403).json({
          status: 'error',
          message: 'This phone number cannot be used for verification'
        });
      }

      // Send OTP
      const result = await phoneVerificationService.sendOTP(
        phoneNumber, 
        clerkId,
        language || 'en-US'
      );

      if (!result.success) {
        return res.status(result.rateLimited ? 429 : 400).json({
          status: 'error',
          message: result.error,
          rateLimited: result.rateLimited
        });
      }

      res.json({
        status: 'success',
        message: 'Verification code sent',
        remainingAttempts: result.remainingAttempts
      });
    } catch (error: any) {
      apiLogger.error('Send OTP failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to send verification code'
      });
    }
  }
);

/**
 * POST /api/phone/verify-otp
 * Verify OTP code
 */
router.post(
  '/phone/verify-otp',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { phoneNumber, code } = req.body;

      if (!phoneNumber || !code) {
        return res.status(400).json({
          status: 'error',
          message: 'Phone number and verification code are required'
        });
      }

      // Verify OTP
      const result = await phoneVerificationService.verifyOTP(
        phoneNumber, 
        code,
        clerkId
      );

      if (!result.success) {
        return res.status(400).json({
          status: 'error',
          message: result.error,
          attemptsRemaining: result.attemptsRemaining
        });
      }

      if (!result.valid) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid verification code',
          attemptsRemaining: result.attemptsRemaining
        });
      }

      res.json({
        status: 'success',
        message: 'Phone number verified successfully',
        verified: true
      });
    } catch (error: any) {
      apiLogger.error('Verify OTP failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to verify code'
      });
    }
  }
);

/**
 * GET /api/phone/status
 * Get phone verification status for current user
 */
router.get(
  '/phone/status',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;

      const status = await phoneVerificationService.getPhoneVerificationStatus(clerkId);

      res.json({
        status: 'success',
        data: status
      });
    } catch (error: any) {
      apiLogger.error('Get phone status failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get verification status'
      });
    }
  }
);

/**
 * DELETE /api/phone/verification
 * Remove phone verification (user can re-verify with different number)
 */
router.delete(
  '/phone/verification',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;

      const success = await phoneVerificationService.removePhoneVerification(clerkId);

      if (!success) {
        return res.status(500).json({
          status: 'error',
          message: 'Failed to remove phone verification'
        });
      }

      res.json({
        status: 'success',
        message: 'Phone verification removed'
      });
    } catch (error: any) {
      apiLogger.error('Remove phone verification failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to remove verification'
      });
    }
  }
);

/**
 * POST /api/phone/validate
 * Validate phone number format without sending OTP
 */
router.post(
  '/phone/validate',
  async (req: Request, res: Response) => {
    try {
      const { phoneNumber, defaultCountryCode } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({
          status: 'error',
          message: 'Phone number is required'
        });
      }

      const result = phoneVerificationService.formatPhoneNumber(
        phoneNumber, 
        defaultCountryCode
      );

      res.json({
        status: 'success',
        data: {
          isValid: result.isValid,
          formattedNumber: result.isValid ? result.formattedNumber : undefined,
          countryCode: result.countryCode,
          error: result.error
        }
      });
    } catch (error: any) {
      apiLogger.error('Phone validation failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to validate phone number'
      });
    }
  }
);

// ==================== Device Fingerprint Routes ====================

/**
 * POST /api/device/fingerprint
 * Store device fingerprint for a user
 */
router.post(
  '/device/fingerprint',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const fingerprint = req.body;

      if (!fingerprint || !fingerprint.visitorId) {
        return res.status(400).json({
          status: 'error',
          message: 'Device fingerprint with visitorId is required'
        });
      }

      // Validate device
      const validation = await deviceFingerprintService.validateDeviceForSignup(
        fingerprint,
        clerkId
      );

      // Store fingerprint even if not fully trusted (for audit)
      const storeResult = await deviceFingerprintService.storeDeviceFingerprint(
        clerkId,
        fingerprint
      );

      if (!validation.allowed) {
        apiLogger.warn('Device validation failed', { 
          clerkId, 
          reason: validation.reason,
          trustScore: validation.trustScore
        });
        
        return res.status(403).json({
          status: 'error',
          message: validation.reason,
          trustScore: validation.trustScore,
          warnings: validation.warnings
        });
      }

      res.json({
        status: 'success',
        data: {
          stored: storeResult.success,
          isNewDevice: storeResult.isNewDevice,
          linkedAccounts: storeResult.linkedAccounts,
          trustScore: validation.trustScore,
          trustTier: deviceFingerprintService.getTrustTier(validation.trustScore),
          warnings: validation.warnings
        }
      });
    } catch (error: any) {
      apiLogger.error('Store device fingerprint failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to process device fingerprint'
      });
    }
  }
);

/**
 * POST /api/device/validate
 * Validate device fingerprint without storing
 */
router.post(
  '/device/validate',
  async (req: Request, res: Response) => {
    try {
      const fingerprint = req.body;

      if (!fingerprint || !fingerprint.visitorId) {
        return res.status(400).json({
          status: 'error',
          message: 'Device fingerprint with visitorId is required'
        });
      }

      // Analyze fingerprint
      const analysis = deviceFingerprintService.analyzeFingerprint(fingerprint);

      // Check if device is blocked
      const isBlocked = await deviceFingerprintService.isDeviceBlocked(fingerprint.visitorId);

      res.json({
        status: 'success',
        data: {
          isValid: analysis.isValid && !isBlocked,
          isTrusted: analysis.isTrusted,
          trustScore: analysis.trustScore,
          trustTier: deviceFingerprintService.getTrustTier(analysis.trustScore),
          isBlocked,
          flags: analysis.flags,
          warnings: analysis.warnings
        }
      });
    } catch (error: any) {
      apiLogger.error('Device validation failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to validate device'
      });
    }
  }
);

/**
 * GET /api/device/linked-accounts
 * Get accounts linked to a device fingerprint (admin only)
 */
router.get(
  '/device/linked-accounts/:visitorId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { visitorId } = req.params;

      // In production, add admin role check here
      const linkedAccounts = await deviceFingerprintService.getLinkedAccounts(visitorId);

      res.json({
        status: 'success',
        data: {
          count: linkedAccounts.linkedAccounts,
          isNewDevice: linkedAccounts.isNewDevice
          // Don't expose account IDs unless admin
        }
      });
    } catch (error: any) {
      apiLogger.error('Get linked accounts failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get linked accounts'
      });
    }
  }
);

/**
 * POST /api/device/block
 * Block a device fingerprint (admin only)
 */
router.post(
  '/device/block',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { visitorId, reason } = req.body;

      // In production, add admin role check here
      if (!visitorId || !reason) {
        return res.status(400).json({
          status: 'error',
          message: 'visitorId and reason are required'
        });
      }

      const success = await deviceFingerprintService.blockDevice(
        visitorId,
        reason,
        clerkId
      );

      if (!success) {
        return res.status(500).json({
          status: 'error',
          message: 'Failed to block device'
        });
      }

      res.json({
        status: 'success',
        message: 'Device blocked successfully'
      });
    } catch (error: any) {
      apiLogger.error('Block device failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to block device'
      });
    }
  }
);

// ==================== Pre-Authorization Card Routes ====================

/**
 * POST /api/cards/verify
 * Perform zero-dollar pre-authorization to verify a card
 */
router.post(
  '/cards/verify',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { cardNumber, expiryMonth, expiryYear, cvv, holderName, saveCard } = req.body;

      // Validate required fields
      if (!cardNumber || !expiryMonth || !expiryYear || !cvv || !holderName) {
        return res.status(400).json({
          status: 'error',
          message: 'All card details are required (cardNumber, expiryMonth, expiryYear, cvv, holderName)'
        });
      }

      // Perform pre-authorization
      const result = await preAuthService.performPreAuthorization({
        number: cardNumber,
        expiryMonth,
        expiryYear,
        cvv,
        holderName
      }, clerkId);

      if (!result.success || !result.authorized) {
        return res.status(400).json({
          status: 'error',
          message: result.error || 'Card verification failed',
          errorCode: result.errorCode
        });
      }

      // Optionally save the card
      let savedCard = null;
      if (saveCard && result.token) {
        savedCard = await preAuthService.saveVerifiedCard(
          clerkId,
          result,
          holderName,
          expiryMonth,
          expiryYear,
          true // setAsDefault
        );
        
        // Mark payment as verified for trust scoring
        await preAuthService.markPaymentVerified(clerkId);
      }

      res.json({
        status: 'success',
        message: 'Card verified successfully',
        data: {
          lastFour: result.lastFour,
          brand: result.brand,
          avsVerified: result.avsVerified,
          cvvVerified: result.cvvVerified,
          saved: !!savedCard,
          cardId: savedCard?.id
        }
      });
    } catch (error: any) {
      apiLogger.error('Card verification failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to verify card'
      });
    }
  }
);

/**
 * GET /api/cards
 * Get user's saved cards
 */
router.get(
  '/cards',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;

      const cards = await preAuthService.getUserCards(clerkId);

      // Return cards without sensitive token data
      const safeCards = cards.map(card => ({
        id: card.id,
        lastFour: card.lastFour,
        brand: card.brand,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        holderName: card.holderName,
        isDefault: card.isDefault,
        createdAt: card.createdAt
      }));

      res.json({
        status: 'success',
        data: safeCards
      });
    } catch (error: any) {
      apiLogger.error('Get cards failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get cards'
      });
    }
  }
);

/**
 * DELETE /api/cards/:cardId
 * Delete a saved card
 */
router.delete(
  '/cards/:cardId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { cardId } = req.params;

      const success = await preAuthService.deleteCard(clerkId, cardId);

      if (!success) {
        return res.status(404).json({
          status: 'error',
          message: 'Card not found or could not be deleted'
        });
      }

      res.json({
        status: 'success',
        message: 'Card deleted successfully'
      });
    } catch (error: any) {
      apiLogger.error('Delete card failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to delete card'
      });
    }
  }
);

/**
 * GET /api/cards/verification-status
 * Check if user has a verified payment method
 */
router.get(
  '/cards/verification-status',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;

      const hasVerified = await preAuthService.hasVerifiedPayment(clerkId);

      res.json({
        status: 'success',
        data: {
          hasVerifiedPayment: hasVerified
        }
      });
    } catch (error: any) {
      apiLogger.error('Check verification status failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to check verification status'
      });
    }
  }
);

/**
 * POST /api/cards/validate
 * Validate card number format (client-side validation helper)
 */
router.post(
  '/cards/validate',
  async (req: Request, res: Response) => {
    try {
      const { cardNumber, expiryMonth, expiryYear, cvv } = req.body;

      if (!cardNumber) {
        return res.status(400).json({
          status: 'error',
          message: 'Card number is required'
        });
      }

      const brand = preAuthService.detectCardBrand(cardNumber);
      const isNumberValid = preAuthService.validateCardNumber(cardNumber);
      const isExpiryValid = expiryMonth && expiryYear 
        ? preAuthService.validateExpiryDate(expiryMonth, expiryYear)
        : undefined;
      const isCvvValid = cvv && brand 
        ? preAuthService.validateCVV(cvv, brand)
        : undefined;

      res.json({
        status: 'success',
        data: {
          brand,
          isNumberValid,
          isExpiryValid,
          isCvvValid,
          maskedNumber: isNumberValid ? preAuthService.maskCardNumber(cardNumber) : undefined
        }
      });
    } catch (error: any) {
      apiLogger.error('Card validation failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to validate card'
      });
    }
  }
);

// ==================== Usage Quota Routes ====================

/**
 * GET /api/usage/summary
 * Get comprehensive usage summary for current user
 */
router.get(
  '/usage/summary',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;

      const summary = await usageQuotaService.getUsageSummary(clerkId);

      res.json({
        status: 'success',
        data: summary
      });
    } catch (error: any) {
      apiLogger.error('Get usage summary failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get usage summary'
      });
    }
  }
);

/**
 * GET /api/usage/quota/:resource
 * Check quota for a specific resource
 */
router.get(
  '/usage/quota/:resource',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { resource } = req.params;

      // Validate resource type
      const validResources = [
        'maxInterviewMinutes',
        'maxInterviewsPerDay',
        'maxAITokensPerInterview',
        'maxAITokensTotal',
        'maxResumesStored',
        'maxChatMessagesPerDay',
        'maxEmailsPerDay'
      ];

      if (!validResources.includes(resource)) {
        return res.status(400).json({
          status: 'error',
          message: `Invalid resource. Valid resources: ${validResources.join(', ')}`
        });
      }

      const quota = await usageQuotaService.checkQuota(
        clerkId, 
        resource as keyof typeof usageQuotaService.USAGE_TIERS.free.limits
      );

      res.json({
        status: 'success',
        data: quota
      });
    } catch (error: any) {
      apiLogger.error('Check quota failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to check quota'
      });
    }
  }
);

/**
 * GET /api/usage/can-start-interview
 * Check if user can start a new interview
 */
router.get(
  '/usage/can-start-interview',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;

      const result = await usageQuotaService.canStartInterview(clerkId);

      res.json({
        status: 'success',
        data: result
      });
    } catch (error: any) {
      apiLogger.error('Check interview permission failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to check interview permission'
      });
    }
  }
);

/**
 * GET /api/usage/tier
 * Get current user's tier information
 */
router.get(
  '/usage/tier',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;

      const tier = await usageQuotaService.getUserTier(clerkId);

      res.json({
        status: 'success',
        data: {
          name: tier.name,
          limits: tier.limits,
          resetPeriod: tier.resetPeriod
        }
      });
    } catch (error: any) {
      apiLogger.error('Get tier info failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to get tier info'
      });
    }
  }
);

/**
 * POST /api/usage/log
 * Log resource usage (internal/admin use)
 */
router.post(
  '/usage/log',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const clerkId = (req as any).clerkUserId;
      const { resourceType, amount, interviewId, description } = req.body;

      if (!resourceType || amount === undefined) {
        return res.status(400).json({
          status: 'error',
          message: 'resourceType and amount are required'
        });
      }

      const success = await usageQuotaService.logUsage({
        userId: clerkId,
        resourceType,
        amount,
        interviewId,
        description,
        timestamp: new Date()
      });

      if (!success) {
        return res.status(500).json({
          status: 'error',
          message: 'Failed to log usage'
        });
      }

      res.json({
        status: 'success',
        message: 'Usage logged successfully'
      });
    } catch (error: any) {
      apiLogger.error('Log usage failed', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to log usage'
      });
    }
  }
);

// ========================================
// RESUME REPOSITORY ROUTES
// Centralized resume management with version control
// ========================================

/**
 * Get all resumes for the authenticated user
 * GET /resumes
 */
router.get('/resumes', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const resumes = await resumeRepositoryService.getResumes(clerkId);
    
    res.json({
      status: 'success',
      data: resumes
    });
  } catch (error: any) {
    apiLogger.error('Get resumes failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get resumes'
    });
  }
});

/**
 * Get primary resume
 * GET /resumes/primary
 */
router.get('/resumes/primary', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const includeData = req.query.includeData === 'true';
    
    const resume = await resumeRepositoryService.getPrimaryResume(clerkId, includeData);
    
    if (!resume) {
      return res.status(404).json({
        status: 'error',
        message: 'No primary resume set'
      });
    }
    
    res.json({
      status: 'success',
      data: resume
    });
  } catch (error: any) {
    apiLogger.error('Get primary resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get primary resume'
    });
  }
});

/**
 * Search resumes
 * GET /resumes/search?q=...&tags=...
 */
router.get('/resumes/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const query = (req.query.q as string) || '';
    const tags = req.query.tags ? (req.query.tags as string).split(',') : undefined;
    
    const resumes = await resumeRepositoryService.searchResumes(clerkId, query, tags);
    
    res.json({
      status: 'success',
      data: resumes
    });
  } catch (error: any) {
    apiLogger.error('Search resumes failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to search resumes'
    });
  }
});

/**
 * Get a specific resume by ID
 * GET /resumes/:resumeId
 */
router.get('/resumes/:resumeId', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { resumeId } = req.params;
    const includeData = req.query.includeData === 'true';
    
    const resume = await resumeRepositoryService.getResumeById(clerkId, resumeId, includeData);
    
    if (!resume) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    res.json({
      status: 'success',
      data: resume
    });
  } catch (error: any) {
    apiLogger.error('Get resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get resume'
    });
  }
});

/**
 * Get resume version history
 * GET /resumes/:resumeId/versions
 */
router.get('/resumes/:resumeId/versions', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { resumeId } = req.params;
    
    const versions = await resumeRepositoryService.getResumeVersionHistory(clerkId, resumeId);
    
    res.json({
      status: 'success',
      data: versions
    });
  } catch (error: any) {
    apiLogger.error('Get resume versions failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get resume versions'
    });
  }
});

/**
 * Create a new resume
 * POST /resumes
 */
router.post('/resumes', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { fileName, mimeType, base64Data, title, description, tags, isPrimary } = req.body;
    
    if (!fileName || !mimeType || !base64Data) {
      return res.status(400).json({
        status: 'error',
        message: 'fileName, mimeType, and base64Data are required'
      });
    }
    
    // Validate file
    const validation = resumeRepositoryService.validateResumeFile(base64Data, mimeType);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'error',
        message: validation.error
      });
    }
    
    const resume = await resumeRepositoryService.createResume(clerkId, {
      fileName,
      mimeType,
      base64Data,
      title,
      description,
      tags,
      isPrimary
    });
    
    if (!resume) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to create resume'
      });
    }
    
    res.status(201).json({
      status: 'success',
      data: {
        id: resume.id,
        title: resume.title,
        fileName: resume.fileName,
        version: resume.version,
        isPrimary: resume.isPrimary
      }
    });
  } catch (error: any) {
    apiLogger.error('Create resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to create resume'
    });
  }
});

/**
 * Update resume metadata
 * PATCH /resumes/:resumeId
 */
router.patch('/resumes/:resumeId', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { resumeId } = req.params;
    const { title, description, tags, isPrimary } = req.body;
    
    const resume = await resumeRepositoryService.updateResume(clerkId, resumeId, {
      title,
      description,
      tags,
      isPrimary
    });
    
    if (!resume) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    res.json({
      status: 'success',
      data: resume
    });
  } catch (error: any) {
    apiLogger.error('Update resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update resume'
    });
  }
});

/**
 * Create a new version of a resume
 * POST /resumes/:resumeId/versions
 */
router.post('/resumes/:resumeId/versions', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { resumeId } = req.params;
    const { fileName, mimeType, base64Data } = req.body;
    
    if (!fileName || !mimeType || !base64Data) {
      return res.status(400).json({
        status: 'error',
        message: 'fileName, mimeType, and base64Data are required'
      });
    }
    
    // Validate file
    const validation = resumeRepositoryService.validateResumeFile(base64Data, mimeType);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'error',
        message: validation.error
      });
    }
    
    const resume = await resumeRepositoryService.createResumeVersion(clerkId, resumeId, {
      fileName,
      mimeType,
      base64Data
    });
    
    if (!resume) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found or failed to create version'
      });
    }
    
    res.status(201).json({
      status: 'success',
      data: {
        id: resume.id,
        title: resume.title,
        fileName: resume.fileName,
        version: resume.version
      }
    });
  } catch (error: any) {
    apiLogger.error('Create resume version failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to create resume version'
    });
  }
});

/**
 * Set resume as primary
 * POST /resumes/:resumeId/primary
 */
router.post('/resumes/:resumeId/primary', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { resumeId } = req.params;
    
    const success = await resumeRepositoryService.setPrimaryResume(clerkId, resumeId);
    
    if (!success) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    res.json({
      status: 'success',
      message: 'Resume set as primary'
    });
  } catch (error: any) {
    apiLogger.error('Set primary resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to set primary resume'
    });
  }
});

/**
 * Delete a resume
 * DELETE /resumes/:resumeId
 */
router.delete('/resumes/:resumeId', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { resumeId } = req.params;
    
    const success = await resumeRepositoryService.deleteResume(clerkId, resumeId);
    
    if (!success) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    res.json({
      status: 'success',
      message: 'Resume deleted'
    });
  } catch (error: any) {
    apiLogger.error('Delete resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete resume'
    });
  }
});

/**
 * Validate a resume file before upload
 * POST /resumes/validate
 */
router.post('/resumes/validate', async (req: Request, res: Response) => {
  try {
    const { base64Data, mimeType } = req.body;
    
    if (!base64Data || !mimeType) {
      return res.status(400).json({
        status: 'error',
        message: 'base64Data and mimeType are required'
      });
    }
    
    const validation = resumeRepositoryService.validateResumeFile(base64Data, mimeType);
    
    res.json({
      status: 'success',
      data: {
        valid: validation.valid,
        error: validation.error
      }
    });
  } catch (error: any) {
    apiLogger.error('Validate resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to validate resume'
    });
  }
});

// ========================================
// ENHANCED ANALYTICS FILTERING ROUTES
// Advanced filtering and comparison views
// ========================================

/**
 * Get enhanced filter options with counts
 * GET /analytics/filters/enhanced
 */
router.get('/analytics/filters/enhanced', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const filterOptions = await analyticsService.getEnhancedFilterOptions(clerkId);
    
    res.json({
      status: 'success',
      data: filterOptions
    });
  } catch (error: any) {
    apiLogger.error('Get enhanced filter options failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get filter options'
    });
  }
});

/**
 * Get filtered analytics with advanced filtering
 * POST /analytics/filtered
 */
router.post('/analytics/filtered', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { dateRange, roles, companies, scoreRange, sortBy, sortOrder } = req.body;
    
    const filters: analyticsService.AdvancedFilters = {
      dateRange: dateRange || { preset: 'last30days' },
      roles,
      companies,
      scoreRange,
      sortBy,
      sortOrder
    };
    
    // Parse dates if provided
    if (filters.dateRange.startDate) {
      filters.dateRange.startDate = new Date(filters.dateRange.startDate);
    }
    if (filters.dateRange.endDate) {
      filters.dateRange.endDate = new Date(filters.dateRange.endDate);
    }
    
    const result = await analyticsService.getFilteredAnalytics(clerkId, filters);
    
    if (!result) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    res.json({
      status: 'success',
      data: result
    });
  } catch (error: any) {
    apiLogger.error('Get filtered analytics failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get filtered analytics'
    });
  }
});

/**
 * Compare two interviews
 * GET /analytics/compare?interview1=...&interview2=...
 */
router.get('/analytics/compare', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interview1, interview2 } = req.query;
    
    if (!interview1 || !interview2) {
      return res.status(400).json({
        status: 'error',
        message: 'Both interview1 and interview2 are required'
      });
    }
    
    const comparison = await analyticsService.compareInterviews(
      clerkId,
      interview1 as string,
      interview2 as string
    );
    
    if (!comparison) {
      return res.status(404).json({
        status: 'error',
        message: 'Interview(s) not found'
      });
    }
    
    res.json({
      status: 'success',
      data: comparison
    });
  } catch (error: any) {
    apiLogger.error('Compare interviews failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to compare interviews'
    });
  }
});

/**
 * Get interview progression over time
 * GET /analytics/progression?role=...&company=...
 */
router.get('/analytics/progression', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { role, company, limit } = req.query;
    
    const progression = await analyticsService.getInterviewProgression(clerkId, {
      role: role as string | undefined,
      company: company as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined
    });
    
    res.json({
      status: 'success',
      data: progression
    });
  } catch (error: any) {
    apiLogger.error('Get progression failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get interview progression'
    });
  }
});

/**
 * Get date range from preset
 * GET /analytics/date-range/:preset
 */
router.get('/analytics/date-range/:preset', async (req: Request, res: Response) => {
  try {
    const { preset } = req.params;
    
    const validPresets = ['today', 'last7days', 'last30days', 'last90days', 'thisMonth', 'lastMonth', 'thisYear', 'allTime'];
    if (!validPresets.includes(preset)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid preset. Valid options: ${validPresets.join(', ')}`
      });
    }
    
    const range = analyticsService.getDateRangeFromPreset(preset as analyticsService.DateRangePreset);
    
    res.json({
      status: 'success',
      data: range
    });
  } catch (error: any) {
    apiLogger.error('Get date range failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get date range'
    });
  }
});

// ========================================
// RECORDING PLAYBACK ROUTES
// Audio playback and transcript synchronization
// ========================================

/**
 * Get complete playback data for an interview
 * GET /recordings/:interviewId
 */
router.get('/recordings/:interviewId', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    
    const playbackData = await recordingPlaybackService.getPlaybackData(clerkId, interviewId);
    
    if (!playbackData) {
      return res.status(404).json({
        status: 'error',
        message: 'Recording not found'
      });
    }
    
    res.json({
      status: 'success',
      data: playbackData
    });
  } catch (error: any) {
    apiLogger.error('Get playback data failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get playback data'
    });
  }
});

/**
 * Get recording info only
 * GET /recordings/:interviewId/info
 */
router.get('/recordings/:interviewId/info', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    
    const recordingInfo = await recordingPlaybackService.getRecordingInfo(clerkId, interviewId);
    
    if (!recordingInfo) {
      return res.status(404).json({
        status: 'error',
        message: 'Recording not found'
      });
    }
    
    res.json({
      status: 'success',
      data: recordingInfo
    });
  } catch (error: any) {
    apiLogger.error('Get recording info failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get recording info'
    });
  }
});

/**
 * Get synchronized transcript
 * GET /recordings/:interviewId/transcript
 */
router.get('/recordings/:interviewId/transcript', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    
    const transcript = await recordingPlaybackService.getSynchronizedTranscript(clerkId, interviewId);
    
    if (!transcript) {
      return res.status(404).json({
        status: 'error',
        message: 'Transcript not found'
      });
    }
    
    res.json({
      status: 'success',
      data: transcript
    });
  } catch (error: any) {
    apiLogger.error('Get transcript failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get transcript'
    });
  }
});

/**
 * Search transcript
 * GET /recordings/:interviewId/transcript/search?q=...
 */
router.get('/recordings/:interviewId/transcript/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    const query = req.query.q as string;
    
    if (!query) {
      return res.status(400).json({
        status: 'error',
        message: 'Search query (q) is required'
      });
    }
    
    const transcript = await recordingPlaybackService.getSynchronizedTranscript(clerkId, interviewId);
    
    if (!transcript) {
      return res.status(404).json({
        status: 'error',
        message: 'Transcript not found'
      });
    }
    
    const results = recordingPlaybackService.searchTranscript(transcript, query);
    
    res.json({
      status: 'success',
      data: {
        query,
        matches: results.length,
        segments: results
      }
    });
  } catch (error: any) {
    apiLogger.error('Search transcript failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to search transcript'
    });
  }
});

/**
 * Get playback markers
 * GET /recordings/:interviewId/markers
 */
router.get('/recordings/:interviewId/markers', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    
    const markers = await recordingPlaybackService.generatePlaybackMarkers(clerkId, interviewId);
    
    res.json({
      status: 'success',
      data: markers
    });
  } catch (error: any) {
    apiLogger.error('Get markers failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get playback markers'
    });
  }
});

/**
 * Save custom marker
 * POST /recordings/:interviewId/markers
 */
router.post('/recordings/:interviewId/markers', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    const { timestamp, label, description, color } = req.body;
    
    if (timestamp === undefined || !label) {
      return res.status(400).json({
        status: 'error',
        message: 'timestamp and label are required'
      });
    }
    
    const marker = await recordingPlaybackService.saveCustomMarker(clerkId, interviewId, {
      type: 'custom',
      timestamp,
      label,
      description,
      color
    });
    
    if (!marker) {
      return res.status(404).json({
        status: 'error',
        message: 'Interview not found'
      });
    }
    
    res.status(201).json({
      status: 'success',
      data: marker
    });
  } catch (error: any) {
    apiLogger.error('Save marker failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to save marker'
    });
  }
});

/**
 * Get segment at specific timestamp
 * GET /recordings/:interviewId/segment?t=...
 */
router.get('/recordings/:interviewId/segment', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    const timestamp = parseFloat(req.query.t as string);
    
    if (isNaN(timestamp)) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid timestamp (t) is required'
      });
    }
    
    const transcript = await recordingPlaybackService.getSynchronizedTranscript(clerkId, interviewId);
    
    if (!transcript) {
      return res.status(404).json({
        status: 'error',
        message: 'Transcript not found'
      });
    }
    
    const segment = recordingPlaybackService.getSegmentAtTime(transcript, timestamp);
    
    res.json({
      status: 'success',
      data: segment
    });
  } catch (error: any) {
    apiLogger.error('Get segment failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get segment'
    });
  }
});

// ========================================
// INTERVIEW CLONE & RETRY ROUTES
// Retry interviews with same job details
// ========================================

/**
 * Clone an interview to retry
 * POST /interviews/:interviewId/clone
 */
router.post('/interviews/:interviewId/clone', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { interviewId } = req.params;
    const { useLatestResume, resumeId, updateJobDescription } = req.body;
    
    const clonedInterview = await interviewService.cloneInterview(
      interviewId,
      clerkId,
      {
        useLatestResume,
        resumeId,
        updateJobDescription
      }
    );
    
    res.status(201).json({
      status: 'success',
      data: {
        id: clonedInterview.id,
        jobTitle: clonedInterview.jobTitle,
        companyName: clonedInterview.companyName,
        status: clonedInterview.status,
        message: 'Interview cloned successfully. Ready to start.'
      }
    });
  } catch (error: any) {
    apiLogger.error('Clone interview failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to clone interview'
    });
  }
});

/**
 * Get suggested interviews to retake
 * GET /interviews/suggested-retakes
 */
router.get('/interviews/suggested-retakes', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
    
    const suggestions = await interviewService.getSuggestedRetakes(clerkId, limit);
    
    res.json({
      status: 'success',
      data: suggestions
    });
  } catch (error: any) {
    apiLogger.error('Get suggested retakes failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get suggested retakes'
    });
  }
});

/**
 * Get interview history for role/company
 * GET /interviews/history?jobTitle=...&companyName=...
 */
router.get('/interviews/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { jobTitle, companyName } = req.query;
    
    const history = await interviewService.getInterviewHistory(clerkId, {
      jobTitle: jobTitle as string | undefined,
      companyName: companyName as string | undefined
    });
    
    res.json({
      status: 'success',
      data: history
    });
  } catch (error: any) {
    apiLogger.error('Get interview history failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get interview history'
    });
  }
});

/**
 * Create interview from resume repository
 * POST /interviews/from-resume
 */
router.post('/interviews/from-resume', requireAuth, async (req: Request, res: Response) => {
  try {
    const clerkId = (req as any).clerkUserId;
    const { resumeId, jobTitle, companyName, jobDescription } = req.body;
    
    if (!resumeId || !jobTitle || !companyName || !jobDescription) {
      return res.status(400).json({
        status: 'error',
        message: 'resumeId, jobTitle, companyName, and jobDescription are required'
      });
    }
    
    const interview = await interviewService.createInterviewFromResume(
      clerkId,
      resumeId,
      { jobTitle, companyName, jobDescription }
    );
    
    res.status(201).json({
      status: 'success',
      data: {
        id: interview.id,
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        status: interview.status,
        message: 'Interview created from resume repository'
      }
    });
  } catch (error: any) {
    apiLogger.error('Create interview from resume failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to create interview from resume'
    });
  }
});

export default router;
export { requireAuth };
