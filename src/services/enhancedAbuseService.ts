/**
 * Enhanced Abuse Prevention Service
 *
 * The original implementation relied on Prisma models that are not present in the
 * canonical `prisma/schema.prisma` (e.g. `signupRecord`, `subnetTracker`,
 * `disposableEmailDomain`). This version keeps the same public API surface but
 * implements lightweight, in-memory tracking.
 */

import { prisma, dbLogger } from './databaseService';

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  // IP/Subnet limits
  MAX_ACCOUNTS_PER_IP: parseInt(process.env.MAX_ACCOUNTS_PER_IP || '2', 10),
  MAX_ACCOUNTS_PER_FINGERPRINT: parseInt(process.env.MAX_ACCOUNTS_PER_FINGERPRINT || '1', 10),
  MAX_SIGNUPS_PER_SUBNET_HOUR: parseInt(process.env.MAX_SIGNUPS_PER_SUBNET_HOUR || '3', 10),
  
  // Credits are no longer auto-granted; keep fields for compatibility.
  INITIAL_CREDITS_UNVERIFIED: 0,
  INITIAL_CREDITS_PHONE_VERIFIED: 0,
  INITIAL_CREDITS_LINKEDIN_VERIFIED: 0,
  
  // Behavioral thresholds
  MIN_BEHAVIOR_SCORE_FOR_CREDITS: 30,
  SUSPICIOUS_BEHAVIOR_THRESHOLD: 20,
  
  // Time windows
  SUBNET_VELOCITY_WINDOW_HOURS: 1,
  SUBNET_TRACKER_EXPIRY_HOURS: 24,
};

type SignupRecord = {
  userId: string;
  ipAddress?: string;
  deviceFingerprint?: string;
  userAgent?: string;
  emailDomain?: string;
  creditTier: 'full' | 'throttled' | 'blocked';
  captchaCompleted: boolean;
  phoneVerified: boolean;
  linkedInId?: string;
  behaviorScore: number;
  isSuspicious: boolean;
  suspicionReason?: string | null;
  createdAt: Date;
};

const signupRecordsByUserId = new Map<string, SignupRecord>();
const fingerprintCounts = new Map<string, number>();
const ipCounts = new Map<string, number>();

type SubnetTrackerEntry = {
  subnet: string;
  signupCount: number;
  windowStart: Date;
  lastSignupAt: Date;
  expiresAt: Date;
};

const subnetTrackers = new Map<string, SubnetTrackerEntry>();

// ========================================
// TYPES
// ========================================

export interface EnhancedSignupInfo {
  email: string;
  ipAddress?: string;
  deviceFingerprint?: string;
  userAgent?: string;
  captchaToken?: string;
  linkedInId?: string;
}

export interface AbuseCheckResult {
  allowed: boolean;
  creditTier: 'full' | 'throttled' | 'blocked';
  creditsToGrant: number;
  isSuspicious: boolean;
  suspicionReasons: string[];
  requiredActions: ('phone_verify' | 'captcha' | 'linkedin')[];
  riskScore: number; // 0-100, higher = more risky
}

export interface DisposableEmailCheckResult {
  isDisposable: boolean;
  domain: string;
}

export interface SubnetVelocityResult {
  subnet: string;
  signupsInWindow: number;
  isHighVelocity: boolean;
}

// ========================================
// DISPOSABLE EMAIL DETECTION
// ========================================

// Common disposable email domains - this is a starter list
// In production, load from database and update regularly
const COMMON_DISPOSABLE_DOMAINS = new Set([
  // Popular temporary email services
  'tempmail.com', 'temp-mail.org', 'guerrillamail.com', 'guerrillamail.org',
  'mailinator.com', 'mailnator.com', '10minutemail.com', '10minmail.com',
  'throwaway.email', 'throwawaymail.com', 'fakeinbox.com', 'fakemailgenerator.com',
  'yopmail.com', 'yopmail.fr', 'trashmail.com', 'trashmail.net',
  'dispostable.com', 'mailcatch.com', 'maildrop.cc', 'mintemail.com',
  'mohmal.com', 'tempail.com', 'tempr.email', 'discard.email',
  'emailondeck.com', 'getnada.com', 'sharklasers.com', 'grr.la',
  'guerrillamailblock.com', 'pokemail.net', 'spam4.me', 'spamgourmet.com',
  'mytrashmail.com', 'mailexpire.com', 'mailnesia.com', 'spamex.com',
  'getairmail.com', 'tempinbox.com', 'incognitomail.org', 'anonbox.net',
  'jetable.org', 'spamfree24.org', 'mailsac.com', 'boun.cr',
  'burnermail.io', 'spamcowboy.com', 'tempomail.fr', 'emailtemporanea.com',
  'crazymailing.com', 'tempmailer.com', 'tempmail.net', 'anonymbox.com',
  // Add more as needed...
]);

