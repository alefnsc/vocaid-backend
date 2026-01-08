/**
 * Authentication Routes
 * 
 * First-party authentication with cookie-based sessions.
 * Supports email/password signup with email verification and Google OAuth.
 * 
 * @module routes/authRoutes
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';
import {
  validatePassword,
  authenticateUser,
  createPasswordResetToken,
  consumePasswordResetToken,
  updateUserPassword,
  setUserPassword,
  userHasPassword,
  PASSWORD_POLICY,
  hashPassword,
  verifyPassword,
} from '../services/passwordService';
import { sendPasswordResetEmail, sendEmailVerificationEmail } from '../services/transactionalEmailService';
import {
  createSession,
  destroySession,
  destroyAllUserSessions,
  getSessionToken,
  getSessionCookieName,
  getSessionCookieOptions,
} from '../services/sessionService';
import { requireSession, optionalSession } from '../middleware/sessionAuthMiddleware';

const router = Router();
const prisma = new PrismaClient();

// Environment configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://api.vocaid.io/api/auth/google/callback'
    : 'http://localhost:3001/api/auth/google/callback');

// LinkedIn OAuth configuration
const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://api.vocaid.io/api/auth/linkedin/callback'
    : 'http://localhost:3001/api/auth/linkedin/callback');

// X (Twitter) OAuth 2.0 configuration
const X_CLIENT_ID = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const X_REDIRECT_URI = process.env.X_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://api.vocaid.io/api/auth/x/callback'
    : 'http://localhost:3001/api/auth/x/callback');

// Microsoft OAuth 2.0 configuration
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://api.vocaid.io/api/auth/microsoft/callback'
    : 'http://localhost:3001/api/auth/microsoft/callback');

const FRONTEND_URL = process.env.FRONTEND_URL || 
  (process.env.NODE_ENV === 'production' ? 'https://vocaid.io' : 'http://localhost:3000');

const DEFAULT_OAUTH_RETURN_TO = '/auth/post-login';

function normalizeReturnTo(value: unknown, fallback: string = DEFAULT_OAUTH_RETURN_TO): string {
  if (typeof value !== 'string') return fallback;

  const trimmed = value.trim();
  if (!trimmed) return fallback;

  // Only allow relative, app-internal paths.
  if (!trimmed.startsWith('/')) return fallback;
  if (trimmed.startsWith('//')) return fallback;
  if (trimmed.includes('://')) return fallback;
  if (/[\r\n]/.test(trimmed)) return fallback;

  return trimmed;
}

// Email verification token TTL (24 hours)
const EMAIL_VERIFICATION_TTL_HOURS = 24;

// Environment checks
const isDevelopment = process.env.NODE_ENV === 'development';

// Logger
const authLogger = {
  info: (msg: string, data?: any) => console.log(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: any) => console.error(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: any) => console.warn(`[AUTH] ${msg}`, data ? JSON.stringify(data) : ''),
};

// ========================================
// VALIDATION SCHEMAS
// ========================================

const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(PASSWORD_POLICY.minLength, `Password must be at least ${PASSWORD_POLICY.minLength} characters`),
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().max(100).optional(),
  preferredLanguage: z.enum(['en', 'pt']).optional().default('en'),
  // Account type: only PERSONAL is currently supported; BUSINESS will be enabled later
  userType: z.literal('PERSONAL').optional().default('PERSONAL'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const verifyEmailSchema = z.object({
  email: z.string().email('Invalid email address'),
  code: z.string().regex(/^\d{6}$/, 'Verification code must be 6 digits'),
});

const resendVerificationSchema = z.object({
  email: z.string().email('Invalid email address'),
});

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Generate a 6-digit email verification code
 */
function generateVerificationCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Hash a verification code for secure storage (scoped to user)
 */
function hashVerificationCode(userId: string, code: string): string {
  return crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

/**
 * Create email verification code for a user
 */
async function createEmailVerificationCode(
  userId: string
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateVerificationCode();
  const tokenHash = hashVerificationCode(userId, code);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  // Delete any existing tokens for this user
  await prisma.emailVerificationToken.deleteMany({
    where: { userId },
  });

  // Create new token
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  return { code, expiresAt };
}

/**
 * Verify and consume an email verification code
 */
async function consumeEmailVerificationCode(
  email: string,
  code: string
): Promise<{ userId: string } | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) {
    return null;
  }

  const tokenHash = hashVerificationCode(user.id, code);

  const verificationToken = await prisma.emailVerificationToken.findFirst({
    where: {
      tokenHash,
      expiresAt: { gt: new Date() },
      usedAt: null,
    },
  });

  if (!verificationToken) {
    return null;
  }

  // Mark token as used
  await prisma.emailVerificationToken.update({
    where: { id: verificationToken.id },
    data: { usedAt: new Date() },
  });

  return {
    userId: verificationToken.userId,
  };
}

// ========================================
// SIGNUP & EMAIL VERIFICATION
// ========================================

/**
 * Register a new user with email/password
 * POST /api/auth/signup
 * 
 * Creates a new user account and sends email verification.
 * User must verify email before they can access protected features.
 */
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const parseResult = signupSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: parseResult.error.errors[0]?.message || 'Invalid request',
        errors: parseResult.error.errors,
      });
    }

    const { email, password, firstName, lastName, preferredLanguage } = parseResult.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Validate password against policy
    const validation = validatePassword(password);
    if (!validation.isValid) {
      return res.status(400).json({
        status: 'error',
        message: validation.errors.join('. '),
        validation: validation.checks,
      });
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      // Don't reveal that email exists - just say we'll send verification
      authLogger.warn('Signup attempted with existing email', { email: normalizedEmail });
      
      // If user exists but not verified, resend verification
      if (!existingUser.emailVerified) {
        const { code, expiresAt } = await createEmailVerificationCode(
          existingUser.id
        );
        
        await sendEmailVerificationEmail({
          user: {
            id: existingUser.id,
            email: normalizedEmail,
            firstName: existingUser.firstName || undefined,
            preferredLanguage: existingUser.preferredLanguage || 'en',
          },
          verificationCode: code,
          expiresAt,
          ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
      
      return res.status(200).json({
        status: 'success',
        message: 'If this email is available, a verification code has been sent.',
        requiresVerification: true,
      });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user (userType currently always PERSONAL; BUSINESS coming soon)
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        firstName,
        lastName: lastName || null,
        preferredLanguage: preferredLanguage || 'en',
        passwordHash,
        emailVerified: false,
        isActive: true,
        currentRole: 'B2C_FREE',
        userType: 'PERSONAL',
        credits: 0, // Credits added after email verification
        authProviders: ['email'],
        lastAuthProvider: 'email',
      },
    });

    authLogger.info('New user created', { userId: user.id, email: normalizedEmail });

    // Create email verification code
    const { code, expiresAt } = await createEmailVerificationCode(
      user.id
    );

    // Send verification email
    const emailResult = await sendEmailVerificationEmail({
      user: {
        id: user.id,
        email: normalizedEmail,
        firstName,
        preferredLanguage: preferredLanguage || 'en',
      },
      verificationCode: code,
      expiresAt,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (!emailResult.success) {
      authLogger.error('Failed to send verification email', { 
        userId: user.id, 
        error: emailResult.error 
      });
    }

    res.status(201).json({
      status: 'success',
      message: 'Account created. Please check your email to verify your account.',
      requiresVerification: true,
    });
  } catch (error: any) {
    authLogger.error('Signup failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Signup failed. Please try again.',
    });
  }
});

/**
 * Verify email with token
 * POST /api/auth/verify-email
 * 
 * Verifies the user's email and activates their account.
 * Sets session cookie on successful verification.
 */
router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const parseResult = verifyEmailSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid verification code',
      });
    }

    const { email, code } = parseResult.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Consume the code
    const result = await consumeEmailVerificationCode(normalizedEmail, code);
    if (!result) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or expired verification code. Please request a new one.',
        code: 'INVALID_CODE',
      });
    }

    // Update user as verified
    const user = await prisma.user.update({
      where: { id: result.userId },
      data: {
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        currentRole: true,
        countryCode: true,
        preferredLanguage: true,
        emailVerified: true,
        credits: true,
      },
    });

    authLogger.info('Email verified', { userId: user.id });

    // Create session and set cookie
    await createSession({
      userId: user.id,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    }, res);

    res.json({
      status: 'success',
      message: 'Email verified successfully!',
      user,
    });
  } catch (error: any) {
    authLogger.error('Email verification failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Verification failed. Please try again.',
    });
  }
});

/**
 * Resend verification email
 * POST /api/auth/resend-verification
 * 
 * Sends a new verification email to the user.
 */
router.post('/resend-verification', async (req: Request, res: Response) => {
  try {
    const parseResult = resendVerificationSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid email is required',
      });
    }

    const { email } = parseResult.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        firstName: true,
        preferredLanguage: true,
        emailVerified: true,
      },
    });

    // Always return success to prevent enumeration
    if (!user) {
      return res.json({
        status: 'success',
        message: 'If an unverified account exists with this email, a verification code has been sent.',
      });
    }

    // If already verified, don't send
    if (user.emailVerified) {
      return res.json({
        status: 'success',
        message: 'If an unverified account exists with this email, a verification code has been sent.',
      });
    }

    // Create and send new verification code
    const { code, expiresAt } = await createEmailVerificationCode(
      user.id
    );

    await sendEmailVerificationEmail({
      user: {
        id: user.id,
        email: normalizedEmail,
        firstName: user.firstName || undefined,
        preferredLanguage: user.preferredLanguage || 'en',
      },
      verificationCode: code,
      expiresAt,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    });

    authLogger.info('Verification email resent', { userId: user.id });

    res.json({
      status: 'success',
      message: 'If an unverified account exists with this email, a verification code has been sent.',
    });
  } catch (error: any) {
    authLogger.error('Resend verification failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to resend verification email.',
    });
  }
});

