/**
 * LinkedIn Profile Routes
 * 
 * API endpoints for LinkedIn profile management with raw sections payload.
 * Separate from ResumeDocument - LinkedIn profiles have their own scoring.
 * 
 * Routes:
 * - GET /api/linkedin-profile - Get user's LinkedIn profile + consent state
 * - PUT /api/linkedin-profile - Create/update profile (requires confirmOverwrite for updates)
 * - POST /api/linkedin-profile/connect - Try OIDC connect, return partial data for form prefill
 * - POST /api/linkedin-profile/score - Score profile for a specific role
 * 
 * @module routes/linkedinProfileRoutes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PrismaClient, ResumeScoreProvider } from '@prisma/client';
import logger from '../utils/logger';
import * as linkedInService from '../services/linkedInService';
import { scoreLinkedInProfile, RawSections } from '../services/linkedinProfileScoringService';
import { requireSession } from '../middleware/sessionAuthMiddleware';
import { hasRequiredConsents } from '../services/consentService';

const router = Router();
const prisma = new PrismaClient();
const linkedinLogger = logger.child({ component: 'linkedin-profile-routes' });

// ========================================
// CONSTANTS
// ========================================

const FRONTEND_URL = process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://vocaid.io' : 'http://localhost:3000');

// Canonical Resume Library path (requested)
const RESUME_LIBRARY_PATH = '/app/b2c/resume-library';

// In-memory OAuth state store (per-user, TTL). In production, use Redis.
const linkedInConnectStates = new Map<string, { state: string; expiresAt: number }>();

function cleanupExpiredLinkedInStates() {
  const now = Date.now();
  for (const [userId, entry] of linkedInConnectStates.entries()) {
    if (entry.expiresAt <= now) linkedInConnectStates.delete(userId);
  }
}

async function requireAppConsent(req: Request, res: Response, next: NextFunction) {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  }

  try {
    const ok = await hasRequiredConsents(userId);
    if (!ok) {
      return res.status(403).json({
        status: 'error',
        code: 'CONSENT_REQUIRED',
        message: 'Consent required before accessing this resource',
        redirectTo: '/onboarding/consent',
      });
    }

    return next();
  } catch (error: any) {
    linkedinLogger.error('Consent check failed', { error: error.message });
    return res.status(500).json({
      status: 'error',
      code: 'CONSENT_CHECK_FAILED',
      message: 'Failed to check consent status',
    });
  }
}

// ========================================
// VALIDATION SCHEMAS
// ========================================

// Raw sections schema - captures all available LinkedIn content
const rawSectionsSchema = z.object({
  about: z.string().max(5000).optional(),
  experience: z.array(z.object({
    title: z.string().max(255),
    company: z.string().max(255),
    location: z.string().max(255).optional(),
    startDate: z.string().max(50).optional(),
    endDate: z.string().max(50).optional(),
    current: z.boolean().optional(),
    description: z.string().max(5000).optional()
  })).max(50).optional(),
  education: z.array(z.object({
    school: z.string().max(255),
    degree: z.string().max(255).optional(),
    field: z.string().max(255).optional(),
    startDate: z.string().max(50).optional(),
    endDate: z.string().max(50).optional(),
    description: z.string().max(2000).optional()
  })).max(20).optional(),
  certifications: z.array(z.object({
    name: z.string().max(255),
    issuer: z.string().max(255).optional(),
    issueDate: z.string().max(50).optional(),
    expirationDate: z.string().max(50).optional(),
    credentialId: z.string().max(255).optional(),
    credentialUrl: z.string().max(500).optional()
  })).max(50).optional(),
  skills: z.array(z.string().max(100)).max(100).optional(),
  languages: z.array(z.object({
    name: z.string().max(100),
    proficiency: z.string().max(50).optional()
  })).max(20).optional()
});

const updateProfileSchema = z.object({
  // Basic info
  name: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
  headline: z.string().max(500).optional(),
  profileUrl: z.string().url().max(500).optional(),
  
  // Raw sections payload
  rawSections: rawSectionsSchema.optional(),
  
  // Source indicator
  source: z.enum(['OIDC', 'FORM', 'HYBRID']).optional(),
  
  // Consent fields (required for first save)
  consentVersion: z.string().max(20).optional(),
  sectionsConsented: z.array(z.string().max(50)).optional()
});

const scoreProfileSchema = z.object({
  roleKey: z.string().min(1).max(100),
  forceRefresh: z.boolean().optional()
});

// ========================================
// ROUTES
// ========================================

/**
 * GET /api/linkedin-profile
 * Get user's LinkedIn profile and consent state
 */
