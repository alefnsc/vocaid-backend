/**
 * Transactional Email Service (Refactored)
 *
 * This is the main entry point for sending transactional emails.
 * Uses the new 3-layer architecture:
 * - Policy: Consent and security rules
 * - Composer: Pure email composition
 * - Sender: Unified send with validation and logging
 *
 * Template Strategy:
 * - welcome_b2c: Welcome emails with Resend template
 * - feedback: Interview feedback with PDF attachment
 * - transactional: All other emails with {{{content}}} HTML block
 *
 * @module services/transactionalEmailService
 */

import logger from '../utils/logger';
import { prisma } from './databaseService';
import { downloadFeedbackPdf } from './azureBlobService';
import { EMAIL_SENDERS } from '../templates/emails';

// Import from new email module
import {
  // Composer functions
  composeWelcomeEmail,
  composeFeedbackEmail,
  composePurchaseReceiptEmail,
  composeLowCreditsEmail,
  composePasswordResetEmail,
  composeEmailVerificationEmail,
  getLanguage,
  // Sender
  sendEmail,
  getEmailProviderMode,
  isEmailMockMode,
  // Types
  type UserContext,
  type SendEmailResult,
  type SupportedLanguage,
} from './email';

// Re-export for backward compatibility
export { isEmailMockMode };

const emailLogger = logger.child({ component: 'transactional-email' });

// ========================================
// TYPES (Backward Compatible)
// ========================================

export interface UserEmailData {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  preferredLanguage?: string | null;
}

export interface PurchaseEmailData {
  user: UserEmailData;
  paymentId: string;
  provider: 'mercadopago' | 'paypal';
  creditsAmount: number;
  amountPaid: number;
  currency: string;
  newBalance: number;
  paidAt: Date;
}

export interface LowCreditsData {
  user: UserEmailData;
  currentCredits: number;
  threshold: number;
}

export interface InterviewCompleteData {
  user: UserEmailData;
  interviewId: string;
  interviewTitle: string;
  jobRole: string;
  duration: number;
  overallScore?: number;
  feedbackSummary?: string;
}

