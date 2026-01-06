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

const FRONTEND_URL = process.env.FRONTEND_URL || 
  (process.env.NODE_ENV === 'production' ? 'https://vocaid.io' : 'http://localhost:3000');

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

    // Create user
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
      res.clearCookie(getSessionCookieName(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });
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
    res.clearCookie(getSessionCookieName(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

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
      return res.status(401).json({
        status: 'error',
        message: 'Not authenticated',
        authenticated: false,
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
      return res.status(401).json({
        status: 'error',
        message: 'User not found',
        authenticated: false,
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

/**
 * Start Google OAuth flow
 * GET /api/auth/google
 * 
 * Redirects to Google's OAuth consent screen.
 */
router.get('/google', (req: Request, res: Response) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({
      status: 'error',
      message: 'Google OAuth not configured',
    });
  }

  // Store redirect URL in state for after callback
  const returnTo = (req.query.returnTo as string) || '/dashboard';
  const state = Buffer.from(JSON.stringify({ returnTo })).toString('base64url');

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  
  authLogger.info('Starting Google OAuth', { returnTo });
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

    // Parse state to get returnTo URL
    let returnTo = '/dashboard';
    if (state && typeof state === 'string') {
      try {
        const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
        returnTo = stateData.returnTo || '/dashboard';
      } catch {
        // Invalid state, use default
      }
    }

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

    // Check if user exists by googleId or email
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { googleId: googleUser.id },
          { email: normalizedEmail },
        ],
      },
    });

    if (user) {
      // Update existing user with Google info
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: googleUser.id,
          // Only update if not already verified - Google OAuth counts as verified
          emailVerified: true,
          emailVerifiedAt: user.emailVerifiedAt || new Date(),
          // Update auth providers
          authProviders: user.authProviders.includes('google') 
            ? user.authProviders 
            : [...user.authProviders, 'google'],
          lastAuthProvider: 'google',
          // Update profile if empty
          firstName: user.firstName || googleUser.given_name || googleUser.name?.split(' ')[0] || null,
          lastName: user.lastName || googleUser.family_name || null,
          imageUrl: user.imageUrl || googleUser.picture || null,
        },
      });

      authLogger.info('Existing user logged in via Google', { userId: user.id, email: normalizedEmail });
    } else {
      // Create new user - Google OAuth is auto-verified
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          googleId: googleUser.id,
          firstName: googleUser.given_name || googleUser.name?.split(' ')[0] || null,
          lastName: googleUser.family_name || null,
          imageUrl: googleUser.picture || null,
          emailVerified: true, // Google OAuth = verified
          emailVerifiedAt: new Date(),
          isActive: true,
          currentRole: 'B2C_FREE',
          authProviders: ['google'],
          lastAuthProvider: 'google',
        },
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
  const returnTo = (req.query.returnTo as string) || '/dashboard';
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
    let returnTo = '/dashboard';
    if (state && typeof state === 'string') {
      try {
        const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
        returnTo = stateData.returnTo || '/dashboard';
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
// X (TWITTER) OAUTH 2.0
// ========================================

// Store PKCE code verifiers temporarily (in production, use Redis or session storage)
const xCodeVerifiers = new Map<string, { verifier: string; returnTo: string; expiresAt: number }>();

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
  const returnTo = (req.query.returnTo as string) || '/dashboard';
  
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
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: 'users.read tweet.read offline.access',
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
 * Creates or links user account and sets session cookie.
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

    // Get user info from X API v2
    const userInfoResponse = await fetch('https://api.twitter.com/2/users/me?user.fields=id,name,username,profile_image_url', {
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
      };
    };

    const xUser = xUserResponse.data;

    if (!xUser || !xUser.id) {
      return res.redirect(`${FRONTEND_URL}/auth/error?error=no_user_data`);
    }

    // X doesn't provide email via OAuth 2.0 by default
    // We'll create a placeholder email or require email verification later
    // For now, use username@x.vocaid.io as placeholder
    const placeholderEmail = `${xUser.username}@x.vocaid.io`.toLowerCase();

    // X profile fields are not stored in the canonical schema.
    // Use placeholder email as the only linking key.
    let user = await prisma.user.findFirst({
      where: { email: placeholderEmail },
    });

    if (user) {
      // Update existing user with X info
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          // X OAuth doesn't verify email, so we don't set emailVerified
          // Update auth providers
          authProviders: user.authProviders.includes('x') 
            ? user.authProviders 
            : [...user.authProviders, 'x'],
          lastAuthProvider: 'x',
          // Update profile if empty
          firstName: user.firstName || xUser.name?.split(' ')[0] || null,
          lastName: user.lastName || xUser.name?.split(' ').slice(1).join(' ') || null,
          imageUrl: user.imageUrl || xUser.profile_image_url?.replace('_normal', '') || null,
        },
      });

      authLogger.info('Existing user logged in via X', { userId: user.id, xUsername: xUser.username });
    } else {
      // Create new user - X OAuth doesn't provide verified email
      user = await prisma.user.create({
        data: {
          email: placeholderEmail,
          firstName: xUser.name?.split(' ')[0] || null,
          lastName: xUser.name?.split(' ').slice(1).join(' ') || null,
          imageUrl: xUser.profile_image_url?.replace('_normal', '') || null,
          emailVerified: false, // X doesn't provide verified email
          isActive: true,
          currentRole: 'B2C_FREE',
          authProviders: ['x'],
          lastAuthProvider: 'x',
        },
      });

      authLogger.info('New user created via X', { userId: user.id, xUsername: xUser.username });
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
    authLogger.error('X OAuth callback failed', { error: error.message });
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
