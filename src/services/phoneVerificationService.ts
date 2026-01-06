/**
 * Phone Verification Service
 * 
 * Provides SMS OTP verification for user authentication.
 * Uses Twilio Verify API for secure, reliable phone verification.
 * 
 * Features:
 * - Send OTP codes via SMS
 * - Verify OTP codes
 * - Phone number validation and normalization
 * - Rate limiting for abuse prevention
 * - Phone number uniqueness enforcement
 * - Multiple language support for SMS messages
 * 
 * @module services/phoneVerificationService
 */

import logger from '../utils/logger';
import { PrismaClient } from '@prisma/client';
import redisService from './azureRedisService';

const prisma = new PrismaClient();

// Create phone verification logger
const phoneLogger = logger.child({ component: 'phone-verification' });

// ========================================
// INTERFACES
// ========================================

export interface PhoneVerificationResult {
  success: boolean;
  status: 'pending' | 'approved' | 'canceled' | 'expired' | 'failed' | 'max_attempts_reached';
  error?: string;
  verificationSid?: string;
}

export interface SendOTPResult {
  success: boolean;
  verificationSid?: string;
  error?: string;
  rateLimited?: boolean;
  remainingAttempts?: number;
}

export interface VerifyOTPResult {
  success: boolean;
  valid: boolean;
  error?: string;
  attemptsRemaining?: number;
}

export interface PhoneCheckResult {
  isValid: boolean;
  isUnique: boolean;
  formattedNumber: string;
  countryCode: string;
  error?: string;
}

// ========================================
// CONFIGURATION
// ========================================

// Rate limiting configuration
const MAX_OTP_REQUESTS_PER_HOUR = 5;
const MAX_VERIFICATION_ATTEMPTS = 3;
const OTP_EXPIRY_MINUTES = 10;

// In-memory rate limiting (in production, use Redis)
const otpRequestCounts = new Map<string, { count: number; resetTime: number }>();
const verificationAttempts = new Map<string, { count: number; lastAttempt: number }>();

const PHONE_SKIP_FOR_CREDITS_KEY = (userId: string) => `phone:skip_for_credits:${userId}`;
const PHONE_SKIP_FOR_CREDITS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Twilio client (lazy-loaded)
let twilioClient: any = null;
let twilioInitialized = false;

/**
 * Initialize Twilio client with API Key auth (required).
 * 
 * Required env vars:
 *   - TWILIO_ACCOUNT_SID: Twilio Account SID (starts with AC)
 *   - TWILIO_API_SID: API Key SID (starts with SK)
 *   - TWILIO_API_SECRET: API Key Secret
 *   - TWILIO_VERIFY_SERVICE_SID: Verify Service SID (starts with VA)
 * 
 * Note: TWILIO_AUTH_TOKEN is deprecated and no longer used.
 */
function getTwilioClient(): any {
  if (twilioInitialized) return twilioClient;
  
  twilioInitialized = true;
  
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_SID;
  const apiKeySecret = process.env.TWILIO_API_SECRET;
  
  // Require API Key auth (more secure, revocable)
  if (accountSid && apiKeySid && apiKeySecret) {
    try {
      const twilio = require('twilio');
      twilioClient = twilio(apiKeySid, apiKeySecret, { accountSid });
      phoneLogger.info('Twilio client initialized with API Key auth');
    } catch (error: any) {
      phoneLogger.error('Failed to initialize Twilio with API Key', { error: error.message });
      twilioClient = null;
    }
  } 
  // Missing credentials
  else {
    const missing = [];
    if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
    if (!apiKeySid) missing.push('TWILIO_API_SID');
    if (!apiKeySecret) missing.push('TWILIO_API_SECRET');
    
    if (process.env.NODE_ENV === 'production') {
      phoneLogger.error('Twilio API Key credentials missing - phone verification disabled', { missing });
    } else {
      phoneLogger.warn('Twilio API Key credentials not set - SMS verification will be simulated', { missing });
    }
  }
  
  return twilioClient;
}

// Twilio Verify Service SID
const getVerifyServiceSid = (): string => {
  return process.env.TWILIO_VERIFY_SERVICE_SID || '';
};

// ========================================
// PHONE NUMBER UTILITIES
// ========================================

/**
 * Validate and format phone number to E.164 format
 */