export interface EmailResult {
  success: boolean;
  emailId?: string;
  messageId?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

export interface PasswordResetEmailData {
  user: {
    id: string;
    email: string;
    firstName?: string;
    preferredLanguage?: string;
  };
  resetToken: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface EmailVerificationData {
  user: {
    id: string;
    email: string;
    firstName?: string;
    preferredLanguage?: string;
  };
  verificationCode: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

// ========================================
// IDEMPOTENCY KEY GENERATORS (Re-export)
// ========================================

export {
  generateWelcomeIdempotencyKey,
  generateFeedbackIdempotencyKey as generateInterviewCompleteIdempotencyKey,
  generatePurchaseIdempotencyKey,
  generateLowCreditsIdempotencyKey,
} from './email';

// ========================================
// CORE EMAIL FUNCTIONS
// ========================================

/**
 * Send welcome email to a new user.
 * Uses Resend template alias: welcome_b2c
 *
 * @param user - User data
 * @param freeCredits - Number of free credits (default: 1)
 */
export async function sendWelcomeEmail(
  user: UserEmailData,
  freeCredits: number = 1
): Promise<EmailResult> {
  emailLogger.info('Sending welcome email', {
    userId: user.id,
    email: user.email,
  });

  const composed = composeWelcomeEmail({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      preferredLanguage: user.preferredLanguage,
    },
    freeCredits,
  });

  const result = await sendEmail(composed);

  return {
    success: result.success,
    emailId: result.emailId,
    messageId: result.messageId,
    error: result.error,
    skipped: result.skipped,
    reason: result.reason,
  };
}

/**
 * Send purchase receipt email.
 * Uses Resend template alias: transactional
 *
 * @param data - Purchase data
 */
export async function sendPurchaseReceiptEmail(data: PurchaseEmailData): Promise<EmailResult> {
  emailLogger.info('Sending purchase receipt email', {
    userId: data.user.id,
    paymentId: data.paymentId,
    provider: data.provider,
  });

  const composed = composePurchaseReceiptEmail({
    user: {
      id: data.user.id,
      email: data.user.email,
      firstName: data.user.firstName,
      lastName: data.user.lastName,
      preferredLanguage: data.user.preferredLanguage,
    },
    paymentId: data.paymentId,
    provider: data.provider,
    creditsAmount: data.creditsAmount,
    amountPaid: data.amountPaid,
    currency: data.currency,
    newBalance: data.newBalance,
    paidAt: data.paidAt,
  });

  const result = await sendEmail(composed);

  return {
    success: result.success,
    emailId: result.emailId,
    messageId: result.messageId,
    error: result.error,
    skipped: result.skipped,
    reason: result.reason,
  };
}

/**
 * Send low credits warning email.
 * Uses Resend template alias: transactional
 *
 * @param data - Low credits data
 */
export async function sendLowCreditsEmail(data: LowCreditsData): Promise<EmailResult> {
  emailLogger.info('Sending low credits email', {
    userId: data.user.id,
    currentCredits: data.currentCredits,
    threshold: data.threshold,
  });

  const composed = composeLowCreditsEmail({
    user: {
      id: data.user.id,
      email: data.user.email,
      firstName: data.user.firstName,
      lastName: data.user.lastName,
      preferredLanguage: data.user.preferredLanguage,
    },
    currentCredits: data.currentCredits,
    threshold: data.threshold,
  });

  const result = await sendEmail(composed);

  return {
    success: result.success,
    emailId: result.emailId,
    messageId: result.messageId,
    error: result.error,
    skipped: result.skipped,
    reason: result.reason,
  };
}

/**
 * Send password reset email.
 * Uses Resend template alias: transactional
 * Security email - bypasses consent check.
 *
 * @param data - Password reset data
 */
export async function sendPasswordResetEmail(data: PasswordResetEmailData): Promise<EmailResult> {
  emailLogger.info('Sending password reset email', {
    userId: data.user.id,
    email: data.user.email,
  });

  // Log reset URL in dev mode
  if (process.env.NODE_ENV === 'development' || getEmailProviderMode() === 'mock') {
    const frontendUrl = process.env.FRONTEND_URL || 'https://vocaid.ai';
    const resetUrl = `${frontendUrl}/auth/password-confirm?token=${data.resetToken}`;
    emailLogger.info('DEV MODE - Password reset URL:', { resetUrl });
  }

  const composed = composePasswordResetEmail({
    user: {
      id: data.user.id,
      email: data.user.email,
      firstName: data.user.firstName,
      preferredLanguage: data.user.preferredLanguage,
    },
    resetToken: data.resetToken,
    expiresAt: data.expiresAt,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
  });

  const result = await sendEmail(composed);

  return {
    success: result.success,
    emailId: result.emailId,
    messageId: result.messageId,
    error: result.error,
    skipped: result.skipped,
    reason: result.reason,
  };
}

/**
 * Send email verification email.
 * Uses Resend template alias: transactional
 * Security email - bypasses consent check.
 *
 * @param data - Email verification data
 */
export async function sendEmailVerificationEmail(data: EmailVerificationData): Promise<EmailResult> {
  emailLogger.info('Sending email verification email', {
    userId: data.user.id,
    email: data.user.email,
  });

  // Log verification code in dev mode
  if (process.env.NODE_ENV === 'development' || getEmailProviderMode() === 'mock') {
    emailLogger.info('DEV MODE - Verification code:', { code: data.verificationCode });
  }

  const composed = composeEmailVerificationEmail({
    user: {
      id: data.user.id,
      email: data.user.email,
      firstName: data.user.firstName,
      preferredLanguage: data.user.preferredLanguage,
    },
    verificationCode: data.verificationCode,
    expiresAt: data.expiresAt,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
  });

  const result = await sendEmail(composed);

  return {
    success: result.success,
    emailId: result.emailId,
    messageId: result.messageId,
    error: result.error,
    skipped: result.skipped,
    reason: result.reason,
  };
}

/**
 * Send interview complete email with feedback PDF.
 * Uses Resend template alias: feedback
 *
 * @param interviewId - Interview ID
 */
export async function sendInterviewCompleteEmail(interviewId: string): Promise<EmailResult> {
  // Fetch interview with all needed data
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    include: {
      feedbackDocument: {
        select: {
          pdfStorageKey: true,
        },
      },
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          preferredLanguage: true,
        },
      },
    },
  });

  if (!interview?.user?.email) {
    return { success: false, error: 'Interview or user email not found' };
  }

  emailLogger.info('Sending interview complete email', {
    userId: interview.user.id,
    interviewId,
  });

  // Check for PDF
  const pdfStorageKey = interview.feedbackDocument?.pdfStorageKey;
  if (!pdfStorageKey) {
    emailLogger.error('Feedback PDF not found', { interviewId });
    return { success: false, error: 'Feedback PDF storage key not found for interview' };
  }

  // Download PDF
  const pdfDownload = await downloadFeedbackPdf(pdfStorageKey);
  if (!pdfDownload.success || !pdfDownload.data) {
    emailLogger.error('Failed to download feedback PDF', {
      interviewId,
      error: pdfDownload.error,
    });
    return { success: false, error: pdfDownload.error || 'Failed to download feedback PDF' };
  }

  // Build filename
  const filenameParts = [interview.seniority, interview.jobTitle, interview.companyName]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join('-');
  const filename = filenameParts
    ? `Vocational Aid - ${filenameParts}.pdf`
    : 'Vocational Aid - Feedback.pdf';

  // Compose email
  const composed = composeFeedbackEmail({
    user: {
      id: interview.user.id,
      email: interview.user.email,
      firstName: interview.user.firstName,
      lastName: interview.user.lastName,
      preferredLanguage: interview.user.preferredLanguage,
    },
    interviewId,
    interview: {
      jobTitle: interview.jobTitle,
      companyName: interview.companyName,
      seniority: interview.seniority,
      language: interview.language,
      completedAt: interview.endedAt, // Use endedAt as completedAt
    },
    pdfAttachment: {
      filename: filename.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim(),
      content: pdfDownload.data,
      contentType: pdfDownload.contentType || 'application/pdf',
    },
  });

  const result = await sendEmail(composed);

  return {
    success: result.success,
    emailId: result.emailId,
    messageId: result.messageId,
    error: result.error,
    skipped: result.skipped,
    reason: result.reason,
  };
}

