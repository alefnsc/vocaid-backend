/**
 * Consent Service
 * 
 * Handles user consent management for Terms of Use, Privacy Policy,
 * and communication preferences. Provides audit-ready consent tracking.
 */

import { PrismaClient, ConsentSource, UserConsent } from '@prisma/client';
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  MARKETING_CONSENT_VERSION,
  getConsentRequirements,
  isConsentVersionCurrent,
} from '../constants/consentVersions';
import logger from '../utils/logger';

const prisma = new PrismaClient();

// Logger instance for consent service
const consentLogger = logger.child({ service: 'consent' });

// ========================================
// TYPES
// ========================================

export interface ConsentStatus {
  hasRequiredConsents: boolean;
  marketingOptIn: boolean;
  transactionalOptIn: boolean;
  versionsAccepted: {
    terms: string | null;
    privacy: string | null;
    marketing: string | null;
  };
  needsReConsent: boolean;
  consentRecordedAt: Date | null;
}

export interface SubmitConsentParams {
  userId: string;
  acceptTerms: boolean;
  acceptPrivacy: boolean;
  marketingOptIn: boolean;
  source?: ConsentSource;
  ipAddress?: string;
  userAgent?: string;
}

export interface ConsentSubmitResult {
  success: boolean;
  hasRequiredConsents: boolean;
  marketingOptIn: boolean;
  onboardingCompletedAt: Date | null;
}

// ========================================
// GET CONSENT STATUS
// ========================================

/**
 * Get the current consent status for a user
 * Returns whether they have required consents and their preferences
 */
export async function getConsentStatus(userId: string): Promise<ConsentStatus> {
  try {
    // Find user by id (first-party auth uses UUID)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userConsent: true },
    });

    if (!user) {
      consentLogger.debug('User not found for consent check', { userId });
      return {
        hasRequiredConsents: false,
        marketingOptIn: false,
        transactionalOptIn: true, // Default
        versionsAccepted: { terms: null, privacy: null, marketing: null },
        needsReConsent: false,
        consentRecordedAt: null,
      };
    }

    const consent = user.userConsent;

    if (!consent) {
      return {
        hasRequiredConsents: false,
        marketingOptIn: false,
        transactionalOptIn: true,
        versionsAccepted: { terms: null, privacy: null, marketing: null },
        needsReConsent: false,
        consentRecordedAt: null,
      };
    }

    // Check if user needs to re-consent due to version changes
    const needsReConsent = !isConsentVersionCurrent(
      consent.termsVersion,
      consent.privacyVersion
    );

    const hasRequiredConsents =
      consent.termsAcceptedAt !== null &&
      consent.privacyAcceptedAt !== null &&
      !needsReConsent;

    return {
      hasRequiredConsents,
      marketingOptIn: consent.marketingOptIn,
      transactionalOptIn: consent.transactionalOptIn,
      versionsAccepted: {
        terms: consent.termsVersion,
        privacy: consent.privacyVersion,
        marketing: consent.marketingVersion,
      },
      needsReConsent,
      consentRecordedAt: consent.createdAt,
    };
  } catch (error) {
    consentLogger.error('Error getting consent status', { userId, error });
    throw error;
  }
}

// ========================================
// SUBMIT CONSENT
// ========================================

/**
 * Submit user consent for Terms, Privacy, and communications
 * Creates or updates consent record with audit metadata
 */
export async function submitConsent(params: SubmitConsentParams): Promise<ConsentSubmitResult> {
  const {
    userId,
    acceptTerms,
    acceptPrivacy,
    marketingOptIn,
    source = ConsentSource.FORM,
    ipAddress,
    userAgent,
  } = params;

  try {
    // Validate required consents
    if (!acceptTerms || !acceptPrivacy) {
      consentLogger.warn('Required consents not accepted', { userId, acceptTerms, acceptPrivacy });
      return {
        success: false,
        hasRequiredConsents: false,
        marketingOptIn: false,
        onboardingCompletedAt: null,
      };
    }

    // Find user by id (first-party auth uses UUID)
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      consentLogger.error('User not found for consent submission', { userId });
      throw new Error('User not found');
    }

    const now = new Date();

    // Upsert consent record
    const consent = await prisma.userConsent.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        transactionalOptIn: true, // Always true - essential emails
        marketingOptIn,
        marketingOptInAt: marketingOptIn ? now : null,
        marketingVersion: marketingOptIn ? MARKETING_CONSENT_VERSION : null,
        ipAddress,
        userAgent,
        source,
      },
      update: {
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        marketingOptIn,
        marketingOptInAt: marketingOptIn ? now : null,
        marketingVersion: marketingOptIn ? MARKETING_CONSENT_VERSION : null,
        ipAddress,
        userAgent,
        source,
      },
    });

    // Update user's onboardingCompletedAt
    await prisma.user.update({
      where: { id: user.id },
      data: {
        onboardingComplete: true,
        onboardingCompletedAt: now,
      },
    });

    // The database (User.onboardingComplete, UserConsent) is the single source of truth.

    consentLogger.info('Consent submitted successfully', {
      userId,
      source,
      marketingOptIn,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });

    return {
      success: true,
      hasRequiredConsents: true,
      marketingOptIn: consent.marketingOptIn,
      onboardingCompletedAt: now,
    };
  } catch (error) {
    consentLogger.error('Error submitting consent', { userId, error });
    throw error;
  }
}

