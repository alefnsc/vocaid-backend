/**
 * Email Admin Routes
 * 
 * Admin endpoints for managing transactional emails:
 * - GET /api/admin/emails - List email logs with filtering
 * - GET /api/admin/emails/stats - Email statistics
 * - GET /api/admin/emails/preview/:type - Preview email templates
 * - POST /api/admin/emails/retry - Retry failed emails
 * - POST /api/admin/emails/test - Send test email
 * 
 * All routes require ADMIN_SECRET_KEY header authentication or CRON_SECRET for cron endpoints.
 * 
 * @module routes/emailAdminRoutes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getEmailLogs,
  getEmailStats,
  retryFailedEmails,
  previewEmail,
  getAvailableEmailTypes,
  PreviewableEmailType
} from '../services/transactionalEmailService';
import logger from '../utils/logger';

const router = Router();
const emailAdminLogger = logger.child({ component: 'email-admin' });

// ============================================================================
// Standardized API Response Contract
// ============================================================================
interface ApiSuccessResponse<T = any> {
  ok: true;
  data: T;
  requestId: string;
}

interface ApiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
  requestId: string;
}

type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Create a standardized success response
 */
function successResponse<T>(data: T, requestId: string): ApiSuccessResponse<T> {
  return { ok: true, data, requestId };
}

/**
 * Create a standardized error response
 */
function errorResponse(
  code: string,
  message: string,
  requestId: string,
  details?: any
): ApiErrorResponse {
  return {
    ok: false,
    error: { code, message, ...(details && { details }) },
    requestId
  };
}

// ============================================================================
// Admin Authentication Middleware
// ============================================================================

/**
 * Middleware to require admin secret key authentication
 * Checks for X-Admin-Secret header against ADMIN_SECRET_KEY env var
 */
function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req as any).requestId || uuidv4();
  (req as any).requestId = requestId;

  const adminSecret = req.headers['x-admin-secret'] as string;
  const expectedSecret = process.env.ADMIN_SECRET_KEY;

  if (!expectedSecret) {
    emailAdminLogger.error('ADMIN_SECRET_KEY not configured');
    res.status(500).json(
      errorResponse('CONFIG_ERROR', 'Admin authentication not configured', requestId)
    );
    return;
  }

  if (!adminSecret || adminSecret !== expectedSecret) {
    emailAdminLogger.warn('Unauthorized admin access attempt', {
      ip: req.ip,
      path: req.path,
      hasHeader: !!adminSecret
    });
    res.status(401).json(
      errorResponse('UNAUTHORIZED', 'Invalid or missing admin credentials', requestId)
    );
    return;
  }

  next();
}

/**
 * Middleware to require cron secret authentication via header
 * Checks for X-Cron-Secret header against CRON_SECRET env var
 */
function requireCronAuth(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req as any).requestId || uuidv4();
  (req as any).requestId = requestId;

  const cronSecret = req.headers['x-cron-secret'] as string;
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    emailAdminLogger.error('CRON_SECRET not configured');
    res.status(500).json(
      errorResponse('CONFIG_ERROR', 'Cron authentication not configured', requestId)
    );
    return;
  }

  if (!cronSecret || cronSecret !== expectedSecret) {
    emailAdminLogger.warn('Unauthorized cron access attempt', {
      ip: req.ip,
      path: req.path,
      hasHeader: !!cronSecret
    });
    res.status(401).json(
      errorResponse('UNAUTHORIZED', 'Invalid or missing cron credentials', requestId)
    );
    return;
  }

  next();
}

// Apply admin auth to all routes by default
router.use((req: Request, res: Response, next: NextFunction) => {
  // Skip auth middleware for cron routes (they have their own auth)
  if (req.path.startsWith('/emails/cron')) {
    return next();
  }
  requireAdminAuth(req, res, next);
});

/**
 * GET /api/admin/emails
 * List email logs with filtering and pagination
 * 
 * Query params:
 * - userId: Filter by user ID
 * - emailType: Filter by email type (WELCOME, CREDITS_PURCHASE_RECEIPT, etc.)
 * - status: Filter by status (PENDING, SENT, FAILED)
 * - fromDate: Start date (ISO string)
 * - toDate: End date (ISO string)
 * - limit: Number of results (default 50)
 * - offset: Pagination offset (default 0)
 */
router.get('/emails', async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || uuidv4();
  
  try {
    const {
      userId,
      emailType,
      status,
      fromDate,
      toDate,
      limit = '50',
      offset = '0'
    } = req.query;

    const filters = {
      userId: userId as string | undefined,
      emailType: emailType as string | undefined,
      status: status as string | undefined,
      fromDate: fromDate ? new Date(fromDate as string) : undefined,
      toDate: toDate ? new Date(toDate as string) : undefined,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10)
    };

    const result = await getEmailLogs(filters);

    res.json(successResponse(result, requestId));

  } catch (error: any) {
    emailAdminLogger.error('Error fetching email logs', { error: error.message, requestId });
    res.status(500).json(
      errorResponse('FETCH_ERROR', 'Failed to fetch email logs', requestId, { message: error.message })
    );
  }
});

/**
 * GET /api/admin/emails/stats
 * Get email statistics for dashboard
 * 
 * Query params:
 * - fromDate: Start date (ISO string)
 * - toDate: End date (ISO string)
 */