// ========================================
// ADMIN / DEBUG FUNCTIONS
// ========================================

export interface EmailLogFilters {
  userId?: string;
  emailType?: string;
  status?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

export interface RetryResult {
  totalFailed: number;
  retried: number;
  succeeded: number;
  stillFailing: number;
  details: Array<{
    id: string;
    status: 'retried' | 'max_retries' | 'error';
    error?: string;
  }>;
}

/**
 * Get email events for a user (for debugging)
 */
export async function getEmailEvents(userId?: string, limit: number = 20) {
  const where = userId ? { userId } : {};

  return prisma.transactionalEmail.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      userId: true,
      toEmail: true,
      emailType: true,
      status: true,
      provider: true,
      providerMessageId: true,
      idempotencyKey: true,
      language: true,
      retryCount: true,
      errorJson: true,
      sentAt: true,
      createdAt: true,
    },
  });
}

/**
 * Get email by idempotency key
 */
export async function getEmailByIdempotencyKey(idempotencyKey: string) {
  return prisma.transactionalEmail.findUnique({
    where: { idempotencyKey },
  });
}

/**
 * Get email logs with filtering and pagination for admin dashboard
 */
export async function getEmailLogs(filters: EmailLogFilters = {}) {
  const { userId, emailType, status, fromDate, toDate, limit = 50, offset = 0 } = filters;

  const where: any = {};

  if (userId) where.userId = userId;
  if (emailType) where.emailType = emailType;
  if (status) where.status = status;
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) where.createdAt.gte = fromDate;
    if (toDate) where.createdAt.lte = toDate;
  }

  const [emails, total] = await Promise.all([
    prisma.transactionalEmail.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    }),
    prisma.transactionalEmail.count({ where }),
  ]);

  return {
    emails,
    total,
    limit,
    offset,
    hasMore: offset + emails.length < total,
  };
}

