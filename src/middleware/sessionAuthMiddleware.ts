/**
 * Session Authentication Middleware
 * 
 * First-party cookie session authentication.
 * 
 * @module middleware/sessionAuthMiddleware
 */

import { Request, Response, NextFunction } from 'express';
import { validateSession, getSessionToken, SessionData } from '../services/sessionService';
import logger from '../utils/logger';

const authLogger = logger.child({ middleware: 'session-auth' });

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      session?: SessionData;
      userId?: string;
    }
  }
}

/**
 * Parse cookies from request (simple parser, no external dependency)
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
    return cookies;
  }, {} as Record<string, string>);
}

/**
 * Middleware that requires a valid session
 * Returns 401 if no valid session
 */
export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = getSessionToken(cookies);
    
    if (!token) {
      res.status(401).json({
        status: 'error',
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
      return;
    }
    
    const session = await validateSession(token);
    
    if (!session) {
      res.status(401).json({
        status: 'error',
        code: 'SESSION_INVALID',
        message: 'Session expired or invalid. Please sign in again.',
      });
      return;
    }
    
    // Attach session to request
    req.session = session;
    req.userId = session.userId;
    
    next();
  } catch (error: any) {
    authLogger.error('Session auth error', { error: error.message });
    res.status(500).json({
      status: 'error',
      code: 'AUTH_ERROR',
      message: 'Authentication error',
    });
  }
}

/**
 * Middleware that requires a valid session with verified email
 * Returns 401 if no session, 403 if email not verified
 */
export async function requireVerifiedSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = getSessionToken(cookies);
    
    if (!token) {
      res.status(401).json({
        status: 'error',
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
      return;
    }
    
    const session = await validateSession(token);
    
    if (!session) {
      res.status(401).json({
        status: 'error',
        code: 'SESSION_INVALID',
        message: 'Session expired or invalid. Please sign in again.',
      });
      return;
    }
    
    // Check email verification
    if (!session.user.emailVerified) {
      res.status(403).json({
        status: 'error',
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address to continue.',
      });
      return;
    }
    
    req.session = session;
    req.userId = session.userId;
    
    next();
  } catch (error: any) {
    authLogger.error('Verified session auth error', { error: error.message });
    res.status(500).json({
      status: 'error',
      code: 'AUTH_ERROR',
      message: 'Authentication error',
    });
  }
}

/**
 * Middleware that optionally attaches session if present
 * Does not require authentication - continues even if no session
 */
export async function optionalSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = getSessionToken(cookies);
    
    if (token) {
      const session = await validateSession(token);
      if (session) {
        req.session = session;
        req.userId = session.userId;
      }
    }
    
    next();
  } catch (error: any) {
    authLogger.warn('Optional session auth error', { error: error.message });
    // Continue without session
    next();
  }
}

/**
 * Alias for requireSession - maintained for backward compatibility
 * @deprecated Use requireSession directly
 */
export const requireAuth = requireSession;

export default {
  requireSession,
  requireVerifiedSession,
  optionalSession,
  requireAuth,
};