export function formatPhoneNumber(phoneNumber: string, defaultCountryCode: string = '+1'): PhoneCheckResult {
  try {
    // Remove all non-digit characters except +
    let cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    // If no + prefix, add default country code
    if (!cleaned.startsWith('+')) {
      // If it's a 10-digit number, assume US/CA
      if (cleaned.length === 10) {
        cleaned = defaultCountryCode + cleaned;
      } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
        cleaned = '+' + cleaned;
      } else {
        cleaned = defaultCountryCode + cleaned;
      }
    }
    
    // Basic E.164 validation (+ followed by 10-15 digits)
    const e164Regex = /^\+[1-9]\d{9,14}$/;
    if (!e164Regex.test(cleaned)) {
      return {
        isValid: false,
        isUnique: false,
        formattedNumber: cleaned,
        countryCode: '',
        error: 'Invalid phone number format'
      };
    }
    
    // Extract country code (rough estimate)
    let countryCode = '';
    if (cleaned.startsWith('+1')) countryCode = 'US';
    else if (cleaned.startsWith('+55')) countryCode = 'BR';
    else if (cleaned.startsWith('+34')) countryCode = 'ES';
    else if (cleaned.startsWith('+33')) countryCode = 'FR';
    else if (cleaned.startsWith('+86')) countryCode = 'CN';
    else if (cleaned.startsWith('+7')) countryCode = 'RU';
    else if (cleaned.startsWith('+91')) countryCode = 'IN';
    else if (cleaned.startsWith('+52')) countryCode = 'MX';
    else if (cleaned.startsWith('+44')) countryCode = 'GB';
    else if (cleaned.startsWith('+49')) countryCode = 'DE';
    else if (cleaned.startsWith('+81')) countryCode = 'JP';
    else countryCode = 'OTHER';
    
    return {
      isValid: true,
      isUnique: true, // Will be checked separately
      formattedNumber: cleaned,
      countryCode
    };
  } catch (error: any) {
    return {
      isValid: false,
      isUnique: false,
      formattedNumber: phoneNumber,
      countryCode: '',
      error: error.message
    };
  }
}

/**
 * Check if a phone number is already registered
 * 
 * Checks User table for existing verified phone (phone stored only after OTP verification)
 */
export async function checkPhoneUniqueness(phoneNumber: string): Promise<boolean> {
  try {
    const formatted = formatPhoneNumber(phoneNumber);
    if (!formatted.isValid) return false;
    
    // Check in User table for existing verified phone
    const existingUser = await prisma.user.findFirst({
      where: {
        phoneNumber: formatted.formattedNumber,
        phoneVerified: true
      }
    });
    
    return existingUser === null;
  } catch (error: any) {
    phoneLogger.error('Error checking phone uniqueness', { error: error.message });
    return false;
  }
}

// ========================================
// RATE LIMITING
// ========================================

/**
 * Check if phone number is rate limited for OTP requests
 */
function isRateLimited(phoneNumber: string): { limited: boolean; remainingAttempts: number } {
  const now = Date.now();
  const record = otpRequestCounts.get(phoneNumber);
  
  if (!record || now > record.resetTime) {
    // Reset or new entry
    otpRequestCounts.set(phoneNumber, { count: 1, resetTime: now + 3600000 }); // 1 hour
    return { limited: false, remainingAttempts: MAX_OTP_REQUESTS_PER_HOUR - 1 };
  }
  
  if (record.count >= MAX_OTP_REQUESTS_PER_HOUR) {
    return { limited: true, remainingAttempts: 0 };
  }
  
  record.count++;
  return { limited: false, remainingAttempts: MAX_OTP_REQUESTS_PER_HOUR - record.count };
}

/**
 * Track verification attempts
 */
function trackVerificationAttempt(phoneNumber: string): { allowed: boolean; attemptsRemaining: number } {
  const now = Date.now();
  const record = verificationAttempts.get(phoneNumber);
  
  // Reset after 30 minutes
  if (!record || now - record.lastAttempt > 1800000) {
    verificationAttempts.set(phoneNumber, { count: 1, lastAttempt: now });
    return { allowed: true, attemptsRemaining: MAX_VERIFICATION_ATTEMPTS - 1 };
  }
  
  if (record.count >= MAX_VERIFICATION_ATTEMPTS) {
    return { allowed: false, attemptsRemaining: 0 };
  }
  
  record.count++;
  record.lastAttempt = now;
  return { allowed: true, attemptsRemaining: MAX_VERIFICATION_ATTEMPTS - record.count };
}