/**
 * Get email statistics for admin dashboard
 */
export async function getEmailStats(fromDate?: Date, toDate?: Date) {
  const dateFilter: any = {};
  if (fromDate || toDate) {
    dateFilter.createdAt = {};
    if (fromDate) dateFilter.createdAt.gte = fromDate;
    if (toDate) dateFilter.createdAt.lte = toDate;
  }

  const [byType, byStatus, recentFailures] = await Promise.all([
    prisma.transactionalEmail.groupBy({
      by: ['emailType'],
      where: dateFilter,
      _count: { id: true },
    }),
    prisma.transactionalEmail.groupBy({
      by: ['status'],
      where: dateFilter,
      _count: { id: true },
    }),
    prisma.transactionalEmail.findMany({
      where: {
        ...dateFilter,
        status: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        toEmail: true,
        emailType: true,
        errorJson: true,
        retryCount: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    byType: Object.fromEntries(byType.map((t) => [t.emailType, t._count.id])),
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count.id])),
    recentFailures,
  };
}

/**
 * Retry failed emails with exponential backoff
 */
export async function retryFailedEmails(maxRetries: number = 3): Promise<RetryResult> {
  const failedEmails = await prisma.transactionalEmail.findMany({
    where: {
      status: 'FAILED',
      retryCount: { lt: maxRetries },
    },
    include: {
      user: true,
    },
  });

  const result: RetryResult = {
    totalFailed: failedEmails.length,
    retried: 0,
    succeeded: 0,
    stillFailing: 0,
    details: [],
  };

  for (const email of failedEmails) {
    try {
      if (!email.toEmail || !email.userId) {
        result.details.push({
          id: email.id,
          status: 'error',
          error: 'No email address or user ID available',
        });
        result.stillFailing++;
        continue;
      }

      let sendResult: EmailResult;
      const user: UserEmailData = {
        id: email.userId,
        email: email.toEmail,
        firstName: email.user?.firstName,
        lastName: email.user?.lastName,
        preferredLanguage: email.language || undefined,
      };

      switch (email.emailType) {
        case 'WELCOME':
          sendResult = await sendWelcomeEmail(user);
          break;

        case 'CREDITS_PURCHASE_RECEIPT':
          const payload = email.payloadJson as any;
          sendResult = await sendPurchaseReceiptEmail({
            user,
            paymentId: payload?.paymentId || email.id,
            provider: payload?.provider || 'mercadopago',
            creditsAmount: payload?.creditsAmount || 0,
            amountPaid: payload?.amountPaid || 0,
            currency: payload?.currency || 'USD',
            newBalance: payload?.newBalance || 0,
            paidAt: new Date(),
          });
          break;

        case 'LOW_CREDITS_WARNING':
          const lcPayload = email.payloadJson as any;
          sendResult = await sendLowCreditsEmail({
            user,
            currentCredits: lcPayload?.currentCredits || 0,
            threshold: lcPayload?.threshold || 1,
          });
          break;

        case 'INTERVIEW_COMPLETE':
          const icPayload = email.payloadJson as any;
          if (icPayload?.interviewId) {
            sendResult = await sendInterviewCompleteEmail(icPayload.interviewId);
          } else {
            sendResult = { success: false, error: 'No interview ID in payload' };
          }
          break;

        default:
          sendResult = { success: false, error: `Unsupported email type: ${email.emailType}` };
      }

      if (sendResult.success) {
        result.succeeded++;
        result.details.push({ id: email.id, status: 'retried' });
      } else {
        result.stillFailing++;
        result.details.push({ id: email.id, status: 'error', error: sendResult.error });
      }

      result.retried++;
    } catch (error: any) {
      result.stillFailing++;
      result.details.push({ id: email.id, status: 'error', error: error.message });
    }
  }

  return result;
}

// ========================================
// LEGACY EXPORTS (for backward compatibility)
// ========================================

// These are deprecated - use the new email module directly
export type { SupportedLanguage };
export { getLanguage };