// ========================================
// LOGIN & LOGOUT
// ========================================

/**
 * Login with email and password
 * POST /api/auth/login
 * 
 * Authenticates user and sets session cookie.
 * Returns error if email not verified.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: parseResult.error.errors[0]?.message || 'Email and password are required',
      });
    }

    const { email, password } = parseResult.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        currentRole: true,
        countryCode: true,
        preferredLanguage: true,
        passwordHash: true,
        isActive: true,
        emailVerified: true,
        credits: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid email or password',
      });
    }

    // Check if user has a password set
    if (!user.passwordHash) {
      return res.status(401).json({
        status: 'error',
        message: 'No password set for this account. Please sign in with Google or reset your password.',
        code: 'NO_PASSWORD',
      });
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      authLogger.warn('Invalid login attempt', { email: normalizedEmail });
      return res.status(401).json({
        status: 'error',
        message: 'Invalid email or password',
      });
    }

    // Check if account is active
    if (!user.isActive) {
      return res.status(403).json({
        status: 'error',
        message: 'Your account is not active. Please contact support.',
        code: 'ACCOUNT_INACTIVE',
      });
    }

    // Check email verification
    if (!user.emailVerified) {
      return res.status(403).json({
        status: 'error',
        message: 'Please verify your email before logging in.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    // Create session and set cookie
    await createSession({
      userId: user.id,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    }, res);

    authLogger.info('User logged in', { userId: user.id, email: normalizedEmail });

    // Return user data (without password hash)
    const { passwordHash: _, ...safeUser } = user;

    res.json({
      status: 'success',
      user: safeUser,
    });
  } catch (error: any) {
    authLogger.error('Login failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Login failed. Please try again.',
    });
  }
});

/**
 * Logout current session
 * POST /api/auth/logout
 * 
 * Destroys the current session and clears the cookie.
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = getSessionToken(req.cookies || {});
    
    if (token) {
      await destroySession(token, res);
    } else {
      // Clear cookie anyway
      res.clearCookie(getSessionCookieName(), getSessionCookieOptions());
    }

    res.json({
      status: 'success',
      message: 'Logged out successfully',
    });
  } catch (error: any) {
    authLogger.error('Logout failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Logout failed',
    });
  }
});

/**
 * Logout all sessions
 * POST /api/auth/logout-all
 * 
 * Destroys all sessions for the current user.
 */
router.post('/logout-all', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    
    if (!userId) {
      return res.status(401).json({
        status: 'error',
        message: 'Not authenticated',
      });
    }

    await destroyAllUserSessions(userId);
    
    // Clear the current session cookie
    res.clearCookie(getSessionCookieName(), getSessionCookieOptions());

    res.json({
      status: 'success',
      message: 'Logged out from all devices',
    });
  } catch (error: any) {
    authLogger.error('Logout all failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to logout from all devices',
    });
  }
});

/**
 * Get current session user
 * GET /api/auth/me
 * 
 * Returns the current authenticated user's data.
 */
router.get('/me', optionalSession, async (req: Request, res: Response) => {
  try {
    // Session-derived responses must never be cached
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!req.userId) {
      return res.status(200).json({
        status: 'success',
        authenticated: false,
        user: null,
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        imageUrl: true,
        currentRole: true,
        countryCode: true,
        preferredLanguage: true,
        emailVerified: true,
        credits: true,
        phoneNumber: true,
        phoneVerified: true,
        accountTypeConfirmedAt: true,
        createdAt: true,
        registrationRegion: true,
        // For hasPassword check and auth source detection
        passwordHash: true,
        authProviders: true,
        lastAuthProvider: true,
      },
    });

    if (!user) {
      // Session exists but user doesn't - clear session
      const token = getSessionToken(req.cookies || {});
      if (token) {
        await destroySession(token, res);
      }
      return res.status(200).json({
        status: 'success',
        authenticated: false,
        user: null,
      });
    }

    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
    
    res.json({
      status: 'success',
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName,
        imageUrl: user.imageUrl,
        emailVerified: user.emailVerified,
        credits: user.credits,
        preferredLanguage: user.preferredLanguage,
        countryCode: user.countryCode,
        phoneNumber: user.phoneNumber,
        phoneVerified: user.phoneVerified,
        accountTypeConfirmedAt: user.accountTypeConfirmedAt,
        createdAt: user.createdAt,
        // First-party auth properties
        hasPassword: Boolean(user.passwordHash),
        authProviders: user.authProviders || [],
        lastAuthProvider: user.lastAuthProvider,
      },
    });
  } catch (error: any) {
    authLogger.error('Get me failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get user data',
    });
  }
});

// ========================================
// GOOGLE OAUTH
// ========================================

// Store Google OAuth state temporarily (in production, use Redis or session storage)
const googleOAuthStates = new Map<string, { returnTo: string; userId?: string; mode: 'login' | 'link'; expiresAt: number }>();

/**
 * Cleanup expired Google OAuth states
 */
function cleanupExpiredGoogleStates() {
  const now = Date.now();
  googleOAuthStates.forEach((value, key) => {
    if (value.expiresAt < now) googleOAuthStates.delete(key);
  });
}

/**
 * Start Google OAuth flow
 * GET /api/auth/google
 * 
 * Redirects to Google's OAuth consent screen.
 * Supports mode=login (default) or mode=link (to link to existing account).
 */
router.get('/google', optionalSession, (req: Request, res: Response) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({
      status: 'error',
      message: 'Google OAuth not configured',
    });
  }

  // Parse mode: 'login' for sign-in/sign-up, 'link' for connecting to existing account
  const mode = req.query.mode === 'link' ? 'link' : 'login';
  const returnTo = normalizeReturnTo(req.query.returnTo);

  // For link mode, require active session
  if (mode === 'link' && !req.userId) {
    return res.redirect(`${FRONTEND_URL}/sign-in?error=session_required&returnTo=${encodeURIComponent(returnTo)}`);
  }

  // Generate state for CSRF protection
  const stateId = crypto.randomBytes(16).toString('hex');

  // Cleanup expired states
  cleanupExpiredGoogleStates();

  // Store state with mode and optional userId
  googleOAuthStates.set(stateId, {
    returnTo,
    userId: req.userId || undefined,
    mode,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes expiry
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state: stateId,
    access_type: 'offline',
    prompt: 'consent',
  });

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  
  authLogger.info('Starting Google OAuth', { returnTo, mode, hasSession: !!req.userId });
  res.redirect(googleAuthUrl);
});

/**
 * Google OAuth callback
 * GET /api/auth/google/callback
 * 
 * Handles the OAuth callback from Google.
 * Creates or links user account and sets session cookie.
 */