/**
 * Clear verification attempts after successful verification
 */
function clearVerificationAttempts(phoneNumber: string): void {
  verificationAttempts.delete(phoneNumber);
  otpRequestCounts.delete(phoneNumber);
}

// ========================================
// SMS LANGUAGE SUPPORT
// ========================================

const smsLanguageCodes: Record<string, string> = {
  'en-US': 'en',
  'pt-BR': 'pt-br',
  'es-ES': 'es',
  'fr-FR': 'fr',
  'zh-CN': 'zh',
  'ru-RU': 'ru',
  'hi-IN': 'hi'
};

// ========================================
// OTP FUNCTIONS
// ========================================

/**
 * Send OTP code via SMS using Twilio Verify
 */
export async function sendOTP(
  phoneNumber: string, 
  userId?: string,
  language: string = 'en-US'
): Promise<SendOTPResult> {
  const formatted = formatPhoneNumber(phoneNumber);
  
  if (!formatted.isValid) {
    return { 
      success: false, 
      error: formatted.error || 'Invalid phone number' 
    };
  }
  
  // Check rate limiting
  const rateCheck = isRateLimited(formatted.formattedNumber);
  if (rateCheck.limited) {
    phoneLogger.warn('Rate limited OTP request', { phoneNumber: formatted.formattedNumber });
    return { 
      success: false, 
      error: 'Too many requests. Please try again later.',
      rateLimited: true,
      remainingAttempts: 0
    };
  }
  
  // Check phone uniqueness if this is for new registration
  if (userId) {
    const isUnique = await checkPhoneUniqueness(formatted.formattedNumber);
    if (!isUnique) {
      phoneLogger.warn('Phone already registered', { phoneNumber: formatted.formattedNumber });
      return { 
        success: false, 
        error: 'This phone number is already registered with another account.' 
      };
    }
  }
  
  phoneLogger.info('Sending OTP', { 
    phoneNumber: formatted.formattedNumber.slice(0, -4) + '****',
    countryCode: formatted.countryCode,
    language
  });
  
  const client = getTwilioClient();
  const verifyServiceSid = getVerifyServiceSid();
  
  // If Twilio is not configured, simulate for development
  if (!client || !verifyServiceSid) {
    phoneLogger.warn('Twilio not configured - simulating OTP send', {
      phoneNumber: formatted.formattedNumber.slice(0, -4) + '****'
    });
    return { 
      success: true, 
      verificationSid: `mock-${Date.now()}`,
      remainingAttempts: rateCheck.remainingAttempts
    };
  }
  
  try {
    const verification = await client.verify.v2
      .services(verifyServiceSid)
      .verifications.create({
        to: formatted.formattedNumber,
        channel: 'sms',
        locale: smsLanguageCodes[language] || 'en'
      });
    
    phoneLogger.info('OTP sent successfully', { 
      verificationSid: verification.sid,
      status: verification.status
    });
    
    return { 
      success: true, 
      verificationSid: verification.sid,
      remainingAttempts: rateCheck.remainingAttempts
    };
  } catch (error: any) {
    phoneLogger.error('Failed to send OTP', { 
      error: error.message, 
      code: error.code,
      moreInfo: error.moreInfo 
    });
    
    // Handle specific Twilio Verify errors
    // See: https://www.twilio.com/docs/verify/api/verification#verify-error-codes
    
    // 60200: Invalid phone number format
    if (error.code === 60200) {
      return { success: false, error: 'Invalid phone number format' };
    }
    
    // 60203: Max attempts reached for this phone
    if (error.code === 60203) {
      return { success: false, error: 'Maximum send attempts reached. Please try again later.', rateLimited: true };
    }
    
    // 60205: SMS not supported for this phone (landline/VoIP)
    if (error.code === 60205) {
      return { success: false, error: 'This phone number cannot receive SMS. Please use a mobile number.' };
    }
    
    // 60212: Invalid destination (carrier rejection)
    if (error.code === 60212) {
      return { success: false, error: 'This phone number cannot receive verification codes.' };
    }
    
    // 60410: Verification delivery attempt blocked (fraud prevention)
    if (error.code === 60410) {
      return { success: false, error: 'Verification temporarily blocked. Please try again later.' };
    }
    
    // Generic fallback
    return { success: false, error: 'Failed to send verification code. Please try a different number.' };
  }
}

/**
 * Verify OTP code using Twilio Verify
 */
