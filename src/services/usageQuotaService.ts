/**
 * Usage Quota Service
 * 
 * Manages usage limits for free tier and different subscription tiers.
 * Tracks interview minutes, AI tokens, and other consumable resources.
 * 
 * Features:
 * - Per-user usage tracking
 * - Tier-based limits
 * - Real-time quota checks
 * - Usage analytics
 * - Quota reset schedules (daily/weekly/monthly)
 * 
 * @module services/usageQuotaService
 */

import logger from '../utils/logger';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Create usage quota logger
const quotaLogger = logger.child({ component: 'usage-quota' });

// ========================================
// INTERFACES
// ========================================

export interface UsageTier {
  name: string;
  limits: UsageLimits;
  resetPeriod: 'daily' | 'weekly' | 'monthly' | 'never';
}

export interface UsageLimits {
  maxInterviewMinutes: number;     // Max interview minutes per period
  maxInterviewsPerDay: number;     // Max interviews per day
  maxAITokensPerInterview: number; // Max AI tokens per interview
  maxAITokensTotal: number;        // Max total AI tokens per period
  maxResumesStored: number;        // Max resumes in storage
  maxChatMessagesPerDay: number;   // Max performance chat messages
  maxEmailsPerDay: number;         // Max automated emails per day
}

export interface CurrentUsage {
  interviewMinutesUsed: number;
  interviewsToday: number;
  aiTokensUsed: number;
  resumesStored: number;
  chatMessagesToday: number;
  emailsSentToday: number;
  lastReset: Date;
}

export interface QuotaCheckResult {
  allowed: boolean;
  resource: keyof UsageLimits;
  currentUsage: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  resetAt?: Date;
  upgradeRequired?: boolean;
}

export interface UsageRecord {
  userId: string;
  resourceType: ResourceType;
  amount: number;
  interviewId?: string;
  description?: string;
  timestamp: Date;
}

export type ResourceType = 
  | 'interview_minutes'
  | 'interview_count'
  | 'ai_tokens'
  | 'resume_storage'
  | 'chat_messages'
  | 'emails_sent';

// ========================================
// TIER CONFIGURATION
// ========================================

/**
 * Define usage tiers and their limits
 */
export const USAGE_TIERS: Record<string, UsageTier> = {
  free: {
    name: 'Free',
    limits: {
      maxInterviewMinutes: 30,         // 30 min/month for free tier
      maxInterviewsPerDay: 2,          // 2 interviews per day
      maxAITokensPerInterview: 10000,  // ~7-8k words per interview
      maxAITokensTotal: 50000,         // Total per month
      maxResumesStored: 3,             // 3 resumes max
      maxChatMessagesPerDay: 20,       // 20 chat messages per day
      maxEmailsPerDay: 5               // 5 emails per day
    },
    resetPeriod: 'monthly'
  },
  
  starter: {
    name: 'Starter',
    limits: {
      maxInterviewMinutes: 120,        // 2 hours/month
      maxInterviewsPerDay: 5,          // 5 interviews per day
      maxAITokensPerInterview: 20000,
      maxAITokensTotal: 200000,
      maxResumesStored: 10,
      maxChatMessagesPerDay: 50,
      maxEmailsPerDay: 20
    },
    resetPeriod: 'monthly'
  },
  
  intermediate: {
    name: 'Intermediate',
    limits: {
      maxInterviewMinutes: 300,        // 5 hours/month
      maxInterviewsPerDay: 10,
      maxAITokensPerInterview: 30000,
      maxAITokensTotal: 500000,
      maxResumesStored: 25,
      maxChatMessagesPerDay: 100,
      maxEmailsPerDay: 50
    },
    resetPeriod: 'monthly'
  },
  
  professional: {
    name: 'Professional',
    limits: {
      maxInterviewMinutes: 1200,       // 20 hours/month (unlimited practically)
      maxInterviewsPerDay: 50,
      maxAITokensPerInterview: 50000,
      maxAITokensTotal: 2000000,
      maxResumesStored: 100,
      maxChatMessagesPerDay: 500,
      maxEmailsPerDay: 200
    },
    resetPeriod: 'monthly'
  },
  
  enterprise: {
    name: 'Enterprise',
    limits: {
      maxInterviewMinutes: -1,         // -1 = unlimited
      maxInterviewsPerDay: -1,
      maxAITokensPerInterview: -1,
      maxAITokensTotal: -1,
      maxResumesStored: -1,
      maxChatMessagesPerDay: -1,
      maxEmailsPerDay: -1
    },
    resetPeriod: 'never'
  }
};

