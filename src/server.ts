import express, { Request, Response, NextFunction } from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { RawData, WebSocket } from 'ws';

// Services
import { RetellService } from './services/retellService';
import { MercadoPagoService } from './services/mercadoPagoService';
import { FeedbackService } from './services/feedbackService';
import { CustomLLMWebSocketHandler } from './services/customLLMWebSocket';

// Logger
import logger, { wsLogger, retellLogger, feedbackLogger, paymentLogger, authLogger } from './utils/logger';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'RETELL_API_KEY',
  'RETELL_AGENT_ID',
  'MERCADOPAGO_ACCESS_TOKEN',
  'CLERK_SECRET_KEY'
];

// Optional env vars (warn but don't fail)
const optionalEnvVars = ['GEMINI_API_KEY'];

const missingEnvVars = requiredEnvVars.filter(varName => {
  const value = process.env[varName];
  return !value || value === `your_${varName.toLowerCase()}_here` || value.includes('your_');
});

if (missingEnvVars.length > 0) {
  logger.error('Missing or invalid API keys in .env file', { missingVars: missingEnvVars });
  logger.error('Please update /voxly-back/.env with valid API keys');
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
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow localhost, ngrok, and configured frontend URL
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    // Allow any ngrok URL
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
    
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'ngrok-skip-browser-warning']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize services
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const retellService = new RetellService(process.env.RETELL_API_KEY || '');
const mercadoPagoService = new MercadoPagoService(process.env.MERCADOPAGO_ACCESS_TOKEN || '');
const feedbackService = new FeedbackService(
  process.env.OPENAI_API_KEY || '',
  process.env.GEMINI_API_KEY // Optional Gemini fallback
);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    message: 'Voxly Backend is running',
    timestamp: new Date().toISOString()
  });
});

// ===== INTERVIEW ENDPOINTS =====

/**
 * Register a new Retell call
 * POST /register-call
 */
app.post('/register-call', async (req: Request, res: Response) => {
  try {
    const { metadata } = req.body;
    const userId = req.headers['x-user-id'] as string || 'anonymous';

    if (!metadata) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing metadata'
      });
    }

    const result = await retellService.registerCall({ metadata }, userId);
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
 */
app.get('/get-feedback-for-interview/:callId', async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;

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
      transcriptLength: Array.isArray(call.transcript) ? call.transcript.length : 'unknown'
    });

    // Generate feedback with call status for accurate scoring
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
      call_status: callStatus
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
 */
app.post('/create-payment-preference', async (req: Request, res: Response) => {
  try {
    const { packageId, userId, userEmail } = req.body;

    if (!packageId || !userId || !userEmail) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: packageId, userId, userEmail'
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
 */
app.post('/webhook/mercadopago', async (req: Request, res: Response) => {
  try {
    paymentLogger.info('Received Mercado Pago webhook', { type: req.body?.type });

    const result = await mercadoPagoService.processWebhook(req.body);

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

/**
 * Check payment status by preference ID
 * GET /payment/status/:preferenceId
 * Used for polling when MercadoPago redirect doesn't work (sandbox mode)
 */
app.get('/payment/status/:preferenceId', async (req: Request, res: Response) => {
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
 */
app.get('/payment/history/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
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

// ===== CLERK WEBHOOKS =====

import { clerkClient } from '@clerk/clerk-sdk-node';

/**
 * Clerk webhook handler for user events
 * POST /webhook/clerk
 * 
 * Handles:
 * - user.created: Grants 1 free credit to new users
 */
app.post('/webhook/clerk', async (req: Request, res: Response) => {
  try {
    const { type, data } = req.body;

    authLogger.info('Received Clerk webhook', { type, userId: data?.id });

    if (type === 'user.created') {
      const userId = data.id;
      const userEmail = data.email_addresses?.[0]?.email_address;
      
      authLogger.info('New user registration', { userId, userEmail });

      // Grant 1 free credit to new user
      try {
        await clerkClient.users.updateUser(userId, {
          publicMetadata: {
            credits: 1,
            freeTrialUsed: false,
            registrationDate: new Date().toISOString()
          }
        });

        authLogger.info('Free trial credit granted', { userId, credits: 1 });
        
        res.status(200).json({
          status: 'success',
          message: 'Free trial credit granted',
          userId,
          credits: 1
        });
      } catch (updateError: any) {
        authLogger.error('Failed to grant free credit', { userId, error: updateError.message });
        res.status(200).json({
          status: 'error',
          message: 'Failed to grant free credit',
          error: updateError.message
        });
      }
    } else {
      // Acknowledge other webhook types
      res.status(200).json({
        status: 'ok',
        message: `Webhook type ${type} acknowledged`
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
    events: ['user.created']
  });
});

// ===== CREDITS MANAGEMENT =====

/**
 * Consume credit when interview starts
 * POST /consume-credit
 */
app.post('/consume-credit', async (req: Request, res: Response) => {
  try {
    const { userId, callId } = req.body;

    if (!userId) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing userId'
      });
    }

    authLogger.info('Credit consumption requested', { userId, callId });

    // Get current user credits
    const user = await clerkClient.users.getUser(userId);
    const currentCredits = (user.publicMetadata.credits as number) || 0;

    if (currentCredits <= 0) {
      authLogger.warn('Insufficient credits', { userId, currentCredits });
      return res.status(400).json({
        status: 'error',
        message: 'Insufficient credits'
      });
    }

    const newCredits = currentCredits - 1;

    // Update user metadata with consumed credit
    await clerkClient.users.updateUser(userId, {
      publicMetadata: {
        ...user.publicMetadata,
        credits: newCredits
      }
    });

    authLogger.info('Credit consumed', { userId, previousCredits: currentCredits, newCredits });

    res.json({
      status: 'success',
      message: 'Credit consumed successfully',
      previousCredits: currentCredits,
      newCredits: newCredits
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
 */
app.post('/restore-credit', async (req: Request, res: Response) => {
  try {
    const { userId, reason, callId } = req.body;

    if (!userId) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing userId'
      });
    }

    authLogger.info('Credit restoration requested', { userId, reason, callId });

    // Get current user credits
    const user = await clerkClient.users.getUser(userId);
    const currentCredits = (user.publicMetadata.credits as number) || 0;
    const newCredits = currentCredits + 1;

    // Update user metadata with restored credit
    await clerkClient.users.updateUser(userId, {
      publicMetadata: {
        ...user.publicMetadata,
        credits: newCredits
      }
    });

    authLogger.info('Credit restored', { userId, previousCredits: currentCredits, newCredits });

    res.json({
      status: 'success',
      message: 'Credit restored successfully',
      previousCredits: currentCredits,
      newCredits: newCredits
    });
  } catch (error: any) {
    authLogger.error('Error restoring credit', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
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
      wsLogger.info('WebSocket message received', { 
        callId, 
        messageLength: messageStr.length,
        messagePreview: messageStr.substring(0, 200)
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
  logger.info('🎙️  Voxly Backend Server Running');
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
  logger.info('═'.repeat(60));
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.warn('SIGTERM signal received: closing WebSocket connections');
  const wss = getWss();
  wss.clients.forEach((client) => {
    client.close();
  });
  logger.info('All connections closed');
  process.exit(0);
});

export default app;
