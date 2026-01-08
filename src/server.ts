// Load environment variables before other modules evaluate (ESM-safe)
import 'dotenv/config';

import express, { Request, Response, NextFunction } from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import OpenAI from 'openai';
import { RawData, WebSocket } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { body, param, validationResult } from 'express-validator';
import crypto from 'crypto';

// Config module (centralized environment configuration)
import { config, logEnvDiagnostics } from './config/env';

// Services
import { RetellService } from './services/retellService';
import { getMultilingualRetellService } from './services/multilingualRetellService';
import { isValidLanguageCode } from './types/multilingual';
import { MercadoPagoService, getMercadoPagoCredentials } from './services/mercadoPagoService';
import { FeedbackService } from './services/feedbackService';
import { CustomLLMWebSocketHandler } from './services/customLLMWebSocket';
import { spendCredits, restoreCredits } from './services/creditsWalletService';
import { verifyMercadoPagoSignature, generateWebhookIdempotencyKey } from './services/webhookVerificationService';
import { sendWelcomeEmail, sendPurchaseReceiptEmail, sendLowCreditsEmail, sendInterviewCompleteEmail, UserEmailData, PurchaseEmailData, LowCreditsData, InterviewCompleteData } from './services/transactionalEmailService';
import { storeCallContext, cleanupExpiredContexts } from './services/callContextService';
import { downloadResume } from './services/azureBlobService';
import { prisma } from './services/databaseService';

// Routes
import analyticsRoutes from './routes/analyticsRoutes';
import creditsRoutes from './routes/creditsRoutes';
import leadsRoutes from './routes/leadsRoutes';
import multilingualRoutes from './routes/multilingualRoutes';
import consentRoutes from './routes/consentRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import phoneRoutes from './routes/phoneRoutes';
import interviewRoutes from './routes/interviewRoutes';

// Middleware
import { requireConsent } from './middleware/consentMiddleware';

// GraphQL
import { setupGraphQL } from './graphql';

// Logger
import logger, { wsLogger, retellLogger, feedbackLogger, paymentLogger, authLogger, httpLogger } from './utils/logger';

// Log environment diagnostics at startup
logEnvDiagnostics();

// Validate required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'RETELL_API_KEY',
  'RETELL_AGENT_ID',
];

// MercadoPago credentials are validated based on NODE_ENV
// Development: MERCADOPAGO_TEST_ACCESS_TOKEN (or fallback to MERCADOPAGO_ACCESS_TOKEN)
// Production: MERCADOPAGO_ACCESS_TOKEN
const mpEnvVar = process.env.NODE_ENV === 'production' 
  ? 'MERCADOPAGO_ACCESS_TOKEN' 
  : (process.env.MERCADOPAGO_TEST_ACCESS_TOKEN ? 'MERCADOPAGO_TEST_ACCESS_TOKEN' : 'MERCADOPAGO_ACCESS_TOKEN');

// Optional env vars (warn but don't fail)
const optionalEnvVars: string[] = [];

const missingEnvVars = requiredEnvVars.filter(varName => {
  const value = process.env[varName];
  return !value || value === `your_${varName.toLowerCase()}_here` || value.includes('your_');
});

if (missingEnvVars.length > 0) {
  logger.error('Missing or invalid API keys in .env file', { missingVars: missingEnvVars });
  logger.error('Please update your .env file with valid API keys');
  logger.error('OpenAI: https://platform.openai.com/api-keys');
  logger.error('Retell: https://beta.retellai.com/');
  logger.error('Mercado Pago: https://www.mercadopago.com.br/developers/panel/credentials');
}

// Log optional env vars status
optionalEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    logger.warn(`Optional env var ${varName} not set - fallback functionality may be limited`);
  }
});

// Initialize Express app
const app = express();
const PORT = config.server.port;

// ===== TRUST PROXY =====
// Enable trust proxy for proper client IP detection behind reverse proxies (nginx, load balancers, etc.)
// This is required for express-rate-limit to work correctly with X-Forwarded-For headers
app.set('trust proxy', 1);

// ===== SECURITY MIDDLEWARE =====

// ===== CORS CONFIGURATION =====

const isLocalhostOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch {
    return false;
  }
};

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (server-to-server, health checks)
    if (!origin) {
      return callback(null, true);
    }

    // Always allow local development origins regardless of NODE_ENV
    if (isLocalhostOrigin(origin)) {
      return callback(null, true);
    }
    
    // Allow localhost, ngrok, and configured frontend URL
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    // Allow any ngrok URL (for development/testing)
    if (origin.includes('ngrok') || origin.includes('ngrok-free.app')) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // In development, allow all origins
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    logger.warn('CORS blocked request from origin', { origin });
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'svix-id', 'svix-timestamp', 'svix-signature']
}));

// Helmet - HTTP Security Headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.retellai.com", "wss://api.retellai.com"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for payment redirects
}));

// Rate Limiting - Prevent DDoS and brute force attacks
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: { status: 'error', message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limit for sensitive endpoints (payments, credits)
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per window
  message: { status: 'error', message: 'Too many requests to this endpoint, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Very strict rate limit for webhooks (prevent replay attacks)
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // Allow 50 webhook calls per minute
  message: { status: 'error', message: 'Webhook rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limiter to all routes
app.use(generalLimiter);

// ===== INPUT VALIDATION HELPERS =====

// Validation error handler middleware
const handleValidationErrors = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Input validation failed', { errors: errors.array(), path: req.path });
    return res.status(400).json({
      status: 'error',
      message: 'Invalid input',
      errors: errors.array()
    });
  }
  next();
};

// Sanitize string input - remove potential XSS
const sanitizeString = (str: string): string => {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>]/g, '') // Remove < and >
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers
    .trim()
    .slice(0, 10000); // Limit length
};

// Body parsers with size limits to prevent large payload attacks
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Cookie parser for session management
app.use(cookieParser());

// ===== OBSERVABILITY MIDDLEWARE =====
// Centralized request tracking with metrics, slow request detection, and duplicate detection
import { observabilityMiddleware } from './middleware/observabilityMiddleware';
app.use(observabilityMiddleware);

// ===== CACHING MIDDLEWARE =====
// Adds Cache-Control headers to reduce bandwidth and Azure costs
import { cachingMiddleware } from './middleware/cachingMiddleware';
app.use(cachingMiddleware);

// Mount analytics, performance chat, and abuse detection routes
app.use('/api', analyticsRoutes);

// Mount credits wallet routes
app.use('/api/credits', creditsRoutes);

// Mount leads routes (public - no auth required)
app.use('/api/leads', leadsRoutes);

// Mount email admin routes (for managing transactional emails)
import emailAdminRoutes from './routes/emailAdminRoutes';
app.use('/api/admin', emailAdminRoutes);

// Mount auth routes (PayPal OAuth + mock endpoints for dev)
import authRoutes from './routes/authRoutes';
app.use('/api/auth', authRoutes);

// Mount multilingual routes (language preferences, geo-payment)
app.use('/api/multilingual', multilingualRoutes);

// Mount consent routes (consent management, no auth required for /requirements)
app.use('/api/consent', consentRoutes);

// Mount dashboard routes (unified candidate dashboard with filtering)
app.use('/api/dashboard', dashboardRoutes);

// Mount phone verification routes (OTP + onboarding skip)
app.use('/api/phone', phoneRoutes);

app.use('/api/interviews', interviewRoutes);

// Mount resume repository routes (resume upload, scoring, LinkedIn import)
// Use larger body limit for base64-encoded resume files (up to 10MB)
import resumeRoutes from './routes/resumeRoutes';
app.use('/api/resumes', bodyParser.json({ limit: '10mb' }), resumeRoutes);

// Mount beta feedback routes (closed beta bug reports & feature requests)
import betaFeedbackRoutes from './routes/betaFeedbackRoutes';
app.use('/api/feedback/beta', betaFeedbackRoutes);

// Mount user profile routes (B2C profile management)
import userRoutes from './routes/userRoutes';
app.use('/api/users', userRoutes);

// Mount account routes (connected OAuth providers management)
import accountRoutes from './routes/accountRoutes';
app.use('/api/account', accountRoutes);

// Mount LinkedIn profile routes (profile storage, scoring, consent)
import linkedinProfileRoutes from './routes/linkedinProfileRoutes';
app.use('/api/linkedin-profile', linkedinProfileRoutes);

