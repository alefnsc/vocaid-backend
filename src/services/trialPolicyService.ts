/**
 * Trial Policy Service
 * 
 * Centralizes all trial credit granting logic with:
 * - Promo period handling (5 credits before Jan 15 2026, 1 after)
 * - User type restrictions (B2C personal users only)
 * - Email verification requirement
 * - Abuse prevention integration
 * - Idempotent credit granting
 * 
 * @module services/trialPolicyService
 */

import { dbLogger } from './databaseService';
import { checkSignupAbuse, SignupInfo } from './signupAbuseService';
import { performEnhancedAbuseCheck, EnhancedSignupInfo } from './enhancedAbuseService';
import { addCredits, getOrCreateWallet } from './creditsWalletService';
import { PrismaClient, UserType } from '@prisma/client';

const prisma = new PrismaClient();

// ========================================
// CONFIGURATION
// ========================================

/**
 * Open Beta promo period configuration
 * - Promo Start: Dec 28, 2025 (OPEN_BETA_START_DATE in frontend)
 * - Promo End: Jan 15, 2026 00:00:00 UTC
 */
export const PROMO_START_DATE = new Date('2025-12-28T00:00:00Z');
export const PROMO_END_DATE = new Date('2026-01-15T00:00:00Z');

/**
 * Credit amounts
 * - During promo: 5 credits
 * - After promo: 1 credit
 */
export const PROMO_TRIAL_CREDITS = 5;
export const DEFAULT_TRIAL_CREDITS = 1;

/**
 * Environment-configurable credits (can override defaults)
 */
const ENV_PROMO_CREDITS = parseInt(process.env.PROMO_TRIAL_CREDITS || String(PROMO_TRIAL_CREDITS), 10);
const ENV_DEFAULT_CREDITS = parseInt(process.env.DEFAULT_TRIAL_CREDITS || String(DEFAULT_TRIAL_CREDITS), 10);

// ========================================
// TYPES
// ========================================

export type TrialEligibility = 'eligible' | 'already_granted' | 'not_personal' | 'email_not_verified' | 'abuse_blocked';

export interface TrialPolicyInput {
  userId: string;
  clerkId: string;
  email: string;
  emailVerified: boolean;
  userType: UserType | string;
  signupInfo?: SignupInfo | EnhancedSignupInfo;
}

export interface TrialPolicyResult {
  eligibility: TrialEligibility;
  creditsToGrant: number;
  isPromoActive: boolean;
  promoEndsAt: Date;
  riskLevel: 'low' | 'medium' | 'high';
  blockedReason?: string;
}

export interface TrialGrantResult {
  success: boolean;
  creditsGranted: number;
  ledgerEntryId?: string;
  error?: string;
  eligibility: TrialEligibility;
}

export interface TrialStatus {
  trialCreditsGranted: boolean;
  trialCreditsAmount: number;
  trialCreditsGrantedAt: Date | null;
  isPromoActive: boolean;
  promoEndsAt: Date;
  currentBalance: number;
  riskLevel: 'low' | 'medium' | 'high';
}

// ========================================
// PROMO PERIOD HELPERS
// ========================================

/**
 * Check if the open beta promo is currently active
 * Promo runs from Dec 28, 2025 to Jan 15, 2026
 */
export function isPromoActive(asOf: Date = new Date()): boolean {
  return asOf >= PROMO_START_DATE && asOf < PROMO_END_DATE;
}

/**
 * Get the number of trial credits to grant based on current date
 * Returns 5 during promo period, 1 after
 */
export function getTrialCreditsAmount(asOf: Date = new Date()): number {
  return isPromoActive(asOf) ? ENV_PROMO_CREDITS : ENV_DEFAULT_CREDITS;
}

/**
 * Get days remaining in promo period
 */
