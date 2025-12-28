// Load environment variables FIRST - before any other imports
import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import bodyParser from 'body-parser';
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
import { MercadoPagoService, getMercadoPagoCredentials } from './services/mercadoPagoService';
import { FeedbackService } from './services/feedbackService';
import { CustomLLMWebSocketHandler } from './services/customLLMWebSocket';
import { spendCredits, restoreCredits } from './services/creditsWalletService';
import { verifyMercadoPagoSignature, generateWebhookIdempotencyKey } from './services/webhookVerificationService';
import { sendWelcomeEmail, sendPurchaseReceiptEmail, sendLowCreditsEmail, sendInterviewCompleteEmail, UserEmailData, PurchaseEmailData, LowCreditsData, InterviewCompleteData } from './services/transactionalEmailService';
import { storeCallContext, cleanupExpiredContexts } from './services/callContextService';

// Routes
import apiRoutes from './routes/apiRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import creditsRoutes from './routes/creditsRoutes';
import leadsRoutes from './routes/leadsRoutes';
import multilingualRoutes from './routes/multilingualRoutes';
import consentRoutes from './routes/consentRoutes';
import dashboardRoutes from './routes/dashboardRoutes';

// Middleware
import { requireConsent } from './middleware/consentMiddleware';

// Logger
import logger, { wsLogger, retellLogger, feedbackLogger, paymentLogger, authLogger, httpLogger } from './utils/logger';

// Log environment diagnostics at startup
logEnvDiagnostics();

// Validate required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'RETELL_API_KEY',
  'RETELL_AGENT_ID',
  'CLERK_SECRET_KEY'
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
  logger.error('Clerk: https://dashboard.clerk.com/');
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

// Validate userId format (Clerk user IDs)
const isValidUserId = (userId: string): boolean => {
  // Clerk user IDs follow pattern: user_xxxxx
  return /^user_[a-zA-Z0-9]+$/.test(userId);
};

// ===== CORS CONFIGURATION =====