// ===== CONSENT MIDDLEWARE =====
// Apply consent checking to protected routes
// Exempt paths are defined in the middleware
app.use(requireConsent);

// ===== SESSION AUTHENTICATION MIDDLEWARE =====
// Import session-based authentication middleware
import { requireSession, optionalSession } from './middleware/sessionAuthMiddleware';

// ===== INITIALIZE SERVICES =====

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const retellService = new RetellService(process.env.RETELL_API_KEY || '');

// MercadoPago: Uses getMercadoPagoCredentials() for environment-based credential selection
// Development (NODE_ENV=development): Uses TEST credentials (sandbox)
// Production (NODE_ENV=production): Uses PROD credentials (live)
const { accessToken: mpAccessToken } = getMercadoPagoCredentials();
const mercadoPagoService = new MercadoPagoService(mpAccessToken);

const feedbackService = new FeedbackService(
  process.env.OPENAI_API_KEY || ''
);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: 'Vocaid Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Metrics endpoint (development only)
import { getMetricsSnapshot, resetMetrics } from './middleware/observabilityMiddleware';
app.get('/metrics', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production' && !req.headers['x-admin-key']) {
    return res.status(403).json({ status: 'error', message: 'Forbidden' });
  }
  
  const snapshot = getMetricsSnapshot();
  res.json({
    status: 'ok',
    ...snapshot
  });
});

app.post('/metrics/reset', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ status: 'error', message: 'Forbidden' });
  }
  resetMetrics();
  res.json({ status: 'ok', message: 'Metrics reset' });
});

// ===== INTERVIEW ENDPOINTS =====

/**
 * Register a new Retell call
 * POST /register-call
 * Protected: Requires valid user authentication
 */
app.post('/register-call',
  requireSession,
  [
    body('metadata').isObject().withMessage('Metadata must be an object'),
    body('metadata.first_name').optional().isString().trim().escape(),
    body('metadata.last_name').optional().isString().trim().escape(),
    body('metadata.company_name').optional().isString().trim().escape(),
    body('metadata.job_title').optional().isString().trim().escape(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { metadata } = req.body;
    const userId = req.userId!; // Non-null: requireSession ensures userId exists

    // Validate interview_id is provided (required for resume lookup)
    if (!metadata.interview_id) {
      return res.status(400).json({
        status: 'error',
        message: 'interview_id is required in metadata'
      });
    }

    // Fetch resume from Azure Blob Storage via Interview -> ResumeDocument -> storageKey
    let intervieweeCV = '';
    let resumeFileName = '';
    let resumeMimeType = '';
    
    const interview = await prisma.interview.findUnique({
      where: { id: metadata.interview_id },
      include: {
        resumeDocument: {
          select: {
            storageKey: true,
            fileName: true,
            mimeType: true
          }
        }
      }
    });

    if (!interview) {
      return res.status(404).json({
        status: 'error',
        message: 'Interview not found'
      });
    }

    if (!interview.resumeDocument?.storageKey) {
      return res.status(400).json({
        status: 'error',
        message: 'Interview has no associated resume. Please upload a resume first.'
      });
    }

    // Download resume from Azure Blob Storage
    const downloadResult = await downloadResume(interview.resumeDocument.storageKey);
    if (!downloadResult.success || !downloadResult.data) {
      retellLogger.error('Failed to download resume from Azure Blob', {
        storageKey: interview.resumeDocument.storageKey,
        error: downloadResult.error
      });
      return res.status(503).json({
        status: 'error',
        message: 'Failed to retrieve resume. Please try again.'
      });
    }

    // Convert Buffer to base64 for storage in call context
    intervieweeCV = downloadResult.data.toString('base64');
    resumeFileName = interview.resumeDocument.fileName;
    resumeMimeType = interview.resumeDocument.mimeType || 'application/pdf';

    retellLogger.info('Resume fetched from Azure Blob for interview', {
      interviewId: metadata.interview_id,
      resumeSize: downloadResult.data.length,
      fileName: resumeFileName
    });

    // Resolve preferred language from request or interview record
    const preferredLanguageRaw = sanitizeString(metadata.preferred_language || '') || interview.language || 'en-US';
    const preferredLanguage = isValidLanguageCode(preferredLanguageRaw) ? preferredLanguageRaw : 'en-US';

    // Sanitize metadata strings
    const sanitizedMetadata = {
      ...metadata,
      preferred_language: preferredLanguage,
      first_name: sanitizeString(metadata.first_name || ''),
      last_name: sanitizeString(metadata.last_name || ''),
      company_name: sanitizeString(metadata.company_name || ''),
      job_title: sanitizeString(metadata.job_title || ''),
      job_description: sanitizeString(metadata.job_description || ''),
    };

    // Register call with multilingual-aware agent selection
    const multilingualRetell = getMultilingualRetellService();
    const result = await multilingualRetell.registerMultilingualCall({
      userId,
      language: preferredLanguage as any,
      metadata: {
        first_name: sanitizedMetadata.first_name,
        last_name: sanitizedMetadata.last_name,
        job_title: sanitizedMetadata.job_title,
        company_name: sanitizedMetadata.company_name,
        job_description: sanitizedMetadata.job_description,
        interviewee_cv: intervieweeCV,
        resume_file_name: resumeFileName,
        resume_mime_type: resumeMimeType,
        interview_id: sanitizedMetadata.interview_id,
        preferred_language: preferredLanguage as any,
      },
    });
    
    // Store call context for Custom LLM WebSocket to retrieve
    // This ensures preferred_language is available even if Retell doesn't forward it
    if (result.call_id) {
      storeCallContext(result.call_id, {
        preferredLanguage: preferredLanguage,
        first_name: sanitizedMetadata.first_name,
        last_name: sanitizedMetadata.last_name,
        job_title: sanitizedMetadata.job_title,
        company_name: sanitizedMetadata.company_name,
        job_description: sanitizedMetadata.job_description,
        interviewee_cv: intervieweeCV, // Base64 from Azure Blob
        resume_file_name: resumeFileName,
        resume_mime_type: resumeMimeType,
      });
      retellLogger.info('Call context stored for Custom LLM', {
        callId: result.call_id,
        preferredLanguage: preferredLanguage,
        hasResume: true
      });
    }
    
    res.json(result);
  } catch (error: any) {
    retellLogger.error('Error in /register-call', { error: error.message });
    
    let errorMessage = error.message;
    let statusCode = 500;
    
    // Provide helpful error messages
    if (error.message?.includes('Invalid API Key') || error.message?.includes('401')) {
      errorMessage = 'Backend configuration error: Invalid Retell API key. Please contact support.';
      statusCode = 503; // Service Unavailable
    }
    
    res.status(statusCode).json({
      status: 'error',
      message: errorMessage
    });
  }
});

/**
 * Get call details
 * GET /get-call/:callId
 */
