/**
 * Device Fingerprinting Service
 * 
 * Identifies devices using browser/hardware signatures to prevent abuse.
 * Works with FingerprintJS Pro or open-source alternatives on the client side.
 * 
 * Features:
 * - Store and validate device fingerprints
 * - Detect duplicate devices across accounts
 * - Identify VM/emulator patterns
 * - Bot detection signals
 * - Device trust scoring
 * 
 * @module services/deviceFingerprintService
 */

import logger from '../utils/logger';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Create device fingerprint logger
const deviceLogger = logger.child({ component: 'device-fingerprint' });

// ========================================
// INTERFACES
// ========================================

export interface DeviceFingerprint {
  visitorId: string;           // Primary fingerprint hash
  requestId?: string;          // Request-level ID for audit
  confidence?: number;         // 0-1 confidence score
  
  // Browser signals
  browserName?: string;
  browserVersion?: string;
  os?: string;
  osVersion?: string;
  device?: string;             // desktop, mobile, tablet
  
  // Hardware signals
  screenResolution?: string;
  colorDepth?: number;
  timezone?: string;
  language?: string;
  platform?: string;
  cpuCores?: number;
  deviceMemory?: number;
  
  // Canvas/WebGL fingerprints (hashed)
  canvasHash?: string;
  webglHash?: string;
  audioHash?: string;
  
  // Bot detection signals
  bot?: {
    detected: boolean;
    type?: string;
  };
  
  // Incognito/privacy mode
  incognito?: boolean;
  
  // VM/Emulator detection
  vm?: {
    detected: boolean;
    type?: string;
  };
  
  // IP info (passed from server)
  ip?: string;
  
  // Timestamps
  firstSeen?: Date;
  lastSeen?: Date;
}

export interface DeviceValidationResult {
  isValid: boolean;
  isTrusted: boolean;
  trustScore: number;          // 0-100
  warnings: string[];
  flags: DeviceFlag[];
  blockedReason?: string;
}

export interface DeviceFlag {
  type: 'bot' | 'vm' | 'duplicate' | 'suspicious' | 'blocked' | 'privacy_mode';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}

export interface DeviceLinkResult {
  linkedAccounts: number;
  accountIds: string[];
  isNewDevice: boolean;
}

// ========================================
// CONFIGURATION
// ========================================

// Trust score thresholds
const TRUST_THRESHOLD_HIGH = 80;
const TRUST_THRESHOLD_MEDIUM = 50;
const TRUST_THRESHOLD_LOW = 20;

// Maximum accounts per device
const MAX_ACCOUNTS_PER_DEVICE = 2;

// Known VM/Emulator signatures
const VM_INDICATORS = [
  'VirtualBox',
  'VMware',
  'Parallels',
  'QEMU',
  'Xen',
  'Hyper-V',
  'BlueStacks',
  'Android Emulator',
  'Genymotion'
];

// Known bot user agents patterns
const BOT_PATTERNS = [
  /bot/i,
  /spider/i,
  /crawler/i,
  /scraper/i,
  /headless/i,
  /phantom/i,
  /selenium/i,
  /puppeteer/i,
  /playwright/i
];

// Suspicious screen resolutions (VMs, headless)
const SUSPICIOUS_RESOLUTIONS = [
  '800x600',
  '1024x768',
  '0x0'
];

// ========================================
// FINGERPRINT ANALYSIS
// ========================================

/**
 * Analyze device fingerprint for suspicious signals
 */