router.get('/', requireSession, async (req: Request, res: Response) => {
  // Must have completed Terms/Privacy consent before using this feature
  const consent = await hasRequiredConsents(req.userId!);
  if (!consent) {
    return res.status(403).json({
      status: 'error',
      code: 'CONSENT_REQUIRED',
      message: 'Consent required before accessing this resource',
      redirectTo: '/onboarding/consent',
    });
  }
  
  
  try {
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    // Get profile and consent in parallel
    const [profile, consent] = await Promise.all([
      prisma.linkedInProfile.findUnique({
        where: { userId },
        include: {
          profileScores: {
            orderBy: { computedAt: 'desc' }
          }
        }
      }),
      prisma.userConsent.findUnique({
        where: { userId },
        select: {
          linkedinConsentAt: true,
          linkedinConsentVersion: true,
          linkedinSectionsConsented: true,
          linkedinConnectedAt: true,
          linkedinMemberId: true
        }
      })
    ]);
    
    linkedinLogger.info('LinkedIn profile fetched', {
      userId: userId?.slice(0, 12),
      hasProfile: !!profile,
      hasConsent: !!consent?.linkedinConsentAt
    });
    
    return res.json({
      status: 'success',
      data: {
        profile: profile ? {
          id: profile.id,
          linkedinMemberId: profile.linkedinMemberId,
          profileUrl: profile.profileUrl,
          name: profile.name,
          email: profile.email,
          pictureUrl: profile.pictureUrl,
          headline: profile.headline,
          rawSections: profile.rawSections,
          source: profile.source,
          scores: profile.profileScores.map(s => ({
            roleKey: s.roleKey,
            score: s.score,
            provider: s.provider,
            breakdown: s.breakdown,
            computedAt: s.computedAt
          })),
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt
        } : null,
        consent: consent ? {
          consentedAt: consent.linkedinConsentAt,
          consentVersion: consent.linkedinConsentVersion,
          sectionsConsented: consent.linkedinSectionsConsented,
          connectedAt: consent.linkedinConnectedAt,
          memberId: consent.linkedinMemberId
        } : null
      }
    });
  } catch (error: any) {
    linkedinLogger.error('Failed to fetch LinkedIn profile', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch LinkedIn profile'
    });
  }
});

/**
 * PUT /api/linkedin-profile
 * Create or update LinkedIn profile with raw sections
 * Requires confirmOverwrite=true query param for updates (irreversible)
 */