router.get('/google/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      authLogger.warn('Google OAuth error', { error });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=google_oauth_denied`);
    }

    if (!code || typeof code !== 'string') {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=missing_code`);
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=oauth_not_configured`);
    }

    // Validate state
    if (!state || typeof state !== 'string') {
      authLogger.warn('Google OAuth missing state');
      return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
    }

    const storedState = googleOAuthStates.get(state);
    if (!storedState) {
      authLogger.warn('Google OAuth state not found or expired');
      return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
    }

    // Delete used state
    googleOAuthStates.delete(state);

    // Check expiry
    if (storedState.expiresAt < Date.now()) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=state_expired`);
    }

    const { returnTo, userId: linkUserId, mode } = storedState;

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: GOOGLE_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      authLogger.error('Google token exchange failed', { 
        status: tokenResponse.status,
        text: await tokenResponse.text() 
      });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=token_exchange_failed`);
    }

    const tokens = await tokenResponse.json() as { access_token: string; id_token?: string };

    // Get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=userinfo_failed`);
    }

    const googleUser = await userInfoResponse.json() as {
      id: string;
      email: string;
      verified_email: boolean;
      name?: string;
      given_name?: string;
      family_name?: string;
      picture?: string;
    };

    if (!googleUser.email) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=no_email`);
    }

    const normalizedEmail = googleUser.email.toLowerCase().trim();

    // Check if this Google ID is already linked to another user
    const existingGoogleProfile = await prisma.googleProfile.findUnique({
      where: { googleId: googleUser.id },
      select: { userId: true },
    });

    // Also check legacy googleId on User
    const existingGoogleUser = await prisma.user.findUnique({
      where: { googleId: googleUser.id },
      select: { id: true },
    });

    // ========== LINK MODE ==========
    if (mode === 'link' && linkUserId) {
      // Check if Google is already linked to a different user
      const linkedToOther = 
        (existingGoogleProfile && existingGoogleProfile.userId !== linkUserId) ||
        (existingGoogleUser && existingGoogleUser.id !== linkUserId);

      if (linkedToOther) {
        authLogger.warn('Google account already linked to another user', {
          googleId: googleUser.id,
          existingUserId: existingGoogleProfile?.userId || existingGoogleUser?.id,
          requestingUserId: linkUserId,
        });
        return res.redirect(`${FRONTEND_URL}/account?section=profile&error=google_already_linked`);
      }

      // Link Google to existing user
      await prisma.$transaction(async (tx) => {
        // Upsert GoogleProfile
        await tx.googleProfile.upsert({
          where: { userId: linkUserId },
          create: {
            userId: linkUserId,
            googleId: googleUser.id,
            email: normalizedEmail,
            name: googleUser.name || [googleUser.given_name, googleUser.family_name].filter(Boolean).join(' ') || null,
            pictureUrl: googleUser.picture || null,
          },
          update: {
            googleId: googleUser.id,
            email: normalizedEmail,
            name: googleUser.name || [googleUser.given_name, googleUser.family_name].filter(Boolean).join(' ') || null,
            pictureUrl: googleUser.picture || null,
          },
        });

        // Update user's authProviders and googleId
        const user = await tx.user.findUnique({ where: { id: linkUserId }, select: { authProviders: true } });
        if (user) {
          await tx.user.update({
            where: { id: linkUserId },
            data: {
              googleId: googleUser.id,
              authProviders: user.authProviders.includes('google')
                ? user.authProviders
                : [...user.authProviders, 'google'],
              lastAuthProvider: 'google',
            },
          });
        }
      });

      authLogger.info('Google account linked', { userId: linkUserId, googleId: googleUser.id });
      return res.redirect(`${FRONTEND_URL}/account?section=profile&connected=google`);
    }

    // ========== LOGIN / SIGNUP MODE ==========
    // Check if user exists by googleId (profile or legacy), or by email
    let user = existingGoogleProfile
      ? await prisma.user.findUnique({ where: { id: existingGoogleProfile.userId } })
      : existingGoogleUser
        ? await prisma.user.findUnique({ where: { id: existingGoogleUser.id } })
        : await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (user) {
      // Update existing user with Google info
      await prisma.$transaction(async (tx) => {
        // Upsert GoogleProfile
        await tx.googleProfile.upsert({
          where: { userId: user!.id },
          create: {
            userId: user!.id,
            googleId: googleUser.id,
            email: normalizedEmail,
            name: googleUser.name || [googleUser.given_name, googleUser.family_name].filter(Boolean).join(' ') || null,
            pictureUrl: googleUser.picture || null,
          },
          update: {
            googleId: googleUser.id,
            email: normalizedEmail,
            name: googleUser.name || [googleUser.given_name, googleUser.family_name].filter(Boolean).join(' ') || null,
            pictureUrl: googleUser.picture || null,
          },
        });

        // Update User
        await tx.user.update({
          where: { id: user!.id },
          data: {
            googleId: googleUser.id,
            emailVerified: true,
            emailVerifiedAt: user!.emailVerifiedAt || new Date(),
            authProviders: user!.authProviders.includes('google')
              ? user!.authProviders
              : [...user!.authProviders, 'google'],
            lastAuthProvider: 'google',
            firstName: user!.firstName || googleUser.given_name || googleUser.name?.split(' ')[0] || null,
            lastName: user!.lastName || googleUser.family_name || null,
            imageUrl: user!.imageUrl || googleUser.picture || null,
          },
        });
      });

      authLogger.info('Existing user logged in via Google', { userId: user.id, email: normalizedEmail });
    } else {
      // Create new user with Google OAuth
      user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            googleId: googleUser.id,
            firstName: googleUser.given_name || googleUser.name?.split(' ')[0] || null,
            lastName: googleUser.family_name || null,
            imageUrl: googleUser.picture || null,
            emailVerified: true,
            emailVerifiedAt: new Date(),
            isActive: true,
            currentRole: 'B2C_FREE',
            authProviders: ['google'],
            lastAuthProvider: 'google',
          },
        });

        // Create GoogleProfile
        await tx.googleProfile.create({
          data: {
            userId: newUser.id,
            googleId: googleUser.id,
            email: normalizedEmail,
            name: googleUser.name || [googleUser.given_name, googleUser.family_name].filter(Boolean).join(' ') || null,
            pictureUrl: googleUser.picture || null,
          },
        });

        return newUser;
      });

      authLogger.info('New user created via Google', { userId: user.id, email: normalizedEmail });
    }

    // Create session and set cookie
    await createSession({
      userId: user.id,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    }, res);

    // Redirect to frontend with success
    res.redirect(`${FRONTEND_URL}${returnTo}`);
  } catch (error: any) {
    authLogger.error('Google OAuth callback failed', { error: error.message });
    res.redirect(`${FRONTEND_URL}/auth/error?error=callback_failed`);
  }
});

// ========================================
// LINKEDIN OAUTH
// ========================================

/**
 * Start LinkedIn OAuth flow
 * GET /api/auth/linkedin
 * 
 * Redirects to LinkedIn's OAuth consent screen.
 * Uses OpenID Connect for authentication.
 */
router.get('/linkedin', (req: Request, res: Response) => {
  if (!LINKEDIN_CLIENT_ID) {
    return res.status(500).json({
      status: 'error',
      message: 'LinkedIn OAuth not configured',
    });
  }

  // Store redirect URL in state for after callback
  const returnTo = normalizeReturnTo(req.query.returnTo);
  const state = Buffer.from(JSON.stringify({ returnTo })).toString('base64url');

  // LinkedIn OAuth 2.0 with OpenID Connect
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: LINKEDIN_CLIENT_ID,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    state,
    scope: 'openid profile email',
  });

  const linkedinAuthUrl = `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  
  authLogger.info('Starting LinkedIn OAuth', { returnTo });
  res.redirect(linkedinAuthUrl);
});

/**
 * LinkedIn OAuth callback
 * GET /api/auth/linkedin/callback
 * 
 * Handles the OAuth callback from LinkedIn.
 * Creates or links user account and sets session cookie.
 */