// ========================================
// TIER DETECTION
// ========================================

/**
 * Get user's current tier based on credits or subscription
 */
export async function getUserTier(userId: string): Promise<UsageTier> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { 
        credits: true,
        signupRecord: {
          select: { creditTier: true }
        }
      }
    });
    
    if (!user) {
      return USAGE_TIERS.free;
    }
    
    // Check if user has been blocked
    if (user.signupRecord?.creditTier === 'blocked') {
      return {
        ...USAGE_TIERS.free,
        limits: {
          maxInterviewMinutes: 0,
          maxInterviewsPerDay: 0,
          maxAITokensPerInterview: 0,
          maxAITokensTotal: 0,
          maxResumesStored: 1,
          maxChatMessagesPerDay: 5,
          maxEmailsPerDay: 0
        }
      };
    }
    
    // Determine tier based on credits purchased
    // In a real system, this would check subscription status
    const credits = user.credits || 0;
    
    if (credits >= 50) return USAGE_TIERS.professional;
    if (credits >= 20) return USAGE_TIERS.intermediate;
    if (credits >= 5) return USAGE_TIERS.starter;
    
    return USAGE_TIERS.free;
  } catch (error: any) {
    quotaLogger.error('Failed to get user tier', { error: error.message });
    return USAGE_TIERS.free;
  }
}

// ========================================
// USAGE TRACKING
// ========================================

/**
 * Get current period start date
 */
function getPeriodStart(resetPeriod: 'daily' | 'weekly' | 'monthly' | 'never'): Date {
  const now = new Date();
  
  switch (resetPeriod) {
    case 'daily':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case 'weekly':
      const dayOfWeek = now.getDay();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - dayOfWeek);
      startOfWeek.setHours(0, 0, 0, 0);
      return startOfWeek;
    case 'monthly':
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'never':
      return new Date(0); // Epoch - includes all usage
  }
}

/**
 * Get current usage for a user
 */
export async function getCurrentUsage(userId: string): Promise<CurrentUsage> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) {
      return {
        interviewMinutesUsed: 0,
        interviewsToday: 0,
        aiTokensUsed: 0,
        resumesStored: 0,
        chatMessagesToday: 0,
        emailsSentToday: 0,
        lastReset: new Date()
      };
    }
    
    const tier = await getUserTier(userId);
    const periodStart = getPeriodStart(tier.resetPeriod);
    const todayStart = getPeriodStart('daily');
    
    // Get usage logs for current period
    const usageLogs = await prisma.usageLog.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: periodStart }
      }
    });
    
    // Get today's usage for daily limits
    const todayLogs = usageLogs.filter(log => log.createdAt >= todayStart);
    
    // Calculate totals
    const interviewMinutesUsed = usageLogs
      .filter(log => log.resourceType === 'interview_minutes')
      .reduce((sum, log) => sum + log.amount, 0);
    
    const interviewsToday = todayLogs
      .filter(log => log.resourceType === 'interview_count')
      .reduce((sum, log) => sum + log.amount, 0);
    
    const aiTokensUsed = usageLogs
      .filter(log => log.resourceType === 'ai_tokens')
      .reduce((sum, log) => sum + log.amount, 0);
    
    const chatMessagesToday = todayLogs
      .filter(log => log.resourceType === 'chat_messages')
      .reduce((sum, log) => sum + log.amount, 0);
    
    const emailsSentToday = todayLogs
      .filter(log => log.resourceType === 'emails_sent')
      .reduce((sum, log) => sum + log.amount, 0);
    
    // Count stored resumes
    const resumesStored = await prisma.interview.count({
      where: {
        userId: user.id,
        resumeData: { not: null }
      }
    });
    
    return {
      interviewMinutesUsed,
      interviewsToday,
      aiTokensUsed,
      resumesStored,
      chatMessagesToday,
      emailsSentToday,
      lastReset: periodStart
    };
  } catch (error: any) {
    quotaLogger.error('Failed to get current usage', { error: error.message });
    return {
      interviewMinutesUsed: 0,
      interviewsToday: 0,
      aiTokensUsed: 0,
      resumesStored: 0,
      chatMessagesToday: 0,
      emailsSentToday: 0,
      lastReset: new Date()
    };
  }
}