router.put('/', requireSession, async (req: Request, res: Response) => {

  // Must have completed Terms/Privacy consent before using this feature
  const consent = await hasRequiredConsents(req.userId!);
  if (!consent) {
    return res.status(403).json({
      status: 'error',
      code: 'CONSENT_REQUIRED',
      message: 'Consent required before accessing this resource',
      redirectTo: '/onboarding/consent',
    });
  }
  
  const confirmOverwrite = req.query.confirmOverwrite === 'true';
  
  try {
    const parseResult = updateProfileSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request data',
        errors: parseResult.error.errors
      });
    }
    
    const { 
      name, email, headline, profileUrl, rawSections, source,
      consentVersion, sectionsConsented
    } = parseResult.data;
    
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    // Check if profile already exists
    const existingProfile = await prisma.linkedInProfile.findUnique({
      where: { userId }
    });
    
    // Require confirmOverwrite for updates
    if (existingProfile && !confirmOverwrite) {
      return res.status(409).json({
        status: 'error',
        code: 'OVERWRITE_REQUIRED',
        message: 'Profile already exists. This action will permanently replace your existing LinkedIn profile data. Set confirmOverwrite=true to proceed.'
      });
    }
    
    // Check/update consent
    const existingConsent = await prisma.userConsent.findUnique({
      where: { userId }
    });
    
    // For first-time save, require consent
    if (!existingProfile && !existingConsent?.linkedinConsentAt && !consentVersion) {
      return res.status(400).json({
        status: 'error',
        code: 'CONSENT_REQUIRED',
        message: 'LinkedIn integration consent is required. Please provide consentVersion and sectionsConsented.'
      });
    }
    
    // Transaction: update consent + upsert profile + clear stale scores
    const result = await prisma.$transaction(async (tx) => {
      // Update consent if new consent provided
      if (consentVersion || sectionsConsented) {
        await tx.userConsent.upsert({
          where: { userId },
          create: {
            userId,
            termsAcceptedAt: new Date(),
            privacyAcceptedAt: new Date(),
            termsVersion: '1.0',
            privacyVersion: '1.0',
            linkedinConsentAt: new Date(),
            linkedinConsentVersion: consentVersion || '1.0',
            linkedinSectionsConsented: sectionsConsented || []
          },
          update: {
            linkedinConsentAt: new Date(),
            linkedinConsentVersion: consentVersion,
            linkedinSectionsConsented: sectionsConsented
          }
        });
      }
      
      // Clear existing scores on overwrite (data changed, scores are stale)
      if (existingProfile) {
        await tx.linkedInProfileScore.deleteMany({
          where: { profileId: existingProfile.id }
        });
      }
      
      // Upsert profile
      const profile = await tx.linkedInProfile.upsert({
        where: { userId },
        create: {
          userId,
          name,
          email,
          headline,
          profileUrl,
          rawSections: rawSections || {},
          source: source || 'FORM'
        },
        update: {
          name,
          email,
          headline,
          profileUrl,
          rawSections: rawSections || {},
          source: source || (existingProfile?.source as string) || 'FORM',
          updatedAt: new Date()
        }
      });
      
      return profile;
    });
    
    linkedinLogger.info('LinkedIn profile saved', {
      userId: userId?.slice(0, 12),
      profileId: result.id.slice(0, 8),
      isUpdate: !!existingProfile,
      source: result.source
    });
    
    return res.json({
      status: 'success',
      data: {
        id: result.id,
        name: result.name,
        email: result.email,
        headline: result.headline,
        source: result.source,
        updatedAt: result.updatedAt
      }
    });
  } catch (error: any) {
    linkedinLogger.error('Failed to save LinkedIn profile', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to save LinkedIn profile'
    });
  }
});

/**
 * POST /api/linkedin-profile/connect
 * Try OIDC connect to get basic profile data
 * Returns partial data for form prefill; if fails or insufficient, client shows form
 */
router.post('/connect', requireSession, async (req: Request, res: Response) => {

  // Must have completed Terms/Privacy consent before starting OAuth connect
  const consent = await hasRequiredConsents(req.userId!);
  if (!consent) {
    return res.status(403).json({
      status: 'error',
      code: 'CONSENT_REQUIRED',
      message: 'Consent required before connecting LinkedIn',
      redirectTo: '/onboarding/consent',
    });
  }
  
  
  try {
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    // Check if LinkedIn OIDC is configured
    if (!linkedInService.isLinkedInConfigured()) {
      linkedinLogger.info('LinkedIn OIDC not configured, falling back to form', {
        userId: userId?.slice(0, 12)
      });
      
      return res.json({
        status: 'success',
        data: {
          connected: false,
          fallbackRequired: true,
          reason: 'LinkedIn integration not configured',
          partialData: null
        }
      });
    }
    
    // Generate auth URL for client to redirect
    const state = linkedInService.generateStateToken();
    const authUrl = linkedInService.getLinkedInAuthUrl(state);

    cleanupExpiredLinkedInStates();
    linkedInConnectStates.set(userId, {
      state,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });
    
    return res.json({
      status: 'success',
      data: {
        connected: false,
        authUrl,
        state,
        fallbackRequired: false,
        reason: 'Redirect user to authUrl for LinkedIn authorization'
      }
    });
  } catch (error: any) {
    linkedinLogger.error('LinkedIn connect failed', { error: error.message });
    
    // On any error, indicate fallback to form
    return res.json({
      status: 'success',
      data: {
        connected: false,
        fallbackRequired: true,
        reason: error.message || 'LinkedIn connection failed',
        partialData: null
      }
    });
  }
});

/**
 * GET /api/linkedin-profile/callback
 * Provider redirect callback for LinkedIn Profile Connect.
 * 
 * LinkedIn redirects the user-agent to this endpoint with query params.
 * We translate this into our existing session-based flow and redirect
 * the user back to the Resume Library UI.
 */