export function getPromoRemainingDays(asOf: Date = new Date()): number {
  if (!isPromoActive(asOf)) {
    return 0;
  }
  const remaining = PROMO_END_DATE.getTime() - asOf.getTime();
  return Math.max(0, Math.ceil(remaining / (1000 * 60 * 60 * 24)));
}

// ========================================
// ELIGIBILITY DETERMINATION
// ========================================

/**
 * Determine if a user is eligible for trial credits and how many
 * This is a pure policy function - it does not modify any state
 * 
 * Rules:
 * 1. User type must be PERSONAL (B2C users only)
 * 2. Email must be verified (handled by Clerk)
 * 3. User must not have already received trial credits
 * 4. User must pass abuse prevention checks
 */
export async function determineTrialEligibility(
  input: TrialPolicyInput
): Promise<TrialPolicyResult> {
  const { userId, email, emailVerified, userType, signupInfo } = input;
  const now = new Date();

  dbLogger.info('Determining trial eligibility', {
    userId,
    email: email.substring(0, 3) + '***',
    userType,
    emailVerified,
    isPromoActive: isPromoActive(now)
  });

  // Rule 1: Only PERSONAL users get trial credits
  // B2B users (COMPANY_ADMIN, HR_MANAGER, etc.) must purchase
  if (userType !== 'PERSONAL' && userType !== UserType.PERSONAL) {
    dbLogger.info('Trial blocked: non-personal user type', { userId, userType });
    return {
      eligibility: 'not_personal',
      creditsToGrant: 0,
      isPromoActive: isPromoActive(now),
      promoEndsAt: PROMO_END_DATE,
      riskLevel: 'low',
      blockedReason: 'B2B accounts do not receive free trial credits'
    };
  }

  // Rule 2: Email must be verified
  if (!emailVerified) {
    dbLogger.info('Trial blocked: email not verified', { userId });
    return {
      eligibility: 'email_not_verified',
      creditsToGrant: 0,
      isPromoActive: isPromoActive(now),
      promoEndsAt: PROMO_END_DATE,
      riskLevel: 'low',
      blockedReason: 'Email verification required for trial credits'
    };
  }

  // Rule 3: Check if already granted
  const existingGrant = await prisma.creditLedger.findFirst({
    where: {
      userId,
      referenceType: 'signup',
      type: 'GRANT'
    }
  });

  if (existingGrant) {
    dbLogger.info('Trial blocked: already granted', { userId, grantId: existingGrant.id });
    return {
      eligibility: 'already_granted',
      creditsToGrant: 0,
      isPromoActive: isPromoActive(now),
      promoEndsAt: PROMO_END_DATE,
      riskLevel: 'low',
      blockedReason: 'Trial credits have already been granted'
    };
  }

  // Rule 4: Abuse prevention checks
  let riskLevel: 'low' | 'medium' | 'high' = 'low';
  let blockedReason: string | undefined;

  if (signupInfo) {
    // Try enhanced check first if we have email
    if ('email' in signupInfo && signupInfo.email) {
      const enhancedCheck = await performEnhancedAbuseCheck(signupInfo as EnhancedSignupInfo);
      
      if (!enhancedCheck.allowed) {
        dbLogger.warn('Trial blocked: abuse detected (enhanced)', {
          userId,
          riskScore: enhancedCheck.riskScore,
          reasons: enhancedCheck.suspicionReasons
        });
        return {
          eligibility: 'abuse_blocked',
          creditsToGrant: 0,
          isPromoActive: isPromoActive(now),
          promoEndsAt: PROMO_END_DATE,
          riskLevel: 'high',
          blockedReason: enhancedCheck.suspicionReasons.join('; ')
        };
      }

      // Determine risk level
      if (enhancedCheck.riskScore >= 50) {
        riskLevel = 'high';
      } else if (enhancedCheck.riskScore >= 20) {
        riskLevel = 'medium';
      }
    } else {
      // Basic abuse check
      const basicCheck = await checkSignupAbuse(signupInfo);
      
      if (!basicCheck.allowFreeCredit) {
        dbLogger.warn('Trial blocked: abuse detected (basic)', {
          userId,
          reason: basicCheck.suspicionReason
        });
        return {
          eligibility: 'abuse_blocked',
          creditsToGrant: 0,
          isPromoActive: isPromoActive(now),
          promoEndsAt: PROMO_END_DATE,
          riskLevel: 'high',
          blockedReason: basicCheck.suspicionReason
        };
      }

      if (basicCheck.isSuspicious) {
        riskLevel = 'medium';
      }
    }
  }

  // User is eligible
  const creditsToGrant = getTrialCreditsAmount(now);

  dbLogger.info('Trial eligibility confirmed', {
    userId,
    creditsToGrant,
    isPromoActive: isPromoActive(now),
    riskLevel
  });

  return {
    eligibility: 'eligible',
    creditsToGrant,
    isPromoActive: isPromoActive(now),
    promoEndsAt: PROMO_END_DATE,
    riskLevel,
    blockedReason: undefined
  };
}

