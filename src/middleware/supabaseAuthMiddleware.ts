/**
 * Supabase Auth Middleware
 * 
 * Verifies Supabase JWT tokens and attaches user info to request.
 * Replaces Clerk auth middleware during migration.
 * 
 * During migration period, supports both:
 * - Authorization: Bearer <supabase_jwt>
 * - x-user-id: <user_id> (legacy, for backward compatibility)
 * 
 * @module middleware/supabaseAuthMiddleware
 */

import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { supabaseAdmin, verifySupabaseToken, getUserBySupabaseId } from '../providers/supabaseProvider';
import logger from '../utils/logger';

const prisma = new PrismaClient();

// Extend Express Request to include auth info
declare global {
  namespace Express {
    interface Request {
      supabaseUser?: {
        id: string;
        email: string;
        phone?: string;
        phoneVerified?: boolean;
        metadata?: Record<string, any>;
      };
      dbUser?: {
        id: string;
        supabaseUserId: string;
        email: string;
        firstName?: string | null;
        lastName?: string | null;
        userType: string;
        countryCode: string;
        credits: number;
      };
      // Legacy fields for backward compatibility
      clerkUserId?: string;
      userId?: string;
    }
  }
}

// Error codes
export const AuthErrorCodes = {
  NO_TOKEN: 'NO_TOKEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_INACTIVE: 'USER_INACTIVE',
} as const;

export type AuthErrorCode = typeof AuthErrorCodes[keyof typeof AuthErrorCodes];

/**
 * Send a structured auth error response
 */
function sendAuthError(
  res: Response,
  statusCode: number,
  code: AuthErrorCode,
  message: string,
  requestId?: string
) {
  return res.status(statusCode).json({
    ok: false,
    status: 'error',
    error: {
      code,
      message,
      requestId: requestId || undefined,
    },
  });
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

/**
 * Optional Supabase auth - sets user if token present, but doesn't require it
 * Use for endpoints that work differently for authenticated vs anonymous users
 */
export async function optionalSupabaseAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = (req as any).requestId || 'N/A';
  const authHeader = req.headers.authorization;
  const legacyUserId = req.headers['x-user-id'] as string | undefined;

  // Try Supabase JWT first
  const token = extractBearerToken(authHeader);
  
  if (token) {
    try {
      const supabaseUser = await verifySupabaseToken(token);
      
      if (supabaseUser) {
        req.supabaseUser = {
          id: supabaseUser.id,
          email: supabaseUser.email || '',
          phone: supabaseUser.phone,
          phoneVerified: !!supabaseUser.phone_confirmed_at,
          metadata: supabaseUser.user_metadata,
        };
        
        // Also set legacy field for backward compatibility
        req.clerkUserId = supabaseUser.id;
        req.userId = supabaseUser.id;

        // Try to fetch DB user
        try {
          const dbUser = await prisma.user.findUnique({
            where: { supabaseUserId: supabaseUser.id },
            select: {
              id: true,
              supabaseUserId: true,
              email: true,
              firstName: true,
              lastName: true,
              userType: true,
              countryCode: true,
              credits: true,
              isActive: true,
            },
          });

          if (dbUser && dbUser.isActive) {
            req.dbUser = {
              id: dbUser.id,
              supabaseUserId: dbUser.supabaseUserId,
              email: dbUser.email,
              firstName: dbUser.firstName,
              lastName: dbUser.lastName,
              userType: dbUser.userType,
              countryCode: dbUser.countryCode,
              credits: dbUser.credits,
            };
          }
        } catch (dbError) {
          logger.warn('Optional auth: DB user lookup failed', { requestId, error: dbError });
        }
      }
    } catch (tokenError) {
      // Token invalid, but this is optional auth so continue
      logger.debug('Optional auth: Token verification failed', { requestId });
    }
  } else if (legacyUserId) {
    // Legacy x-user-id header (backward compatibility during migration)
    req.clerkUserId = legacyUserId;
    req.userId = legacyUserId;
    
    // Try to fetch DB user by legacy clerkId
    try {
      // First try supabaseUserId, then fall back to clerkId
      let dbUser = await prisma.user.findUnique({
        where: { supabaseUserId: legacyUserId },
        select: {
          id: true,
          supabaseUserId: true,
          email: true,
          firstName: true,
          lastName: true,
          userType: true,
          countryCode: true,
          credits: true,
          isActive: true,
        },
      });

      if (!dbUser) {
        // Fall back to legacy clerkId field if it exists
        dbUser = await prisma.user.findFirst({
          where: { 
            OR: [
              { supabaseUserId: legacyUserId },
              // During migration, check if there's a clerkId match
              // @ts-ignore - clerkId may not exist after schema migration
              { clerkId: legacyUserId },
            ]
          },
          select: {
            id: true,
            supabaseUserId: true,
            email: true,
            firstName: true,
            lastName: true,
            userType: true,
            countryCode: true,
            credits: true,
            isActive: true,
          },
        });
      }

      if (dbUser && dbUser.isActive) {
        req.dbUser = {
          id: dbUser.id,
          supabaseUserId: dbUser.supabaseUserId,
          email: dbUser.email,
          firstName: dbUser.firstName,
          lastName: dbUser.lastName,
          userType: dbUser.userType,
          countryCode: dbUser.countryCode,
          credits: dbUser.credits,
        };
      }
    } catch (dbError) {
      logger.warn('Optional auth: Legacy user lookup failed', { requestId, error: dbError });
    }
  }

  next();
}

