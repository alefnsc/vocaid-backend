/**
 * Trial Policy Service
 *
 * Fixed policy:
 * - Trial credits are ALWAYS 5.
 * - Trial credits are NOT auto-granted.
 * - Trial credits are claimable only after phone verification.
 *
 * This module intentionally contains no promo logic and no signupRecord dependency.
 */

import { UserType } from '@prisma/client';
import { addCredits, getOrCreateWallet } from './creditsWalletService';
import { dbLogger, prisma } from './databaseService';

export const TRIAL_CREDITS_AMOUNT = 5;

export type TrialClaimEligibility =
  | 'eligible'
  | 'already_claimed'
  | 'not_personal'
  | 'email_not_verified'
  | 'phone_not_verified';

export interface TrialClaimResult {
  success: boolean;
  eligibility: TrialClaimEligibility;
  creditsGranted: number;
  ledgerEntryId?: string;
  newBalance?: number;
  error?: string;
}

export interface TrialStatus {
  trialCreditsClaimed: boolean;
  trialCreditsAmount: number;
  trialCreditsClaimedAt: Date | null;
  currentBalance: number;
  canClaim: boolean;
  blockedReason?: string;
}

async function getTrialGrantLedgerEntry(userId: string) {
  return prisma.creditLedger.findFirst({
    where: {
      userId,
      referenceType: 'trial',
      type: 'GRANT',
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getTrialStatus(userId: string): Promise<TrialStatus> {
  const [wallet, user, trialGrant] = await Promise.all([
    getOrCreateWallet(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { userType: true, emailVerified: true, phoneVerified: true },
    }),
    getTrialGrantLedgerEntry(userId),
  ]);

  if (!user) {
    return {
      trialCreditsClaimed: false,
      trialCreditsAmount: TRIAL_CREDITS_AMOUNT,
      trialCreditsClaimedAt: null,
      currentBalance: wallet.balance,
      canClaim: false,
      blockedReason: 'User not found',
    };
  }

  const alreadyClaimed = !!trialGrant;
  const isPersonal = user.userType === UserType.PERSONAL;

  let blockedReason: string | undefined;
  let canClaim = false;

  if (alreadyClaimed) {
    blockedReason = 'Trial credits already claimed';
  } else if (!isPersonal) {
    blockedReason = 'B2B accounts do not receive free trial credits';
  } else if (!user.emailVerified) {
    blockedReason = 'Email verification required for trial credits';
  } else if (!user.phoneVerified) {
    blockedReason = 'Phone verification required to claim trial credits';
  } else {
    canClaim = true;
  }

  return {
    trialCreditsClaimed: alreadyClaimed,
    trialCreditsAmount: trialGrant?.amount ?? TRIAL_CREDITS_AMOUNT,
    trialCreditsClaimedAt: trialGrant?.createdAt ?? null,
    currentBalance: wallet.balance,
    canClaim,
    blockedReason,
  };
}

export async function claimTrialCredits(userId: string): Promise<TrialClaimResult> {
  const status = await getTrialStatus(userId);

  if (status.trialCreditsClaimed) {
    return { success: true, eligibility: 'already_claimed', creditsGranted: 0 };
  }

  if (!status.canClaim) {
    const reason = status.blockedReason;
    const eligibility: TrialClaimEligibility =
      reason === 'Trial credits already claimed' ? 'already_claimed'
      : reason === 'B2B accounts do not receive free trial credits' ? 'not_personal'
      : reason === 'Email verification required for trial credits' ? 'email_not_verified'
      : reason === 'Phone verification required to claim trial credits' ? 'phone_not_verified'
      : 'not_personal';

    return {
      success: false,
      eligibility,
      creditsGranted: 0,
      error: status.blockedReason ?? 'Not eligible to claim trial credits',
    };
  }

  const idempotencyKey = `trial_claim_${userId}`;

  // Ensure wallet exists
  await getOrCreateWallet(userId);

  // Secondary check: if a claim already exists, treat as idempotent success.
  const existing = await prisma.creditLedger.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return {
      success: true,
      eligibility: 'already_claimed',
      creditsGranted: existing.amount,
      ledgerEntryId: existing.id,
      newBalance: existing.balanceAfter,
    };
  }

  dbLogger.info('Claiming trial credits', { userId, amount: TRIAL_CREDITS_AMOUNT });

  const grantResult = await addCredits(userId, {
    type: 'GRANT',
    amount: TRIAL_CREDITS_AMOUNT,
    description: `Free trial credits (${TRIAL_CREDITS_AMOUNT})`,
    referenceType: 'trial',
    referenceId: userId,
    metadata: { claimedAt: new Date().toISOString() },
    idempotencyKey,
  });

  if (!grantResult.success) {
    return {
      success: false,
      eligibility: 'eligible',
      creditsGranted: 0,
      error: grantResult.error || 'Failed to claim trial credits',
    };
  }

  return {
    success: true,
    eligibility: 'eligible',
    creditsGranted: TRIAL_CREDITS_AMOUNT,
    ledgerEntryId: grantResult.ledgerEntryId,
    newBalance: grantResult.newBalance,
  };
}

export default {
  TRIAL_CREDITS_AMOUNT,
  getTrialStatus,
  claimTrialCredits,
};