// ========================================
// CREDIT GRANTING (IDEMPOTENT)
// ========================================

/**
 * Grant trial credits to a user (idempotent)
 * 
 * Uses row-level locking and idempotency key to prevent double-grants.
 * The idempotency key format is: `trial_signup_${userId}`
 * 
 * This function:
 * 1. Evaluates trial eligibility
 * 2. Creates wallet if needed
 * 3. Grants credits with audit trail
 * 4. Updates signup record
 */
export async function grantTrialCredits(
  input: TrialPolicyInput
): Promise<TrialGrantResult> {
  const { userId, clerkId, signupInfo } = input;
  const idempotencyKey = `trial_signup_${userId}`;

  dbLogger.info('Attempting to grant trial credits', { userId, clerkId });

  // First, check idempotency outside transaction
  const existingLedgerEntry = await prisma.creditLedger.findUnique({
    where: { idempotencyKey }
  });

  if (existingLedgerEntry) {
    dbLogger.info('Trial grant already processed (idempotency hit)', {
      userId,
      existingId: existingLedgerEntry.id,
      amount: existingLedgerEntry.amount
    });
    return {
      success: true,
      creditsGranted: existingLedgerEntry.amount,
      ledgerEntryId: existingLedgerEntry.id,
      eligibility: 'already_granted'
    };
  }

  // Determine eligibility
  const policy = await determineTrialEligibility(input);

  if (policy.eligibility !== 'eligible') {
    return {
      success: policy.eligibility === 'already_granted',
      creditsGranted: 0,
      eligibility: policy.eligibility,
      error: policy.blockedReason
    };
  }

  // Grant credits using creditsWalletService (handles transactions)
  const grantResult = await addCredits(userId, {
    type: 'GRANT',
    amount: policy.creditsToGrant,
    description: policy.isPromoActive 
      ? `Open Beta trial credits (${policy.creditsToGrant})` 
      : `Free trial credit (${policy.creditsToGrant})`,
    referenceType: 'signup',
    referenceId: clerkId,
    metadata: {
      isPromoActive: policy.isPromoActive,
      promoEndsAt: policy.promoEndsAt.toISOString(),
      riskLevel: policy.riskLevel,
      grantedAt: new Date().toISOString()
    },
    idempotencyKey
  });

  if (!grantResult.success) {
    dbLogger.error('Failed to grant trial credits', {
      userId,
      error: grantResult.error
    });
    return {
      success: false,
      creditsGranted: 0,
      eligibility: 'eligible',
      error: grantResult.error
    };
  }

  // Update signup record with grant info
  if (signupInfo) {
    await prisma.signupRecord.upsert({
      where: { userId },
      create: {
        userId,
        ipAddress: signupInfo.ipAddress,
        deviceFingerprint: signupInfo.deviceFingerprint,
        userAgent: signupInfo.userAgent,
        freeCreditGranted: true,
        creditTier: policy.riskLevel === 'high' ? 'throttled' : 'full'
      },
      update: {
        freeCreditGranted: true,
        creditTier: policy.riskLevel === 'high' ? 'throttled' : 'full'
      }
    }).catch(err => {
      // Non-critical - log but don't fail
      dbLogger.warn('Failed to update signup record', { userId, error: err.message });
    });
  }

  dbLogger.info('Trial credits granted successfully', {
    userId,
    creditsGranted: policy.creditsToGrant,
    ledgerEntryId: grantResult.ledgerEntryId,
    isPromoActive: policy.isPromoActive
  });

  return {
    success: true,
    creditsGranted: policy.creditsToGrant,
    ledgerEntryId: grantResult.ledgerEntryId,
    eligibility: 'eligible'
  };
}