export function analyzeFingerprint(fingerprint: DeviceFingerprint): DeviceValidationResult {
  const warnings: string[] = [];
  const flags: DeviceFlag[] = [];
  let trustScore = 100;
  
  // 1. Check for bot detection
  if (fingerprint.bot?.detected) {
    trustScore -= 50;
    flags.push({
      type: 'bot',
      severity: 'critical',
      message: `Bot detected: ${fingerprint.bot.type || 'unknown'}`
    });
  }
  
  // 2. Check for VM/Emulator
  if (fingerprint.vm?.detected) {
    trustScore -= 30;
    flags.push({
      type: 'vm',
      severity: 'high',
      message: `Virtual machine detected: ${fingerprint.vm.type || 'unknown'}`
    });
  }
  
  // Check user agent for VM patterns
  if (fingerprint.platform) {
    for (const indicator of VM_INDICATORS) {
      if (fingerprint.platform.toLowerCase().includes(indicator.toLowerCase())) {
        trustScore -= 20;
        flags.push({
          type: 'vm',
          severity: 'medium',
          message: `Possible VM environment: ${indicator}`
        });
        break;
      }
    }
  }
  
  // 3. Check for incognito/privacy mode
  if (fingerprint.incognito) {
    trustScore -= 10;
    flags.push({
      type: 'privacy_mode',
      severity: 'low',
      message: 'Privacy/incognito mode detected'
    });
  }
  
  // 4. Check for suspicious screen resolution
  if (fingerprint.screenResolution && 
      SUSPICIOUS_RESOLUTIONS.includes(fingerprint.screenResolution)) {
    trustScore -= 15;
    warnings.push('Unusual screen resolution detected');
    flags.push({
      type: 'suspicious',
      severity: 'medium',
      message: `Suspicious screen resolution: ${fingerprint.screenResolution}`
    });
  }
  
  // 5. Check for missing hardware signals (automation)
  if (!fingerprint.cpuCores || fingerprint.cpuCores === 0) {
    trustScore -= 15;
    warnings.push('CPU cores not detected');
  }
  
  if (!fingerprint.deviceMemory || fingerprint.deviceMemory === 0) {
    trustScore -= 10;
    warnings.push('Device memory not detected');
  }
  
  // 6. Check for missing canvas/webgl (automation/privacy extension)
  if (!fingerprint.canvasHash) {
    trustScore -= 10;
    warnings.push('Canvas fingerprint blocked or unavailable');
  }
  
  if (!fingerprint.webglHash) {
    trustScore -= 5;
    warnings.push('WebGL fingerprint unavailable');
  }
  
  // 7. Check confidence score from fingerprint service
  if (fingerprint.confidence !== undefined && fingerprint.confidence < 0.5) {
    trustScore -= 20;
    warnings.push('Low fingerprint confidence');
    flags.push({
      type: 'suspicious',
      severity: 'medium',
      message: `Low fingerprint confidence: ${Math.round(fingerprint.confidence * 100)}%`
    });
  }
  
  // Ensure trust score is within bounds
  trustScore = Math.max(0, Math.min(100, trustScore));
  
  // Determine if device is valid and trusted
  const isValid = trustScore > TRUST_THRESHOLD_LOW;
  const isTrusted = trustScore >= TRUST_THRESHOLD_MEDIUM;
  
  return {
    isValid,
    isTrusted,
    trustScore,
    warnings,
    flags,
    blockedReason: !isValid ? 'Device failed security validation' : undefined
  };
}

// ========================================
// DATABASE OPERATIONS
// ========================================

/**
 * Store or update device fingerprint for a user
 */
export async function storeDeviceFingerprint(
  userId: string,
  fingerprint: DeviceFingerprint
): Promise<{ success: boolean; isNewDevice: boolean; linkedAccounts: number }> {
  try {
    // Get user's internal ID
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) {
      deviceLogger.error('User not found for fingerprint storage', { userId });
      return { success: false, isNewDevice: false, linkedAccounts: 0 };
    }
    
    // Check how many accounts are linked to this device
    const existingRecords = await prisma.signupRecord.findMany({
      where: { deviceFingerprint: fingerprint.visitorId },
      select: { userId: true }
    });
    
    const linkedAccounts = existingRecords.length;
    const isNewDevice = linkedAccounts === 0;
    
    // Update signup record with device fingerprint
    await prisma.signupRecord.upsert({
      where: { userId: user.id },
      update: {
        deviceFingerprint: fingerprint.visitorId,
        userAgent: `${fingerprint.browserName || ''} ${fingerprint.browserVersion || ''} on ${fingerprint.os || ''}`.trim()
      },
      create: {
        userId: user.id,
        deviceFingerprint: fingerprint.visitorId,
        userAgent: `${fingerprint.browserName || ''} ${fingerprint.browserVersion || ''} on ${fingerprint.os || ''}`.trim()
      }
    });
    
    deviceLogger.info('Device fingerprint stored', { 
      userId, 
      visitorId: fingerprint.visitorId.slice(0, 8) + '...',
      isNewDevice,
      linkedAccounts 
    });
    
    return { success: true, isNewDevice, linkedAccounts };
  } catch (error: any) {
    deviceLogger.error('Failed to store device fingerprint', { error: error.message });
    return { success: false, isNewDevice: false, linkedAccounts: 0 };
  }
}

/**
 * Check if device has exceeded account limit
 */
export async function checkDeviceAccountLimit(
  fingerprint: DeviceFingerprint,
  excludeUserId?: string
): Promise<{ exceeds: boolean; count: number; limit: number }> {
  try {
    const whereClause: any = {
      deviceFingerprint: fingerprint.visitorId
    };
    
    if (excludeUserId) {
      const user = await prisma.user.findUnique({
        where: { clerkId: excludeUserId },
        select: { id: true }
      });
      
      if (user) {
        whereClause.NOT = { userId: user.id };
      }
    }
    
    const count = await prisma.signupRecord.count({
      where: whereClause
    });
    
    return {
      exceeds: count >= MAX_ACCOUNTS_PER_DEVICE,
      count,
      limit: MAX_ACCOUNTS_PER_DEVICE
    };
  } catch (error: any) {
    deviceLogger.error('Failed to check device account limit', { error: error.message });
    return { exceeds: false, count: 0, limit: MAX_ACCOUNTS_PER_DEVICE };
  }
}

/**
 * Get all accounts linked to a device fingerprint
 */
