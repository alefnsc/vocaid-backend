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
import { sendFeedbackEmail } from '../services/emailService';
import { dbLogger } from '../services/databaseService';
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
      
      // Ensure user exists in database
      await userService.findOrCreateUser(clerkId);
      
      const interview = await interviewService.createInterview({
        ...data,
        userId: clerkId
      });
      
      res.status(201).json({
        status: 'success',
        data: interview
      });
    } catch (error: any) {
      dbLogger.error('Error creating interview', { error: error.message });
      res.status(500).json({
        status: 'error',
        message: 'Failed to create interview'
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
          fileName: `voxly-feedback-${interview.companyName}-${interview.jobTitle}.pdf`,
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
      
      // Format for frontend
      const formattedInterviews = result.interviews.map(i => ({
        id: i.id,
        position: i.jobTitle,
        company: i.companyName,
        createdAt: i.createdAt,
        duration: Math.round((i.callDuration || 0) / 1000 / 60), // Convert milliseconds to minutes
        overallScore: i.score,
        status: i.status.toLowerCase()
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

export default router;