const disposableDomains = COMMON_DISPOSABLE_DOMAINS;

/**
 * Extract domain from email address
 */
export function extractEmailDomain(email: string): string {
  const parts = email.toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : '';
}

/**
 * Check if email domain is disposable
 */
export async function checkDisposableEmail(email: string): Promise<DisposableEmailCheckResult> {
  const domain = extractEmailDomain(email);
  
  if (!domain) {
    return { isDisposable: false, domain: '' };
  }

  if (disposableDomains.has(domain)) {
    dbLogger.warn('Disposable email detected (in-memory)', { domain });
    return { isDisposable: true, domain };
  }

  return { isDisposable: false, domain };
}

/**
 * Add a new disposable email domain to the database
 */
export async function addDisposableEmailDomain(domain: string, source?: string) {
  disposableDomains.add(domain.toLowerCase());
  dbLogger.info('Disposable email domain added (in-memory)', { domain, source });
  return { domain, source };
}

/**
 * Seed the database with common disposable email domains
 */
export async function seedDisposableEmailDomains() {
  const domains = Array.from(COMMON_DISPOSABLE_DOMAINS);
  
  dbLogger.info('Seeding disposable email domains', { count: domains.length });
  
  domains.forEach((d) => disposableDomains.add(d.toLowerCase()));
  
  dbLogger.info('Disposable email domains seeded');
}

// ========================================
// SUBNET VELOCITY TRACKING
// ========================================

/**
 * Extract /24 subnet from IP address
 */
export function extractSubnet(ipAddress: string): string {
  // Handle IPv4
  const ipv4Match = ipAddress.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (ipv4Match) {
    return `${ipv4Match[1]}.0/24`;
  }
  
  // Handle IPv6 (use first 48 bits as "subnet")
  if (ipAddress.includes(':')) {
    const parts = ipAddress.split(':').slice(0, 3);
    return `${parts.join(':')}::/48`;
  }
  
  return ipAddress; // Fallback to full IP
}

/**
 * Track and check subnet velocity
 */
export async function checkSubnetVelocity(ipAddress: string): Promise<SubnetVelocityResult> {
  if (!ipAddress) {
    return { subnet: '', signupsInWindow: 0, isHighVelocity: false };
  }

  const subnet = extractSubnet(ipAddress);
  const now = Date.now();
  const windowMs = CONFIG.SUBNET_VELOCITY_WINDOW_HOURS * 60 * 60 * 1000;
  const bucketStartMs = Math.floor(now / windowMs) * windowMs;
  const windowStart = new Date(bucketStartMs);
  const expiresAt = new Date(now + CONFIG.SUBNET_TRACKER_EXPIRY_HOURS * 60 * 60 * 1000);

  const key = `${subnet}:${windowStart.toISOString()}`;
  const existing = subnetTrackers.get(key);
  const tracker: SubnetTrackerEntry = existing
    ? {
        ...existing,
        signupCount: existing.signupCount + 1,
        lastSignupAt: new Date(),
        expiresAt,
      }
    : {
        subnet,
        signupCount: 1,
        windowStart,
        lastSignupAt: new Date(),
        expiresAt,
      };

  subnetTrackers.set(key, tracker);

  const isHighVelocity = tracker.signupCount > CONFIG.MAX_SIGNUPS_PER_SUBNET_HOUR;

  if (isHighVelocity) {
    dbLogger.warn('High velocity signup detected from subnet', {
      subnet,
      signupCount: tracker.signupCount,
      threshold: CONFIG.MAX_SIGNUPS_PER_SUBNET_HOUR
    });
  }

  return {
    subnet,
    signupsInWindow: tracker.signupCount,
    isHighVelocity
  };
}

