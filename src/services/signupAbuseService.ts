/**
 * Signup Abuse Prevention Service
 * Prevents users from creating multiple accounts to claim free credits
 * 
 * Features:
 * - IP address tracking
 * - Device fingerprint tracking
 * - Suspicious activity flagging
 */

import { dbLogger } from './databaseService';

// Configuration: How many accounts from same IP/fingerprint before blocking free credits
const MAX_ACCOUNTS_PER_IP = parseInt(process.env.MAX_ACCOUNTS_PER_IP || '2', 10);
const MAX_ACCOUNTS_PER_FINGERPRINT = parseInt(process.env.MAX_ACCOUNTS_PER_FINGERPRINT || '1', 10);

export interface SignupInfo {
  ipAddress?: string;
  deviceFingerprint?: string;
  userAgent?: string;
}

export interface AbuseCheckResult {
  allowFreeCredit: boolean;
  isSuspicious: boolean;
  suspicionReason?: string;
  existingAccountsFromIP: number;
  existingAccountsFromFingerprint: number;
}

type SignupRecord = {
  userId: string;
  ipAddress?: string;
  deviceFingerprint?: string;
  userAgent?: string;
  freeCreditGranted: boolean;
  isSuspicious: boolean;
  suspicionReason?: string;
  reviewedAt?: Date | null;
  createdAt: Date;
};

const recordsByUserId = new Map<string, SignupRecord>();

/**
 * Check if a new signup should receive free credits
 * Based on IP and device fingerprint analysis
 */
export async function checkSignupAbuse(signupInfo: SignupInfo): Promise<AbuseCheckResult> {
  const { ipAddress, deviceFingerprint } = signupInfo;
  
  let existingAccountsFromIP = 0;
  let existingAccountsFromFingerprint = 0;
  let isSuspicious = false;
  let suspicionReason: string | undefined;

  // Check accounts from same IP
  if (ipAddress) {
    existingAccountsFromIP = Array.from(recordsByUserId.values()).filter(
      (r) => r.ipAddress === ipAddress && r.freeCreditGranted
    ).length;

    if (existingAccountsFromIP >= MAX_ACCOUNTS_PER_IP) {
      isSuspicious = true;
      suspicionReason = `Multiple accounts (${existingAccountsFromIP}) from same IP address`;
      dbLogger.warn('Suspicious signup: multiple accounts from same IP', {
        ipAddress: ipAddress.substring(0, 10) + '...',
        existingAccounts: existingAccountsFromIP
      });
    }
  }

  // Check accounts from same device fingerprint (more reliable than IP)
  if (deviceFingerprint) {
    existingAccountsFromFingerprint = Array.from(recordsByUserId.values()).filter(
      (r) => r.deviceFingerprint === deviceFingerprint && r.freeCreditGranted
    ).length;

    if (existingAccountsFromFingerprint >= MAX_ACCOUNTS_PER_FINGERPRINT) {
      isSuspicious = true;
      suspicionReason = `Multiple accounts (${existingAccountsFromFingerprint}) from same device`;
      dbLogger.warn('Suspicious signup: multiple accounts from same device', {
        fingerprint: deviceFingerprint.substring(0, 10) + '...',
        existingAccounts: existingAccountsFromFingerprint
      });
    }
  }

  // Decide if free credit should be granted
  // Block if device fingerprint matches (strongest signal)
  // Or if too many accounts from same IP
  const allowFreeCredit = !isSuspicious;

  dbLogger.info('Signup abuse check completed', {
    allowFreeCredit,
    isSuspicious,
    existingAccountsFromIP,
    existingAccountsFromFingerprint
  });

  return {
    allowFreeCredit,
    isSuspicious,
    suspicionReason,
    existingAccountsFromIP,
    existingAccountsFromFingerprint
  };
}

/**
 * Record signup information for a new user
 */
export async function recordSignup(
  userId: string,
  signupInfo: SignupInfo,
  freeCreditGranted: boolean,
  isSuspicious: boolean = false,
  suspicionReason?: string
) {
  try {
    const record: SignupRecord = {
      userId,
      ipAddress: signupInfo.ipAddress,
      deviceFingerprint: signupInfo.deviceFingerprint,
      userAgent: signupInfo.userAgent,
      freeCreditGranted,
      isSuspicious,
      suspicionReason,
      reviewedAt: null,
      createdAt: new Date(),
    };

    recordsByUserId.set(userId, record);

    dbLogger.info('Signup record created', {
      userId,
      freeCreditGranted,
      isSuspicious
    });

    return record;
  } catch (error: any) {
    // Don't fail user creation if signup record fails
    dbLogger.error('Failed to create signup record', {
      userId,
      error: error.message
    });
    return null;
  }
}

/**
 * Get signup statistics for admin dashboard
 */
export async function getSignupStats() {
  const records = Array.from(recordsByUserId.values());

  const totalSignups = records.length;
  const suspiciousSignups = records.filter((r) => r.isSuspicious).length;
  const blockedFreeCredits = records.filter((r) => r.isSuspicious && !r.freeCreditGranted).length;

  const ipCounts = new Map<string, number>();
  for (const r of records) {
    if (!r.ipAddress) continue;
    ipCounts.set(r.ipAddress, (ipCounts.get(r.ipAddress) ?? 0) + 1);
  }

  const suspiciousIPs = Array.from(ipCounts.entries())
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ipAddress, count]) => ({ ipAddress, count }));

  return {
    totalSignups,
    suspiciousSignups,
    blockedFreeCredits,
    suspiciousIPs: suspiciousIPs.map((ip) => ({
      ipPrefix: ip.ipAddress.substring(0, 10) + '...',
      count: ip.count,
    }))
  };
}

/**
 * Check if a specific user's signup was suspicious
 */
export async function getUserSignupRecord(userId: string) {
  return recordsByUserId.get(userId) ?? null;
}

/**
 * Mark a signup as reviewed (for admin use)
 */
export async function markSignupReviewed(
  userId: string,
  isSuspicious: boolean,
  reason?: string
) {
  const existing = recordsByUserId.get(userId);
  if (!existing) return null;

  const updated: SignupRecord = {
    ...existing,
    isSuspicious,
    suspicionReason: reason,
    reviewedAt: new Date(),
  };

  recordsByUserId.set(userId, updated);
  return updated;
}
