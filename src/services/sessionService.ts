/**
 * Session Service
 * 
 * Manages first-party authentication sessions using httpOnly cookies.
 * Sessions are stored in the database with hashed tokens for security.
 * 
 * @module services/sessionService
 */

import * as crypto from 'crypto';
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const sessionLogger = logger.child({ service: 'session' });

// ========================================
// CONFIGURATION
// ========================================

type SameSiteOption = 'lax' | 'strict' | 'none';

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return undefined;
}

function parseSameSiteEnv(value: string | undefined): SameSiteOption | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'lax' || normalized === 'strict' || normalized === 'none') return normalized;
  return undefined;
}

function shouldUseSecureCookiesByDefault(): boolean {
  const candidates = [
    process.env.BACKEND_PUBLIC_URL,
    process.env.WEBHOOK_BASE_URL,
    process.env.PUBLIC_URL,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:') return true;
      if (url.hostname.includes('ngrok')) return true;
    } catch {
      // ignore
    }
  }

  return process.env.NODE_ENV === 'production';
}

export function getSessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSiteOption;
  path: string;
} {
  const envSameSite = parseSameSiteEnv(process.env.SESSION_COOKIE_SAMESITE);
  const envSecure = parseBooleanEnv(process.env.SESSION_COOKIE_SECURE);

  const secure = envSecure ?? shouldUseSecureCookiesByDefault();
  const sameSite: SameSiteOption = envSameSite ?? (secure ? 'none' : 'lax');

  // Browsers reject SameSite=None cookies unless Secure=true.
  const normalizedSameSite: SameSiteOption = sameSite === 'none' && !secure ? 'lax' : sameSite;

  return {
    httpOnly: true,
    secure,
    sameSite: normalizedSameSite,
    path: '/',
  };
}

const SESSION_CONFIG = {
  // Session token length (32 bytes = 256 bits of entropy)
  tokenLength: 32,
  
  // Session TTL in days
  ttlDays: parseInt(process.env.SESSION_TTL_DAYS || '7', 10),
  
  // Cookie name
  cookieName: 'vocaid_session',
  
  // Cookie settings
  cookie: getSessionCookieOptions(),
};

// Log effective session cookie options on module load (helps debug SameSite/Secure issues)
sessionLogger.info('Session cookie options resolved', SESSION_CONFIG.cookie);

// ========================================
// TOKEN UTILITIES
// ========================================

/**
 * Generate a cryptographically secure random session token
 */
function generateSessionToken(): string {
  return crypto.randomBytes(SESSION_CONFIG.tokenLength).toString('hex');
}

/**
 * Hash a session token using SHA-256
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ========================================
// SESSION MANAGEMENT
// ========================================

export interface CreateSessionOptions {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionData {
  id: string;
  userId: string;
  expiresAt: Date;
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    emailVerified: boolean;
    isActive: boolean;
    credits: number;
    userType: string;
    countryCode: string;
    preferredLanguage: string | null;
    onboardingComplete: boolean;
    phoneVerified: boolean;
  };
}

/**
 * Create a new session for a user and set the cookie
 * 
 * @param options - Session creation options
 * @param res - Express response object (to set cookie)
 * @returns The raw session token (for testing purposes)
 */
export async function createSession(
  options: CreateSessionOptions,
  res: Response
): Promise<string> {
  const { userId, ipAddress, userAgent } = options;
  
  // Generate token
  const rawToken = generateSessionToken();
  const tokenHash = hashToken(rawToken);
  
  // Calculate expiration
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_CONFIG.ttlDays);
  
  // Create session in database
  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      ipAddress,
      userAgent: userAgent?.substring(0, 500),
    },
  });
  
  // Set cookie
  res.cookie(SESSION_CONFIG.cookieName, rawToken, {
    ...SESSION_CONFIG.cookie,
    expires: expiresAt,
  });
  
  sessionLogger.info('Session created', { userId });
  
  return rawToken;
}

/**
 * Validate a session token and return user data
 * 
 * @param token - Raw session token from cookie
 * @returns Session data with user, or null if invalid/expired
 */
export async function validateSession(token: string): Promise<SessionData | null> {
  if (!token) {
    return null;
  }
  
  const tokenHash = hashToken(token);
  
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          emailVerified: true,
          isActive: true,
          credits: true,
          userType: true,
          countryCode: true,
          preferredLanguage: true,
          onboardingComplete: true,
          phoneVerified: true,
        },
      },
    },
  });
  
  if (!session) {
    return null;
  }
  
  // Check expiration
  if (session.expiresAt < new Date()) {
    sessionLogger.info('Session expired', { sessionId: session.id });
    // Clean up expired session
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  
  // Check if user is active
  if (!session.user.isActive) {
    sessionLogger.warn('Session for inactive user', { userId: session.userId });
    return null;
  }
  
  // Update last used timestamp (fire-and-forget)
  prisma.session.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});
  
  return {
    id: session.id,
    userId: session.userId,
    expiresAt: session.expiresAt,
    user: session.user,
  };
}

/**
 * Destroy a session (logout)
 * 
 * @param token - Raw session token from cookie
 * @param res - Express response object (to clear cookie)
 */
export async function destroySession(token: string, res: Response): Promise<void> {
  if (token) {
    const tokenHash = hashToken(token);
    
    await prisma.session.deleteMany({
      where: { tokenHash },
    }).catch((err) => {
      sessionLogger.warn('Failed to delete session', { error: err.message });
    });
  }
  
  // Clear cookie
  res.clearCookie(SESSION_CONFIG.cookieName, {
    ...SESSION_CONFIG.cookie,
  });
  
  sessionLogger.info('Session destroyed');
}

/**
 * Destroy all sessions for a user (e.g., password change)
 * 
 * @param userId - User ID
 */
export async function destroyAllUserSessions(userId: string): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { userId },
  });
  
  sessionLogger.info('All user sessions destroyed', { userId, count: result.count });
  
  return result.count;
}

/**
 * Clean up expired sessions (run periodically)
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  
  if (result.count > 0) {
    sessionLogger.info('Expired sessions cleaned up', { count: result.count });
  }
  
  return result.count;
}

/**
 * Get session cookie name (for middleware)
 */
export function getSessionCookieName(): string {
  return SESSION_CONFIG.cookieName;
}

/**
 * Get session token from request cookies
 */
export function getSessionToken(cookies: Record<string, string>): string | undefined {
  return cookies[SESSION_CONFIG.cookieName];
}

export default {
  createSession,
  validateSession,
  destroySession,
  destroyAllUserSessions,
  cleanupExpiredSessions,
  getSessionCookieName,
  getSessionToken,
};