// ========================================
// CHECK CONSENT FOR GATING
// ========================================

/**
 * Check if a user has completed required consents
 * Used by middleware to gate access to protected endpoints
 */
export async function hasRequiredConsents(userId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { onboardingCompletedAt: true, userConsent: true },
    });

    if (!user || !user.onboardingCompletedAt) {
      return false;
    }

    // Also verify consent versions are current
    if (user.userConsent) {
      return isConsentVersionCurrent(
        user.userConsent.termsVersion,
        user.userConsent.privacyVersion
      );
    }

    return false;
  } catch (error) {
    consentLogger.error('Error checking required consents', { userId, error });
    return false;
  }
}

// ========================================
// GET CONSENT REQUIREMENTS (PUBLIC)
// ========================================

/**
 * Get current consent requirements configuration
 * Public endpoint - no auth required
 */
export function getRequirements() {
  return getConsentRequirements();
}

// ========================================
// UPDATE MARKETING PREFERENCE
// ========================================

/**
 * Update just the marketing preference
 * Can be called from settings page
 */
export async function updateMarketingPreference(
  userId: string,
  marketingOptIn: boolean
): Promise<{ success: boolean; marketingOptIn: boolean }> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userConsent: true },
    });

    if (!user || !user.userConsent) {
      throw new Error('User or consent record not found');
    }

    const now = new Date();

    await prisma.userConsent.update({
      where: { userId: user.id },
      data: {
        marketingOptIn,
        marketingOptInAt: marketingOptIn ? now : null,
        marketingVersion: marketingOptIn ? MARKETING_CONSENT_VERSION : null,
      },
    });

    consentLogger.info('Marketing preference updated', { userId, marketingOptIn });

    return { success: true, marketingOptIn };
  } catch (error) {
    consentLogger.error('Error updating marketing preference', { userId, error });
    throw error;
  }
}

// ========================================
// EMAIL CONSENT CHECKS
// For use by EmailService to gate email sending
// ========================================

/**
 * Check if transactional emails can be sent to a user
 * Transactional emails (receipts, security) require Terms + Privacy acceptance
 * Returns true for new users who haven't consented yet (essential account notifications)
 * 
 * @param userId - User's database ID (UUID)
 */
export async function canSendTransactional(userId: string): Promise<boolean> {
  // Transactional emails are essential (receipts, account/security) and must always be allowed.
  // Keep this fail-open by design.
  return true;
}

/**
 * Check if marketing emails can be sent to a user
 * Marketing emails require explicit opt-in
 * 
 * @param userId - User's database ID (UUID)
 */
export async function canSendMarketing(userId: string): Promise<boolean> {
  try {
    // Find user by id (first-party auth uses UUID)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userConsent: true },
    });

    if (!user || !user.userConsent) {
      // No user or no consent = no marketing
      return false;
    }

    return user.userConsent.marketingOptIn === true;
  } catch (error) {
    consentLogger.error('Error checking marketing consent', { userId, error });
    // Fail closed for marketing
    return false;
  }
}

/**
 * Get consent preferences for a user by email
 * Used when we only have email address (e.g., from payment webhook)
 */
export async function getConsentByEmail(email: string): Promise<{
  canSendTransactional: boolean;
  canSendMarketing: boolean;
  userId: string | null;
}> {
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { userConsent: true },
    });

    if (!user) {
      return {
        canSendTransactional: false,
        canSendMarketing: false,
        userId: null,
      };
    }

    return {
      canSendTransactional: true,
      canSendMarketing: user.userConsent?.marketingOptIn ?? false,
      userId: user.id,
    };
  } catch (error) {
    consentLogger.error('Error getting consent by email', { email, error });
    return {
      canSendTransactional: false,
      canSendMarketing: false,
      userId: null,
    };
  }
}