router.get('/emails/stats', async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || uuidv4();
  
  try {
    const { fromDate, toDate } = req.query;

    const stats = await getEmailStats(
      fromDate ? new Date(fromDate as string) : undefined,
      toDate ? new Date(toDate as string) : undefined
    );

    res.json(successResponse(stats, requestId));

  } catch (error: any) {
    emailAdminLogger.error('Error fetching email stats', { error: error.message, requestId });
    res.status(500).json(
      errorResponse('FETCH_ERROR', 'Failed to fetch email stats', requestId, { message: error.message })
    );
  }
});

/**
 * GET /api/admin/emails/types
 * Get list of available email types
 */
router.get('/emails/types', (req: Request, res: Response) => {
  const requestId = (req as any).requestId || uuidv4();
  
  try {
    const types = getAvailableEmailTypes();
    res.json(successResponse(types, requestId));
  } catch (error: any) {
    res.status(500).json(
      errorResponse('FETCH_ERROR', 'Failed to get email types', requestId, { message: error.message })
    );
  }
});

/**
 * GET /api/admin/emails/preview/:type
 * Preview an email template
 * 
 * Params:
 * - type: Email type (welcome, purchase, low-credits, interview-reminder, interview-complete)
 * 
 * Query params:
 * - lang: Language (en, pt) - default en
 * - format: Response format (html, json) - default json
 * - Custom sample data can be passed as query params
 */
router.get('/emails/preview/:type', (req: Request, res: Response) => {
  const requestId = (req as any).requestId || uuidv4();
  
  try {
    const { type } = req.params;
    const { lang = 'en', format = 'json', ...sampleData } = req.query;

    const validTypes: PreviewableEmailType[] = ['welcome', 'purchase', 'low-credits', 'interview-complete'];
    
    if (!validTypes.includes(type as PreviewableEmailType)) {
      return res.status(400).json(
        errorResponse('INVALID_TYPE', 'Invalid email type', requestId, { validTypes })
      );
    }

    const validLangs = ['en', 'pt'];
    const language = validLangs.includes(lang as string) ? (lang as 'en' | 'pt') : 'en';

    // Convert query params to proper types for sample data
    const processedSampleData: Record<string, any> = {};
    for (const [key, value] of Object.entries(sampleData)) {
      if (value === 'true') processedSampleData[key] = true;
      else if (value === 'false') processedSampleData[key] = false;
      else if (!isNaN(Number(value))) processedSampleData[key] = Number(value);
      else processedSampleData[key] = value;
    }

    const preview = previewEmail(type as PreviewableEmailType, language, processedSampleData);

    // If format is html, return just the HTML content
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(preview.html);
    }

    // Otherwise return JSON with all content
    res.json(successResponse({
      type,
      language,
      subject: preview.subject,
      html: preview.html,
      text: preview.text
    }, requestId));

  } catch (error: any) {
    emailAdminLogger.error('Error previewing email', { error: error.message, requestId });
    res.status(500).json(
      errorResponse('PREVIEW_ERROR', 'Failed to preview email', requestId, { message: error.message })
    );
  }
});

/**
 * POST /api/admin/emails/retry
 * Retry all failed emails (up to max retries)
 * 
 * Body:
 * - maxRetries: Maximum retry attempts (default 3)
 */
router.post('/emails/retry', async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || uuidv4();
  
  try {
    const { maxRetries = 3 } = req.body;

    emailAdminLogger.info('Starting email retry job', { maxRetries, requestId });

    const result = await retryFailedEmails(maxRetries);

    emailAdminLogger.info('Email retry job completed', {
      totalFailed: result.totalFailed,
      retried: result.retried,
      succeeded: result.succeeded,
      stillFailing: result.stillFailing,
      requestId
    });

    res.json(successResponse(result, requestId));

  } catch (error: any) {
    emailAdminLogger.error('Error retrying emails', { error: error.message, requestId });
    res.status(500).json(
      errorResponse('RETRY_ERROR', 'Failed to retry emails', requestId, { message: error.message })
    );
  }
});

/**
 * POST /api/admin/emails/test
 * Send a test email to verify configuration
 * 
 * Body:
 * - type: Email type to test
 * - to: Email address to send to
 * - lang: Language (en, pt)
 */
router.post('/emails/test', async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || uuidv4();
  
  try {
    const { type, to, lang = 'en' } = req.body;

    if (!type || !to) {
      return res.status(400).json(
        errorResponse('MISSING_FIELDS', 'Missing required fields: type and to', requestId)
      );
    }

    // This would send an actual test email
    // For now, we just return the preview
    const validTypes: PreviewableEmailType[] = ['welcome', 'purchase', 'low-credits', 'interview-complete'];
    
    if (!validTypes.includes(type)) {
      return res.status(400).json(
        errorResponse('INVALID_TYPE', 'Invalid email type', requestId, { validTypes })
      );
    }

    const preview = previewEmail(type, lang === 'pt' ? 'pt' : 'en');

    // In a real implementation, you'd send the email here
    // For now, just return the preview
    res.json(successResponse({
      message: 'Test email would be sent (preview only in this version)',
      to,
      type,
      lang,
      subject: preview.subject
    }, requestId));

  } catch (error: any) {
    emailAdminLogger.error('Error sending test email', { error: error.message, requestId });
    res.status(500).json(
      errorResponse('TEST_ERROR', 'Failed to send test email', requestId, { message: error.message })
    );
  }
});

export default router;