router.get('/linkedin/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      authLogger.warn('LinkedIn OAuth error', { error, error_description });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=linkedin_oauth_denied`);
    }

    if (!code || typeof code !== 'string') {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=missing_code`);
    }

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=oauth_not_configured`);
    }

    // Parse state to get returnTo URL
    let returnTo = DEFAULT_OAUTH_RETURN_TO;
    if (state && typeof state === 'string') {
      try {
        const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
        returnTo = normalizeReturnTo(stateData.returnTo);
      } catch {
        // Invalid state, use default
      }
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
        redirect_uri: LINKEDIN_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      authLogger.error('LinkedIn token exchange failed', { 
        status: tokenResponse.status,
        text: errorText 
      });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=token_exchange_failed`);
    }

    const tokens = await tokenResponse.json() as { 
      access_token: string; 
      expires_in: number;
      id_token?: string;
    };

    // Get user info from LinkedIn userinfo endpoint (OpenID Connect)
    const userInfoResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      authLogger.error('LinkedIn userinfo failed', { 
        status: userInfoResponse.status,
        text: await userInfoResponse.text() 
      });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=userinfo_failed`);
    }

    const linkedinUser = await userInfoResponse.json() as {
      sub: string;           // LinkedIn member ID
      email: string;
      email_verified?: boolean;
      name?: string;
      given_name?: string;
      family_name?: string;
      picture?: string;
      locale?: { country: string; language: string };
    };

    if (!linkedinUser.email) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=no_email`);
    }

    const normalizedEmail = linkedinUser.email.toLowerCase().trim();

    // Find existing user by LinkedIn member id (stored on LinkedInProfile) or by email
    const existingProfile = await prisma.linkedInProfile.findFirst({
      where: { linkedinMemberId: linkedinUser.sub },
      select: { userId: true },
    });

    let user = existingProfile
      ? await prisma.user.findUnique({ where: { id: existingProfile.userId } })
      : await prisma.user.findFirst({ where: { email: normalizedEmail } });

    if (user) {
      // Update existing user with LinkedIn info
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          // LinkedIn OAuth counts as verified
          emailVerified: true,
          emailVerifiedAt: user.emailVerifiedAt || new Date(),
          // Update auth providers
          authProviders: user.authProviders.includes('linkedin') 
            ? user.authProviders 
            : [...user.authProviders, 'linkedin'],
          lastAuthProvider: 'linkedin',
          // Update profile if empty
          firstName: user.firstName || linkedinUser.given_name || linkedinUser.name?.split(' ')[0] || null,
          lastName: user.lastName || linkedinUser.family_name || null,
          imageUrl: user.imageUrl || linkedinUser.picture || null,
        },
      });

      // Upsert LinkedInProfile linkage
      await prisma.linkedInProfile.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          linkedinMemberId: linkedinUser.sub,
          email: normalizedEmail,
          name: linkedinUser.name || null,
          pictureUrl: linkedinUser.picture || null,
          source: 'oauth',
        },
        update: {
          linkedinMemberId: linkedinUser.sub,
          email: normalizedEmail,
          name: linkedinUser.name || null,
          pictureUrl: linkedinUser.picture || null,
          source: 'oauth',
        },
      });

      authLogger.info('Existing user logged in via LinkedIn', { userId: user.id, email: normalizedEmail });
    } else {
      // Create new user - LinkedIn OAuth is auto-verified
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          firstName: linkedinUser.given_name || linkedinUser.name?.split(' ')[0] || null,
          lastName: linkedinUser.family_name || null,
          imageUrl: linkedinUser.picture || null,
          emailVerified: true, // LinkedIn OAuth = verified
          emailVerifiedAt: new Date(),
          isActive: true,
          currentRole: 'B2C_FREE',
          authProviders: ['linkedin'],
          lastAuthProvider: 'linkedin',
        },
      });

      await prisma.linkedInProfile.create({
        data: {
          userId: user.id,
          linkedinMemberId: linkedinUser.sub,
          email: normalizedEmail,
          name: linkedinUser.name || null,
          pictureUrl: linkedinUser.picture || null,
          source: 'oauth',
        },
      });

      authLogger.info('New user created via LinkedIn', { userId: user.id, email: normalizedEmail });
    }

    // Create session and set cookie
    await createSession({
      userId: user.id,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    }, res);

    // Redirect to frontend with success
    res.redirect(`${FRONTEND_URL}${returnTo}`);
  } catch (error: any) {
    authLogger.error('LinkedIn OAuth callback failed', { error: error.message });
    res.redirect(`${FRONTEND_URL}/auth/error?error=callback_failed`);
  }
});

// ========================================
// LINKEDIN PROFILE IMPORT (ONBOARDING)
// ========================================

// LinkedIn Profile Import redirect URI (separate from SSO)
const LINKEDIN_PROFILE_REDIRECT_URI = process.env.LINKEDIN_PROFILE_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://api.vocaid.io/api/auth/linkedin-profile/callback'
    : 'http://localhost:3001/api/auth/linkedin-profile/callback');

// Store LinkedIn import state tokens (in production, use Redis or session storage)
// Maps state -> { userId, returnTo, expiresAt }
interface LinkedInImportState {
  userId: string;
  returnTo: string;
  expiresAt: number;
}
const linkedinImportStates = new Map<string, LinkedInImportState>();

// Cleanup expired states periodically
function cleanupExpiredLinkedInImportStates() {
  const now = Date.now();
  for (const [state, data] of linkedinImportStates.entries()) {
    if (data.expiresAt < now) {
      linkedinImportStates.delete(state);
    }
  }
}

/**
 * Start LinkedIn Profile Import flow (for onboarding)
 * GET /api/auth/linkedin-profile
 * 
 * Requires existing session (user is mid-onboarding).
 * Redirects to LinkedIn's OAuth consent screen with import-specific redirect URI.
 */
router.get('/linkedin-profile', requireSession, (req: Request, res: Response) => {
  const userId = req.userId!;
  
  if (!LINKEDIN_CLIENT_ID) {
    authLogger.error('LinkedIn profile import: OAuth not configured');
    return res.redirect(`${FRONTEND_URL}/onboarding?import=linkedin&error=oauth_not_configured`);
  }

  // Generate state token with embedded flow info
  const stateId = crypto.randomBytes(16).toString('hex');
  const returnTo = normalizeReturnTo(req.query.returnTo, '/onboarding');
  
  // Store state with TTL (10 minutes)
  cleanupExpiredLinkedInImportStates();
  linkedinImportStates.set(stateId, {
    userId,
    returnTo,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  // Build LinkedIn auth URL with import-specific redirect URI
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: LINKEDIN_CLIENT_ID,
    redirect_uri: LINKEDIN_PROFILE_REDIRECT_URI,
    state: stateId,
    scope: 'openid profile email',
  });

  const linkedinAuthUrl = `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  
  authLogger.info('Starting LinkedIn profile import', { 
    userId: userId.slice(0, 12),
    returnTo,
    redirectUri: LINKEDIN_PROFILE_REDIRECT_URI,
    stateId: stateId.slice(0, 8),
  });
  
  res.redirect(linkedinAuthUrl);
});

/**
 * LinkedIn Profile Import callback (for onboarding)
 * GET /api/auth/linkedin-profile/callback
 * 
 * Handles the OAuth callback from LinkedIn for profile import.
 * Validates state, exchanges code for tokens, fetches userinfo,
 * persists LinkedIn profile data, and redirects back to onboarding.
 */
router.get('/linkedin-profile/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_description } = req.query;

    // Handle LinkedIn errors
    if (error) {
      authLogger.warn('LinkedIn profile import error', { error, error_description });
      const errorCode = error === 'user_cancelled_login' || error === 'user_cancelled_authorize' 
        ? 'cancelled' 
        : 'linkedin_denied';
      return res.redirect(`${FRONTEND_URL}/onboarding?import=linkedin&error=${errorCode}`);
    }

    if (!code || typeof code !== 'string') {
      authLogger.warn('LinkedIn profile import: missing code');
      return res.redirect(`${FRONTEND_URL}/onboarding?import=linkedin&error=missing_code`);
    }

    if (!state || typeof state !== 'string') {
      authLogger.warn('LinkedIn profile import: missing state');
      return res.redirect(`${FRONTEND_URL}/onboarding?import=linkedin&error=invalid_state`);
    }

    // Validate state and get associated user
    cleanupExpiredLinkedInImportStates();
    const storedState = linkedinImportStates.get(state);
    
    if (!storedState) {
      authLogger.warn('LinkedIn profile import: invalid or expired state', { state: state.slice(0, 8) });
      return res.redirect(`${FRONTEND_URL}/onboarding?import=linkedin&error=invalid_state`);
    }

    const { userId, returnTo } = storedState;
    linkedinImportStates.delete(state);

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
      authLogger.error('LinkedIn profile import: OAuth not configured');
      return res.redirect(`${FRONTEND_URL}${returnTo}?import=linkedin&error=oauth_not_configured`);
    }

    // Exchange code for tokens using import-specific redirect URI
    const tokenResponse = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
        redirect_uri: LINKEDIN_PROFILE_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      authLogger.error('LinkedIn profile import: token exchange failed', { 
        status: tokenResponse.status,
        text: errorText,
      });
      return res.redirect(`${FRONTEND_URL}${returnTo}?import=linkedin&error=token_exchange_failed`);
    }

    const tokens = await tokenResponse.json() as { 
      access_token: string; 
      expires_in: number;
      id_token?: string;
    };

    // Get user info from LinkedIn userinfo endpoint (OpenID Connect)
    const userInfoResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      authLogger.error('LinkedIn profile import: userinfo failed', { 
        status: userInfoResponse.status,
        text: await userInfoResponse.text(),
      });
      return res.redirect(`${FRONTEND_URL}${returnTo}?import=linkedin&error=userinfo_failed`);
    }

    const linkedinUser = await userInfoResponse.json() as {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      given_name?: string;
      family_name?: string;
      picture?: string;
      locale?: { country: string; language: string };
    };

    authLogger.info('LinkedIn profile import: userinfo retrieved', {
      userId: userId.slice(0, 12),
      linkedinSub: linkedinUser.sub?.slice(0, 8),
      hasEmail: !!linkedinUser.email,
      hasName: !!linkedinUser.name,
    });

    // Persist LinkedIn profile data
    await prisma.linkedInProfile.upsert({
      where: { userId },
      create: {
        userId,
        linkedinMemberId: linkedinUser.sub,
        email: linkedinUser.email?.toLowerCase().trim() || null,
        name: linkedinUser.name || null,
        pictureUrl: linkedinUser.picture || null,
        source: 'import',
        rawSections: {
          sub: linkedinUser.sub,
          email: linkedinUser.email,
          email_verified: linkedinUser.email_verified,
          name: linkedinUser.name,
          given_name: linkedinUser.given_name,
          family_name: linkedinUser.family_name,
          picture: linkedinUser.picture,
          locale: linkedinUser.locale,
          importedAt: new Date().toISOString(),
        },
      },
      update: {
        linkedinMemberId: linkedinUser.sub,
        email: linkedinUser.email?.toLowerCase().trim() || null,
        name: linkedinUser.name || null,
        pictureUrl: linkedinUser.picture || null,
        source: 'import',
        rawSections: {
          sub: linkedinUser.sub,
          email: linkedinUser.email,
          email_verified: linkedinUser.email_verified,
          name: linkedinUser.name,
          given_name: linkedinUser.given_name,
          family_name: linkedinUser.family_name,
          picture: linkedinUser.picture,
          locale: linkedinUser.locale,
          importedAt: new Date().toISOString(),
        },
      },
    });

    // Update user consent to record LinkedIn connection
    await prisma.userConsent.upsert({
      where: { userId },
      create: {
        userId,
        termsAcceptedAt: new Date(),
        privacyAcceptedAt: new Date(),
        termsVersion: '1.0',
        privacyVersion: '1.0',
        linkedinConnectedAt: new Date(),
        linkedinMemberId: linkedinUser.sub,
      },
      update: {
        linkedinConnectedAt: new Date(),
        linkedinMemberId: linkedinUser.sub,
      },
    });

    // Optionally update user profile with LinkedIn data if fields are empty
    await prisma.user.update({
      where: { id: userId },
      data: {
        firstName: (await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true } }))?.firstName || linkedinUser.given_name || linkedinUser.name?.split(' ')[0] || undefined,
        lastName: (await prisma.user.findUnique({ where: { id: userId }, select: { lastName: true } }))?.lastName || linkedinUser.family_name || undefined,
        imageUrl: (await prisma.user.findUnique({ where: { id: userId }, select: { imageUrl: true } }))?.imageUrl || linkedinUser.picture || undefined,
        // Add linkedin to auth providers if not already present
        authProviders: {
          push: 'linkedin',
        },
      },
    });

    authLogger.info('LinkedIn profile import: completed', {
      userId: userId.slice(0, 12),
      linkedinSub: linkedinUser.sub?.slice(0, 8),
    });

    // Redirect back to onboarding with success
    res.redirect(`${FRONTEND_URL}${returnTo}?import=linkedin&success=1`);
  } catch (error: any) {
    authLogger.error('LinkedIn profile import callback failed', { error: error.message });
    res.redirect(`${FRONTEND_URL}/onboarding?import=linkedin&error=callback_failed`);
  }
});

