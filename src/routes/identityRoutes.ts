/**
 * Identity Verification Routes
 * 
 * Brazil KYC verification scaffold for Personal (B2C) users.
 * Provider-agnostic design ready for future vendor integration.
 * 
 * Endpoints:
 * - GET /api/identity/status - Get current verification status
 * - POST /api/identity/start - Start a new verification session
 * - POST /api/identity/upload - Upload selfie and document
 * - POST /api/identity/consent - Record biometric consent
 * 
 * @module routes/identityRoutes
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient, IdentityVerificationStatus, UserType } from '@prisma/client';
import { requireAuth } from './apiRoutes';
import { requireB2C, requireIdVerificationCountry, B2CErrorCodes } from '../middleware/b2cMiddleware';
import logger from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

const router = Router();
const prisma = new PrismaClient();

// Feature flag for identity verification
const IDENTITY_VERIFICATION_ENABLED = process.env.IDENTITY_VERIFICATION_ENABLED === 'true';

// Storage paths (local in dev, S3 in production)
const STORAGE_BASE_PATH = process.env.IDENTITY_STORAGE_PATH || './uploads/identity';

// ========================================
// VALIDATION SCHEMAS
// ========================================

const startSessionSchema = z.object({
  documentType: z.enum(['RG', 'CNH', 'CPF']).optional(),
});

const uploadSchema = z.object({
  sessionId: z.string().uuid(),
  selfieBase64: z.string().min(100).max(10_000_000), // Max ~7.5MB
  documentBase64: z.string().min(100).max(10_000_000),
});

const consentSchema = z.object({
  termsAccepted: z.boolean(),
  biometricConsent: z.boolean(),
});

// ========================================
// MOCK IDENTITY PROVIDER
// For development/testing - returns deterministic results
// ========================================
interface IdentityProviderResult {
  success: boolean;
  verified: boolean;
  confidence: number;
  failureReason?: string;
  details?: Record<string, any>;
}

class MockIdentityProvider {
  static async verify(params: {
    selfie: string;
    document: string;
    countryCode: string;
  }): Promise<IdentityProviderResult> {
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Mock logic: verify based on data patterns
    // In production, this would call actual KYC vendor
    const selfieSize = params.selfie.length;
    const documentSize = params.document.length;

    // Deterministic result based on data characteristics
    if (selfieSize < 1000 || documentSize < 1000) {
      return {
        success: true,
        verified: false,
        confidence: 0.2,
        failureReason: 'Image quality too low',
      };
    }

    // Success case
    return {
      success: true,
      verified: true,
      confidence: 0.95,
      details: {
        matchScore: 0.95,
        livenessScore: 0.98,
        documentValid: true,
      },
    };
  }
}

// Provider factory (for future vendor integration)
function getIdentityProvider(): typeof MockIdentityProvider {
  // TODO: Switch based on environment/configuration
  // - 'serpro': Official Brazil government API
  // - 'datavalid': Brazilian data validation service
  // - 'onfido', 'jumio': International KYC vendors
  return MockIdentityProvider;
}

// ========================================
// HELPER FUNCTIONS
// ========================================

async function ensureStorageDirectory() {
  if (!fs.existsSync(STORAGE_BASE_PATH)) {
    fs.mkdirSync(STORAGE_BASE_PATH, { recursive: true });
  }
}

function generateSecureFileName(userId: string, type: 'selfie' | 'document'): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  return `${userId}_${type}_${timestamp}_${random}`;
}

async function saveFile(base64Data: string, fileName: string): Promise<string> {
  await ensureStorageDirectory();
  
  // Remove data URL prefix if present
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Clean, 'base64');
  
  const filePath = path.join(STORAGE_BASE_PATH, fileName);
  fs.writeFileSync(filePath, buffer);
  
  return filePath;
}

// ========================================
// MIDDLEWARE: Check feature flag
// ========================================
function requireIdentityEnabled(req: Request, res: Response, next: Function) {
  if (!IDENTITY_VERIFICATION_ENABLED) {
    return res.status(503).json({
      ok: false,
      status: 'error',
      error: {
        code: 'FEATURE_DISABLED',
        message: 'Identity verification is not enabled in this environment',
      }
    });
  }
  next();
}

// ========================================
// GET /api/identity/status - Get verification status
// ========================================
router.get('/status', requireAuth, requireB2C, requireIdVerificationCountry, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const b2cUser = (req as any).b2cUser;

  try {
    // Get latest verification session
    const session = await prisma.identityVerificationSession.findFirst({
      where: { userId: b2cUser.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        provider: true,
        documentType: true,
        verifiedAt: true,
        failureReason: true,
        createdAt: true,
        expiresAt: true,
      }
    });

    res.json({
      ok: true,
      status: 'success',
      data: {
        featureEnabled: IDENTITY_VERIFICATION_ENABLED,
        verification: session || {
          status: IdentityVerificationStatus.NOT_STARTED,
        },
        canStartNew: !session || 
          session.status === IdentityVerificationStatus.NOT_STARTED ||
          session.status === IdentityVerificationStatus.FAILED ||
          session.status === IdentityVerificationStatus.EXPIRED,
      }
    });
  } catch (error: any) {
    logger.error('Error fetching identity status', { requestId, error: error.message });
    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to fetch verification status',
        requestId
      }
    });
  }
});

// ========================================
// POST /api/identity/consent - Record consent
// ========================================
router.post('/consent', requireAuth, requireB2C, requireIdVerificationCountry, requireIdentityEnabled, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const b2cUser = (req as any).b2cUser;

  try {
    const result = consentSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: result.error.errors,
          requestId
        }
      });
    }

    const { termsAccepted, biometricConsent } = result.data;

    if (!termsAccepted || !biometricConsent) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'Both terms and biometric consent must be accepted',
          requestId
        }
      });
    }

    // Record consent in new session
    const session = await prisma.identityVerificationSession.create({
      data: {
        userId: b2cUser.id,
        status: IdentityVerificationStatus.NOT_STARTED,
        termsAcceptedAt: new Date(),
        biometricConsentAt: new Date(),
        consentIpAddress: req.ip,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      }
    });

    logger.info('Identity consent recorded', { 
      requestId, 
      userId: b2cUser.id,
      sessionId: session.id 
    });

    res.json({
      ok: true,
      status: 'success',
      data: {
        sessionId: session.id,
        status: session.status,
        expiresAt: session.expiresAt,
      }
    });
  } catch (error: any) {
    logger.error('Error recording consent', { requestId, error: error.message });
    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to record consent',
        requestId
      }
    });
  }
});

// ========================================
// POST /api/identity/start - Start verification session
// ========================================
router.post('/start', requireAuth, requireB2C, requireIdVerificationCountry, requireIdentityEnabled, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const b2cUser = (req as any).b2cUser;

  try {
    const result = startSessionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: result.error.errors,
          requestId
        }
      });
    }

    // Check for existing pending session
    const existingSession = await prisma.identityVerificationSession.findFirst({
      where: {
        userId: b2cUser.id,
        status: IdentityVerificationStatus.PENDING,
      }
    });

    if (existingSession) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'SESSION_EXISTS',
          message: 'A verification session is already in progress',
          sessionId: existingSession.id,
          requestId
        }
      });
    }

    // Check for recent successful verification
    const verifiedSession = await prisma.identityVerificationSession.findFirst({
      where: {
        userId: b2cUser.id,
        status: IdentityVerificationStatus.VERIFIED,
      }
    });

    if (verifiedSession) {
      return res.json({
        ok: true,
        status: 'success',
        data: {
          alreadyVerified: true,
          verifiedAt: verifiedSession.verifiedAt,
        }
      });
    }

    // Find or create session with consent
    let session = await prisma.identityVerificationSession.findFirst({
      where: {
        userId: b2cUser.id,
        status: IdentityVerificationStatus.NOT_STARTED,
        biometricConsentAt: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'Please accept consent terms first via POST /api/identity/consent',
          requestId
        }
      });
    }

    // Update session
    session = await prisma.identityVerificationSession.update({
      where: { id: session.id },
      data: {
        documentType: result.data.documentType,
        provider: 'mock', // Will be real provider in production
        status: IdentityVerificationStatus.PENDING,
      }
    });

    logger.info('Identity verification started', { 
      requestId, 
      userId: b2cUser.id,
      sessionId: session.id 
    });

    res.json({
      ok: true,
      status: 'success',
      data: {
        sessionId: session.id,
        status: session.status,
        expiresAt: session.expiresAt,
        nextStep: 'Upload selfie and document via POST /api/identity/upload',
      }
    });
  } catch (error: any) {
    logger.error('Error starting verification', { requestId, error: error.message });
    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to start verification session',
        requestId
      }
    });
  }
});

// ========================================
// POST /api/identity/upload - Upload documents
// ========================================
router.post('/upload', requireAuth, requireB2C, requireIdVerificationCountry, requireIdentityEnabled, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId || 'N/A';
  const b2cUser = (req as any).b2cUser;

  try {
    const result = uploadSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: result.error.errors,
          requestId
        }
      });
    }

    const { sessionId, selfieBase64, documentBase64 } = result.data;

    // Get session
    const session = await prisma.identityVerificationSession.findFirst({
      where: {
        id: sessionId,
        userId: b2cUser.id,
        status: IdentityVerificationStatus.PENDING,
      }
    });

    if (!session) {
      return res.status(404).json({
        ok: false,
        status: 'error',
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Verification session not found or not in pending state',
          requestId
        }
      });
    }

    // Check expiration
    if (session.expiresAt && session.expiresAt < new Date()) {
      await prisma.identityVerificationSession.update({
        where: { id: sessionId },
        data: { status: IdentityVerificationStatus.EXPIRED }
      });

      return res.status(400).json({
        ok: false,
        status: 'error',
        error: {
          code: 'SESSION_EXPIRED',
          message: 'Verification session has expired. Please start a new session.',
          requestId
        }
      });
    }

    // Save files
    const selfieFileName = generateSecureFileName(b2cUser.id, 'selfie');
    const documentFileName = generateSecureFileName(b2cUser.id, 'document');

    const selfiePath = await saveFile(selfieBase64, selfieFileName);
    const documentPath = await saveFile(documentBase64, documentFileName);

    // Update session with file paths
    await prisma.identityVerificationSession.update({
      where: { id: sessionId },
      data: {
        selfiePath,
        documentPath,
      }
    });

    // Verify with provider
    const provider = getIdentityProvider();
    const verificationResult = await provider.verify({
      selfie: selfieBase64,
      document: documentBase64,
      countryCode: b2cUser.countryCode,
    });

    // Update session with result
    const finalStatus = verificationResult.verified 
      ? IdentityVerificationStatus.VERIFIED 
      : IdentityVerificationStatus.FAILED;

    const updatedSession = await prisma.identityVerificationSession.update({
      where: { id: sessionId },
      data: {
        status: finalStatus,
        resultJson: verificationResult as any,
        failureReason: verificationResult.failureReason,
        verifiedAt: verificationResult.verified ? new Date() : null,
      }
    });

    logger.info('Identity verification completed', { 
      requestId, 
      userId: b2cUser.id,
      sessionId,
      verified: verificationResult.verified,
    });

    res.json({
      ok: true,
      status: 'success',
      data: {
        sessionId,
        status: finalStatus,
        verified: verificationResult.verified,
        confidence: verificationResult.confidence,
        failureReason: verificationResult.failureReason,
        verifiedAt: updatedSession.verifiedAt,
      }
    });
  } catch (error: any) {
    logger.error('Error uploading documents', { requestId, error: error.message });
    res.status(500).json({
      ok: false,
      status: 'error',
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to process documents',
        requestId
      }
    });
  }
});

export default router;