// ========================================
// STATUS RETRIEVAL
// ========================================

/**
 * Get trial status for a user
 * Used by GET /api/me/trial-status endpoint
 */
export async function getTrialStatus(userId: string): Promise<TrialStatus> {
  const now = new Date();

  // Get trial grant from ledger
  const trialGrant = await prisma.creditLedger.findFirst({
    where: {
      userId,
      referenceType: 'signup',
      type: 'GRANT'
    },
    orderBy: { createdAt: 'asc' }
  });

  // Get current balance
  const wallet = await getOrCreateWallet(userId);

  // Get signup record for risk level
  const signupRecord = await prisma.signupRecord.findUnique({
    where: { userId }
  });

  let riskLevel: 'low' | 'medium' | 'high' = 'low';
  if (signupRecord) {
    if (signupRecord.isSuspicious) {
      riskLevel = 'high';
    } else if (signupRecord.creditTier === 'throttled') {
      riskLevel = 'medium';
    }
  }

  return {
    trialCreditsGranted: !!trialGrant,
    trialCreditsAmount: trialGrant?.amount || 0,
    trialCreditsGrantedAt: trialGrant?.createdAt || null,
    isPromoActive: isPromoActive(now),
    promoEndsAt: PROMO_END_DATE,
    currentBalance: wallet.balance,
    riskLevel
  };
}

// ========================================
// ADMIN UTILITIES
// ========================================

/**
 * Get trial grant statistics for admin dashboard
 */
export async function getTrialGrantStats(): Promise<{
  totalTrialGrants: number;
  promoGrants: number;
  standardGrants: number;
  blockedGrants: number;
  creditsGrantedTotal: number;
}> {
  const trialGrants = await prisma.creditLedger.findMany({
    where: {
      referenceType: 'signup',
      type: 'GRANT'
    },
    select: {
      amount: true,
      metadata: true,
      createdAt: true
    }
  });

  const blockedSignups = await prisma.signupRecord.count({
    where: {
      freeCreditGranted: false,
      isSuspicious: true
    }
  });

  let promoGrants = 0;
  let standardGrants = 0;
  let creditsGrantedTotal = 0;

  for (const grant of trialGrants) {
    creditsGrantedTotal += grant.amount;
    
    // Check if it was a promo grant
    const metadata = grant.metadata as Record<string, any> | null;
    if (metadata?.isPromoActive === true) {
      promoGrants++;
    } else {
      standardGrants++;
    }
  }

  return {
    totalTrialGrants: trialGrants.length,
    promoGrants,
    standardGrants,
    blockedGrants: blockedSignups,
    creditsGrantedTotal
  };
}

// ========================================
// EXPORTS
// ========================================

export default {
  // Config
  PROMO_START_DATE,
  PROMO_END_DATE,
  PROMO_TRIAL_CREDITS,
  DEFAULT_TRIAL_CREDITS,
  
  // Helpers
  isPromoActive,
  getTrialCreditsAmount,
  getPromoRemainingDays,
  
  // Core functions
  determineTrialEligibility,
  grantTrialCredits,
  getTrialStatus,
  
  // Admin
  getTrialGrantStats
};