/**
 * Log resource usage
 */
export async function logUsage(record: UsageRecord): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: record.userId },
      select: { id: true }
    });
    
    if (!user) return false;
    
    await prisma.usageLog.create({
      data: {
        userId: user.id,
        eventType: `${record.resourceType}_used`,
        resourceType: record.resourceType,
        amount: record.amount,
        interviewId: record.interviewId,
        description: record.description,
        createdAt: record.timestamp || new Date()
      }
    });
    
    quotaLogger.debug('Usage logged', { 
      userId: record.userId, 
      resourceType: record.resourceType,
      amount: record.amount
    });
    
    return true;
  } catch (error: any) {
    quotaLogger.error('Failed to log usage', { error: error.message });
    return false;
  }
}

// ========================================
// QUOTA CHECKS
// ========================================

/**
 * Check if user can use a specific resource
 */
export async function checkQuota(
  userId: string,
  resource: keyof UsageLimits,
  requestedAmount: number = 1
): Promise<QuotaCheckResult> {
  try {
    const tier = await getUserTier(userId);
    const usage = await getCurrentUsage(userId);
    
    let limit: number;
    let currentUsage: number;
    
    // Map resource to usage
    switch (resource) {
      case 'maxInterviewMinutes':
        limit = tier.limits.maxInterviewMinutes;
        currentUsage = usage.interviewMinutesUsed;
        break;
      case 'maxInterviewsPerDay':
        limit = tier.limits.maxInterviewsPerDay;
        currentUsage = usage.interviewsToday;
        break;
      case 'maxAITokensTotal':
        limit = tier.limits.maxAITokensTotal;
        currentUsage = usage.aiTokensUsed;
        break;
      case 'maxAITokensPerInterview':
        limit = tier.limits.maxAITokensPerInterview;
        currentUsage = 0; // Per-interview limit checked separately
        break;
      case 'maxResumesStored':
        limit = tier.limits.maxResumesStored;
        currentUsage = usage.resumesStored;
        break;
      case 'maxChatMessagesPerDay':
        limit = tier.limits.maxChatMessagesPerDay;
        currentUsage = usage.chatMessagesToday;
        break;
      case 'maxEmailsPerDay':
        limit = tier.limits.maxEmailsPerDay;
        currentUsage = usage.emailsSentToday;
        break;
      default:
        return {
          allowed: false,
          resource,
          currentUsage: 0,
          limit: 0,
          remaining: 0,
          percentUsed: 100,
          upgradeRequired: true
        };
    }
    
    // -1 means unlimited
    if (limit === -1) {
      return {
        allowed: true,
        resource,
        currentUsage,
        limit: -1,
        remaining: -1,
        percentUsed: 0
      };
    }
    
    const remaining = Math.max(0, limit - currentUsage);
    const allowed = currentUsage + requestedAmount <= limit;
    const percentUsed = limit > 0 ? Math.round((currentUsage / limit) * 100) : 100;
    
    // Calculate next reset
    let resetAt: Date | undefined;
    if (tier.resetPeriod !== 'never') {
      const periodStart = getPeriodStart(tier.resetPeriod);
      switch (tier.resetPeriod) {
        case 'daily':
          resetAt = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
          break;
        case 'weekly':
          resetAt = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);
          break;
        case 'monthly':
          resetAt = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);
          break;
      }
    }
    
    return {
      allowed,
      resource,
      currentUsage,
      limit,
      remaining,
      percentUsed,
      resetAt,
      upgradeRequired: !allowed && tier.name === 'Free'
    };
  } catch (error: any) {
    quotaLogger.error('Quota check failed', { error: error.message });
    // Fail open - allow the operation but log the error
    return {
      allowed: true,
      resource,
      currentUsage: 0,
      limit: -1,
      remaining: -1,
      percentUsed: 0
    };
  }
}

