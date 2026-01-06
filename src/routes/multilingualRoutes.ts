/**
 * Multilingual API Routes
 * 
 * Routes for managing user language preferences, multilingual interviews,
 * and geo-based payment provider selection.
 * 
 * @module routes/multilingualRoutes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// Middleware
import { requireAuth } from '../middleware/sessionAuthMiddleware';
import { prisma } from '../services/databaseService';

// Services
import {
  getUserPreferences,
  updateUserPreferences,
  initializeUserPreferences,
  getPreferredPaymentProvider,
} from '../services/userPreferencesService';
import { getMultilingualRetellService } from '../services/multilingualRetellService';
import { getPaymentGateway, CREDIT_PACKAGES, getPackagePrice, getCurrencyForRegion } from '../services/paymentStrategyService';
import { addPurchasedCredits } from '../services/creditsWalletService';
import { apiLogger, paymentLogger } from '../utils/logger';

// Types
import { SupportedLanguageCode, isValidLanguageCode } from '../types/multilingual';

const router = Router();

// ========================================
// SCHEMAS
// ========================================

const updatePreferencesSchema = z.object({
  language: z.string().refine(isValidLanguageCode, 'Invalid language code').optional(),
  country: z.string().length(2).optional(),
  timezone: z.string().optional(),
  preferredPhoneCountry: z.string().length(2).optional(), // ISO2 for phone country picker
});

const registerMultilingualCallSchema = z.object({
  language: z.string().refine(isValidLanguageCode, 'Invalid language code').optional(),
  metadata: z.object({
    first_name: z.string(),
    last_name: z.string().optional(),
    job_title: z.string(),
    company_name: z.string(),
    job_description: z.string(),
    interviewee_cv: z.string(),
    resume_file_name: z.string().optional(),
    resume_mime_type: z.string().optional(),
    interview_id: z.string().optional(),
  }),
});

const createPaymentSchema = z.object({
  packageId: z.enum(['starter', 'intermediate', 'professional']),
  language: z.string().refine(isValidLanguageCode, 'Invalid language code').optional(),
  provider: z.enum(['mercadopago', 'paypal']).optional(),
});

const confirmMercadoPagoSchema = z.object({
  paymentId: z.string().min(1),
});

// ========================================
// MIDDLEWARE
// ========================================

/**
 * Extract client IP from request
 */
function getClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = typeof forwarded === 'string' ? forwarded : forwarded[0];
    return ips.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || '127.0.0.1';
}

// ========================================
// USER PREFERENCES ROUTES
// ========================================

/**
 * GET /api/multilingual/preferences
 * Get user's language and region preferences
 */
router.get('/preferences', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const preferences = await getUserPreferences(userId);
    
    if (!preferences) {
      return res.status(404).json({
        status: 'error',
        message: 'Preferences not found',
      });
    }
    
    res.json({
      status: 'success',
      data: preferences,
    });
  } catch (error: any) {
    apiLogger.error('Error fetching preferences', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch preferences',
    });
  }
});

/**
 * PUT /api/multilingual/preferences
 * Update user's language and region preferences
 */
router.put('/preferences', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const body = updatePreferencesSchema.parse(req.body);
    
    const preferences = await updateUserPreferences(userId, {
      language: body.language as SupportedLanguageCode,
      country: body.country,
      timezone: body.timezone,
      setByUser: true,
      preferredPhoneCountry: body.preferredPhoneCountry,
    });
    
    res.json({
      status: 'success',
      data: preferences,
      message: 'Preferences updated successfully',
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }
    
    apiLogger.error('Error updating preferences', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update preferences',
    });
  }
});

/**
 * POST /api/multilingual/preferences/initialize
 * Initialize preferences for new user with auto-detection
 */
router.post('/preferences/initialize', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const ip = getClientIP(req);
    const headers = req.headers as Record<string, string>;
    
    const preferences = await initializeUserPreferences(userId, ip, headers);
    
    res.json({
      status: 'success',
      data: preferences,
      message: 'Preferences initialized successfully',
    });
  } catch (error: any) {
    apiLogger.error('Error initializing preferences', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to initialize preferences',
    });
  }
});

// ========================================
// MULTILINGUAL INTERVIEW ROUTES
// ========================================