/**
 * Clean up expired subnet trackers
 */
export async function cleanupExpiredSubnetTrackers() {
  const now = Date.now();
  let count = 0;
  for (const [key, entry] of subnetTrackers.entries()) {
    if (entry.expiresAt.getTime() < now) {
      subnetTrackers.delete(key);
      count++;
    }
  }

  if (count > 0) {
    dbLogger.info('Cleaned up expired subnet trackers', { count });
  }

  return count;
}

// ========================================
// HARDWARE FINGERPRINT VALIDATION
// ========================================

/**
 * Check if device fingerprint has been used before
 */
export async function checkDeviceFingerprint(fingerprint: string): Promise<{
  isReused: boolean;
  previousAccounts: number;
}> {
  if (!fingerprint) {
    return { isReused: false, previousAccounts: 0 };
  }

  const previousAccounts = fingerprintCounts.get(fingerprint) ?? 0;

  const isReused = previousAccounts >= CONFIG.MAX_ACCOUNTS_PER_FINGERPRINT;

  if (isReused) {
    dbLogger.warn('Device fingerprint reuse detected', {
      fingerprint: fingerprint.substring(0, 10) + '...',
      previousAccounts
    });
  }

  return { isReused, previousAccounts };
}

// ========================================
// IP ADDRESS VALIDATION
// ========================================

/**
 * Check if IP address has been used for multiple accounts
 */
export async function checkIPAddress(ipAddress: string): Promise<{
  isOverLimit: boolean;
  previousAccounts: number;
}> {
  if (!ipAddress) {
    return { isOverLimit: false, previousAccounts: 0 };
  }

  const previousAccounts = ipCounts.get(ipAddress) ?? 0;

  const isOverLimit = previousAccounts >= CONFIG.MAX_ACCOUNTS_PER_IP;

  if (isOverLimit) {
    dbLogger.warn('IP address limit exceeded', {
      ipAddress: ipAddress.substring(0, 10) + '...',
      previousAccounts
    });
  }

  return { isOverLimit, previousAccounts };
}

// ========================================
// BEHAVIORAL ANALYSIS
// ========================================

/**
 * Calculate behavior score for a user based on their activity patterns
 * Higher score = more trustworthy
 */
export async function calculateBehaviorScore(userId: string): Promise<number> {
  let score = 50; // Start at neutral

  try {
    // Get user's interviews
    const interviews = await prisma.interview.findMany({
      where: { userId },
      select: {
        status: true,
        callDuration: true,
        createdAt: true,
        startedAt: true
      },
      orderBy: { createdAt: 'asc' }
    });

    if (interviews.length === 0) {
      return score; // No data yet
    }

    // Factor 1: Interview completion rate
    const completedInterviews = interviews.filter(i => i.status === 'COMPLETED').length;
    const completionRate = completedInterviews / interviews.length;
    score += Math.round(completionRate * 20); // +0 to +20

    // Factor 2: Average interview duration (penalize very short interviews)
    const durations = interviews
      .filter(i => i.callDuration && i.callDuration > 0)
      .map(i => i.callDuration!);
    
    if (durations.length > 0) {
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      if (avgDuration < 60) {
        score -= 20; // Very short interviews (< 1 min) - suspicious
      } else if (avgDuration < 180) {
        score -= 10; // Short interviews (< 3 min)
      } else if (avgDuration >= 300) {
        score += 15; // Substantial interviews (5+ min)
      }
    }

    // Factor 3: Time between signup and first interview
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true }
    });

    if (user && interviews[0]) {
      const timeToFirstInterview = interviews[0].createdAt.getTime() - user.createdAt.getTime();
      const hoursToFirst = timeToFirstInterview / (1000 * 60 * 60);
      
      if (hoursToFirst < 0.1) {
        score -= 10; // Very fast (< 6 min) - possibly automated
      } else if (hoursToFirst > 24) {
        score += 10; // Waited more than a day - likely genuine
      }
    }

    // Factor 4: Cancelled interview rate
    const cancelledInterviews = interviews.filter(i => i.status === 'CANCELLED').length;
    const cancelRate = cancelledInterviews / interviews.length;
    if (cancelRate > 0.5) {
      score -= 15; // More than half cancelled - suspicious
    }

    // Clamp score to 0-100
    return Math.max(0, Math.min(100, score));
  } catch (error) {
    dbLogger.error('Error calculating behavior score', { userId, error });
    return score;
  }
}