router.get('/callback', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { code, state, error, error_description } = req.query;

  // If user cancelled/denied, redirect back to resume library with a stable error code
  if (error) {
    linkedinLogger.warn('LinkedIn profile connect denied/cancelled', {
      userId: userId.slice(0, 12),
      error,
      error_description,
    });
    cleanupExpiredLinkedInStates();
    linkedInConnectStates.delete(userId);
    return res.redirect(`${FRONTEND_URL}${RESUME_LIBRARY_PATH}?linkedinConnect=cancelled`);
  }

  if (!code || typeof code !== 'string') {
    cleanupExpiredLinkedInStates();
    linkedInConnectStates.delete(userId);
    return res.redirect(`${FRONTEND_URL}${RESUME_LIBRARY_PATH}?linkedinConnect=failed`);
  }

  // Must have completed Terms/Privacy consent before exchanging code
  try {
    const consent = await hasRequiredConsents(userId);
    if (!consent) {
      cleanupExpiredLinkedInStates();
      linkedInConnectStates.delete(userId);
      return res.redirect(`${FRONTEND_URL}/onboarding/consent`);
    }
  } catch (e: any) {
    linkedinLogger.error('Consent check failed on LinkedIn callback', { error: e?.message });
    cleanupExpiredLinkedInStates();
    linkedInConnectStates.delete(userId);
    return res.redirect(`${FRONTEND_URL}${RESUME_LIBRARY_PATH}?linkedinConnect=failed`);
  }

  // Validate state token
  cleanupExpiredLinkedInStates();
  const expected = linkedInConnectStates.get(userId);
  if (expected?.state) {
    if (!state || typeof state !== 'string' || state !== expected.state) {
      linkedInConnectStates.delete(userId);
      return res.redirect(`${FRONTEND_URL}${RESUME_LIBRARY_PATH}?linkedinConnect=failed`);
    }
    linkedInConnectStates.delete(userId);
  }

  // Exchange code and update connection metadata (OIDC gives partial data)
  try {
    const profileData = await linkedInService.completeOAuthFlow(code);
    if (!profileData) {
      return res.redirect(`${FRONTEND_URL}${RESUME_LIBRARY_PATH}?linkedinConnect=failed`);
    }

    await prisma.userConsent.update({
      where: { userId },
      data: {
        linkedinConnectedAt: new Date(),
        linkedinMemberId: profileData.linkedInId,
      },
    });

    return res.redirect(`${FRONTEND_URL}${RESUME_LIBRARY_PATH}?linkedinConnect=success`);
  } catch (e: any) {
    linkedinLogger.error('LinkedIn profile connect callback failed', { error: e?.message });
    return res.redirect(`${FRONTEND_URL}${RESUME_LIBRARY_PATH}?linkedinConnect=failed`);
  }
});

/**
 * POST /api/linkedin-profile/callback
 * Handle OAuth callback, fetch userinfo, update consent
 */
router.post('/callback', requireSession, async (req: Request, res: Response) => {
  
  const { code, state } = req.body;
  
  if (!code) {
    return res.status(400).json({
      status: 'error',
      message: 'Authorization code is required'
    });
  }
  
  try {
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    // Must have completed Terms/Privacy consent before exchanging code
    const consent = await hasRequiredConsents(userId);
    if (!consent) {
      return res.status(403).json({
        status: 'error',
        code: 'CONSENT_REQUIRED',
        message: 'Consent required before connecting LinkedIn',
        redirectTo: '/onboarding/consent',
      });
    }

    // Validate state token if provided
    cleanupExpiredLinkedInStates();
    const expected = linkedInConnectStates.get(userId);
    if (expected?.state) {
      if (!state || typeof state !== 'string' || state !== expected.state) {
        linkedInConnectStates.delete(userId);
        return res.status(400).json({
          status: 'error',
          code: 'INVALID_STATE',
          message: 'Invalid or expired OAuth state. Please try again.',
        });
      }
      linkedInConnectStates.delete(userId);
    }

    // Complete OAuth flow
    const profileData = await linkedInService.completeOAuthFlow(code);
    
    if (!profileData) {
      return res.json({
        status: 'success',
        data: {
          connected: false,
          fallbackRequired: true,
          reason: 'Failed to fetch LinkedIn profile data',
          partialData: null
        }
      });
    }
    
    // Update consent record with connection info (do NOT create Terms/Privacy consent here)
    await prisma.userConsent.update({
      where: { userId },
      data: {
        linkedinConnectedAt: new Date(),
        linkedinMemberId: profileData.linkedInId,
      },
    });
    
    linkedinLogger.info('LinkedIn OAuth completed', {
      userId: userId?.slice(0, 12),
      linkedInId: profileData.linkedInId?.slice(0, 8)
    });
    
    // Return partial data - OIDC only provides basic info
    // Client should show form to collect remaining sections
    return res.json({
      status: 'success',
      data: {
        connected: true,
        fallbackRequired: true, // Still need form for Experience/Education/etc
        reason: 'LinkedIn connected but additional sections require manual entry',
        partialData: {
          linkedinMemberId: profileData.linkedInId,
          name: profileData.name,
          email: profileData.email,
          pictureUrl: profileData.pictureUrl,
          profileUrl: profileData.profileUrl,
          headline: profileData.headline
        }
      }
    });
  } catch (error: any) {
    linkedinLogger.error('LinkedIn callback failed', { error: error.message });
    return res.json({
      status: 'success',
      data: {
        connected: false,
        fallbackRequired: true,
        reason: error.message || 'LinkedIn callback processing failed',
        partialData: null
      }
    });
  }
});