app.get('/get-call/:callId', async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;
    const call = await retellService.getCall(callId);
    res.json(call);
  } catch (error: any) {
    retellLogger.error('Error in /get-call', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Generate feedback for interview
 * GET /get-feedback-for-interview/:callId
 * 
 * Query params:
 * - structured=true: Return new structured feedback format alongside legacy
 * - seniority: Candidate seniority level (intern, junior, mid, senior, staff, principal)
 * - language: Feedback language code (en, es, pt-BR, zh-CN)
 */
app.get('/get-feedback-for-interview/:callId', async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;
    const useStructured = req.query.structured === 'true' || process.env.USE_STRUCTURED_FEEDBACK === 'true';
    const seniority = (req.query.seniority as string) || 'mid';
    const language = (req.query.language as string) || 'en';

    // Prefer pre-generated feedback stored during the post-call pipeline.
    // This avoids slow Retell transcript fetching + on-demand LLM generation on page load.
    const interview = await prisma.interview.findUnique({
      where: { retellCallId: callId },
      select: {
        id: true,
        feedbackDocument: {
          select: {
            contentJson: true,
          },
        },
      },
    });

    if (interview?.feedbackDocument?.contentJson) {
      const structured = interview.feedbackDocument.contentJson as any;

      // Minimal legacy mapping for backwards compatibility.
      const legacy = {
        overall_rating: Math.max(1, Math.min(5, Math.round(((structured?.overallScore ?? 0) as number) / 20))),
        strengths: Array.isArray(structured?.strengths)
          ? structured.strengths.map((s: any) => s?.title).filter(Boolean)
          : [],
        areas_for_improvement: Array.isArray(structured?.improvements)
          ? structured.improvements.map((i: any) => i?.title).filter(Boolean)
          : [],
        recommendations: Array.isArray(structured?.studyPlan)
          ? structured.studyPlan.map((p: any) => p?.title).filter(Boolean)
          : [],
        detailed_feedback: structured?.executiveSummary || '',
      };

      return res.json({
        status: 'success',
        call_id: callId,
        feedback: legacy,
        structured_feedback: structured,
        call_status: null,
        version: '2.0',
      });
    }

    // If we have an interview record but feedback isn't stored yet, kick off post-call processing
    // and return a fast "not ready" response.
    if (interview?.id) {
      postCallProcessingService.processInterview(interview.id).catch((error: any) => {
        feedbackLogger.error('Failed to trigger post-call processing from feedback endpoint', {
          interviewId: interview.id,
          callId,
          error: error.message,
        });
      });

      return res.status(404).json({
        status: 'error',
        message: 'Interview feedback not available yet',
      });
    }

    // Get call details from Retell
    const call: any = await retellService.getCall(callId);

    if (!call.transcript) {
      return res.status(400).json({
        status: 'error',
        message: 'Interview transcript not available yet'
      });
    }

    // Extract call status information for feedback analysis
    const callStatus = {
      end_call_reason: call.end_call_reason || call.disconnection_reason,
      disconnection_reason: call.disconnection_reason,
      call_duration_ms: call.end_timestamp && call.start_timestamp 
        ? call.end_timestamp - call.start_timestamp 
        : call.call_duration_ms,
      call_status: call.call_status
    };

    feedbackLogger.info('Processing feedback request', { 
      callId, 
      callStatus,
      useStructured,
      seniority,
      language,
      transcriptLength: Array.isArray(call.transcript) ? call.transcript.length : 'unknown'
    });

    // Use structured feedback if enabled
    if (useStructured) {
      const { structured, legacy } = await feedbackService.generateStructuredFeedback(
        call.transcript as any,
        call.metadata?.job_title || 'Unknown Position',
        call.metadata?.job_description || '',
        call.metadata?.first_name || 'Candidate',
        callStatus,
        {
          seniority: seniority as any,
          language: language as any,
          resumeUsed: !!call.metadata?.interviewee_cv,
          interviewId: call.metadata?.interview_id || callId
        }
      );

      return res.json({
        status: 'success',
        call_id: callId,
        feedback: legacy,  // Legacy format for backward compatibility
        structured_feedback: structured,  // New structured format (null if generation failed)
        call_status: callStatus,
        version: structured ? '2.0' : '1.0'
      });
    }

    // Legacy feedback generation (backward compatible)
    const feedback = await feedbackService.generateFeedback(
      call.transcript as any,
      call.metadata?.job_title || 'Unknown Position',
      call.metadata?.job_description || '',
      call.metadata?.first_name || 'Candidate',
      callStatus
    );

    res.json({
      status: 'success',
      call_id: callId,
      feedback: feedback,
      call_status: callStatus,
      version: '1.0'
    });
  } catch (error: any) {
    feedbackLogger.error('Error in /get-feedback-for-interview', { callId: req.params.callId, error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// ===== PAYMENT ENDPOINTS =====

/**
 * Create Mercado Pago payment preference
 * POST /create-payment-preference
 * Protected: Requires valid user authentication + rate limited
 */
app.post('/create-payment-preference',
  sensitiveLimiter, // Stricter rate limit for payment endpoints
  requireSession,
  [
    body('packageId').isIn(['starter', 'intermediate', 'professional']).withMessage('Invalid package ID'),
    body('userId').isString().matches(/^user_[a-zA-Z0-9]+$/).withMessage('Invalid user ID format'),
    body('userEmail').isEmail().normalizeEmail().withMessage('Invalid email format'),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { packageId, userId, userEmail } = req.body;
    const authenticatedUserId = req.userId;
    
    // CRITICAL: Verify the request is for the authenticated user (prevent credit theft)
    if (userId !== authenticatedUserId) {
      paymentLogger.warn('User ID mismatch in payment request', { 
        requestedUserId: userId, 
        authenticatedUserId 
      });
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized: Cannot create payment for another user'
      });
    }

    const preference = await mercadoPagoService.createPreference(
      packageId,
      userId,
      userEmail
    );

    res.json({
      status: 'success',
      preference: preference
    });
  } catch (error: any) {
    paymentLogger.error('Error in /create-payment-preference', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Mercado Pago webhook handler
 * POST /webhook/mercadopago
 * Handles both IPN (query params) and Webhook (body) formats
 * Rate limited to prevent replay attacks
 */
app.post('/webhook/mercadopago',
  webhookLimiter,
  async (req: Request, res: Response) => {
  try {
    // MercadoPago can send data in body (webhook) or query params (IPN)
    const webhookData = req.body && Object.keys(req.body).length > 0 
      ? req.body 
      : req.query;

    const dataId = webhookData?.data?.id || webhookData?.id || '';

    paymentLogger.info('Received Mercado Pago webhook', { 
      type: webhookData?.type,
      action: webhookData?.action,
      dataId,
      topic: webhookData?.topic,
      resource: webhookData?.resource,
      source: req.body && Object.keys(req.body).length > 0 ? 'body' : 'query'
    });

    // Verify webhook signature (if secret is configured)
    if (dataId && process.env.MERCADOPAGO_WEBHOOK_SECRET) {
      const verification = verifyMercadoPagoSignature(req.headers as Record<string, string>, dataId);
      if (!verification.valid) {
        paymentLogger.warn('Webhook signature verification failed', { 
          error: verification.error,
          dataId 
        });
        // Return 200 to prevent retries, but don't process
        return res.status(200).json({ 
          status: 'rejected', 
          message: 'Signature verification failed' 
        });
      }
    }

    // Handle merchant_order topic - these are informational, just acknowledge
    // The actual payment processing happens via the 'payment' topic
    if (webhookData?.topic === 'merchant_order' || webhookData?.resource?.includes('merchant_orders')) {
      paymentLogger.info('Merchant order notification received - acknowledged', { 
        topic: webhookData.topic,
        resource: webhookData.resource
      });
      return res.status(200).json({ status: 'acknowledged', message: 'Merchant order notification received' });
    }

    // Handle IPN format (topic + id in query params)
    if (webhookData?.topic && webhookData?.id) {
      paymentLogger.info('Processing IPN notification', { 
        topic: webhookData.topic, 
        id: webhookData.id 
      });
      
      // Only process payment topics
      if (webhookData.topic !== 'payment') {
        paymentLogger.info('Ignoring non-payment IPN topic', { topic: webhookData.topic });
        return res.status(200).json({ status: 'ignored', message: `Topic ${webhookData.topic} not processed` });
      }
      
      // Convert IPN format to webhook format for processing
      const ipnData = {
        type: 'payment',
        action: 'payment.updated',
        data: { id: webhookData.id }
      };
      
      const result = await mercadoPagoService.processWebhook(ipnData);
      return res.status(200).json({ status: 'success', result });
    }

    // Handle webhook format (type + data.id in body)
    if (!webhookData || !webhookData.type) {
      // Check if it's a resource-based notification (older format)
      if (webhookData?.resource) {
        paymentLogger.info('Resource-based notification received - acknowledged', { 
          resource: webhookData.resource 
        });
        return res.status(200).json({ status: 'acknowledged', message: 'Resource notification received' });
      }
      
      paymentLogger.warn('Invalid webhook payload received', { 
        body: JSON.stringify(req.body),
        query: JSON.stringify(req.query)
      });
      return res.status(200).json({ status: 'ignored', message: 'Invalid payload' });
    }

    const result = await mercadoPagoService.processWebhook(webhookData);

    // Acknowledge receipt
    res.status(200).json({
      status: 'success',
      result: result
    });
  } catch (error: any) {
    paymentLogger.error('Error in /webhook/mercadopago', { error: error.message });
    // Still return 200 to acknowledge receipt
    res.status(200).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Get Mercado Pago webhook info
 * GET /webhook/mercadopago
 */
app.get('/webhook/mercadopago', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: 'Mercado Pago webhook endpoint',
    url: `${process.env.WEBHOOK_BASE_URL}/webhook/mercadopago`
  });
});

// ========================================
// PAYPAL PAYMENT ENDPOINTS
// ========================================

import { getPaymentGateway } from './services/paymentStrategyService';
import { addPurchasedCredits } from './services/creditsWalletService';
import postCallProcessingService from './services/postCallProcessingService';
import { Retell } from 'retell-sdk';

/**
 * PayPal webhook handler
 * POST /webhook/paypal
 * Handles PayPal webhook events (PAYMENT.CAPTURE.COMPLETED, etc.)
 */
app.post('/webhook/paypal',
  webhookLimiter,
  async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const headers = req.headers as Record<string, string>;
    
    paymentLogger.info('Received PayPal webhook', {
      eventType: payload.event_type,
      resourceId: payload.resource?.id,
    });

    // TODO: Add webhook signature verification for production
    // PayPal webhook verification requires certificate download and validation
    // For now, we verify by checking the order status via API
    
    const gateway = getPaymentGateway();
    const paypalProvider = gateway.getProvider('paypal');
    
    const result = await paypalProvider.handleWebhook(payload, headers);
    
    if (result.success && result.creditsToAdd && result.userId) {
      // Find user by internal UUID and add credits
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const user = await prisma.user.findUnique({
        where: { id: result.userId }
      });
      
      if (user) {
        await addPurchasedCredits(
          user.id,
          result.creditsToAdd,
          result.paymentId,
          'PayPal Purchase'
        );
        paymentLogger.info('Credits added via PayPal webhook', {
          userId: user.id,
          credits: result.creditsToAdd,
          paymentId: result.paymentId,
        });

        // ========================================
        // SEND PURCHASE RECEIPT EMAIL (non-blocking, idempotent)
        // ========================================
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        const newBalance = updatedUser?.credits ?? 0;

        // Fetch payment details for accurate receipt fields
        let amountPaid = 0;
        let currency = 'USD';
        let paidAt = new Date();
        try {
          const status = await paypalProvider.getPaymentStatus(result.paymentId);
          if (typeof status.amount === 'number' && !Number.isNaN(status.amount)) amountPaid = status.amount;
          if (status.currency) currency = status.currency;
          if (status.paidAt) paidAt = status.paidAt;
        } catch (e: any) {
          paymentLogger.warn('Failed to fetch PayPal payment status for receipt', {
            paymentId: result.paymentId,
            error: e?.message,
          });
        }

        if (user.email) {
          const purchaseData: PurchaseEmailData = {
            user: {
              id: user.id,
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
              preferredLanguage: user.preferredLanguage
            },
            paymentId: result.paymentId,
            provider: 'paypal',
            creditsAmount: result.creditsToAdd,
            amountPaid,
            currency,
            newBalance,
            paidAt
          };

          // Fire and forget
          sendPurchaseReceiptEmail(purchaseData)
            .then(emailResult => {
              if (emailResult.success && !emailResult.skipped) {
                paymentLogger.info('PayPal purchase receipt email sent', { 
                  userId: user.id, 
                  paymentId: result.paymentId, 
                  messageId: emailResult.messageId 
                });
              } else if (emailResult.skipped) {
                paymentLogger.info('PayPal purchase receipt already sent (idempotent)', { 
                  userId: user.id, 
                  paymentId: result.paymentId 
                });
              } else {
                paymentLogger.warn('PayPal purchase receipt email failed (non-blocking)', { 
                  userId: user.id, 
                  paymentId: result.paymentId, 
                  error: emailResult.error 
                });
              }
            })
            .catch(err => {
              paymentLogger.error('PayPal purchase receipt email error (non-blocking)', { 
                userId: user.id, 
                paymentId: result.paymentId, 
                error: err.message 
              });
            });
        }
      }
    }
    
    res.status(200).json({ status: 'success', result });
  } catch (error: any) {
    paymentLogger.error('Error in /webhook/paypal', { error: error.message });
    res.status(200).json({ status: 'error', message: error.message });
  }
});

// ========================================
// RETELL WEBHOOK ENDPOINTS
// ========================================

type RetellWebhookPayload = {
  event?: string;
  call?: any;
};

const handleRetellWebhook = async (req: Request, res: Response) => {
  try {
    const payload = req.body as RetellWebhookPayload;
    const signature = (req.headers['x-retell-signature'] as string) || '';
    const apiKey = process.env.RETELL_API_KEY || '';

    // Verify signature (required in production)
    if (apiKey && signature) {
      const valid = Retell.verify(JSON.stringify(req.body), apiKey, signature);
      if (!valid) {
        retellLogger.warn('Invalid Retell webhook signature');
        return res.status(401).json({ status: 'rejected', message: 'Invalid signature' });
      }
    } else if (process.env.NODE_ENV === 'production') {
      retellLogger.warn('Missing Retell webhook verification inputs');
      return res.status(401).json({ status: 'rejected', message: 'Missing signature verification' });
    }

    const event = payload?.event;
    const call = payload?.call;

    const interviewId =
      call?.metadata?.interview_id ||
      call?.metadata?.interviewId ||
      call?.metadata?.InterviewId ||
      call?.metadata?.interviewID ||
      null;

    // Always ack quickly (Retell webhook timeout is short)
    res.status(204).send();

    if (!interviewId) {
      retellLogger.warn('Retell webhook missing interview_id metadata', {
        event,
        callId: call?.call_id,
      });
      return;
    }

    // Best-effort: ensure interview has retellCallId linked
    if (call?.call_id) {
      prisma.interview
        .updateMany({
          where: { id: interviewId, retellCallId: null },
          data: { retellCallId: call.call_id },
        })
        .catch((e: any) => {
          retellLogger.warn('Failed to link retellCallId to interview', {
            interviewId,
            callId: call.call_id,
            error: e?.message,
          });
        });
    }

    // Trigger processing on analysis-ready event (per Retell docs)
    if (event === 'call_analyzed') {
      postCallProcessingService
        .processInterview(interviewId, { callData: call })
        .catch((error: any) => {
          retellLogger.error('Post-call processing failed from webhook', {
            interviewId,
            callId: call?.call_id,
            error: error.message,
          });
        });
    }
  } catch (error: any) {
    retellLogger.error('Error handling Retell webhook', { error: error.message });
    // Acknowledge anyway to avoid retries storms
    if (!res.headersSent) {
      res.status(204).send();
    }
  }
};

/**
 * Retell webhook handler
 * POST /webhook/retell
 */
app.post('/webhook/retell', webhookLimiter, handleRetellWebhook);

/**
 * Retell webhook handler (alias)
 * POST /api/webhooks/retell
 */
app.post('/api/webhooks/retell', webhookLimiter, handleRetellWebhook);

/**
 * Get PayPal webhook info
 * GET /webhook/paypal
 */
app.get('/webhook/paypal', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: 'PayPal webhook endpoint',
    url: `${process.env.WEBHOOK_BASE_URL}/webhook/paypal`
  });
});

// ========================================
// UNIFIED PAYMENT WEBHOOK ENDPOINT
// ========================================

/**
 * Unified payment webhook handler
 * POST /webhook/payment
 * Routes webhooks to the appropriate payment provider (MercadoPago or PayPal)
 * This is the webhook URL set in payment creation
 */
app.post('/webhook/payment',
  webhookLimiter,
  async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const query = req.query;
    const headers = req.headers as Record<string, string>;
    
    // Detect provider based on payload/query structure
    let provider: 'mercadopago' | 'paypal' | null = null;
    
    // MercadoPago detection
    if (query.topic || query.id || payload?.type === 'payment' || payload?.action) {
      provider = 'mercadopago';
    }
    // PayPal detection  
    else if (payload?.event_type || payload?.resource_type) {
      provider = 'paypal';
    }
    
    if (!provider) {
      paymentLogger.warn('Could not detect payment provider from webhook', {
        hasBody: !!payload,
        hasQuery: !!Object.keys(query).length,
        bodyKeys: Object.keys(payload || {}),
        queryKeys: Object.keys(query || {})
      });
      return res.status(400).json({ status: 'error', message: 'Could not detect payment provider' });
    }
    
    paymentLogger.info('Unified webhook received', { 
      provider,
      queryParams: query,
      bodyKeys: Object.keys(payload || {})
    });
    
    // Route to appropriate provider webhook
    if (provider === 'mercadopago') {
      // MercadoPago sends data in both query params (IPN) and body (webhook)
      // Merge both sources, with query params taking precedence for IPN
      const webhookData = {
        ...payload,
        // Query params override body for IPN format
        ...(query.topic && { topic: query.topic }),
        ...(query.id && { id: query.id }),
        // Handle data.id from body
        ...(payload?.data?.id && { data: { id: payload.data.id } }),
      };
      
      const dataId = webhookData?.data?.id || webhookData?.id || '';
      const topic = webhookData?.topic || '';

      paymentLogger.info('Routing to MercadoPago webhook handler', { 
        type: webhookData?.type,
        action: webhookData?.action,
        dataId,
        topic,
        hasQueryId: !!query.id,
        hasBodyDataId: !!payload?.data?.id,
      });

      // Handle merchant_order topic - acknowledge but don't process
      if (topic === 'merchant_order' || webhookData?.resource?.includes('merchant_orders')) {
        paymentLogger.info('Merchant order notification - acknowledged', { topic });
        return res.status(200).json({ 
          status: 'acknowledged', 
          message: 'Merchant order notification received' 
        });
      }

      // Skip if no payment ID found
      if (!dataId) {
        paymentLogger.warn('No payment ID found in MercadoPago webhook', { 
          query, 
          bodyKeys: Object.keys(payload || {}) 
        });
        return res.status(200).json({ 
          status: 'error', 
          message: 'No payment ID found' 
        });
      }

      // Verify webhook signature if secret is configured
      if (dataId && process.env.MERCADOPAGO_WEBHOOK_SECRET) {
        const verification = verifyMercadoPagoSignature(headers, dataId);
        if (!verification.valid) {
          paymentLogger.warn('MercadoPago webhook signature verification failed', { 
            error: verification.error,
            dataId 
          });
          return res.status(200).json({ 
            status: 'rejected', 
            message: 'Signature verification failed' 
          });
        }
      }

      // Process payment webhook
      const gateway = getPaymentGateway();
      const mercadoPagoProvider = gateway.getProvider('mercadopago');
      
      const result = await mercadoPagoProvider.handleWebhook(webhookData, headers);
      
      if (result.success && result.creditsToAdd && result.userId) {
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        
        const user = await prisma.user.findUnique({
          where: { id: result.userId }
        });
        
        if (user) {
          await addPurchasedCredits(
            user.id,
            result.creditsToAdd,
            result.paymentId,
            'Mercado Pago Purchase'
          );
          paymentLogger.info('✅ Credits added via unified webhook (MercadoPago)', {
            userId: user.id,
            credits: result.creditsToAdd,
            paymentId: result.paymentId,
          });

          // Send purchase receipt email (non-blocking)
          const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
          const newBalance = updatedUser?.credits ?? 0;

          // Fetch payment details for accurate receipt fields
          let amountPaid = 0;
          let currency = 'BRL';
          let paidAt = new Date();
          try {
            const status = await mercadoPagoProvider.getPaymentStatus(result.paymentId);
            if (typeof status.amount === 'number' && !Number.isNaN(status.amount)) amountPaid = status.amount;
            if (status.currency) currency = status.currency;
            if (status.paidAt) paidAt = status.paidAt;
          } catch (e: any) {
            paymentLogger.warn('Failed to fetch MercadoPago payment status for receipt', {
              paymentId: result.paymentId,
              error: e?.message,
            });
          }

          if (user.email) {
            const purchaseData: PurchaseEmailData = {
              user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                preferredLanguage: user.preferredLanguage
              },
              paymentId: result.paymentId,
              provider: 'mercadopago',
              creditsAmount: result.creditsToAdd,
              amountPaid,
              currency,
              newBalance,
              paidAt
            };

            sendPurchaseReceiptEmail(purchaseData).catch(err => {
              paymentLogger.error('Purchase receipt email error (non-blocking)', { 
                error: err.message 
              });
            });
          }
        }
        
        await prisma.$disconnect();
      }
      
      return res.status(200).json({ status: 'success', result });
      
    } else if (provider === 'paypal') {
      // Forward to PayPal webhook handler logic
      paymentLogger.info('Routing to PayPal webhook handler', {
        eventType: payload.event_type,
      });

      const gateway = getPaymentGateway();
      const paypalProvider = gateway.getProvider('paypal');
      
      const result = await paypalProvider.handleWebhook(payload, headers);
      
      if (result.success && result.creditsToAdd && result.userId) {
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        
        const user = await prisma.user.findUnique({
          where: { id: result.userId }
        });
        
        if (user) {
          await addPurchasedCredits(
            user.id,
            result.creditsToAdd,
            result.paymentId,
            'PayPal Purchase'
          );
          paymentLogger.info('✅ Credits added via unified webhook (PayPal)', {
            userId: user.id,
            credits: result.creditsToAdd,
            paymentId: result.paymentId,
          });

          // Send purchase receipt email (non-blocking)
          const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
          const newBalance = updatedUser?.credits ?? 0;

          // Fetch payment details for accurate receipt fields
          let amountPaid = 0;
          let currency = 'USD';
          let paidAt = new Date();
          try {
            const status = await paypalProvider.getPaymentStatus(result.paymentId);
            if (typeof status.amount === 'number' && !Number.isNaN(status.amount)) amountPaid = status.amount;
            if (status.currency) currency = status.currency;
            if (status.paidAt) paidAt = status.paidAt;
          } catch (e: any) {
            paymentLogger.warn('Failed to fetch PayPal payment status for receipt', {
              paymentId: result.paymentId,
              error: e?.message,
            });
          }

          if (user.email) {
            const purchaseData: PurchaseEmailData = {
              user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                preferredLanguage: user.preferredLanguage
              },
              paymentId: result.paymentId,
              provider: 'paypal',
              creditsAmount: result.creditsToAdd,
              amountPaid,
              currency,
              newBalance,
              paidAt
            };

            sendPurchaseReceiptEmail(purchaseData).catch(err => {
              paymentLogger.error('Purchase receipt email error (non-blocking)', { 
                error: err.message 
              });
            });
          }
        }
        
        await prisma.$disconnect();
      }
      
      return res.status(200).json({ status: 'success', result });
    }
    
  } catch (error: any) {
    paymentLogger.error('Error in unified /webhook/payment', { error: error.message, stack: error.stack });
    return res.status(200).json({ status: 'error', message: error.message });
  }
});