// ========================================
// COMPREHENSIVE ABUSE CHECK
// ========================================

/**
 * Perform comprehensive abuse check for signup
 */
export async function performEnhancedAbuseCheck(
  signupInfo: EnhancedSignupInfo
): Promise<AbuseCheckResult> {
  const suspicionReasons: string[] = [];
  const requiredActions: ('phone_verify' | 'captcha' | 'linkedin')[] = [];
  let riskScore = 0;

  // Layer 1: Disposable email check
  const emailCheck = await checkDisposableEmail(signupInfo.email);
  if (emailCheck.isDisposable) {
    suspicionReasons.push(`Disposable email domain: ${emailCheck.domain}`);
    riskScore += 40;
    requiredActions.push('linkedin');
  }

  // Layer 2: Device fingerprint check
  if (signupInfo.deviceFingerprint) {
    const fpCheck = await checkDeviceFingerprint(signupInfo.deviceFingerprint);
    if (fpCheck.isReused) {
      suspicionReasons.push(`Device fingerprint reused (${fpCheck.previousAccounts} previous accounts)`);
      riskScore += 50;
    }
  } else {
    // No fingerprint provided - slightly suspicious
    riskScore += 10;
  }

  // Layer 3: IP address check
  if (signupInfo.ipAddress) {
    const ipCheck = await checkIPAddress(signupInfo.ipAddress);
    if (ipCheck.isOverLimit) {
      suspicionReasons.push(`IP address limit exceeded (${ipCheck.previousAccounts} previous accounts)`);
      riskScore += 30;
    }

    // Layer 4: Subnet velocity check
    const subnetCheck = await checkSubnetVelocity(signupInfo.ipAddress);
    if (subnetCheck.isHighVelocity) {
      suspicionReasons.push(`High velocity signups from subnet (${subnetCheck.signupsInWindow} in last hour)`);
      riskScore += 25;
      requiredActions.push('captcha');
    }
  }

  // Layer 5: Check for required verifications
  if (!signupInfo.captchaToken && riskScore > 30) {
    requiredActions.push('captcha');
  }
  
  if (riskScore > 50 && !signupInfo.linkedInId) {
    requiredActions.push('linkedin');
  }
  
  // Always require phone verification for full credits
  if (!requiredActions.includes('phone_verify')) {
    requiredActions.push('phone_verify');
  }

  // Determine credit tier and outcome
  const isSuspicious = riskScore >= CONFIG.SUSPICIOUS_BEHAVIOR_THRESHOLD;
  let creditTier: 'full' | 'throttled' | 'blocked';
  let creditsToGrant: number;
  let allowed = true;

  if (riskScore >= 80) {
    // Very high risk - block
    creditTier = 'blocked';
    creditsToGrant = 0;
    allowed = false;
  } else if (riskScore >= 40) {
    // Medium risk - throttle
    creditTier = 'throttled';
    creditsToGrant = signupInfo.linkedInId 
      ? CONFIG.INITIAL_CREDITS_LINKEDIN_VERIFIED 
      : CONFIG.INITIAL_CREDITS_UNVERIFIED;
  } else {
    // Low risk - full credits (pending phone verification)
    creditTier = 'full';
    creditsToGrant = CONFIG.INITIAL_CREDITS_PHONE_VERIFIED;
  }

  dbLogger.info('Enhanced abuse check completed', {
    email: signupInfo.email,
    riskScore,
    creditTier,
    suspicionReasons: suspicionReasons.length,
    requiredActions
  });

  return {
    allowed,
    creditTier,
    creditsToGrant,
    isSuspicious,
    suspicionReasons,
    requiredActions,
    riskScore
  };
}

// ========================================
// RECORD MANAGEMENT
// ========================================

/**
 * Record enhanced signup information
 */