app.use(cors({
  origin: function (origin, callback) {
    // Block requests with no origin in production (except webhooks)
    if (!origin) {
      // Allow for webhooks and health checks
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'ngrok-skip-browser-warning', 'svix-id', 'svix-timestamp', 'svix-signature']
}));

// Body parsers with size limits to prevent large payload attacks
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// ===== OBSERVABILITY MIDDLEWARE =====
// Centralized request tracking with metrics, slow request detection, and duplicate detection
import { observabilityMiddleware } from './middleware/observabilityMiddleware';
app.use(observabilityMiddleware);

// ===== CACHING MIDDLEWARE =====
// Adds Cache-Control headers to reduce bandwidth and Azure costs
import { cachingMiddleware } from './middleware/cachingMiddleware';
app.use(cachingMiddleware);

// Mount API routes for database operations (dashboard, interviews, payments, etc.)
app.use('/api', apiRoutes);

// Mount analytics, performance chat, and abuse detection routes
app.use('/api', analyticsRoutes);

// Mount credits wallet routes
app.use('/api/credits', creditsRoutes);

// Mount leads routes (public - no auth required)
app.use('/api/leads', leadsRoutes);

// Mount email routes (with increased body size limit for PDF attachments)
import emailRoutes from './routes/emailRoutes';
app.use('/api/email', emailRoutes);

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

// Mount resume repository routes (resume upload, scoring, LinkedIn import)
import resumeRoutes from './routes/resumeRoutes';
app.use('/api/resumes', resumeRoutes);

// Mount beta feedback routes (closed beta bug reports & feature requests)
import betaFeedbackRoutes from './routes/betaFeedbackRoutes';
app.use('/api/feedback/beta', betaFeedbackRoutes);

// Mount user profile routes (B2C profile management)
import userRoutes from './routes/userRoutes';
app.use('/api/users', userRoutes);

// Mount identity verification routes (Brazil KYC scaffold)
import identityRoutes from './routes/identityRoutes';
app.use('/api/identity', identityRoutes);

// ===== CONSENT MIDDLEWARE =====
// Apply consent checking to protected routes
// Exempt paths are defined in the middleware
app.use(requireConsent);

// ===== AUTHENTICATION MIDDLEWARE =====

// Verify user ID from header matches Clerk format and is present
const verifyUserAuth = async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.headers['x-user-id'] as string || req.body?.userId;
  
  if (!userId) {
    authLogger.warn('Missing user ID in request', { path: req.path });
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }
  
  if (!isValidUserId(userId)) {
    authLogger.warn('Invalid user ID format', { userId, path: req.path });
    return res.status(401).json({
      status: 'error',
      message: 'Invalid authentication'
    });
  }
  
  // Attach userId to request for downstream use
  (req as any).authenticatedUserId = userId;
  next();
};

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
  verifyUserAuth,
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
    const userId = (req as any).authenticatedUserId;

    // Sanitize metadata strings
    const sanitizedMetadata = {
      ...metadata,
      first_name: sanitizeString(metadata.first_name || ''),
      last_name: sanitizeString(metadata.last_name || ''),
      company_name: sanitizeString(metadata.company_name || ''),
      job_title: sanitizeString(metadata.job_title || ''),
      job_description: sanitizeString(metadata.job_description || ''),
      interviewee_cv: sanitizeString(metadata.interviewee_cv || ''),
    };

    const result = await retellService.registerCall({ metadata: sanitizedMetadata }, userId);
    
    // Store call context for Custom LLM WebSocket to retrieve
    // This ensures preferred_language is available even if Retell doesn't forward it
    if (result.call_id) {
      storeCallContext(result.call_id, {
        preferredLanguage: sanitizedMetadata.preferred_language || 'en-US',
        first_name: sanitizedMetadata.first_name,
        last_name: sanitizedMetadata.last_name,
        job_title: sanitizedMetadata.job_title,
        company_name: sanitizedMetadata.company_name,
        job_description: sanitizedMetadata.job_description,
        interviewee_cv: sanitizedMetadata.interviewee_cv,
        resume_file_name: sanitizedMetadata.resume_file_name,
        resume_mime_type: sanitizedMetadata.resume_mime_type,
      });
      retellLogger.info('Call context stored for Custom LLM', {
        callId: result.call_id,
        preferredLanguage: sanitizedMetadata.preferred_language || 'en-US',
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
  verifyUserAuth,
  [
    body('packageId').isIn(['starter', 'intermediate', 'professional']).withMessage('Invalid package ID'),
    body('userId').isString().matches(/^user_[a-zA-Z0-9]+$/).withMessage('Invalid user ID format'),
    body('userEmail').isEmail().normalizeEmail().withMessage('Invalid email format'),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { packageId, userId, userEmail } = req.body;
    const authenticatedUserId = (req as any).authenticatedUserId;
    
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
      // Find user by Clerk ID and add credits
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const user = await prisma.user.findUnique({
        where: { clerkId: result.userId }
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

        if (user.email) {
          const purchaseData: PurchaseEmailData = {
            user: {
              id: user.id,
              clerkId: user.clerkId,
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
              preferredLanguage: user.preferredLanguage
            },
            paymentId: result.paymentId,
            provider: 'paypal',
            packageName: `${result.creditsToAdd} Credits`,
            creditsAmount: result.creditsToAdd,
            amountPaid: 0, // PayPal doesn't provide this in webhook easily
            currency: 'USD',
            newBalance,
            paidAt: new Date()
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

/**
 * Capture PayPal order after buyer approval
 * POST /api/payments/paypal/capture/:orderId
 * Called by frontend after PayPal checkout approval
 */
app.post('/api/payments/paypal/capture/:orderId',
  sensitiveLimiter,
  async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const clerkUserId = req.headers['x-user-id'] as string;
    
    if (!clerkUserId) {
      return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }
    
    paymentLogger.info('Capturing PayPal order', { orderId, clerkUserId });
    
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
        const customId = captureResult.purchase_units?.[0]?.custom_id;
        customData = JSON.parse(customId || '{}');
      } catch (e) {
        paymentLogger.warn('Failed to parse custom_id', { orderId });
      }
      
      if (customData.credits && customData.userId) {
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        
        const user = await prisma.user.findUnique({
          where: { clerkId: customData.userId }
        });
        
        if (user) {
          await addPurchasedCredits(
            user.id,
            customData.credits,
            orderId,
            `PayPal ${customData.packageId || 'Purchase'}`
          );
          
          paymentLogger.info('Credits added via PayPal capture', {
            userId: user.id,
            credits: customData.credits,
            orderId,
          });
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
  verifyUserAuth,
  [
    param('userId').matches(/^user_[a-zA-Z0-9]+$/).withMessage('Invalid user ID format'),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const authenticatedUserId = (req as any).authenticatedUserId;
    
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

// ===== CLERK WEBHOOKS & USER SYNC =====

import { clerkClient } from '@clerk/express';
import { Webhook } from 'svix';
import * as clerkService from './services/clerkService';

/**
 * Clerk webhook handler for user events
 * POST /webhook/clerk
 * 
 * Handles:
 * - user.created: Creates user in database, grants 1 free credit
 * - user.updated: Syncs updated user data to database
 * - user.deleted: Removes user and related data from database
 * 
 * Security: Verifies Svix signature when CLERK_WEBHOOK_SECRET is set
 * 
 * Required Clerk Webhook Events (configure in Clerk Dashboard):
 * - user.created
 * - user.updated
 * - user.deleted
 */
app.post('/webhook/clerk',
  webhookLimiter,
  async (req: Request, res: Response) => {
  try {
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    
    // Verify webhook signature if secret is configured
    if (webhookSecret) {
      const svixId = req.headers['svix-id'] as string;
      const svixTimestamp = req.headers['svix-timestamp'] as string;
      const svixSignature = req.headers['svix-signature'] as string;
      
      if (!svixId || !svixTimestamp || !svixSignature) {
        authLogger.warn('Missing Svix headers in Clerk webhook');
        return res.status(400).json({ status: 'error', message: 'Missing webhook headers' });
      }
      
      // Prevent replay attacks - check if we've seen this webhook ID
      if (clerkService.isWebhookProcessed(svixId)) {
        authLogger.warn('Duplicate webhook ID detected (potential replay attack)', { svixId });
        return res.status(200).json({ status: 'ignored', message: 'Duplicate webhook' });
      }
      
      // Verify signature
      const isValid = clerkService.verifyWebhookSignature(
        JSON.stringify(req.body),
        {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        },
        webhookSecret
      );
      
      if (!isValid) {
        authLogger.error('Clerk webhook signature verification failed');
        return res.status(401).json({ status: 'error', message: 'Invalid webhook signature' });
      }
      
      // Mark webhook as processed
      clerkService.markWebhookProcessed(svixId);
      authLogger.info('Clerk webhook signature verified');
    } else {
      authLogger.warn('CLERK_WEBHOOK_SECRET not set - webhook signature not verified');
    }
    
    const { type, data } = req.body;
    const userId = data?.id || data?.user_id; // user_id for session events, id for user events

    authLogger.info('Received Clerk webhook', { type, userId });

    // Validate user ID format for user/session events
    const eventUserId = type.startsWith('session.') ? data?.user_id : data?.id;
    if ((type.startsWith('user.') || type.startsWith('session.')) && eventUserId && !isValidUserId(eventUserId)) {
      authLogger.warn('Invalid user ID in webhook', { userId: eventUserId, type });
      return res.status(200).json({ status: 'ignored', message: 'Invalid user ID' });
    }

    // Process the webhook event using clerkService
    try {
      const result = await clerkService.processWebhookEvent({ type, data, object: 'event' });
      
      // Extract ID from result based on event type
      let resultId = null;
      if (result) {
        if ('id' in result) {
          resultId = result.id;
        } else if ('user' in result && result.user) {
          resultId = result.user.id;
        } else if ('session' in result && result.session) {
          resultId = result.session.id;
        }
      }
      
      res.status(200).json({
        status: 'success',
        message: `Webhook ${type} processed successfully`,
        userId: eventUserId,
        result: resultId ? { id: resultId } : null
      });
    } catch (processError: any) {
      authLogger.error('Failed to process webhook event', { 
        type, 
        userId, 
        error: processError.message 
      });
      // Still return 200 to acknowledge receipt
      res.status(200).json({
        status: 'error',
        message: `Failed to process ${type}`,
        error: processError.message
      });
    }
  } catch (error: any) {
    authLogger.error('Error processing Clerk webhook', { error: error.message });
    // Still return 200 to acknowledge receipt
    res.status(200).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * Get Clerk webhook info
 * GET /webhook/clerk
 */
app.get('/webhook/clerk', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: 'Clerk webhook endpoint',
    url: `${process.env.WEBHOOK_BASE_URL}/webhook/clerk`,
    supportedEvents: clerkService.SUPPORTED_WEBHOOK_EVENTS,
    description: 'Subscribe to these events in Clerk Dashboard > Webhooks'
  });
});

// ===== USER SYNC ENDPOINTS =====

/**
 * Sync user data on login
 * POST /api/users/sync
 * 
 * Called by frontend when user logs in.
 * Ensures user exists in local database, creates from Clerk if not found.
 * 
 * Protected: Requires valid user authentication
 */
app.post('/api/users/sync',
  verifyUserAuth,
  async (req: Request, res: Response) => {
  try {
    const userId = (req as any).authenticatedUserId;
    
    authLogger.info('User sync requested', { userId });

    // Find or create user in database
    const { user, source } = await clerkService.findOrCreateUserByClerkId(userId);

    authLogger.info('User sync completed', { 
      userId, 
      dbUserId: user.id, 
      source,
      credits: user.credits 
    });

    res.json({
      status: 'success',
      message: source === 'clerk' ? 'User created from Clerk' : 'User found in database',
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
    authLogger.error('User sync failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to sync user',
      error: error.message
    });
  }
});

/**
 * Get current user data
 * GET /api/users/me
 * 
 * Returns the authenticated user's data from local database.
 * If user doesn't exist, attempts to create from Clerk.
 * 
 * Protected: Requires valid user authentication
 */
app.get('/api/users/me',
  verifyUserAuth,
  async (req: Request, res: Response) => {
  try {
    const userId = (req as any).authenticatedUserId;
    
    // First try to get from database
    let user = await clerkService.getUserFromDatabase(userId);
    
    // If not found, create from Clerk
    if (!user) {
      authLogger.info('User not in database, creating from Clerk', { userId });
      const result = await clerkService.findOrCreateUserByClerkId(userId);
      user = result.user as any;
    }

    // At this point user is guaranteed to exist
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found and could not be created'
      });
    }

    res.json({
      status: 'success',
      user: {
        id: user.id,
        clerkId: user.clerkId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        credits: user.credits,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        _count: (user as any)._count
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
 * Validates Clerk session and ensures user exists in database.
 * Creates user from Clerk if not found.
 * Includes abuse detection for free credit grants.
 * 
 * Protected: Requires valid user authentication
 */
app.post('/api/users/validate',
  verifyUserAuth,
  async (req: Request, res: Response) => {
  try {
    const userId = (req as any).authenticatedUserId;
    
    authLogger.info('User validation requested', { userId });

    // Capture signup info for abuse detection
    const signupInfo = {
      // Get IP from various headers (nginx, cloudflare, ngrok, etc.)
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                 (req.headers['x-real-ip'] as string) ||
                 req.socket.remoteAddress,
      // Device fingerprint from frontend (optional, sent in body)
      deviceFingerprint: req.body?.deviceFingerprint,
      userAgent: req.headers['user-agent']
    };

    // Validate and sync user with abuse detection
    const { user, source, freeTrialGranted, freeCreditBlocked, phoneVerificationRequired } = await clerkService.validateAndSyncUser(userId, signupInfo);

    authLogger.info('User validation completed', { 
      userId, 
      dbUserId: user.id, 
      source,
      credits: user.credits,
      freeTrialGranted,
      freeCreditBlocked,
      phoneVerificationRequired
    });

    // ========================================
    // TRIGGER WELCOME EMAIL (non-blocking, idempotent)
    // Sends once per user (deduped by clerkId)
    // ========================================
    if (user.email) {
      const userEmailData: UserEmailData = {
        id: user.id,
        clerkId: user.clerkId,
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
      message: source === 'clerk' ? 'User created from Clerk' : 'User validated',
      user: {
        id: user.id,
        clerkId: user.clerkId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
        credits: user.credits,
        createdAt: user.createdAt
      },
      freeTrialGranted,
      freeCreditBlocked,
      phoneVerificationRequired
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

// ===== CREDITS MANAGEMENT =====

/**
 * Consume credit when interview starts
 * POST /consume-credit
 * CRITICAL: This endpoint handles financial transactions
 * Protected: Requires valid user authentication + rate limited
 * Uses PostgreSQL as source of truth for credits
 */
app.post('/consume-credit',
  sensitiveLimiter,
  verifyUserAuth,
  [
    body('userId').matches(/^user_[a-zA-Z0-9]+$/).withMessage('Invalid user ID format'),
    body('callId').optional().isString().trim(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { userId, callId } = req.body;
    const authenticatedUserId = (req as any).authenticatedUserId;

    // CRITICAL SECURITY: Verify the request is for the authenticated user
    // Prevents users from consuming other users' credits
    if (userId !== authenticatedUserId) {
      authLogger.warn('Credit consumption user ID mismatch - potential attack', { 
        requestedUserId: userId, 
        authenticatedUserId,
        callId 
      });
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized: Cannot consume credits for another user'
      });
    }

    authLogger.info('Credit consumption requested', { userId, callId });

    // Get current user credits from PostgreSQL (source of truth)
    const dbUser = await clerkService.getUserFromDatabase(userId);
    
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
    const updatedUser = await clerkService.updateUserCredits(userId, 1, 'subtract');

    // Record in wallet ledger (non-blocking)
    // CRITICAL: Use dbUser.id (UUID) not userId (Clerk ID) for wallet operations
    try {
      await spendCredits(
        dbUser.id, // Use internal UUID, not Clerk ID
        1,
        'Interview credit consumed',
        callId ? 'interview' : undefined,
        callId,
        callId ? `interview_${callId}` : undefined
      );
    } catch (walletError: any) {
      authLogger.warn('Failed to record credit spend in wallet (non-critical)', { 
        userId,
        dbUserId: dbUser.id,
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
              clerkId: dbUser.clerkId,
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
 * Protected: Requires valid user authentication + rate limited
 * Uses PostgreSQL as source of truth for credits
 */
app.post('/restore-credit',
  sensitiveLimiter,
  verifyUserAuth,
  [
    body('userId').matches(/^user_[a-zA-Z0-9]+$/).withMessage('Invalid user ID format'),
    body('reason').optional().isString().trim().isLength({ max: 200 }),
    body('callId').optional().isString().trim(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response) => {
  try {
    const { userId, reason, callId } = req.body;
    const authenticatedUserId = (req as any).authenticatedUserId;

    // SECURITY: Verify the request is for the authenticated user
    if (userId !== authenticatedUserId) {
      authLogger.warn('Credit restoration user ID mismatch - potential attack', { 
        requestedUserId: userId, 
        authenticatedUserId,
        callId 
      });
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized: Cannot restore credits for another user'
      });
    }

    authLogger.info('Credit restoration requested', { userId, reason, callId });

    // Get current user credits from PostgreSQL (source of truth)
    const dbUser = await clerkService.getUserFromDatabase(userId);
    
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
    const updatedUser = await clerkService.updateUserCredits(userId, 1, 'add');

    // Record in wallet ledger (non-blocking)
    // CRITICAL: Use dbUser.id (UUID) not userId (Clerk ID) for wallet operations
    try {
      await restoreCredits(
        dbUser.id, // Use internal UUID, not Clerk ID
        1,
        reason || 'Credit restored due to interview cancellation',
        callId ? 'interview' : undefined,
        callId
      );
    } catch (walletError: any) {
      authLogger.warn('Failed to record credit restore in wallet (non-critical)', { 
        userId,
        dbUserId: dbUser.id,
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

const { app: wsApp, getWss } = expressWs(app);

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

// ===== START SERVER =====

wsApp.listen(PORT, () => {
  logger.info('═'.repeat(60));
  logger.info('🎙️  Vocaid Backend Server Running');
  logger.info('═'.repeat(60));
  logger.info(`Port: ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info('Endpoints:', {
    http: `http://localhost:${PORT}`,
    websocket: `ws://localhost:${PORT}/llm-websocket`,
    health: `http://localhost:${PORT}/health`
  });
  logger.info('Services: Retell Custom LLM, Mercado Pago, OpenAI, Clerk');
  logger.info(`Custom LLM WebSocket URL: ${retellService.getCustomLLMWebSocketUrl()}`);
  logger.info(`Webhook URL: ${process.env.WEBHOOK_BASE_URL}/webhook/mercadopago`);
  logger.info(`Log Level: ${process.env.LOG_LEVEL || 'info'}`);
  logger.info('═'.repeat(60));
  
  // Periodic cleanup of expired call contexts (every 30 minutes)
  setInterval(() => {
    cleanupExpiredContexts();
  }, 30 * 60 * 1000);
});

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