/**
 * Get unified webhook info
 * GET /webhook/payment
 */
app.get('/webhook/payment', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: 'Unified payment webhook endpoint',
    url: `${process.env.WEBHOOK_BASE_URL}/webhook/payment`,
    providers: ['mercadopago', 'paypal']
  });
});

// ========================================
// PAYMENT REDIRECT BRIDGE (for HTTPS providers)
// ========================================

/**
 * Payment redirect bridge
 * 
 * Some providers (especially MercadoPago) require HTTPS public return URLs.
 * In development we can point return URLs to the public backend (ngrok)
 * and then redirect back to the local frontend.
 */
function buildFrontendRedirectUrl(pathname: string, query: Request['query']): string {
  const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3000';
  const url = new URL(`${frontendBase}${pathname}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach(v => url.searchParams.append(key, String(v)));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

app.get('/payment/redirect/success', (req: Request, res: Response) => {
  res.redirect(302, buildFrontendRedirectUrl('/payment/success', req.query));
});

app.get('/payment/redirect/failure', (req: Request, res: Response) => {
  res.redirect(302, buildFrontendRedirectUrl('/payment/failure', req.query));
});

app.get('/payment/redirect/pending', (req: Request, res: Response) => {
  res.redirect(302, buildFrontendRedirectUrl('/payment/pending', req.query));
});

/**
 * Capture PayPal order after buyer approval
 * POST /api/payments/paypal/capture/:orderId
 * Called by frontend after PayPal checkout approval
 * Requires session authentication
 */
app.post('/api/payments/paypal/capture/:orderId',
  sensitiveLimiter,
  requireSession,
  async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }
    
    paymentLogger.info('Capturing PayPal order', { orderId, userId });
    
    // Get PayPal credentials
    const isProduction = process.env.NODE_ENV === 'production';
    const clientId = isProduction 
      ? process.env.PAYPAL_CLIENT_ID 
      : process.env.PAYPAL_SANDBOX_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
    const clientSecret = isProduction
      ? process.env.PAYPAL_CLIENT_SECRET
      : process.env.PAYPAL_SANDBOX_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET;
    const baseUrl = isProduction
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
    
    if (!clientId || !clientSecret) {
      return res.status(500).json({ status: 'error', message: 'PayPal not configured' });
    }
    
    // Get access token
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    
    if (!tokenResponse.ok) {
      throw new Error('Failed to get PayPal access token');
    }
    
    const tokenData = await tokenResponse.json() as { access_token: string };
    
    // Capture the order
    const captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!captureResponse.ok) {
      const errorText = await captureResponse.text();
      paymentLogger.error('PayPal capture failed', { orderId, error: errorText });
      return res.status(400).json({ status: 'error', message: 'Payment capture failed' });
    }
    
    interface PayPalCaptureResponse {
      id: string;
      status: string;
      purchase_units?: Array<{
        custom_id?: string;
        payments?: {
          captures?: Array<{ id: string; status: string }>;
        };
      }>;
    }
    
    const captureResult = await captureResponse.json() as PayPalCaptureResponse;
    
    paymentLogger.info('PayPal order captured', {
      orderId,
      status: captureResult.status,
    });
    
    // If capture successful, add credits
    if (captureResult.status === 'COMPLETED') {
      let customData: { userId?: string; credits?: number; packageId?: string } = {};
      try {
        const customIdFromCapture = captureResult.purchase_units?.[0]?.custom_id;
        if (customIdFromCapture) {
          customData = JSON.parse(customIdFromCapture);
        }
      } catch (e) {
        paymentLogger.warn('Failed to parse custom_id', { orderId });
      }

      // Fallback: capture response may omit custom_id; fetch order details
      if ((!customData.userId || !customData.credits) && tokenData.access_token) {
        try {
          const orderDetailsResponse = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}`, {
            headers: {
              'Authorization': `Bearer ${tokenData.access_token}`,
            },
          });

          if (orderDetailsResponse.ok) {
            const orderDetails = await orderDetailsResponse.json() as any;
            const customIdFromOrder = orderDetails?.purchase_units?.[0]?.custom_id;
            if (customIdFromOrder) {
              customData = {
                ...customData,
                ...(JSON.parse(customIdFromOrder) || {}),
              };
            }
          }
        } catch (e: any) {
          paymentLogger.warn('Failed to fetch PayPal order details for custom_id', {
            orderId,
            error: e?.message,
          });
        }
      }
      
      if (customData.userId && customData.userId !== userId) {
        return res.status(403).json({
          status: 'error',
          message: 'Payment does not belong to the current user',
        });
      }

      if (customData.credits && customData.userId) {
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        
        const user = await prisma.user.findUnique({
          where: { id: customData.userId }
        });
        
        if (user) {
          const creditTx = await addPurchasedCredits(
            user.id,
            customData.credits,
            orderId,
            `PayPal ${customData.packageId || 'Purchase'}`
          );

          if (!creditTx.success) {
            paymentLogger.error('Failed to add credits via PayPal capture', {
              userId: user.id,
              orderId,
              credits: customData.credits,
              error: creditTx.error,
            });

            return res.status(500).json({
              status: 'error',
              orderId,
              paymentStatus: captureResult.status,
              message: 'Payment captured but credit allocation failed',
            });
          }

          paymentLogger.info('Credits added via PayPal capture', {
            userId: user.id,
            credits: customData.credits,
            orderId,
          });

          // ========================================
          // SEND PURCHASE RECEIPT EMAIL (non-blocking, idempotent)
          // Use PayPal orderId as the stable identifier for receipts.
          // ========================================
          try {
            const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
            const newBalance = updatedUser?.credits ?? 0;

            const gateway = getPaymentGateway();
            const paypalProvider = gateway.getProvider('paypal');

            // Fetch payment details for accurate receipt fields
            let amountPaid = 0;
            let currency = 'USD';
            let paidAt = new Date();
            try {
              const status = await paypalProvider.getPaymentStatus(orderId);
              if (typeof status.amount === 'number' && !Number.isNaN(status.amount)) amountPaid = status.amount;
              if (status.currency) currency = status.currency;
              if (status.paidAt) paidAt = status.paidAt;
            } catch (e: any) {
              paymentLogger.warn('Failed to fetch PayPal payment status for receipt (capture)', {
                orderId,
                error: e?.message,
              });
            }

            if (user.email) {
              const purchaseData: PurchaseEmailData = {
                user: {
                  id: user.id,
                  email: user.email,
                  firstName: user.firstName,
                  lastName: user.lastName,
                  preferredLanguage: user.preferredLanguage,
                },
                paymentId: orderId,
                provider: 'paypal',
                creditsAmount: customData.credits,
                amountPaid,
                currency,
                newBalance,
                paidAt,
              };

              sendPurchaseReceiptEmail(purchaseData).catch((err) => {
                paymentLogger.error('Purchase receipt email error (non-blocking) (capture)', {
                  orderId,
                  error: err.message,
                });
              });
            }
          } catch (emailError: any) {
            paymentLogger.warn('Could not prepare receipt email (non-blocking) (capture)', {
              orderId,
              error: emailError.message,
            });
          }
        }
      }
    }
    
    res.json({
      status: 'success',
      orderId,
      paymentStatus: captureResult.status,
    });
  } catch (error: any) {
    paymentLogger.error('Error capturing PayPal order', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * Check payment status by preference ID
 * GET /payment/status/:preferenceId
 * Rate limited + authenticated
 */
app.get('/payment/status/:preferenceId',
  sensitiveLimiter,
  [
    param('preferenceId').isString().notEmpty().withMessage('Invalid preference ID'),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { preferenceId } = req.params;
    paymentLogger.info('Checking payment status', { preferenceId });

    const result = await mercadoPagoService.getPaymentByPreferenceId(preferenceId);

    res.json({
      status: 'success',
      ...result
    });
  } catch (error: any) {
    paymentLogger.error('Error checking payment status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Manually verify and process a payment by payment ID
 * POST /payment/verify/:paymentId
 * Used for manual recovery when webhook fails
 */
app.post('/payment/verify/:paymentId', async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    paymentLogger.info('Manually verifying payment', { paymentId });

    // Simulate webhook notification
    const result = await mercadoPagoService.processWebhook({
      type: 'payment',
      data: { id: paymentId }
    });

    res.json({
      status: 'success',
      result
    });
  } catch (error: any) {
    paymentLogger.error('Error verifying payment', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Get recent payments for a user (for debugging)
 * GET /payment/history/:userId
 * Protected: User can only view their own history
 */
app.get('/payment/history/:userId',
  sensitiveLimiter,
  requireSession,
  [
    param('userId').matches(/^user_[a-zA-Z0-9]+$/).withMessage('Invalid user ID format'),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const authenticatedUserId = req.userId;
    
    // SECURITY: User can only view their own payment history
    if (userId !== authenticatedUserId) {
      paymentLogger.warn('Unauthorized payment history access attempt', { 
        requestedUserId: userId, 
        authenticatedUserId 
      });
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized: Cannot view payment history for another user'
      });
    }
    
    paymentLogger.info('Getting payment history', { userId });

    const payments = await mercadoPagoService.getRecentPayments();

    // Filter payments for this user
    const userPayments = payments.filter((p: any) => {
      try {
        const ref = JSON.parse(p.external_reference || '{}');
        return ref.userId === userId;
      } catch {
        return false;
      }
    });

    res.json({
      status: 'success',
      payments: userPayments
    });
  } catch (error: any) {
    paymentLogger.error('Error getting payment history', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// ===== USER ENDPOINTS =====

/**
 * Get current user data
 * GET /api/users/me
 * 
 * Returns the authenticated user's data from local database.
 * 
 * Protected: Requires valid session
 */
app.get('/api/users/me',
  requireSession,
  async (req: Request, res: Response) => {
  try {
    // Session-based auth responses must never be cached (stale credits after purchases)
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const userId = req.userId;
    
    // Get user from database directly
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            interviews: true,
            payments: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        status: 'error',
        message: 'User account is deactivated'
      });
    }

    res.json({
      status: 'success',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        credits: user.credits,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        _count: user._count
      }
    });
  } catch (error: any) {
    authLogger.error('Failed to get user', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get user data',
      error: error.message
    });
  }
});

/**
 * Validate user session and ensure user exists
 * POST /api/users/validate
 * 
 * Called by frontend on interview page load and critical actions.
 * Validates session and ensures user exists in database.
 * 
 * Protected: Requires valid session
 */
app.post('/api/users/validate',
  requireSession,
  async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    
    authLogger.info('User validation requested', { userId });

    // Look up user directly from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            interviews: true,
            payments: true
          }
        }
      }
    });

    if (!user) {
      authLogger.warn('User not found in database', { userId });
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    if (!user.isActive) {
      authLogger.warn('User is inactive', { userId });
      return res.status(403).json({
        status: 'error',
        message: 'User account is deactivated'
      });
    }

    authLogger.info('User validation completed', { 
      userId, 
      dbUserId: user.id, 
      credits: user.credits
    });

    // ========================================
    // TRIGGER WELCOME EMAIL (non-blocking, idempotent)
    // Sends once per user (deduped by userId)
    // ========================================
    if (user.email) {
      const userEmailData: UserEmailData = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        preferredLanguage: user.preferredLanguage
      };
      
      // Fire and forget - don't block the response
      sendWelcomeEmail(userEmailData)
        .then(result => {
          if (result.success) {
            if (result.skipped) {
              authLogger.info('Welcome email skipped (already sent)', { userId: user.id });
            } else {
              authLogger.info('Welcome email sent', { userId: user.id, messageId: result.messageId });
            }
          } else {
            authLogger.warn('Welcome email failed (non-blocking)', { 
              userId: user.id, 
              error: result.error 
            });
          }
        })
        .catch(err => {
          authLogger.error('Welcome email error (non-blocking)', { 
            userId: user.id, 
            error: err.message 
          });
        });
    }

    res.json({
      status: 'success',
      message: 'User validated',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        credits: user.credits,
        createdAt: user.createdAt
      },
      freeTrialGranted: false,
      freeCreditBlocked: false,
      phoneVerificationRequired: user.credits === 0 && !user.phoneVerified
    });
  } catch (error: any) {
    authLogger.error('User validation failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to validate user',
      error: error.message
    });
  }
});