/**
 * Required Supabase auth - requires valid token, returns 401 if not present
 * Use for protected endpoints
 */
export async function requireSupabaseAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = (req as any).requestId || 'N/A';
  const authHeader = req.headers.authorization;
  const legacyUserId = req.headers['x-user-id'] as string | undefined;

  // Try Supabase JWT first
  const token = extractBearerToken(authHeader);

  if (!token && !legacyUserId) {
    logger.warn('Auth required: No token or user ID provided', { requestId, path: req.path });
    return sendAuthError(res, 401, AuthErrorCodes.NO_TOKEN, 'Authentication required', requestId);
  }

  if (token) {
    try {
      const supabaseUser = await verifySupabaseToken(token);

      if (!supabaseUser) {
        return sendAuthError(res, 401, AuthErrorCodes.INVALID_TOKEN, 'Invalid token', requestId);
      }

      req.supabaseUser = {
        id: supabaseUser.id,
        email: supabaseUser.email || '',
        phone: supabaseUser.phone,
        phoneVerified: !!supabaseUser.phone_confirmed_at,
        metadata: supabaseUser.user_metadata,
      };

      // Set legacy fields
      req.clerkUserId = supabaseUser.id;
      req.userId = supabaseUser.id;

      // Fetch DB user
      const dbUser = await prisma.user.findUnique({
        where: { supabaseUserId: supabaseUser.id },
        select: {
          id: true,
          supabaseUserId: true,
          email: true,
          firstName: true,
          lastName: true,
          userType: true,
          countryCode: true,
          credits: true,
          isActive: true,
        },
      });

      if (!dbUser) {
        logger.warn('Auth required: User not found in database', { 
          requestId, 
          supabaseUserId: supabaseUser.id.slice(0, 10) 
        });
        return sendAuthError(res, 404, AuthErrorCodes.USER_NOT_FOUND, 'User not found', requestId);
      }

      if (!dbUser.isActive) {
        logger.warn('Auth required: User is inactive', { requestId });
        return sendAuthError(res, 403, AuthErrorCodes.USER_INACTIVE, 'Account is inactive', requestId);
      }

      req.dbUser = {
        id: dbUser.id,
        supabaseUserId: dbUser.supabaseUserId,
        email: dbUser.email,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        userType: dbUser.userType,
        countryCode: dbUser.countryCode,
        credits: dbUser.credits,
      };

      return next();
    } catch (tokenError: any) {
      if (tokenError.message?.includes('expired')) {
        return sendAuthError(res, 401, AuthErrorCodes.TOKEN_EXPIRED, 'Token expired', requestId);
      }
      logger.error('Auth required: Token verification failed', { requestId, error: tokenError.message });
      return sendAuthError(res, 401, AuthErrorCodes.INVALID_TOKEN, 'Invalid token', requestId);
    }
  }

  // Fall back to legacy x-user-id (during migration)
  if (legacyUserId) {
    req.clerkUserId = legacyUserId;
    req.userId = legacyUserId;

    try {
      // Try to find user by supabaseUserId or clerkId
      const dbUser = await prisma.user.findFirst({
        where: {
          OR: [
            { supabaseUserId: legacyUserId },
            // @ts-ignore - clerkId may exist during migration
            { clerkId: legacyUserId },
          ],
        },
        select: {
          id: true,
          supabaseUserId: true,
          email: true,
          firstName: true,
          lastName: true,
          userType: true,
          countryCode: true,
          credits: true,
          isActive: true,
        },
      });

      if (!dbUser) {
        return sendAuthError(res, 404, AuthErrorCodes.USER_NOT_FOUND, 'User not found', requestId);
      }

      if (!dbUser.isActive) {
        return sendAuthError(res, 403, AuthErrorCodes.USER_INACTIVE, 'Account is inactive', requestId);
      }

      req.dbUser = {
        id: dbUser.id,
        supabaseUserId: dbUser.supabaseUserId,
        email: dbUser.email,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        userType: dbUser.userType,
        countryCode: dbUser.countryCode,
        credits: dbUser.credits,
      };

      return next();
    } catch (dbError) {
      logger.error('Auth required: Legacy user lookup failed', { requestId, error: dbError });
      return sendAuthError(res, 500, AuthErrorCodes.USER_NOT_FOUND, 'Authentication error', requestId);
    }
  }

  return sendAuthError(res, 401, AuthErrorCodes.NO_TOKEN, 'Authentication required', requestId);
}

/**
 * Require B2C (Personal) user type
 * Must be used after requireSupabaseAuth
 */
export async function requireB2CUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = (req as any).requestId || 'N/A';

  if (!req.dbUser) {
    return sendAuthError(res, 401, AuthErrorCodes.USER_NOT_FOUND, 'User not found', requestId);
  }

  if (req.dbUser.userType !== 'PERSONAL') {
    return res.status(403).json({
      ok: false,
      status: 'error',
      error: {
        code: 'NOT_PERSONAL_USER',
        message: 'This feature is only available for personal accounts',
        requestId,
      },
    });
  }

  next();
}

export default {
  optionalSupabaseAuth,
  requireSupabaseAuth,
  requireB2CUser,
};
