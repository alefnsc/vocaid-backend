/**
 * Consent Middleware
 * 
 * Middleware to enforce consent requirements on protected endpoints.
 * Returns 403 CONSENT_REQUIRED if user hasn't completed required consents.
 */

import { Request, Response, NextFunction } from 'express';
import { hasRequiredConsents } from '../services/consentService';
import logger from '../utils/logger';

const middlewareLogger = logger.child({ middleware: 'consent' });

// Endpoints that don't require consent (allowlist)
const CONSENT_EXEMPT_PATHS = [
  // GraphQL endpoint (handled by GraphQL context auth)
  '/graphql',
  // User validation and consent endpoints
  '/api/users/validate',
  '/api/consent',
  '/api/consent/requirements',
  '/api/consent/status',
  '/api/consent/submit',
  '/api/consent/marketing',
  // Health checks
  '/api/health',
  '/health',
  // Webhooks (no user context)
  '/webhook',
  // Auth routes
  '/api/auth',
  // Leads (public)
  '/api/leads',
  // Multilingual (language detection, geo)
  '/api/multilingual/geo',
  '/api/multilingual/detect-language',
];

/**
 * Check if a path is exempt from consent requirements
 */
function isExemptPath(path: string): boolean {
  return CONSENT_EXEMPT_PATHS.some(exemptPath => 
    path === exemptPath || path.startsWith(exemptPath + '/')
  );
}

/**
 * Middleware to require user consent before accessing protected endpoints
 * 
 * Usage:
 * - Apply globally after auth middleware but before route handlers
 * - Or apply to specific routes that need protection
 */
export async function requireConsent(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Skip consent check for exempt paths
  if (isExemptPath(req.path)) {
    return next();
  }

  // Skip if no auth header (will be caught by auth middleware)
  const userId = req.headers['x-user-id'] as string;
  if (!userId) {
    return next();
  }

  try {
    const hasConsent = await hasRequiredConsents(userId);

    if (!hasConsent) {
      middlewareLogger.debug('User blocked - consent required', { 
        userId, 
        path: req.path 
      });
      
      return res.status(403).json({
        ok: false,
        error: 'Consent required before accessing this resource',
        code: 'CONSENT_REQUIRED',
        redirectTo: '/onboarding/consent',
      });
    }

    next();
  } catch (error) {
    middlewareLogger.error('Error checking consent', { userId, error });
    // Fail open for now to avoid blocking users on errors
    // In production, you might want to fail closed
    next();
  }
}

/**
 * Middleware factory for specific route protection
 * Can be used to selectively protect certain routes
 */
export function requireConsentFor(...paths: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only check consent if path matches
    const shouldCheck = paths.some(p => 
      req.path === p || req.path.startsWith(p + '/')
    );
    
    if (!shouldCheck) {
      return next();
    }
    
    return requireConsent(req, res, next);
  };
}