/**
 * POST /api/multilingual/call/register
 * Register a multilingual interview call
 */
router.post('/call/register', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const body = registerMultilingualCallSchema.parse(req.body);
    
    const retellService = getMultilingualRetellService();
    
    let result;
    if (body.language) {
      // Use specified language
      result = await retellService.registerMultilingualCall({
        userId,
        language: body.language as SupportedLanguageCode,
        metadata: {
          ...body.metadata,
          preferred_language: body.language as SupportedLanguageCode,
        },
      });
    } else {
      // Auto-detect from user preferences
      result = await retellService.registerCallWithAutoLanguage(userId, body.metadata);
    }
    
    res.json({
      status: 'success',
      data: result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }
    
    apiLogger.error('Error registering multilingual call', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to register call',
    });
  }
});

/**
 * GET /api/multilingual/languages
 * Get list of supported languages with configuration
 */
router.get('/languages', async (_req: Request, res: Response) => {
  try {
    const retellService = getMultilingualRetellService();
    const configuredLanguages = retellService.getConfiguredLanguages();
    
    const { LANGUAGE_CONFIGS } = await import('../types/multilingual');
    
    const languages = Object.entries(LANGUAGE_CONFIGS).map(([code, config]) => ({
      code,
      name: config.name,
      englishName: config.englishName,
      flag: config.flag,
      hasAgent: configuredLanguages.includes(code as SupportedLanguageCode),
    }));
    
    res.json({
      status: 'success',
      data: languages,
    });
  } catch (error: any) {
    apiLogger.error('Error fetching languages', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch languages',
    });
  }
});

// ========================================
// GEO-PAYMENT ROUTES
// ========================================

/**
 * GET /api/multilingual/payment/provider
 * Get the preferred payment provider for the user
 */
router.get('/payment/provider', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { provider, isFallback } = await getPreferredPaymentProvider(userId);
    
    const gateway = getPaymentGateway();
    const providerInfo = gateway.getProvider(provider);
    
    res.json({
      status: 'success',
      data: {
        provider: provider,
        name: providerInfo.name,
        isFallback,
        supportedCurrencies: providerInfo.supportedCurrencies,
      },
    });
  } catch (error: any) {
    paymentLogger.error('Error getting payment provider', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get payment provider',
    });
  }
});

/**
 * GET /api/multilingual/payment/packages
 * Get available credit packages with localized prices
 */
router.get('/payment/packages', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const preferences = await getUserPreferences(userId);
    
    const language = (preferences?.language || 'en-US') as SupportedLanguageCode;
    const region = preferences?.region || 'GLOBAL';
    const currency = getCurrencyForRegion(region);
    
    const packages = Object.entries(CREDIT_PACKAGES).map(([id, pkg]) => ({
      id,
      name: pkg.name,
      credits: pkg.credits,
      price: pkg.prices[currency],
      priceUSD: pkg.prices.USD,
      currency,
      description: pkg.description[language] || pkg.description['en-US'],
    }));
    
    res.json({
      status: 'success',
      data: {
        packages,
        currency,
        region,
        language,
      },
    });
  } catch (error: any) {
    paymentLogger.error('Error fetching packages', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch packages',
    });
  }
});

/**
 * POST /api/multilingual/payment/create
 * Create a payment with automatic provider selection
 */