export async function getLinkedAccounts(visitorId: string): Promise<DeviceLinkResult> {
  try {
    const records = await prisma.signupRecord.findMany({
      where: { deviceFingerprint: visitorId },
      select: { 
        user: { 
          select: { clerkId: true, email: true } 
        } 
      }
    });
    
    return {
      linkedAccounts: records.length,
      accountIds: records.map(r => r.user.clerkId),
      isNewDevice: records.length === 0
    };
  } catch (error: any) {
    deviceLogger.error('Failed to get linked accounts', { error: error.message });
    return { linkedAccounts: 0, accountIds: [], isNewDevice: true };
  }
}

/**
 * Block a device fingerprint
 */
export async function blockDevice(
  visitorId: string,
  reason: string,
  blockedBy: string
): Promise<boolean> {
  try {
    // Mark all signup records with this device as suspicious
    await prisma.signupRecord.updateMany({
      where: { deviceFingerprint: visitorId },
      data: {
        isSuspicious: true,
        suspicionReason: reason,
        creditTier: 'blocked'
      }
    });
    
    deviceLogger.info('Device blocked', { 
      visitorId: visitorId.slice(0, 8) + '...', 
      reason, 
      blockedBy 
    });
    
    return true;
  } catch (error: any) {
    deviceLogger.error('Failed to block device', { error: error.message });
    return false;
  }
}

/**
 * Check if a device is blocked
 */
export async function isDeviceBlocked(visitorId: string): Promise<boolean> {
  try {
    const blockedRecord = await prisma.signupRecord.findFirst({
      where: {
        deviceFingerprint: visitorId,
        creditTier: 'blocked'
      }
    });
    
    return blockedRecord !== null;
  } catch (error: any) {
    deviceLogger.error('Failed to check device block status', { error: error.message });
    return false;
  }
}

// ========================================
// COMBINED VALIDATION
// ========================================

/**
 * Validate a device for signup/authentication
 * Combines fingerprint analysis with account checks
 */
export async function validateDeviceForSignup(
  fingerprint: DeviceFingerprint,
  userId?: string
): Promise<{
  allowed: boolean;
  trustScore: number;
  reason?: string;
  warnings: string[];
  flags: DeviceFlag[];
}> {
  // 1. Analyze fingerprint signals
  const analysis = analyzeFingerprint(fingerprint);
  
  // 2. Check if device is blocked
  const isBlocked = await isDeviceBlocked(fingerprint.visitorId);
  if (isBlocked) {
    return {
      allowed: false,
      trustScore: 0,
      reason: 'This device has been blocked due to abuse',
      warnings: analysis.warnings,
      flags: [...analysis.flags, {
        type: 'blocked',
        severity: 'critical',
        message: 'Device is on blocklist'
      }]
    };
  }
  
  // 3. Check account limit
  const accountCheck = await checkDeviceAccountLimit(fingerprint, userId);
  if (accountCheck.exceeds) {
    analysis.flags.push({
      type: 'duplicate',
      severity: 'high',
      message: `Device already linked to ${accountCheck.count} accounts (limit: ${accountCheck.limit})`
    });
    analysis.trustScore -= 30;
    analysis.warnings.push(`Maximum accounts per device exceeded`);
  }
  
  // 4. Final decision
  const allowed = analysis.isValid && !accountCheck.exceeds;
  
  deviceLogger.info('Device validation result', {
    visitorId: fingerprint.visitorId.slice(0, 8) + '...',
    allowed,
    trustScore: analysis.trustScore,
    flagCount: analysis.flags.length
  });
  
  return {
    allowed,
    trustScore: Math.max(0, analysis.trustScore),
    reason: !allowed ? (accountCheck.exceeds 
      ? 'Maximum accounts per device exceeded' 
      : 'Device failed security validation') : undefined,
    warnings: analysis.warnings,
    flags: analysis.flags
  };
}

/**
 * Calculate trust tier based on score
 */
export function getTrustTier(trustScore: number): 'high' | 'medium' | 'low' | 'blocked' {
  if (trustScore >= TRUST_THRESHOLD_HIGH) return 'high';
  if (trustScore >= TRUST_THRESHOLD_MEDIUM) return 'medium';
  if (trustScore >= TRUST_THRESHOLD_LOW) return 'low';
  return 'blocked';
}

/**
 * Get credit tier based on trust score
 * Determines how many free credits a user gets
 */
export function getCreditTier(trustScore: number): 'full' | 'throttled' | 'blocked' {
  if (trustScore >= TRUST_THRESHOLD_HIGH) return 'full';
  if (trustScore >= TRUST_THRESHOLD_LOW) return 'throttled';
  return 'blocked';
}

// ========================================
// EXPORTS
// ========================================

export default {
  analyzeFingerprint,
  storeDeviceFingerprint,
  checkDeviceAccountLimit,
  getLinkedAccounts,
  blockDevice,
  isDeviceBlocked,
  validateDeviceForSignup,
  getTrustTier,
  getCreditTier
};