export async function verifyOTP(
  phoneNumber: string, 
  code: string,
  userId?: string
): Promise<VerifyOTPResult> {
  const formatted = formatPhoneNumber(phoneNumber);
  
  if (!formatted.isValid) {
    return { 
      success: false, 
      valid: false,
      error: formatted.error || 'Invalid phone number' 
    };
  }
  
  // Validate code format (6 digits)
  if (!/^\d{6}$/.test(code)) {
    return { 
      success: false, 
      valid: false,
      error: 'Invalid verification code format. Please enter 6 digits.' 
    };
  }
  
  // Check verification attempts
  const attemptCheck = trackVerificationAttempt(formatted.formattedNumber);
  if (!attemptCheck.allowed) {
    phoneLogger.warn('Max verification attempts reached', { phoneNumber: formatted.formattedNumber });
    return { 
      success: false, 
      valid: false,
      error: 'Too many failed attempts. Please request a new code.',
      attemptsRemaining: 0
    };
  }
  
  phoneLogger.info('Verifying OTP', { 
    phoneNumber: formatted.formattedNumber.slice(0, -4) + '****'
  });
  
  const client = getTwilioClient();
  const verifyServiceSid = getVerifyServiceSid();
  
  // If Twilio is not configured, simulate for development (accept 123456 as test code)
  if (!client || !verifyServiceSid) {
    const isValid = code === '123456';
    phoneLogger.warn('Twilio not configured - simulating OTP verification', { 
      isValid,
      phoneNumber: formatted.formattedNumber.slice(0, -4) + '****'
    });
    
    if (isValid) {
      clearVerificationAttempts(formatted.formattedNumber);
      
      // Mark phone as verified in database
      if (userId) {
        await markPhoneAsVerified(userId, formatted.formattedNumber);
      }
    }
    
    return { 
      success: true, 
      valid: isValid,
      attemptsRemaining: attemptCheck.attemptsRemaining
    };
  }
  
  try {
    const verificationCheck = await client.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({
        to: formatted.formattedNumber,
        code
      });
    
    const isValid = verificationCheck.status === 'approved';
    
    phoneLogger.info('OTP verification result', { 
      status: verificationCheck.status,
      isValid
    });
    
    if (isValid) {
      clearVerificationAttempts(formatted.formattedNumber);
      
      // Mark phone as verified in database
      if (userId) {
        await markPhoneAsVerified(userId, formatted.formattedNumber);
      }
    }
    
    return { 
      success: true, 
      valid: isValid,
      attemptsRemaining: isValid ? undefined : attemptCheck.attemptsRemaining
    };
  } catch (error: any) {
    phoneLogger.error('Failed to verify OTP', { error: error.message });
    
    // Handle specific Twilio errors
    if (error.code === 20404) {
      return { 
        success: false, 
        valid: false, 
        error: 'Verification code expired. Please request a new code.',
        attemptsRemaining: attemptCheck.attemptsRemaining
      };
    }
    
    return { 
      success: false, 
      valid: false, 
      error: 'Failed to verify code',
      attemptsRemaining: attemptCheck.attemptsRemaining
    };
  }
}

// ========================================
// DATABASE OPERATIONS
// ========================================

/**
 * Mark a user's phone number as verified
 * 
 * IMPORTANT: Phone number is stored on User table ONLY after successful OTP verification.
 * This prevents phone number "reservation" before actual verification.
 */
async function markPhoneAsVerified(userId: string, phoneNumber: string): Promise<void> {
  try {
    // Update User directly with phone verification data
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber,
        phoneVerified: true,
        phoneVerifiedAt: new Date()
      }
    });
    
    if (!updatedUser) {
      phoneLogger.error('User not found for phone verification', { userId });
      return;
    }
    
    phoneLogger.info('Phone marked as verified on User', { 
      userId, 
      phoneNumber: phoneNumber.slice(0, -4) + '****',
      userDbId: updatedUser.id
    });

    // If user verifies later, clear the "skipped" preference.
    await redisService.del(PHONE_SKIP_FOR_CREDITS_KEY(userId));
  } catch (error: any) {
    phoneLogger.error('Failed to mark phone as verified', { error: error.message, userId });
  }
}

/**
 * Get user's phone verification status
 * 
 * Reads from User table (phone data stored after OTP verification)
 */