/**
 * Check all quotas for a user
 */
export async function checkAllQuotas(userId: string): Promise<Record<keyof UsageLimits, QuotaCheckResult>> {
  const resources: (keyof UsageLimits)[] = [
    'maxInterviewMinutes',
    'maxInterviewsPerDay',
    'maxAITokensPerInterview',
    'maxAITokensTotal',
    'maxResumesStored',
    'maxChatMessagesPerDay',
    'maxEmailsPerDay'
  ];
  
  const results: Record<string, QuotaCheckResult> = {};
  
  for (const resource of resources) {
    results[resource] = await checkQuota(userId, resource);
  }
  
  return results as Record<keyof UsageLimits, QuotaCheckResult>;
}

/**
 * Check if user can start an interview
 */
export async function canStartInterview(userId: string): Promise<{
  allowed: boolean;
  reason?: string;
  quotas: QuotaCheckResult[];
}> {
  const dailyCheck = await checkQuota(userId, 'maxInterviewsPerDay');
  const minutesCheck = await checkQuota(userId, 'maxInterviewMinutes', 15); // Assume 15 min
  
  const quotas = [dailyCheck, minutesCheck];
  
  if (!dailyCheck.allowed) {
    return {
      allowed: false,
      reason: `Daily interview limit reached (${dailyCheck.currentUsage}/${dailyCheck.limit})`,
      quotas
    };
  }
  
  if (!minutesCheck.allowed) {
    return {
      allowed: false,
      reason: `Interview minutes quota exceeded (${minutesCheck.currentUsage}/${minutesCheck.limit} minutes used)`,
      quotas
    };
  }
  
  return { allowed: true, quotas };
}

/**
 * Check if user can send a chat message
 */
export async function canSendChatMessage(userId: string): Promise<QuotaCheckResult> {
  return checkQuota(userId, 'maxChatMessagesPerDay');
}

/**
 * Check if user can send an automated email
 */
export async function canSendEmail(userId: string): Promise<QuotaCheckResult> {
  return checkQuota(userId, 'maxEmailsPerDay');
}

/**
 * Check if user can store another resume
 */
export async function canStoreResume(userId: string): Promise<QuotaCheckResult> {
  return checkQuota(userId, 'maxResumesStored');
}

// ========================================
// USAGE REPORTING
// ========================================

/**
 * Get usage summary for dashboard display
 */
export async function getUsageSummary(userId: string): Promise<{
  tier: string;
  usage: CurrentUsage;
  limits: UsageLimits;
  quotas: Record<keyof UsageLimits, QuotaCheckResult>;
  warnings: string[];
}> {
  const tier = await getUserTier(userId);
  const usage = await getCurrentUsage(userId);
  const quotas = await checkAllQuotas(userId);
  
  // Generate warnings for quotas near limit
  const warnings: string[] = [];
  
  for (const [resource, quota] of Object.entries(quotas)) {
    if (quota.limit !== -1 && quota.percentUsed >= 80) {
      if (quota.percentUsed >= 100) {
        warnings.push(`${resource.replace('max', '').replace(/([A-Z])/g, ' $1').trim()} limit reached`);
      } else {
        warnings.push(`${Math.round(quota.percentUsed)}% of ${resource.replace('max', '').replace(/([A-Z])/g, ' $1').trim()} used`);
      }
    }
  }
  
  return {
    tier: tier.name,
    usage,
    limits: tier.limits,
    quotas,
    warnings
  };
}

// ========================================
// EXPORTS
// ========================================

export default {
  USAGE_TIERS,
  getUserTier,
  getCurrentUsage,
  logUsage,
  checkQuota,
  checkAllQuotas,
  canStartInterview,
  canSendChatMessage,
  canSendEmail,
  canStoreResume,
  getUsageSummary
};