/**
 * POST /api/linkedin-profile/score
 * Score LinkedIn profile for a specific role
 */
router.post('/score', requireSession, async (req: Request, res: Response) => {

  // Must have completed Terms/Privacy consent before using this feature
  const consent = await hasRequiredConsents(req.userId!);
  if (!consent) {
    return res.status(403).json({
      status: 'error',
      code: 'CONSENT_REQUIRED',
      message: 'Consent required before accessing this resource',
      redirectTo: '/onboarding/consent',
    });
  }
  
  
  try {
    const parseResult = scoreProfileSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request data',
        errors: parseResult.error.errors
      });
    }
    
    const { roleKey, forceRefresh } = parseResult.data;
    
    const userId = req.userId!; // Non-null: requireSession ensures userId exists
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    // Get profile
    const profile = await prisma.linkedInProfile.findUnique({
      where: { userId }
    });
    
    if (!profile) {
      return res.status(404).json({
        status: 'error',
        message: 'LinkedIn profile not found. Please connect or create your profile first.'
      });
    }
    
    // Check for existing score
    if (!forceRefresh) {
      const existingScore = await prisma.linkedInProfileScore.findFirst({
        where: {
          profileId: profile.id,
          roleKey,
          // Score is fresh if computed within last 24 hours
          computedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }
      });
      
      if (existingScore) {
        return res.json({
          status: 'success',
          data: {
            roleKey: existingScore.roleKey,
            score: existingScore.score,
            provider: existingScore.provider,
            breakdown: existingScore.breakdown,
            computedAt: existingScore.computedAt,
            cached: true
          }
        });
      }
    }
    
    // Compute new score
    // Cast profile to LinkedInProfileData for scoring function
    const profileForScoring = {
      ...profile,
      rawSections: profile.rawSections as RawSections | null
    };
    const scoreResult = await scoreLinkedInProfile(profileForScoring, roleKey);
    
    // Upsert score
    const savedScore = await prisma.linkedInProfileScore.upsert({
      where: {
        profileId_roleKey_provider: {
          profileId: profile.id,
          roleKey,
          provider: scoreResult.provider as ResumeScoreProvider
        }
      },
      create: {
        profileId: profile.id,
        roleKey,
        score: scoreResult.score,
        provider: scoreResult.provider as ResumeScoreProvider,
        breakdown: scoreResult.breakdown as object
      },
      update: {
        score: scoreResult.score,
        breakdown: scoreResult.breakdown as object,
        computedAt: new Date()
      }
    });
    
    linkedinLogger.info('LinkedIn profile scored', {
      userId: userId?.slice(0, 12),
      profileId: profile.id.slice(0, 8),
      roleKey,
      score: savedScore.score
    });
    
    return res.json({
      status: 'success',
      data: {
        roleKey: savedScore.roleKey,
        score: savedScore.score,
        provider: savedScore.provider,
        breakdown: savedScore.breakdown,
        computedAt: savedScore.computedAt,
        cached: false
      }
    });
  } catch (error: any) {
    linkedinLogger.error('Failed to score LinkedIn profile', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to score LinkedIn profile'
    });
  }
});

export default router;
