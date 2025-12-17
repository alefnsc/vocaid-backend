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

// Services
import {
  getUserPreferences,
  updateUserPreferences,
  initializeUserPreferences,
  getPreferredPaymentProvider,
} from '../services/userPreferencesService';
import { getMultilingualRetellService } from '../services/multilingualRetellService';
import { getPaymentGateway, CREDIT_PACKAGES, getPackagePrice, getCurrencyForRegion } from '../services/paymentStrategyService';
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

/**
 * Get Clerk user ID from request
 */
function getClerkUserId(req: Request): string | null {
  return (req.headers['x-user-id'] as string) || null;
}

/**
 * Require authenticated user
 */
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const clerkId = getClerkUserId(req);
  if (!clerkId) {
    return res.status(401).json({ status: 'error', message: 'Authentication required' });
  }
  (req as any).clerkUserId = clerkId;
  next();
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
    const clerkId = (req as any).clerkUserId;
    const preferences = await getUserPreferences(clerkId);
    
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
    const clerkId = (req as any).clerkUserId;
    const body = updatePreferencesSchema.parse(req.body);
    
    const preferences = await updateUserPreferences(clerkId, {
      language: body.language as SupportedLanguageCode,
      country: body.country,
      timezone: body.timezone,
      setByUser: true,
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
    const clerkId = (req as any).clerkUserId;
    const ip = getClientIP(req);
    const headers = req.headers as Record<string, string>;
    
    const preferences = await initializeUserPreferences(clerkId, ip, headers);
    
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
    const clerkId = (req as any).clerkUserId;
    const body = registerMultilingualCallSchema.parse(req.body);
    
    const retellService = getMultilingualRetellService();
    
    let result;
    if (body.language) {
      // Use specified language
      result = await retellService.registerMultilingualCall({
        userId: clerkId,
        language: body.language as SupportedLanguageCode,
        metadata: {
          ...body.metadata,
          preferred_language: body.language as SupportedLanguageCode,
        },
      });
    } else {
      // Auto-detect from user preferences
      result = await retellService.registerCallWithAutoLanguage(clerkId, body.metadata);
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
    const clerkId = (req as any).clerkUserId;
    const { provider, isFallback } = await getPreferredPaymentProvider(clerkId);
    
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
    const clerkId = (req as any).clerkUserId;
    const preferences = await getUserPreferences(clerkId);
    
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
    const clerkId = (req as any).clerkUserId;
    const body = createPaymentSchema.parse(req.body);
    
    // Get user preferences for language and region
    const preferences = await getUserPreferences(clerkId);
    const language = (body.language || preferences?.language || 'en-US') as SupportedLanguageCode;
    const region = preferences?.region || 'GLOBAL';
    const currency = getCurrencyForRegion(region);
    
    // Get package info
    const pkg = CREDIT_PACKAGES[body.packageId];
    if (!pkg) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid package ID',
      });
    }
    
    // Get user email from Clerk
    const { clerkClient } = await import('@clerk/express');
    const clerkUser = await clerkClient.users.getUser(clerkId);
    const userEmail = clerkUser.emailAddresses[0]?.emailAddress || '';
    
    // Create payment with geo-based provider
    const gateway = getPaymentGateway();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const webhookUrl = process.env.WEBHOOK_BASE_URL;
    
    const result = await gateway.createPayment(clerkId, {
      userEmail,
      packageId: body.packageId,
      packageName: pkg.name,
      credits: pkg.credits,
      amountUSD: pkg.prices.USD,
      amountLocal: pkg.prices[currency],
      currency,
      language,
      successUrl: `${frontendUrl}/payment/success`,
      failureUrl: `${frontendUrl}/payment/failure`,
      pendingUrl: `${frontendUrl}/payment/pending`,
      webhookUrl: webhookUrl ? `${webhookUrl}/webhook/payment` : undefined,
    });
    
    paymentLogger.info('Payment created', {
      provider: result.selectedProvider,
      packageId: body.packageId,
      userId: clerkId,
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

export default router;