router.post('/payment/create', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const body = createPaymentSchema.parse(req.body);
    
    // Get user preferences for language and region
    const preferences = await getUserPreferences(userId);
    const language = (body.language || preferences?.language || 'en-US') as SupportedLanguageCode;
    const region = preferences?.region || 'GLOBAL';
    
    // Determine currency based on provider
    // MercadoPago requires a LATAM currency, PayPal uses USD
    let currency = getCurrencyForRegion(region);
    if (body.provider === 'mercadopago' && currency === 'USD') {
      // Default to BRL for MercadoPago when region is not LATAM
      // BRL is the primary currency for MercadoPago
      currency = 'BRL';
      paymentLogger.info('Overriding currency to BRL for MercadoPago', { originalRegion: region });
    }
    
    // Get package info
    const pkg = CREDIT_PACKAGES[body.packageId];
    if (!pkg) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid package ID',
      });
    }
    
    // Get user email from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    
    if (!user?.email) {
      return res.status(400).json({
        status: 'error',
        message: 'User email not found',
      });
    }
    
    const userEmail = user.email;
    
    // Create payment with geo-based provider (or user-specified provider)
    const gateway = getPaymentGateway();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const webhookUrl = process.env.WEBHOOK_BASE_URL;

    // In development we typically only expose the backend via ngrok.
    // If WEBHOOK_BASE_URL is configured, use backend redirect-bridge endpoints
    // so providers can redirect to HTTPS (ngrok) and then bounce to the frontend.
    const successUrl = webhookUrl
      ? `${webhookUrl}/payment/redirect/success`
      : `${frontendUrl}/payment/success`;
    const failureUrl = webhookUrl
      ? `${webhookUrl}/payment/redirect/failure`
      : `${frontendUrl}/payment/failure`;
    const pendingUrl = webhookUrl
      ? `${webhookUrl}/payment/redirect/pending`
      : `${frontendUrl}/payment/pending`;
    
    const result = await gateway.createPayment(userId, {
      userEmail,
      packageId: body.packageId,
      packageName: pkg.name,
      credits: pkg.credits,
      amountUSD: pkg.prices.USD,
      amountLocal: pkg.prices[currency],
      currency,
      language,
      successUrl,
      failureUrl,
      pendingUrl,
      webhookUrl: webhookUrl ? `${webhookUrl}/webhook/payment` : undefined,
    }, body.provider); // Pass user-specified provider
    
    paymentLogger.info('Payment created', {
      provider: result.selectedProvider,
      packageId: body.packageId,
      userId,
    });
    
    res.json({
      status: 'success',
      data: {
        paymentId: result.id,
        redirectUrl: result.initPoint,
        provider: result.selectedProvider,
        sandboxMode: result.sandboxMode,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }
    
    paymentLogger.error('Error creating payment', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to create payment',
    });
  }
});

/**
 * GET /api/multilingual/payment/status/:paymentId
 * Check payment status
 */
router.get('/payment/status/:paymentId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    const provider = req.query.provider as string;
    
    if (!provider || (provider !== 'mercadopago' && provider !== 'paypal')) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or missing provider parameter',
      });
    }
    
    const gateway = getPaymentGateway();
    const providerInstance = gateway.getProvider(provider as any);
    const status = await providerInstance.getPaymentStatus(paymentId);
    
    res.json({
      status: 'success',
      data: status,
    });
  } catch (error: any) {
    paymentLogger.error('Error checking payment status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to check payment status',
    });
  }
});

/**
 * POST /api/multilingual/payment/confirm/mercadopago
 * Confirm MercadoPago payment and add credits (fallback when webhook/redirect timing is unreliable).
 * Protected: requires session auth; enforces `user.id`.
 */
router.post('/payment/confirm/mercadopago', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const { paymentId } = confirmMercadoPagoSchema.parse(req.body);

    const gateway = getPaymentGateway();
    const mpProvider = gateway.getProvider('mercadopago');

    // Reuse provider webhook logic to fetch/verify payment details and extract metadata.
    const result = await mpProvider.handleWebhook({ data: { id: paymentId } }, req.headers as any);

    if (result.userId && result.userId !== userId) {
      return res.status(403).json({
        status: 'error',
        message: 'Payment does not belong to the current user',
      });
    }

    if (!result.success || !result.creditsToAdd) {
      return res.json({
        status: 'success',
        data: {
          confirmed: false,
          paymentId: result.paymentId || paymentId,
          paymentStatus: result.status,
          statusDetail: result.statusDetail,
        },
      });
    }

    const tx = await addPurchasedCredits(
      userId,
      result.creditsToAdd,
      result.paymentId || paymentId,
      'Mercado Pago Purchase'
    );

    return res.json({
      status: 'success',
      data: {
        confirmed: true,
        paymentId: result.paymentId || paymentId,
        creditsAdded: result.creditsToAdd,
        newBalance: tx.newBalance,
      },
    });
  } catch (error: any) {
    paymentLogger.error('Error confirming MercadoPago payment', { error: error.message });
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }
    return res.status(500).json({
      status: 'error',
      message: 'Failed to confirm payment',
    });
  }
});

export default router;
