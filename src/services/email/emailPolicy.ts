/**
 * Email Policy Service
 *
 * Single source of truth for email consent and security classification.
 * Determines which emails require consent and which are security/mandatory emails.
 *
 * @module services/email/emailPolicy
 */

import { getConsentStatus } from '../consentService';
import logger from '../../utils/logger';

const policyLogger = logger.child({ component: 'email-policy' });

// ========================================
// EMAIL TYPES
// ========================================

/**
 * All supported email types in the system.
 * Must match the emailType values stored in TransactionalEmail table.
 */
export type EmailType =
  | 'WELCOME'
  | 'INTERVIEW_COMPLETE' // feedback
  | 'CREDITS_PURCHASE_RECEIPT'
  | 'LOW_CREDITS_WARNING'
  | 'PASSWORD_RESET'
  | 'EMAIL_VERIFICATION'
  | 'INTERVIEW_REMINDER';

/**
 * Template categories mapping to Resend dashboard template aliases.
 */
export type TemplateCategory = 'welcome_b2c' | 'feedback' | 'transactional';

/**
 * Map email types to their template categories.
 */
export const EMAIL_TYPE_TO_TEMPLATE: Record<EmailType, TemplateCategory> = {
  WELCOME: 'welcome_b2c',
  INTERVIEW_COMPLETE: 'feedback',
  CREDITS_PURCHASE_RECEIPT: 'transactional',
  LOW_CREDITS_WARNING: 'transactional',
  PASSWORD_RESET: 'transactional',
  EMAIL_VERIFICATION: 'transactional',
  INTERVIEW_REMINDER: 'transactional',
};

// ========================================
// SECURITY / MUST-SEND CLASSIFICATION
// ========================================

/**
 * Security emails that bypass consent requirements.
 * These are critical for account access and security.
 */
const SECURITY_EMAIL_TYPES: Set<EmailType> = new Set([
  'PASSWORD_RESET',
  'EMAIL_VERIFICATION',
]);

/**
 * Must-send transactional emails that bypass marketing consent.
 * These are legally required or essential for the transaction.
 * - Purchase receipts: Required for financial transactions
 * - Welcome: Essential onboarding (can be configured to respect consent)
 */
const MUST_SEND_EMAIL_TYPES: Set<EmailType> = new Set([
  'CREDITS_PURCHASE_RECEIPT',
  // Note: WELCOME could be added here if you want it to always send
  // For now, we respect consent for welcome emails
]);

/**
 * Product emails that are essential to the service delivery.
 * These are sent when the user has used the product (e.g., completed interview).
 * Typically should be sent as they relate directly to user's product usage.
 */
const PRODUCT_ESSENTIAL_EMAIL_TYPES: Set<EmailType> = new Set([
  'INTERVIEW_COMPLETE',
]);

// ========================================
// POLICY FUNCTIONS
// ========================================

/**
 * Check if an email type is a security email (always sent, ignores consent).
 *
 * Security emails include:
 * - Password reset
 * - Email verification
 *
 * @param emailType - The type of email to check
 * @returns true if this is a security email
 */
export function isSecurityEmail(emailType: EmailType): boolean {
  return SECURITY_EMAIL_TYPES.has(emailType);
}

/**
 * Check if an email type is a must-send email (bypasses marketing consent).
 *
 * Must-send emails include:
 * - Security emails (password reset, email verification)
 * - Purchase receipts (legally required)
 *
 * @param emailType - The type of email to check
 * @returns true if this email must be sent regardless of consent
 */
export function isMustSendEmail(emailType: EmailType): boolean {
  return SECURITY_EMAIL_TYPES.has(emailType) || MUST_SEND_EMAIL_TYPES.has(emailType);
}

/**
 * Check if an email type is a product-essential email.
 *
 * Product-essential emails are sent when user has used the product.
 * Currently respects transactional consent, but could be made mandatory.
 *
 * @param emailType - The type of email to check
 * @returns true if this is a product-essential email
 */
export function isProductEssentialEmail(emailType: EmailType): boolean {
  return PRODUCT_ESSENTIAL_EMAIL_TYPES.has(emailType);
}

/**
 * Check if an email type requires user consent.
 *
 * Returns false for:
 * - Security emails (password reset, email verification)
 * - Must-send emails (purchase receipts)
 *
 * Returns true for:
 * - Welcome emails
 * - Low credits warnings
 * - Interview reminders
 * - Feedback emails (respects consent for now)
 *
 * @param emailType - The type of email to check
 * @returns true if consent check should be performed
 */
export function requiresConsent(emailType: EmailType): boolean {
  // Security and must-send emails never require consent
  if (isMustSendEmail(emailType)) {
    return false;
  }

  // Product-essential emails: currently respect consent
  // Change this to `return false` if you want feedback to always send
  if (isProductEssentialEmail(emailType)) {
    return true;
  }

  // All other emails require consent
  return true;
}

/**
 * Get the template category for an email type.
 *
 * @param emailType - The type of email
 * @returns The Resend template alias to use
 */
export function getTemplateCategory(emailType: EmailType): TemplateCategory {
  return EMAIL_TYPE_TO_TEMPLATE[emailType];
}

// ========================================
// CONSENT CHECK
// ========================================

/**
 * Check if an email can be sent to a user based on consent and policy.
 *
 * @param userId - The user's ID
 * @param emailType - The type of email to send
 * @returns Object with canSend boolean and reason if blocked
 */
export async function canSendEmail(
  userId: string,
  emailType: EmailType
): Promise<{ canSend: boolean; reason?: string }> {
  // Security and must-send emails always allowed
  if (isMustSendEmail(emailType)) {
    policyLogger.debug('Email allowed - must-send/security', { userId, emailType });
    return { canSend: true };
  }

  // Check consent for other email types
  try {
    const consentStatus = await getConsentStatus(userId);

    if (!consentStatus.transactionalOptIn) {
      policyLogger.info('Email blocked - user opted out of transactional', {
        userId,
        emailType,
      });
      return {
        canSend: false,
        reason: 'User opted out of transactional emails',
      };
    }

    return { canSend: true };
  } catch (error: any) {
    // On consent check failure, default to allowing the send
    // This prevents email delivery failures due to consent service issues
    policyLogger.warn('Consent check failed - defaulting to allow', {
      userId,
      emailType,
      error: error.message,
    });
    return { canSend: true };
  }
}

// ========================================
// POLICY SUMMARY (for debugging/admin)
// ========================================

/**
 * Get a summary of all email policies for debugging/admin purposes.
 */
export function getPolicySummary(): Array<{
  emailType: EmailType;
  template: TemplateCategory;
  isSecurity: boolean;
  isMustSend: boolean;
  requiresConsent: boolean;
}> {
  const emailTypes: EmailType[] = [
    'WELCOME',
    'INTERVIEW_COMPLETE',
    'CREDITS_PURCHASE_RECEIPT',
    'LOW_CREDITS_WARNING',
    'PASSWORD_RESET',
    'EMAIL_VERIFICATION',
    'INTERVIEW_REMINDER',
  ];

  return emailTypes.map((emailType) => ({
    emailType,
    template: getTemplateCategory(emailType),
    isSecurity: isSecurityEmail(emailType),
    isMustSend: isMustSendEmail(emailType),
    requiresConsent: requiresConsent(emailType),
  }));
}