// ========================================
// X (TWITTER) OAUTH 2.0
// ========================================

// Store PKCE code verifiers temporarily (in production, use Redis or session storage)
const xCodeVerifiers = new Map<string, { verifier: string; returnTo: string; expiresAt: number }>();

// Store pending X links for email capture flow (when X doesn't provide email)
interface XPendingLink {
  xUserId: string;
  username: string;
  name: string;
  pictureUrl: string | null;
  returnTo: string;
  expiresAt: number;
}
const xPendingLinks = new Map<string, XPendingLink>();

/**
 * Generate PKCE code verifier and challenge
 * X OAuth 2.0 requires PKCE (Proof Key for Code Exchange)
 */
function generatePKCE(): { verifier: string; challenge: string } {
  // Generate random verifier (43-128 characters, URL-safe)
  const verifier = crypto.randomBytes(32).toString('base64url');
  
  // Generate challenge (SHA256 hash of verifier, base64url encoded)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  
  return { verifier, challenge };
}

/**
 * Start X OAuth 2.0 flow
 * GET /api/auth/x
 * 
 * Redirects to X's OAuth consent screen.
 * Uses PKCE for security as required by X OAuth 2.0.
 */
router.get('/x', (req: Request, res: Response) => {
  if (!X_CLIENT_ID) {
    return res.status(500).json({
      status: 'error',
      message: 'X OAuth not configured',
    });
  }

  // Generate PKCE challenge
  const { verifier, challenge } = generatePKCE();
  
  // Generate state for CSRF protection
  const stateId = crypto.randomBytes(16).toString('hex');
  const returnTo = normalizeReturnTo(req.query.returnTo);
  
  // Store verifier with state (cleanup old entries)
  const now = Date.now();
  xCodeVerifiers.forEach((value, key) => {
    if (value.expiresAt < now) xCodeVerifiers.delete(key);
  });
  xCodeVerifiers.set(stateId, { 
    verifier, 
    returnTo,
    expiresAt: now + 10 * 60 * 1000 // 10 minutes expiry
  });

  // X OAuth 2.0 authorization URL
  // Include users.email scope to request confirmed_email field
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: 'users.read users.email tweet.read offline.access',
    state: stateId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const xAuthUrl = `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
  
  authLogger.info('Starting X OAuth', { returnTo });
  res.redirect(xAuthUrl);
});

/**
 * X OAuth 2.0 callback
 * GET /api/auth/x/callback
 * 
 * Handles the OAuth callback from X (Twitter).
 * Uses confirmed_email from X API v2 when available.
 * Falls back to email-capture flow if email not provided.
 * Links via XProfile to prevent duplicates.
 */
router.get('/x/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      authLogger.warn('X OAuth error', { error, error_description });
      // Clean up stored verifier if state is present
      if (state && typeof state === 'string') {
        xCodeVerifiers.delete(state);
      }
      return res.redirect(`${FRONTEND_URL}/auth/error?error=x_oauth_denied`);
    }

    if (!code || typeof code !== 'string') {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=missing_code`);
    }

    if (!state || typeof state !== 'string') {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=missing_state`);
    }

    if (!X_CLIENT_ID || !X_CLIENT_SECRET) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=oauth_not_configured`);
    }

    // Retrieve and remove stored verifier
    const storedData = xCodeVerifiers.get(state);
    if (!storedData) {
      authLogger.warn('X OAuth: Invalid or expired state');
      return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
    }
    xCodeVerifiers.delete(state);
    
    const { verifier, returnTo } = storedData;

    // Exchange code for tokens (X requires Basic Auth with client credentials)
    const basicAuth = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');
    
    const tokenResponse = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: X_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      authLogger.error('X token exchange failed', { 
        status: tokenResponse.status,
        text: errorText 
      });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=token_exchange_failed`);
    }

    const tokens = await tokenResponse.json() as { 
      access_token: string; 
      refresh_token?: string;
      expires_in: number;
      token_type: string;
      scope: string;
    };

    // Get user info from X API v2 with confirmed_email field
    const userInfoResponse = await fetch('https://api.twitter.com/2/users/me?user.fields=id,name,username,profile_image_url,confirmed_email', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      authLogger.error('X userinfo failed', { 
        status: userInfoResponse.status,
        text: await userInfoResponse.text() 
      });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=userinfo_failed`);
    }

    const xUserResponse = await userInfoResponse.json() as {
      data: {
        id: string;           // X user ID
        name: string;         // Display name
        username: string;     // @handle
        profile_image_url?: string;
        confirmed_email?: string; // Email (requires users.email scope)
      };
    };

    const xUser = xUserResponse.data;

    if (!xUser || !xUser.id) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=no_user_data`);
    }

    authLogger.info('X userinfo received', { 
      xUserId: xUser.id, 
      username: xUser.username,
      hasEmail: !!xUser.confirmed_email 
    });

    // Step 1: Check if user already linked via XProfile
    const existingXProfile = await prisma.xProfile.findUnique({
      where: { xUserId: xUser.id },
      include: { user: true },
    });

    if (existingXProfile) {
      // User already linked - just log them in
      const user = await prisma.user.update({
        where: { id: existingXProfile.userId },
        data: {
          lastAuthProvider: 'x',
          // Update profile picture if changed
          imageUrl: existingXProfile.user.imageUrl || xUser.profile_image_url?.replace('_normal', '') || null,
        },
      });

      // Update XProfile with latest info
      await prisma.xProfile.update({
        where: { id: existingXProfile.id },
        data: {
          username: xUser.username,
          name: xUser.name,
          pictureUrl: xUser.profile_image_url?.replace('_normal', '') || null,
        },
      });

      authLogger.info('Existing user logged in via X (XProfile link)', { 
        userId: user.id, 
        xUsername: xUser.username 
      });

      // Create session and redirect
      await createSession({
        userId: user.id,
        ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
        userAgent: req.headers['user-agent'],
      }, res);

      return res.redirect(`${FRONTEND_URL}${returnTo}`);
    }

    // Step 2: No XProfile link - check if we have confirmed_email from X
    if (xUser.confirmed_email) {
      const normalizedEmail = xUser.confirmed_email.toLowerCase().trim();

      // Check if user exists with this email
      let user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (user) {
        // Link existing user to X
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            // X confirmed_email = verified by X
            emailVerified: true,
            emailVerifiedAt: user.emailVerifiedAt || new Date(),
            authProviders: user.authProviders.includes('x') 
              ? user.authProviders 
              : [...user.authProviders, 'x'],
            lastAuthProvider: 'x',
            firstName: user.firstName || xUser.name?.split(' ')[0] || null,
            lastName: user.lastName || xUser.name?.split(' ').slice(1).join(' ') || null,
            imageUrl: user.imageUrl || xUser.profile_image_url?.replace('_normal', '') || null,
          },
        });

        // Create XProfile linkage
        await prisma.xProfile.create({
          data: {
            userId: user.id,
            xUserId: xUser.id,
            username: xUser.username,
            name: xUser.name,
            pictureUrl: xUser.profile_image_url?.replace('_normal', '') || null,
          },
        });

        authLogger.info('Existing user linked to X via confirmed_email', { 
          userId: user.id, 
          email: normalizedEmail,
          xUsername: xUser.username 
        });
      } else {
        // Create new user with X confirmed email
        user = await prisma.user.create({
          data: {
            email: normalizedEmail,
            firstName: xUser.name?.split(' ')[0] || null,
            lastName: xUser.name?.split(' ').slice(1).join(' ') || null,
            imageUrl: xUser.profile_image_url?.replace('_normal', '') || null,
            emailVerified: true, // X confirmed_email = verified
            emailVerifiedAt: new Date(),
            isActive: true,
            currentRole: 'B2C_FREE',
            authProviders: ['x'],
            lastAuthProvider: 'x',
          },
        });

        // Create XProfile linkage
        await prisma.xProfile.create({
          data: {
            userId: user.id,
            xUserId: xUser.id,
            username: xUser.username,
            name: xUser.name,
            pictureUrl: xUser.profile_image_url?.replace('_normal', '') || null,
          },
        });

        authLogger.info('New user created via X with confirmed_email', { 
          userId: user.id, 
          email: normalizedEmail,
          xUsername: xUser.username 
        });
      }

      // Create session and redirect
      await createSession({
        userId: user.id,
        ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
        userAgent: req.headers['user-agent'],
      }, res);

      return res.redirect(`${FRONTEND_URL}${returnTo}`);
    }

    // Step 3: No confirmed_email - redirect to email capture flow
    // Store X user data temporarily for email verification linking
    const xPendingId = crypto.randomBytes(16).toString('hex');
    xPendingLinks.set(xPendingId, {
      xUserId: xUser.id,
      username: xUser.username,
      name: xUser.name,
      pictureUrl: xUser.profile_image_url?.replace('_normal', '') || null,
      returnTo,
      expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    authLogger.info('X OAuth requires email capture', { 
      xUsername: xUser.username,
      xPendingId 
    });

    // Redirect to frontend email capture page
    return res.redirect(`${FRONTEND_URL}/sign-in?xPending=${xPendingId}`);
  } catch (error: any) {
    authLogger.error('X OAuth callback failed', { error: error.message });
    res.redirect(`${FRONTEND_URL}/auth/error?error=callback_failed`);
  }
});

// ========================================
// X EMAIL CAPTURE FLOW
// ========================================

/**
 * Get X pending link info
 * GET /api/auth/x/pending/:id
 * 
 * Returns X user info for pending email capture.
 */
router.get('/x/pending/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  
  // Cleanup expired entries
  const now = Date.now();
  xPendingLinks.forEach((value, key) => {
    if (value.expiresAt < now) xPendingLinks.delete(key);
  });

  const pending = xPendingLinks.get(id);
  
  if (!pending) {
    return res.status(404).json({
      status: 'error',
      message: 'Pending X link not found or expired',
    });
  }

  res.json({
    status: 'success',
    data: {
      username: pending.username,
      name: pending.name,
      pictureUrl: pending.pictureUrl,
    },
  });
});

/**
 * Request email verification for X linking
 * POST /api/auth/x/request-email
 * 
 * Sends verification code to provided email for X account linking.
 */
router.post('/x/request-email', async (req: Request, res: Response) => {
  try {
    const { xPendingId, email } = req.body;

    if (!xPendingId || !email) {
      return res.status(400).json({
        status: 'error',
        message: 'xPendingId and email are required',
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid email format',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check pending link exists
    const pending = xPendingLinks.get(xPendingId);
    if (!pending || pending.expiresAt < Date.now()) {
      xPendingLinks.delete(xPendingId);
      return res.status(400).json({
        status: 'error',
        message: 'X link session expired. Please try signing in with X again.',
      });
    }

    // Check if X user is already linked to another account
    const existingXProfile = await prisma.xProfile.findUnique({
      where: { xUserId: pending.xUserId },
    });

    if (existingXProfile) {
      return res.status(400).json({
        status: 'error',
        message: 'This X account is already linked to another user.',
      });
    }

    // Check if user exists with this email
    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      // Create new user with unverified email
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          firstName: pending.name?.split(' ')[0] || null,
          lastName: pending.name?.split(' ').slice(1).join(' ') || null,
          imageUrl: pending.pictureUrl,
          emailVerified: false,
          isActive: true,
          currentRole: 'B2C_FREE',
          authProviders: ['x'],
          lastAuthProvider: 'x',
        },
      });

      authLogger.info('New user created for X email verification', { 
        userId: user.id, 
        email: normalizedEmail,
        xUsername: pending.username 
      });
    }

    // Generate and send verification code
    const { code, expiresAt } = await createEmailVerificationCode(user.id);

    await sendEmailVerificationEmail({
      user: {
        id: user.id,
        email: normalizedEmail,
        firstName: user.firstName || undefined,
        preferredLanguage: user.preferredLanguage || 'en',
      },
      verificationCode: code,
      expiresAt,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    });

    authLogger.info('X email verification code sent', { 
      userId: user.id, 
      email: normalizedEmail 
    });

    res.json({
      status: 'success',
      message: 'Verification code sent to your email.',
    });
  } catch (error: any) {
    authLogger.error('X email request failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to send verification email.',
    });
  }
});

/**
 * Verify email and complete X linking
 * POST /api/auth/x/verify-email
 * 
 * Verifies email code and links X account to user.
 */
router.post('/x/verify-email', async (req: Request, res: Response) => {
  try {
    const { xPendingId, email, code } = req.body;

    if (!xPendingId || !email || !code) {
      return res.status(400).json({
        status: 'error',
        message: 'xPendingId, email, and code are required',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Validate code format
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid verification code format',
      });
    }

    // Check pending link
    const pending = xPendingLinks.get(xPendingId);
    if (!pending || pending.expiresAt < Date.now()) {
      xPendingLinks.delete(xPendingId);
      return res.status(400).json({
        status: 'error',
        message: 'X link session expired. Please try signing in with X again.',
      });
    }

    // Consume verification code
    const result = await consumeEmailVerificationCode(normalizedEmail, code);
    if (!result) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or expired verification code.',
      });
    }

    // Update user as verified and link X
    const user = await prisma.user.update({
      where: { id: result.userId },
      data: {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        authProviders: { push: 'x' },
        lastAuthProvider: 'x',
        firstName: pending.name?.split(' ')[0] || undefined,
        lastName: pending.name?.split(' ').slice(1).join(' ') || undefined,
        imageUrl: pending.pictureUrl || undefined,
      },
    });

    // Dedupe auth providers
    const uniqueProviders = [...new Set(user.authProviders)];
    if (uniqueProviders.length !== user.authProviders.length) {
      await prisma.user.update({
        where: { id: user.id },
        data: { authProviders: uniqueProviders },
      });
    }

    // Create XProfile linkage
    await prisma.xProfile.create({
      data: {
        userId: user.id,
        xUserId: pending.xUserId,
        username: pending.username,
        name: pending.name,
        pictureUrl: pending.pictureUrl,
      },
    });

    // Clean up pending link
    xPendingLinks.delete(xPendingId);

    authLogger.info('X account linked via email verification', { 
      userId: user.id, 
      email: normalizedEmail,
      xUsername: pending.username 
    });

    // Create session
    await createSession({
      userId: user.id,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    }, res);

    res.json({
      status: 'success',
      message: 'Email verified and X account linked!',
      returnTo: pending.returnTo,
    });
  } catch (error: any) {
    authLogger.error('X email verification failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Verification failed. Please try again.',
    });
  }
});

// ========================================
// MICROSOFT OAUTH 2.0
// ========================================

// Store Microsoft OAuth state temporarily (in production, use Redis or session storage)
const microsoftOAuthStates = new Map<
  string,
  {
    returnTo: string;
    userId?: string;
    mode: 'login' | 'link';
    pkceVerifier: string;
    expiresAt: number;
  }
>();

/**
 * Cleanup expired Microsoft OAuth states
 */
function cleanupExpiredMicrosoftStates() {
  const now = Date.now();
  microsoftOAuthStates.forEach((value, key) => {
    if (value.expiresAt < now) microsoftOAuthStates.delete(key);
  });
}

/**
 * Start Microsoft OAuth flow
 * GET /api/auth/microsoft
 * 
 * Redirects to Microsoft's OAuth consent screen.
 * Supports mode=login (default) or mode=link (to link to existing account).
 */
router.get('/microsoft', optionalSession, (req: Request, res: Response) => {
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_REDIRECT_URI) {
    authLogger.warn('Microsoft OAuth not configured', {
      hasClientId: !!MICROSOFT_CLIENT_ID,
      hasClientSecret: !!MICROSOFT_CLIENT_SECRET,
      hasRedirectUri: !!MICROSOFT_REDIRECT_URI,
    });
    return res.redirect(`${FRONTEND_URL}/auth/error?error=oauth_not_configured`);
  }

  // Generate PKCE challenge (Microsoft requires PKCE for code redemption)
  const { verifier, challenge } = generatePKCE();

  // Parse mode: 'login' for sign-in/sign-up, 'link' for connecting to existing account
  const mode = req.query.mode === 'link' ? 'link' : 'login';
  const returnTo = normalizeReturnTo(req.query.returnTo);

  // For link mode, require active session
  if (mode === 'link' && !req.userId) {
    return res.redirect(`${FRONTEND_URL}/sign-in?error=session_required&returnTo=${encodeURIComponent(returnTo)}`);
  }

  // Generate state for CSRF protection
  const stateId = crypto.randomBytes(16).toString('hex');

  // Cleanup expired states
  cleanupExpiredMicrosoftStates();

  // Store state with mode and optional userId
  microsoftOAuthStates.set(stateId, {
    returnTo,
    userId: req.userId || undefined,
    mode,
    pkceVerifier: verifier,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes expiry
  });

  // Microsoft OAuth 2.0 authorization URL (using common endpoint for multi-tenant)
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: MICROSOFT_REDIRECT_URI,
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state: stateId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const microsoftAuthUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  
  authLogger.info('Starting Microsoft OAuth', { returnTo, mode, hasSession: !!req.userId });
  res.redirect(microsoftAuthUrl);
});

/**
 * Microsoft OAuth callback
 * GET /api/auth/microsoft/callback
 * 
 * Handles the OAuth callback from Microsoft.
 * Creates or links user account and sets session cookie.
 */
router.get('/microsoft/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      authLogger.warn('Microsoft OAuth error', { error, error_description });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=microsoft_oauth_denied`);
    }

    if (!code || typeof code !== 'string') {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=missing_code`);
    }

    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_REDIRECT_URI) {
      authLogger.warn('Microsoft OAuth callback: not configured', {
        hasClientId: !!MICROSOFT_CLIENT_ID,
        hasClientSecret: !!MICROSOFT_CLIENT_SECRET,
        hasRedirectUri: !!MICROSOFT_REDIRECT_URI,
      });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=oauth_not_configured`);
    }

    // Validate state
    if (!state || typeof state !== 'string') {
      authLogger.warn('Microsoft OAuth missing state');
      return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
    }

    const storedState = microsoftOAuthStates.get(state);
    if (!storedState) {
      authLogger.warn('Microsoft OAuth state not found or expired');
      return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
    }

    // Check expiry
    if (storedState.expiresAt < Date.now()) {
      microsoftOAuthStates.delete(state);
      return res.redirect(`${FRONTEND_URL}/auth/error?error=state_expired`);
    }

    const { returnTo, userId: linkUserId, mode, pkceVerifier } = storedState;
    if (!pkceVerifier) {
      microsoftOAuthStates.delete(state);
      authLogger.warn('Microsoft OAuth missing PKCE verifier in stored state');
      return res.redirect(`${FRONTEND_URL}/auth/error?error=invalid_state`);
    }

    // Delete used state
    microsoftOAuthStates.delete(state);

    // Exchange code for tokens
    const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri: MICROSOFT_REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: pkceVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      authLogger.error('Microsoft token exchange failed', {
        status: tokenResponse.status,
        text: errorText,
      });

      // AADSTS90023: Azure app is registered as a public client but we sent client_secret.
      // This means the Azure app configuration is wrong (should be Web / Confidential).
      if (errorText.includes('AADSTS90023')) {
        return res.redirect(`${FRONTEND_URL}/auth/error?error=microsoft_public_client_misconfigured`);
      }

      return res.redirect(`${FRONTEND_URL}/auth/error?error=token_exchange_failed`);
    }

    const tokens = await tokenResponse.json() as { access_token: string; id_token?: string };

    // Get user info from Microsoft Graph API
    const userInfoResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      authLogger.error('Microsoft user info fetch failed', { status: userInfoResponse.status });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=userinfo_failed`);
    }

    const msUser = await userInfoResponse.json() as {
      id: string;
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
      givenName?: string;
      surname?: string;
    };

    // Email: use mail if available, otherwise userPrincipalName (may be email format)
    const rawEmail = msUser.mail || msUser.userPrincipalName || '';
    const normalizedEmail = rawEmail.toLowerCase().trim();

    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      authLogger.warn('Microsoft OAuth: no valid email', { msUserId: msUser.id });
      return res.redirect(`${FRONTEND_URL}/auth/error?error=no_email`);
    }

    // Check if this Microsoft ID is already linked to another user
    const existingMsProfile = await prisma.microsoftProfile.findUnique({
      where: { msUserId: msUser.id },
      select: { userId: true },
    });

    // ========== LINK MODE ==========
    if (mode === 'link' && linkUserId) {
      // Check if Microsoft is already linked to a different user
      if (existingMsProfile && existingMsProfile.userId !== linkUserId) {
        authLogger.warn('Microsoft account already linked to another user', {
          msUserId: msUser.id,
          existingUserId: existingMsProfile.userId,
          requestingUserId: linkUserId,
        });
        return res.redirect(`${FRONTEND_URL}/account?section=profile&error=microsoft_already_linked`);
      }

      // Link Microsoft to existing user
      await prisma.$transaction(async (tx) => {
        // Upsert MicrosoftProfile
        await tx.microsoftProfile.upsert({
          where: { userId: linkUserId },
          create: {
            userId: linkUserId,
            msUserId: msUser.id,
            email: normalizedEmail,
            name: msUser.displayName || [msUser.givenName, msUser.surname].filter(Boolean).join(' ') || null,
            pictureUrl: null, // Microsoft Graph doesn't return picture URL directly
          },
          update: {
            msUserId: msUser.id,
            email: normalizedEmail,
            name: msUser.displayName || [msUser.givenName, msUser.surname].filter(Boolean).join(' ') || null,
          },
        });

        // Update user's authProviders
        const user = await tx.user.findUnique({ where: { id: linkUserId }, select: { authProviders: true } });
        if (user && !user.authProviders.includes('microsoft')) {
          await tx.user.update({
            where: { id: linkUserId },
            data: {
              authProviders: [...user.authProviders, 'microsoft'],
              lastAuthProvider: 'microsoft',
            },
          });
        }
      });

      authLogger.info('Microsoft account linked', { userId: linkUserId, msUserId: msUser.id });
      return res.redirect(`${FRONTEND_URL}/account?section=profile&connected=microsoft`);
    }

    // ========== LOGIN / SIGNUP MODE ==========
    // Check if user exists by Microsoft ID, or by email
    let user = existingMsProfile
      ? await prisma.user.findUnique({ where: { id: existingMsProfile.userId } })
      : await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (user) {
      // Update existing user with Microsoft info
      await prisma.$transaction(async (tx) => {
        // Upsert MicrosoftProfile
        await tx.microsoftProfile.upsert({
          where: { userId: user!.id },
          create: {
            userId: user!.id,
            msUserId: msUser.id,
            email: normalizedEmail,
            name: msUser.displayName || [msUser.givenName, msUser.surname].filter(Boolean).join(' ') || null,
            pictureUrl: null,
          },
          update: {
            msUserId: msUser.id,
            email: normalizedEmail,
            name: msUser.displayName || [msUser.givenName, msUser.surname].filter(Boolean).join(' ') || null,
          },
        });

        // Update User
        await tx.user.update({
          where: { id: user!.id },
          data: {
            emailVerified: true,
            emailVerifiedAt: user!.emailVerifiedAt || new Date(),
            authProviders: user!.authProviders.includes('microsoft')
              ? user!.authProviders
              : [...user!.authProviders, 'microsoft'],
            lastAuthProvider: 'microsoft',
            firstName: user!.firstName || msUser.givenName || msUser.displayName?.split(' ')[0] || null,
            lastName: user!.lastName || msUser.surname || null,
          },
        });
      });

      authLogger.info('Existing user logged in via Microsoft', { userId: user.id, email: normalizedEmail });
    } else {
      // Create new user with Microsoft OAuth
      user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            firstName: msUser.givenName || msUser.displayName?.split(' ')[0] || null,
            lastName: msUser.surname || null,
            emailVerified: true,
            emailVerifiedAt: new Date(),
            isActive: true,
            currentRole: 'B2C_FREE',
            authProviders: ['microsoft'],
            lastAuthProvider: 'microsoft',
          },
        });

        // Create MicrosoftProfile
        await tx.microsoftProfile.create({
          data: {
            userId: newUser.id,
            msUserId: msUser.id,
            email: normalizedEmail,
            name: msUser.displayName || [msUser.givenName, msUser.surname].filter(Boolean).join(' ') || null,
            pictureUrl: null,
          },
        });

        return newUser;
      });

      authLogger.info('New user created via Microsoft', { userId: user.id, email: normalizedEmail });
    }

    // Create session and set cookie
    await createSession({
      userId: user.id,
      ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
      userAgent: req.headers['user-agent'],
    }, res);

    // Redirect to frontend
    res.redirect(`${FRONTEND_URL}${returnTo}`);
  } catch (error: any) {
    authLogger.error('Microsoft OAuth callback failed', { error: error.message });
    res.redirect(`${FRONTEND_URL}/auth/error?error=callback_failed`);
  }
});

// ========================================
// AUTH PROVIDER TRACKING (Legacy - for migration)
// ========================================

/**
 * Track auth provider used for login
 * POST /api/auth/track-provider
 * 
 * Called after successful OAuth to track which provider was used.
 * Requires session authentication.
 */
router.post('/track-provider', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    const { provider } = req.body;

    if (!provider) {
      return res.status(400).json({
        status: 'error',
        message: 'provider is required',
      });
    }

    const validProviders = ['google', 'apple', 'microsoft', 'email'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid provider. Use: google, apple, microsoft, email',
      });
    }

    // Find and update user
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found',
      });
    }

    // Update auth providers array (add if not present)
    const currentProviders = user.authProviders || [];
    const updatedProviders = currentProviders.includes(provider)
      ? currentProviders
      : [...currentProviders, provider];

    await prisma.user.update({
      where: { id: user.id },
      data: {
        authProviders: updatedProviders,
        lastAuthProvider: provider,
      },
    });

    authLogger.info('Auth provider tracked', { userId: user.id, provider });

    res.json({
      status: 'success',
      message: 'Auth provider tracked',
    });
  } catch (error: any) {
    authLogger.error('Track provider failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to track auth provider',
    });
  }
});

// ========================================
// MOCK OAUTH ENDPOINTS (DEVELOPMENT ONLY)
// ========================================

if (isDevelopment) {
  authLogger.info('Mock OAuth endpoints enabled (development mode)');

  /**
   * Start mock OAuth flow
   * GET /api/auth/mock/oauth/start
   * 
   * Returns a mock redirect URL for testing OAuth UI flow.
   */
  router.get('/mock/oauth/start', (req: Request, res: Response) => {
    const { provider, redirectUrl } = req.query;
    const providerStr = provider as string;

    if (!providerStr || !['microsoft', 'apple', 'google'].includes(providerStr)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid provider. Use: microsoft, apple, google',
      });
    }

    const mockState = Buffer.from(JSON.stringify({
      provider: providerStr,
      timestamp: Date.now(),
      mock: true,
    })).toString('base64');

    const baseRedirect = redirectUrl || '/auth/callback';
    const callbackUrl = baseRedirect + '?mock=1&provider=' + providerStr + '&state=' + mockState + '&code=mock_auth_code_' + providerStr;

    authLogger.info('Mock OAuth started', { provider: providerStr, callbackUrl });

    res.json({
      status: 'success',
      redirectUrl: callbackUrl,
      provider: providerStr,
      mock: true,
    });
  });

  /**
   * Handle mock OAuth callback
   * POST /api/auth/mock/oauth/callback
   * 
   * Simulates successful OAuth by returning mock user data.
   * NOTE: This is a dev-only endpoint and doesn't require auth.
   */
  router.post('/mock/oauth/callback', async (req: Request, res: Response) => {
    const { provider, code, userId } = req.body;

    if (!provider) {
      return res.status(400).json({
        status: 'error',
        message: 'Provider is required',
      });
    }

    // Generate mock user data
    const mockUser = {
      id: 'mock_' + provider + '_' + Date.now(),
      email: 'mock.user.' + provider + '@example.com',
      firstName: 'Mock',
      lastName: provider.charAt(0).toUpperCase() + provider.slice(1) + ' User',
      provider,
      accessToken: 'mock_access_token_' + provider + '_' + Date.now(),
    };

    authLogger.info('Mock OAuth callback', { provider, mockUser: mockUser.email });

    // If userId provided, track the provider
    if (userId) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
        });

        if (user) {
          const currentProviders = user.authProviders || [];
          const updatedProviders = currentProviders.includes(provider)
            ? currentProviders
            : [...currentProviders, provider];

          await prisma.user.update({
            where: { id: user.id },
            data: {
              authProviders: updatedProviders,
              lastAuthProvider: provider,
            },
          });
        }
      } catch (e) {
        authLogger.warn('Mock user update failed (non-blocking)', { error: (e as Error).message });
      }
    }

    res.json({
      status: 'success',
      mock: true,
      user: mockUser,
      message: 'Mock ' + provider + ' authentication successful',
    });
  });

  /**
   * Dev-only: Full mock OAuth login that creates a real session
   * GET /api/auth/mock/login
   * 
   * Creates or finds a test user and sets a session cookie.
   * Then redirects to /auth/post-login just like real OAuth would.
   */
  router.get('/mock/login', async (req: Request, res: Response) => {
    const email = (req.query.email as string) || 'dev-test@vocaid.io';
    const provider = (req.query.provider as string) || 'google';
    const normalizedEmail = email.toLowerCase().trim();

    try {
      // Find or create user
      let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email: normalizedEmail,
            firstName: 'Dev',
            lastName: 'Tester',
            emailVerified: true,
            emailVerifiedAt: new Date(),
            isActive: true,
            currentRole: 'B2C_FREE',
            authProviders: [provider],
            lastAuthProvider: provider,
          },
        });
        authLogger.info('Mock login: created user', { userId: user.id, email: normalizedEmail });
      } else {
        authLogger.info('Mock login: found existing user', { userId: user.id, email: normalizedEmail });
      }

      // Create session
      await createSession({
        userId: user.id,
        ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip,
        userAgent: req.headers['user-agent'],
      }, res);

      const returnTo = normalizeReturnTo(req.query.returnTo);
      res.redirect(`${FRONTEND_URL}${returnTo}`);
    } catch (error: any) {
      authLogger.error('Mock login failed', { error: error.message });
      res.redirect(`${FRONTEND_URL}/auth/error?error=mock_login_failed`);
    }
  });
}

// ========================================
// PASSWORD RESET ENDPOINTS
// ========================================

// Validation schemas
const passwordResetRequestSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const passwordResetConfirmSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  newPassword: z.string().min(PASSWORD_POLICY.minLength, `Password must be at least ${PASSWORD_POLICY.minLength} characters`),
});

/**
 * Request password reset email
 * POST /api/auth/password-reset/request
 * 
 * Sends a password reset email with a secure token link.
 * Always returns success to prevent email enumeration.
 * Works both authenticated (uses session) and unauthenticated (uses email from body).
 */
router.post('/password-reset/request', optionalSession, async (req: Request, res: Response) => {
  try {
    let email: string | undefined;
    let user: any;

    // Check if user is authenticated via session
    if (req.userId) {
      // Authenticated request - get email from user
      user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, email: true, firstName: true, preferredLanguage: true },
      });
      
      if (!user) {
        return res.status(404).json({
          status: 'error',
          message: 'User not found',
        });
      }
      
      email = user.email;
    } else {
      // Unauthenticated request - validate email from body
      const parseResult = passwordResetRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          status: 'error',
          message: parseResult.error.errors[0]?.message || 'Invalid request',
        });
      }
      
      email = parseResult.data.email.toLowerCase();
      
      user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, firstName: true, preferredLanguage: true },
      });
    }

    // Always return success to prevent email enumeration
    if (!user) {
      authLogger.info('Password reset requested for unknown email', { email });
      return res.json({
        status: 'success',
        message: 'If an account exists with this email, a reset link has been sent.',
      });
    }

    // Get request metadata
    const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip;
    const userAgent = req.headers['user-agent'];

    // Create reset token
    const { rawToken, expiresAt } = await createPasswordResetToken(
      user.id,
      ipAddress,
      userAgent
    );

    // Send reset email
    const emailResult = await sendPasswordResetEmail({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName || undefined,
        preferredLanguage: user.preferredLanguage || 'en',
      },
      resetToken: rawToken,
      expiresAt,
      ipAddress,
      userAgent,
    });

    if (!emailResult.success) {
      authLogger.error('Failed to send password reset email', { 
        userId: user.id, 
        error: emailResult.error 
      });
      // Still return success to prevent enumeration
    } else {
      authLogger.info('Password reset email sent', { userId: user.id });
    }

    res.json({
      status: 'success',
      message: 'If an account exists with this email, a reset link has been sent.',
    });
  } catch (error: any) {
    authLogger.error('Password reset request failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to process password reset request',
    });
  }
});

/**
 * Confirm password reset with token
 * POST /api/auth/password-reset/confirm
 * 
 * Validates the reset token and sets the new password.
 */
router.post('/password-reset/confirm', async (req: Request, res: Response) => {
  try {
    const parseResult = passwordResetConfirmSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: parseResult.error.errors[0]?.message || 'Invalid request',
      });
    }

    const { token, newPassword } = parseResult.data;

    // Validate password against policy
    const validation = validatePassword(newPassword);
    if (!validation.isValid) {
      return res.status(400).json({
        status: 'error',
        message: validation.errors.join('. '),
        validation: validation.checks,
      });
    }

    // Consume the token
    const tokenResult = await consumePasswordResetToken(token);
    if (!tokenResult) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or expired reset link. Please request a new one.',
      });
    }

    // Update the password
    await updateUserPassword(tokenResult.userId, newPassword);

    authLogger.info('Password reset completed', { userId: tokenResult.userId });

    res.json({
      status: 'success',
      message: 'Password has been reset successfully. You can now sign in.',
    });
  } catch (error: any) {
    authLogger.error('Password reset confirm failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to reset password',
    });
  }
});

/**
 * Set password for OAuth user
 * POST /api/auth/set-password
 * 
 * Allows OAuth users to set a DB password for future email/password login.
 * Requires session authentication.
 */
router.post('/set-password', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    
    if (!userId) {
      return res.status(401).json({
        status: 'error',
        message: 'Authentication required',
      });
    }

    const setPasswordSchema = z.object({
      password: z.string().min(PASSWORD_POLICY.minLength, `Password must be at least ${PASSWORD_POLICY.minLength} characters`),
    });

    const parseResult = setPasswordSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: parseResult.error.errors[0]?.message || 'Invalid request',
      });
    }

    const { password } = parseResult.data;

    // Validate password against policy
    const validation = validatePassword(password);
    if (!validation.isValid) {
      return res.status(400).json({
        status: 'error',
        message: validation.errors.join('. '),
        validation: validation.checks,
      });
    }

    // Set the password
    await setUserPassword(userId, password);

    authLogger.info('Password set for OAuth user', { userId });

    res.json({
      status: 'success',
      message: 'Password set successfully',
    });
  } catch (error: any) {
    authLogger.error('Set password failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to set password',
    });
  }
});

/**
 * Check if user has a password set
 * GET /api/auth/has-password
 * 
 * Returns whether the authenticated user has a DB password.
 */
router.get('/has-password', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    
    if (!userId) {
      return res.status(401).json({
        status: 'error',
        message: 'Authentication required',
      });
    }

    const hasPassword = await userHasPassword(userId);

    res.json({
      status: 'success',
      hasPassword,
    });
  } catch (error: any) {
    authLogger.error('Check password failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to check password status',
    });
  }
});

/**
 * Get password policy
 * GET /api/auth/password-policy
 * 
 * Returns the password policy requirements for UI display.
 */
router.get('/password-policy', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    policy: {
      minLength: PASSWORD_POLICY.minLength,
      requiredClasses: PASSWORD_POLICY.requiredClasses,
      maxConsecutiveIdentical: PASSWORD_POLICY.maxConsecutiveIdentical,
      classes: ['lowercase', 'uppercase', 'numbers', 'special'],
      description: `Password must be at least ${PASSWORD_POLICY.minLength} characters with at least ${PASSWORD_POLICY.requiredClasses} of: lowercase, uppercase, numbers, special characters. No more than ${PASSWORD_POLICY.maxConsecutiveIdentical} identical characters in a row.`,
    },
  });
});

export default router;