export async function recordEnhancedSignup(
  userId: string,
  signupInfo: EnhancedSignupInfo,
  abuseCheckResult: AbuseCheckResult
) {
  try {
    const emailDomain = extractEmailDomain(signupInfo.email);

    const record: SignupRecord = {
      userId,
      ipAddress: signupInfo.ipAddress,
      deviceFingerprint: signupInfo.deviceFingerprint,
      userAgent: signupInfo.userAgent,
      emailDomain,
      creditTier: abuseCheckResult.creditTier,
      captchaCompleted: !!signupInfo.captchaToken,
      phoneVerified: false,
      linkedInId: signupInfo.linkedInId,
      behaviorScore: 50,
      isSuspicious: abuseCheckResult.isSuspicious,
      suspicionReason: abuseCheckResult.suspicionReasons.join('; ') || null,
      createdAt: new Date(),
    };

    signupRecordsByUserId.set(userId, record);

    if (signupInfo.deviceFingerprint) {
      fingerprintCounts.set(
        signupInfo.deviceFingerprint,
        (fingerprintCounts.get(signupInfo.deviceFingerprint) ?? 0) + 1
      );
    }
    if (signupInfo.ipAddress) {
      ipCounts.set(signupInfo.ipAddress, (ipCounts.get(signupInfo.ipAddress) ?? 0) + 1);
    }

    dbLogger.info('Enhanced signup record created', {
      userId,
      creditTier: abuseCheckResult.creditTier,
      riskScore: abuseCheckResult.riskScore
    });

    return record;
  } catch (error: any) {
    dbLogger.error('Failed to create enhanced signup record', {
      userId,
      error: error.message
    });
    return null;
  }
}

/**
 * Update signup record after verification
 */
export async function updateSignupVerification(
  userId: string,
  verificationType: 'phone' | 'captcha' | 'linkedin',
  verificationData?: string
) {
  try {
    const existing = signupRecordsByUserId.get(userId);
    if (!existing) return null;

    const updated: SignupRecord = { ...existing };
    switch (verificationType) {
      case 'phone':
        updated.phoneVerified = true;
        break;
      case 'captcha':
        updated.captchaCompleted = true;
        break;
      case 'linkedin':
        updated.linkedInId = verificationData;
        break;
    }

    if (updated.phoneVerified && updated.creditTier === 'throttled') {
      updated.creditTier = 'full';
    }

    signupRecordsByUserId.set(userId, updated);

    dbLogger.info('Signup verification updated', {
      userId,
      verificationType
    });

    return updated;
  } catch (error: any) {
    dbLogger.error('Failed to update signup verification', {
      userId,
      verificationType,
      error: error.message
    });
    return null;
  }
}

/**
 * Update behavior score for a user
 */
export async function updateUserBehaviorScore(userId: string) {
  const score = await calculateBehaviorScore(userId);

  const existing = signupRecordsByUserId.get(userId);
  if (existing) {
    signupRecordsByUserId.set(userId, { ...existing, behaviorScore: score });
  }
  return score;
}

// ========================================
// ADMIN STATISTICS
// ========================================

/**
 * Get comprehensive abuse prevention statistics
 */
export async function getEnhancedAbuseStats() {
  const records = Array.from(signupRecordsByUserId.values());
  const totalSignups = records.length;
  const suspiciousSignups = records.filter((r) => r.isSuspicious).length;
  const blockedSignups = records.filter((r) => r.creditTier === 'blocked').length;
  const throttledSignups = records.filter((r) => r.creditTier === 'throttled').length;
  const phoneVerifiedSignups = records.filter((r) => r.phoneVerified).length;
  const disposableEmailAttempts = records.filter((r) => (r.suspicionReason ?? '').includes('Disposable email')).length;

  const recentSubnetVelocity = Array.from(subnetTrackers.values())
    .filter((s) => s.signupCount > CONFIG.MAX_SIGNUPS_PER_SUBNET_HOUR)
    .sort((a, b) => b.signupCount - a.signupCount)
    .slice(0, 10);

  return {
    totalSignups,
    suspiciousSignups,
    blockedSignups,
    throttledSignups,
    phoneVerifiedSignups,
    disposableEmailAttempts,
    recentHighVelocitySubnets: recentSubnetVelocity.map(s => ({
      subnet: s.subnet,
      signupCount: s.signupCount,
      lastSignup: s.lastSignupAt
    })),
    verificationRate: totalSignups > 0 
      ? Math.round((phoneVerifiedSignups / totalSignups) * 100) 
      : 0
  };
}
