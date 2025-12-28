/**
 * B2C Authorization Middleware
 * 
 * Enforces PERSONAL user type access for B2C features.
 * All countries are supported for B2C interview flow.
 * ID verification is Brazil-only (handled separately).
 * 
 * Checks:
 * 1. User must be authenticated (via Clerk)
 * 2. User must exist in database
 * 3. User must be userType = PERSONAL
 * 
 * @module middleware/b2cMiddleware
 */

import { Request, Response, NextFunction } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

// Countries where ID verification is available
const ID_VERIFICATION_COUNTRIES = ['BR'];

// Error codes for structured JSON responses
export const B2CErrorCodes = {
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  NOT_PERSONAL_USER: 'NOT_PERSONAL_USER',
  COUNTRY_NOT_SUPPORTED: 'COUNTRY_NOT_SUPPORTED',
  COUNTRY_REQUIRED: 'COUNTRY_REQUIRED',
  ID_VERIFICATION_NOT_AVAILABLE: 'ID_VERIFICATION_NOT_AVAILABLE',
} as const;

export type B2CErrorCode = typeof B2CErrorCodes[keyof typeof B2CErrorCodes];

/**
 * Send a structured JSON error response
 */
function sendB2CError(
  res: Response,
  statusCode: number,
  code: B2CErrorCode,
  message: string,
  requestId?: string
) {
  return res.status(statusCode).json({
    ok: false,
    status: 'error',
    error: {
      code,
      message,
      requestId: requestId || undefined
    }
  });
}

/**
 * Middleware to require B2C (Personal + Brazil) access
 * 
 * Usage:
 *   router.get('/b2c-only-route', requireAuth, requireB2C, handler);
 */
export async function requireB2C(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = (req as any).requestId || 'N/A';
  const clerkId = (req as any).clerkUserId;

  // Check authentication
  if (!clerkId) {
    logger.warn('B2C middleware: No clerkUserId found', { requestId, path: req.path });
    return sendB2CError(
      res,
      401,
      B2CErrorCodes.NOT_AUTHENTICATED,
      'Authentication required',
      requestId
    );
  }

  try {
    // Fetch user from database
    const user = await prisma.user.findUnique({
      where: { clerkId },
      select: {
        id: true,
        clerkId: true,
        userType: true,
        countryCode: true,
        email: true,
      }
    });

    if (!user) {
      logger.warn('B2C middleware: User not found in database', { requestId, clerkId: clerkId.slice(0, 15) });
      return sendB2CError(
        res,
        404,
        B2CErrorCodes.USER_NOT_FOUND,
        'User not found. Please complete registration.',
        requestId
      );
    }

    // Check user type (must be PERSONAL for B2C)
    if (user.userType !== UserType.PERSONAL) {
      logger.info('B2C middleware: Non-personal user blocked', { 
        requestId, 
        userId: user.id,
        userType: user.userType,
        path: req.path 
      });
      return sendB2CError(
        res,
        403,
        B2CErrorCodes.NOT_PERSONAL_USER,
        'This feature is only available for Personal (B2C) users. B2B access coming soon.',
        requestId
      );
    }

    // Attach user info to request for downstream handlers
    (req as any).b2cUser = {
      id: user.id,
      clerkId: user.clerkId,
      userType: user.userType,
      countryCode: user.countryCode,
      email: user.email,
    };

    next();
  } catch (error: any) {
    logger.error('B2C middleware error', { requestId, error: error.message });
    return sendB2CError(
      res,
      500,
      'SERVER_ERROR' as any,
      'An error occurred while checking access',
      requestId
    );
  }
}

/**
 * Check if ID verification is available for a country
 */
export function isIdVerificationAvailable(countryCode: string): boolean {
  return ID_VERIFICATION_COUNTRIES.includes(countryCode);
}

/**
 * Get list of countries with ID verification
 */
export function getIdVerificationCountries(): string[] {
  return [...ID_VERIFICATION_COUNTRIES];
}

/**
 * Validate country code format (ISO 3166-1 alpha-2)
 */
export function isValidCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code);
}

/**
 * Middleware to require ID verification availability (Brazil-only)
 * Use this on ID verification routes
 */
export async function requireIdVerificationCountry(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const b2cUser = (req as any).b2cUser;
  
  if (!b2cUser) {
    return sendB2CError(
      res,
      401,
      B2CErrorCodes.NOT_AUTHENTICATED,
      'Authentication required',
      (req as any).requestId
    );
  }

  if (!b2cUser.countryCode || !isIdVerificationAvailable(b2cUser.countryCode)) {
    logger.info('ID verification not available for country', {
      requestId: (req as any).requestId,
      userId: b2cUser.id,
      countryCode: b2cUser.countryCode,
    });
    return sendB2CError(
      res,
      403,
      B2CErrorCodes.ID_VERIFICATION_NOT_AVAILABLE,
      'ID verification is currently only available in Brazil.',
      (req as any).requestId
    );
  }

  next();
}
