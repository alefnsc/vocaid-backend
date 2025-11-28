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
const feedbackService = new FeedbackService(process.env.OPENAI_API_KEY || '');

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

    // Generate feedback
    const feedback = await feedbackService.generateFeedback(
      call.transcript as any,
      call.metadata?.job_title || 'Unknown Position',
      call.metadata?.job_description || '',
      call.metadata?.first_name || 'Candidate'
    );

    res.json({
      status: 'success',
      call_id: callId,
      feedback: feedback
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

// ===== CREDITS MANAGEMENT =====

import { clerkClient } from '@clerk/clerk-sdk-node';

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