export async function getPhoneVerificationStatus(userId: string): Promise<{
  hasPhone: boolean;
  isVerified: boolean;
  phoneCreditsGranted: boolean;
  phoneVerificationSkippedForCredits: boolean;
  phoneNumber?: string;
  verifiedAt?: Date;
}> {
  try {
    const skip = await redisService.get<{ skipped: boolean; skippedAt: string }>(
      PHONE_SKIP_FOR_CREDITS_KEY(userId)
    );

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { 
        phoneNumber: true,
        phoneVerified: true,
        phoneVerifiedAt: true
      }
    });
    
    if (!user) {
      return { hasPhone: false, isVerified: false, phoneCreditsGranted: false, phoneVerificationSkippedForCredits: false };
    }
    
    return {
      hasPhone: !!user.phoneNumber,
      isVerified: user.phoneVerified || false,
      // Canonical schema does not track phone-credit flags in UserConsent.
      phoneCreditsGranted: false,
      phoneVerificationSkippedForCredits: (skip?.skipped === true) && user.phoneVerified !== true,
      phoneNumber: user.phoneNumber ? user.phoneNumber.slice(0, -4) + '****' : undefined,
      verifiedAt: user.phoneVerifiedAt || undefined
    };
  } catch (error: any) {
    phoneLogger.error('Failed to get phone verification status', { error: error.message });
    return { hasPhone: false, isVerified: false, phoneCreditsGranted: false, phoneVerificationSkippedForCredits: false };
  }
}

/**
 * Mark that user skipped phone verification for credits during onboarding
 * 
 * This is stored in UserConsent and used for dashboard CTA targeting
 */
export async function skipPhoneVerificationForCredits(userId: string): Promise<boolean> {
  try {
    await redisService.set(
      PHONE_SKIP_FOR_CREDITS_KEY(userId),
      { skipped: true, skippedAt: new Date().toISOString() },
      PHONE_SKIP_FOR_CREDITS_TTL_SECONDS
    );

    phoneLogger.info('Phone verification skipped for credits (cached)', { userId });
    return true;
  } catch (error: any) {
    phoneLogger.error('Failed to mark phone verification as skipped', { error: error.message });
    return false;
  }
}

/**
 * Clear the skip flag (called when user successfully verifies phone)
 */
export async function clearPhoneVerificationSkip(userId: string): Promise<void> {
  try {
    await redisService.del(PHONE_SKIP_FOR_CREDITS_KEY(userId));
    phoneLogger.info('Phone verification skip flag cleared (cached)', { userId });
  } catch (error: any) {
    phoneLogger.warn('Failed to clear phone verification skip flag', { error: error.message });
  }
}

/**
 * Remove phone verification (for admin or user request)
 * 
 * Clears phone data from User table
 */
export async function removePhoneVerification(userId: string): Promise<boolean> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber: null,
        phoneVerified: false,
        phoneVerifiedAt: null
      }
    });
    
    phoneLogger.info('Phone verification removed from User', { userId });
    return true;
  } catch (error: any) {
    phoneLogger.error('Failed to remove phone verification', { error: error.message });
    return false;
  }
}

// ========================================
// ABUSE PREVENTION
// ========================================

/**
 * Check if a phone number is blocked.
 * 
 * NOTE: Internal blocklist is disabled. VoIP/carrier detection is delegated
 * to Twilio Verify, which will reject undeliverable numbers during send.
 * This function always returns false to avoid false positives.
 * 
 * If you need blocklisting in the future:
 * 1. Add a BlockedPhone model to Prisma schema
 * 2. Re-implement the DB lookup here
 */
export async function isPhoneBlocked(_phoneNumber: string): Promise<boolean> {
  // Blocklist disabled - Twilio handles carrier/VoIP rejections
  return false;
}

/**
 * Block a phone number (no-op).
 * 
 * NOTE: Internal blocklist is disabled. This function is a no-op.
 * Twilio Verify handles carrier-level rejections.
 */
export async function blockPhone(
  _phoneNumber: string, 
  _reason: string,
  _blockedBy: string
): Promise<boolean> {
  phoneLogger.warn('blockPhone called but internal blocklist is disabled');
  return false;
}

// ========================================
// EXPORTS
// ========================================

export default {
  formatPhoneNumber,
  checkPhoneUniqueness,
  sendOTP,
  verifyOTP,
  getPhoneVerificationStatus,
  skipPhoneVerificationForCredits,
  clearPhoneVerificationSkip,
  removePhoneVerification,
  isPhoneBlocked,
  blockPhone
};
