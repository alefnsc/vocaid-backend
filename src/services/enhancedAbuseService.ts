/**
 * Enhanced Abuse Prevention Service
 * Multi-layered defense system for free trial protection
 * 
 * Features:
 * - Disposable email domain blocking
 * - Subnet velocity tracking
 * - Hardware fingerprint validation
 * - Credit throttling
 * - Behavioral analysis
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
  
  // Credit throttling
  INITIAL_CREDITS_UNVERIFIED: 1,
  INITIAL_CREDITS_PHONE_VERIFIED: 2,
  INITIAL_CREDITS_LINKEDIN_VERIFIED: 3,
  
  // Behavioral thresholds
  MIN_BEHAVIOR_SCORE_FOR_CREDITS: 30,
  SUSPICIOUS_BEHAVIOR_THRESHOLD: 20,
  
  // Time windows
  SUBNET_VELOCITY_WINDOW_HOURS: 1,
  SUBNET_TRACKER_EXPIRY_HOURS: 24,
};

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

  // First check in-memory list (fast)
  if (COMMON_DISPOSABLE_DOMAINS.has(domain)) {
    dbLogger.warn('Disposable email detected (in-memory)', { domain });
    return { isDisposable: true, domain };
  }

  // Then check database for extended list
  const dbRecord = await prisma.disposableEmailDomain.findUnique({
    where: { domain },
    select: { isActive: true }
  });

  if (dbRecord?.isActive) {
    dbLogger.warn('Disposable email detected (database)', { domain });
    return { isDisposable: true, domain };
  }

  return { isDisposable: false, domain };
}

/**
 * Add a new disposable email domain to the database
 */
export async function addDisposableEmailDomain(domain: string, source?: string) {
  return prisma.disposableEmailDomain.upsert({
    where: { domain },
    create: { domain, source, isActive: true },
    update: { isActive: true, source }
  });
}

/**
 * Seed the database with common disposable email domains
 */
export async function seedDisposableEmailDomains() {
  const domains = Array.from(COMMON_DISPOSABLE_DOMAINS);
  
  dbLogger.info('Seeding disposable email domains', { count: domains.length });
  
  for (const domain of domains) {
    await prisma.disposableEmailDomain.upsert({
      where: { domain },
      create: { domain, source: 'initial_seed', isActive: true },
      update: {} // Don't update if exists
    });
  }
  
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
  const windowStart = new Date(Date.now() - CONFIG.SUBNET_VELOCITY_WINDOW_HOURS * 60 * 60 * 1000);
  const expiresAt = new Date(Date.now() + CONFIG.SUBNET_TRACKER_EXPIRY_HOURS * 60 * 60 * 1000);

  // Upsert subnet tracker
  const tracker = await prisma.subnetTracker.upsert({
    where: {
      subnet_windowStart: {
        subnet,
        windowStart
      }
    },
    create: {
      subnet,
      signupCount: 1,
      windowStart,
      expiresAt
    },
    update: {
      signupCount: { increment: 1 },
      lastSignupAt: new Date()
    }
  });

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
  const result = await prisma.subnetTracker.deleteMany({
    where: {
      expiresAt: { lt: new Date() }
    }
  });
  
  if (result.count > 0) {
    dbLogger.info('Cleaned up expired subnet trackers', { count: result.count });
  }
  
  return result.count;
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

  const previousAccounts = await prisma.signupRecord.count({
    where: {
      deviceFingerprint: fingerprint,
      freeCreditGranted: true
    }
  });

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

  const previousAccounts = await prisma.signupRecord.count({
    where: {
      ipAddress,
      freeCreditGranted: true
    }
  });

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
    
    const record = await prisma.signupRecord.create({
      data: {
        userId,
        ipAddress: signupInfo.ipAddress,
        deviceFingerprint: signupInfo.deviceFingerprint,
        userAgent: signupInfo.userAgent,
        emailDomain,
        freeCreditGranted: abuseCheckResult.creditsToGrant > 0,
        creditTier: abuseCheckResult.creditTier,
        captchaCompleted: !!signupInfo.captchaToken,
        linkedInId: signupInfo.linkedInId,
        behaviorScore: 50, // Initial score
        isSuspicious: abuseCheckResult.isSuspicious,
        suspicionReason: abuseCheckResult.suspicionReasons.join('; ') || null
      }
    });

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
    const updateData: any = {};
    
    switch (verificationType) {
      case 'phone':
        updateData.phoneVerified = true;
        break;
      case 'captcha':
        updateData.captchaCompleted = true;
        break;
      case 'linkedin':
        updateData.linkedInId = verificationData;
        break;
    }

    const updated = await prisma.signupRecord.update({
      where: { userId },
      data: updateData
    });

    // Potentially upgrade credit tier
    if (updated.phoneVerified && updated.creditTier === 'throttled') {
      await prisma.signupRecord.update({
        where: { userId },
        data: { creditTier: 'full' }
      });
    }

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
  
  try {
    await prisma.signupRecord.update({
      where: { userId },
      data: { behaviorScore: score }
    });
    
    return score;
  } catch (error) {
    // Record might not exist for older users
    return score;
  }
}

// ========================================
// ADMIN STATISTICS
// ========================================

/**
 * Get comprehensive abuse prevention statistics
 */
export async function getEnhancedAbuseStats() {
  const [
    totalSignups,
    suspiciousSignups,
    blockedSignups,
    throttledSignups,
    phoneVerifiedSignups,
    disposableEmailAttempts,
    recentSubnetVelocity
  ] = await Promise.all([
    prisma.signupRecord.count(),
    prisma.signupRecord.count({ where: { isSuspicious: true } }),
    prisma.signupRecord.count({ where: { creditTier: 'blocked' } }),
    prisma.signupRecord.count({ where: { creditTier: 'throttled' } }),
    prisma.signupRecord.count({ where: { phoneVerified: true } }),
    prisma.signupRecord.count({
      where: {
        isSuspicious: true,
        suspicionReason: { contains: 'Disposable email' }
      }
    }),
    prisma.subnetTracker.findMany({
      where: {
        signupCount: { gt: CONFIG.MAX_SIGNUPS_PER_SUBNET_HOUR }
      },
      orderBy: { signupCount: 'desc' },
      take: 10
    })
  ]);

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