/**
 * Update user profile
 * PUT /api/users/profile
 * 
 * Updates user profile fields (firstName, lastName, role, etc.)
 * Protected: Requires valid user authentication
 */
app.put('/api/users/profile',
  requireSession,
  async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { firstName, lastName, role } = req.body;

    authLogger.info('Profile update requested', { userId, firstName, lastName, role });

    // Validate that user exists
    const existingUser = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!existingUser) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Build update data
    const updateData: any = {};
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    
    // Update role in database if provided
    // Note: role is stored as currentRole in the User table
    if (role !== undefined) {
      // Map frontend role names to backend role enum if needed
      const roleMap: Record<string, string> = {
        'Candidate': 'B2C_FREE',
        'Recruiter': 'B2B_RECRUITER',
        'Admin': 'ADMIN'
      };
      updateData.currentRole = roleMap[role] || existingUser.currentRole;
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData
    });

    authLogger.info('Profile updated successfully', { userId });

    res.json({
      status: 'success',
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        imageUrl: updatedUser.imageUrl,
        credits: updatedUser.credits,
        currentRole: updatedUser.currentRole
      }
    });
  } catch (error: any) {
    authLogger.error('Profile update failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update profile',
      error: error.message
    });
  }
});

/**
 * Delete user account (soft delete)
 * DELETE /api/users/delete
 * 
 * Soft-deletes the user account by setting isActive=false and deletedAt.
 * Protected: Requires valid user authentication
 */
app.delete('/api/users/delete',
  requireSession,
  async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    authLogger.info('Account deletion requested', { userId });

    // Validate that user exists
    const existingUser = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!existingUser) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Soft delete - set isActive=false and deletedAt
    await prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        deletedAt: new Date()
      }
    });

    // Invalidate any active sessions for this user
    await prisma.session.deleteMany({
      where: { userId }
    });

    authLogger.info('Account deleted successfully', { userId });

    res.json({
      status: 'success',
      message: 'Account deleted successfully'
    });
  } catch (error: any) {
    authLogger.error('Account deletion failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete account',
      error: error.message
    });
  }
});

// ===== CREDITS MANAGEMENT =====

/**
 * Consume credit when interview starts
 * POST /consume-credit
 * CRITICAL: This endpoint handles financial transactions
 * Protected: Requires valid session + rate limited
 * Uses PostgreSQL as source of truth for credits
 */
app.post('/consume-credit',
  sensitiveLimiter,
  requireSession,
  [
    body('callId').optional().isString().trim(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { callId } = req.body;
    const userId = req.userId!; // Non-null: requireSession ensures userId exists

    authLogger.info('Credit consumption requested', { userId, callId });

    // Get current user credits from PostgreSQL (source of truth)
    const dbUser = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!dbUser) {
      authLogger.warn('User not found in database', { userId });
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    const currentCredits = dbUser.credits;

    if (currentCredits <= 0) {
      authLogger.warn('Insufficient credits', { userId, currentCredits });
      return res.status(400).json({
        status: 'error',
        message: 'Insufficient credits'
      });
    }

    // Update credits in PostgreSQL (source of truth)
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { credits: { decrement: 1 } }
    });

    // Record in wallet ledger (non-blocking)
    try {
      await spendCredits(
        userId,
        1,
        'Interview credit consumed',
        callId ? 'interview' : undefined,
        callId,
        callId ? `interview_${callId}` : undefined
      );
    } catch (walletError: any) {
      authLogger.warn('Failed to record credit spend in wallet (non-critical)', { 
        userId,
        error: walletError.message 
      });
    }

    authLogger.info('Credit consumed', { userId, previousCredits: currentCredits, newCredits: updatedUser.credits });

    // ========================================
    // SEND LOW CREDITS WARNING (non-blocking, idempotent)
    // Trigger when credits fall to 2 or below
    // ========================================
    const LOW_CREDITS_THRESHOLD = 2;
    if (updatedUser.credits <= LOW_CREDITS_THRESHOLD && currentCredits > LOW_CREDITS_THRESHOLD) {
      // Only send if user just crossed the threshold
      try {
        if (dbUser.email) {
          const lowCreditsData: LowCreditsData = {
            user: {
              id: dbUser.id,
              email: dbUser.email,
              firstName: dbUser.firstName,
              lastName: dbUser.lastName,
              preferredLanguage: dbUser.preferredLanguage
            },
            currentCredits: updatedUser.credits,
            threshold: LOW_CREDITS_THRESHOLD
          };
          
          // Fire and forget
          sendLowCreditsEmail(lowCreditsData)
            .then(result => {
              if (result.success && !result.skipped) {
                authLogger.info('Low credits warning email sent', { 
                  userId, 
                  newCredits: updatedUser.credits,
                  messageId: result.messageId 
                });
              } else if (result.skipped) {
                authLogger.info('Low credits warning already sent (idempotent)', { userId });
              }
            })
            .catch(err => {
              authLogger.warn('Low credits email failed (non-blocking)', { 
                userId, 
                error: err.message 
              });
            });
        }
      } catch (emailError: any) {
        // Non-blocking
        authLogger.warn('Could not prepare low credits email', { error: emailError.message });
      }
    }

    res.json({
      status: 'success',
      message: 'Credit consumed successfully',
      previousCredits: currentCredits,
      newCredits: updatedUser.credits
    });
  } catch (error: any) {
    authLogger.error('Error consuming credit', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Restore credits when interview is cancelled due to incompatibility
 * POST /restore-credit
 * Protected: Requires valid session + rate limited
 * Uses PostgreSQL as source of truth for credits
 */
app.post('/restore-credit',
  sensitiveLimiter,
  requireSession,
  [
    body('reason').optional().isString().trim().isLength({ max: 200 }),
    body('callId').optional().isString().trim(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { reason, callId } = req.body;
    const userId = req.userId;

    if (!userId) {
      authLogger.warn('Credit restoration - no user ID in session');
      return res.status(401).json({
        status: 'error',
        message: 'Unauthorized: No authenticated user'
      });
    }

    authLogger.info('Credit restoration requested', { userId, reason, callId });

    const restoreIdempotencyKey = callId ? `restore_call_${callId}` : null;
    if (restoreIdempotencyKey) {
      const existingRestore = await prisma.creditLedger.findUnique({
        where: { idempotencyKey: restoreIdempotencyKey },
        select: { id: true }
      });

      if (existingRestore) {
        authLogger.info('Credit restoration skipped (idempotent)', {
          userId,
          callId,
          idempotencyKey: restoreIdempotencyKey
        });

        // Best-effort: report current credits
        const dbUser = await prisma.user.findUnique({
          where: { id: userId },
          select: { credits: true }
        });

        const currentCredits = dbUser?.credits ?? 0;

        return res.json({
          status: 'success',
          message: 'Credit already restored',
          previousCredits: currentCredits,
          newCredits: currentCredits
        });
      }
    }

    // Get current user credits from PostgreSQL (source of truth)
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, credits: true }
    });
    
    if (!dbUser) {
      authLogger.warn('User not found in database', { userId });
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    const currentCredits = dbUser.credits;
    
    // SECURITY: Cap maximum credits to prevent abuse
    const MAX_CREDITS = 100;
    if (currentCredits >= MAX_CREDITS) {
      authLogger.warn('Credit restoration blocked - max credits reached', { userId, currentCredits });
      return res.status(400).json({
        status: 'error',
        message: 'Maximum credit limit reached'
      });
    }

    // Update credits in PostgreSQL (source of truth)
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { credits: { increment: 1 } },
      select: { credits: true }
    });

    // Record in wallet ledger (non-blocking)
    try {
      await restoreCredits(
        userId,
        1,
        reason || 'Credit restored due to interview cancellation',
        callId ? 'interview' : undefined,
        callId,
        restoreIdempotencyKey || undefined
      );
    } catch (walletError: any) {
      authLogger.warn('Failed to record credit restore in wallet (non-critical)', { 
        userId,
        error: walletError.message 
      });
    }

    authLogger.info('Credit restored', { userId, previousCredits: currentCredits, newCredits: updatedUser.credits });

    res.json({
      status: 'success',
      message: 'Credit restored successfully',
      previousCredits: currentCredits,
      newCredits: updatedUser.credits
    });
  } catch (error: any) {
    authLogger.error('Error restoring credit', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// ========================================
// GLOBAL ERROR HANDLERS (JSON-ONLY)
// ========================================

/**
 * API 404 Handler - Catch all unmatched /api/* routes
 * Returns JSON instead of HTML for missing API routes
 */
app.use('/api/*', (req: Request, res: Response) => {
  const requestId = (req as any).requestId || crypto.randomUUID().slice(0, 8);
  
  httpLogger.warn('API route not found', { 
    requestId, 
    method: req.method, 
    path: req.path,
    originalUrl: req.originalUrl 
  });
  
  res.status(404).json({
    ok: false,
    status: 'error',
    error: {
      code: 'NOT_FOUND',
      message: `API endpoint not found: ${req.method} ${req.path}`,
      requestId
    }
  });
});

/**
 * Global Error Handler - Ensures all errors return JSON
 * Catches any unhandled errors and returns proper JSON response
 */
app.use((err: Error & { status?: number; statusCode?: number }, req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId || crypto.randomUUID().slice(0, 8);
  const statusCode = err.status || err.statusCode || 500;
  
  // Log the error
  logger.error('Unhandled error caught by global handler', {
    requestId,
    path: req.path,
    method: req.method,
    error: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
  });
  
  // Determine safe message (don't expose internal errors in production)
  const safeMessage = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'An internal server error occurred'
    : err.message || 'An unexpected error occurred';
  
  // Always return JSON
  res.status(statusCode).json({
    ok: false,
    status: 'error',
    error: {
      code: statusCode === 500 ? 'SERVER_ERROR' : 'REQUEST_ERROR',
      message: safeMessage,
      requestId
    }
  });
});

// ===== APPLY EXPRESS-WS TO APP =====

// Import http for shared server with GraphQL
import http from 'http';

// Create HTTP server for both Express, WebSocket, and GraphQL
const httpServer = http.createServer(app);

// Apply express-ws with shared HTTP server
const { app: wsApp, getWss } = expressWs(app, httpServer);

// ===== WEBSOCKET ENDPOINT FOR CUSTOM LLM =====
// Handle multiple URL patterns for flexibility:
// Pattern 1: /llm-websocket/:call_id (standard - Retell should replace {call_id})
// Pattern 2: /llm-websocket/:placeholder/:actual_call_id (if Retell appends instead of replacing)

// Handler function to avoid code duplication
const handleWebSocketConnection = (ws: WebSocket, callId: string, url: string) => {
  wsLogger.info('WebSocket connection received', {
    callId,
    url
  });

  if (!callId || callId === 'undefined' || callId === '{call_id}') {
    wsLogger.error('Invalid call ID received', { callId, url });
    return;
  }

  // Create handler for this connection
  const handler = new CustomLLMWebSocketHandler(ws, openai, callId);

  ws.on('message', async (data: RawData) => {
    try {
      const messageStr = data.toString();
      wsLogger.debug('WebSocket message received', { 
        callId, 
        messageLength: messageStr.length
      });
      await handler.handleMessage(messageStr);
    } catch (error: any) {
      wsLogger.error('WebSocket message processing error', { 
        callId, 
        error: error.message,
        stack: error.stack 
      });
    }
  });

  ws.on('error', (error: Error) => {
    wsLogger.error('WebSocket error', { callId, error: error.message });
    handler.handleError(error);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    wsLogger.info('WebSocket closed', { 
      callId, 
      code, 
      reason: reason.toString() 
    });
    handler.handleClose();
  });
};

// Pattern: /llm-websocket/{call_id}/<actual_call_id> (Retell appends call ID)
wsApp.ws('/llm-websocket/:placeholder/:actual_call_id', (ws: WebSocket, req: express.Request, next: express.NextFunction) => {
  const callId = req.params.actual_call_id;
  wsLogger.info('WebSocket matched pattern 2 (appended call ID)', { 
    placeholder: req.params.placeholder,
    callId 
  });
  handleWebSocketConnection(ws, callId, req.url);
});

// Pattern: /llm-websocket/<call_id> (standard - Retell replaces {call_id})
wsApp.ws('/llm-websocket/:call_id', (ws: WebSocket, req: express.Request, next: express.NextFunction) => {
  const callId = req.params.call_id;
  wsLogger.info('WebSocket matched pattern 1 (direct call ID)', { callId });
  handleWebSocketConnection(ws, callId, req.url);
});

logger.info('WebSocket endpoints initialized', {
  pattern1: '/llm-websocket/:call_id',
  pattern2: '/llm-websocket/:placeholder/:actual_call_id'
});

// ===== START SERVER WITH GRAPHQL =====

// Start server with async initialization for GraphQL
(async () => {
  try {
    // Initialize GraphQL before starting the server
    await setupGraphQL(app, httpServer);
    logger.info('GraphQL server initialized');

    // Start listening
    httpServer.listen(PORT, () => {
      logger.info('═'.repeat(60));
      logger.info('🎙️  Vocaid Backend Server Running');
      logger.info('═'.repeat(60));
      logger.info(`Port: ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info('Endpoints:', {
        http: `http://localhost:${PORT}`,
        graphql: `http://localhost:${PORT}/graphql`,
        websocket: `ws://localhost:${PORT}/llm-websocket`,
        health: `http://localhost:${PORT}/health`
      });
      logger.info('Services: Retell Custom LLM, Mercado Pago, OpenAI, Google OAuth, GraphQL');
      logger.info(`Custom LLM WebSocket URL: ${retellService.getCustomLLMWebSocketUrl()}`);
      logger.info(`Webhook URL: ${process.env.WEBHOOK_BASE_URL}/webhook/mercadopago`);
      logger.info(`Log Level: ${process.env.LOG_LEVEL || 'info'}`);
      logger.info('═'.repeat(60));
      
      // Periodic cleanup of expired call contexts (every 30 minutes)
      setInterval(() => {
        cleanupExpiredContexts();
      }, 30 * 60 * 1000);
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
})();

// Graceful shutdown handler
const gracefulShutdown = async (signal: string) => {
  logger.warn(`${signal} signal received: starting graceful shutdown`);
  
  // Close WebSocket connections first
  const wss = getWss();
  const closePromises: Promise<void>[] = [];
  
  wss.clients.forEach((client) => {
    closePromises.push(new Promise((resolve) => {
      client.once('close', () => resolve());
      client.close(1001, 'Server shutting down');
    }));
  });

  // Wait for connections to close (max 5 seconds)
  await Promise.race([
    Promise.all(closePromises),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  
  logger.info('WebSocket connections closed');

  // Disconnect database
  try {
    const { disconnectDatabase } = await import('./services/databaseService');
    await disconnectDatabase();
    logger.info('Database disconnected');
  } catch (err) {
    logger.error('Error disconnecting database', { error: err });
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
});

export default app;
