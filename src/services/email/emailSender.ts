/**
 * Email Sender Service
 *
 * Unified send layer that handles:
 * - Provider mode (live/mock/disabled)
 * - Template variable validation
 * - Resend API calls
 * - Audit logging to TransactionalEmail table
 * - Structured logging
 *
 * @module services/email/emailSender
 */

import logger from '../../utils/logger';
import { prisma } from '../databaseService';
import { type ComposedEmail, type EmailAttachment } from './emailComposer';
import { type EmailType, canSendEmail } from './emailPolicy';
import {
  validateTemplateVariables,
  TemplateValidationError,
  type TemplateAlias,
} from './templateManifest';

const sendLogger = logger.child({ component: 'email-sender' });

// ========================================
// TYPES
// ========================================

export type EmailProviderMode = 'live' | 'mock' | 'disabled';

export interface SendEmailResult {
  success: boolean;
  emailId?: string;
  messageId?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  mode: EmailProviderMode;
}

// ========================================
// PROVIDER MODE
// ========================================

function getEmailProviderMode(): EmailProviderMode {
  const raw = (process.env.EMAIL_PROVIDER_MODE || 'live').toLowerCase();
  if (raw === 'mock') return 'mock';
  if (raw === 'disabled') return 'disabled';
  return 'live';
}

export function isEmailMockMode(): boolean {
  return getEmailProviderMode() === 'mock';
}

export function isEmailDisabled(): boolean {
  return getEmailProviderMode() === 'disabled';
}

// ========================================
// RESEND CLIENT (LAZY INIT)
// ========================================

let resendClient: any = null;
let resendInitialized = false;

function getResendClient(): any {
  if (resendInitialized) return resendClient;
  resendInitialized = true;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    sendLogger.warn('RESEND_API_KEY not set');
    resendClient = null;
    return resendClient;
  }

  try {
    const { Resend } = require('resend');
    resendClient = new Resend(apiKey);
    sendLogger.info('Resend client initialized');
    return resendClient;
  } catch (error: any) {
    sendLogger.error('Failed to initialize Resend', { error: error.message });
    resendClient = null;
    return resendClient;
  }
}

// ========================================
// CORE SEND FUNCTION
// ========================================

interface ResendSendParams {
  to: string;
  from: string;
  subject?: string;
  templateId?: string;
  templateVariables?: Record<string, any>;
  attachments?: Array<{
    filename: string;
    content: string | Buffer;
    contentType?: string;
  }>;
}

async function sendViaResend(
  params: ResendSendParams
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const mode = getEmailProviderMode();

  if (mode === 'disabled') {
    return { success: false, error: 'Email provider disabled' };
  }

  if (mode === 'mock') {
    const messageId = `mock-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    sendLogger.info('MOCK MODE - Email send skipped', {
      to: params.to,
      from: params.from,
      templateId: params.templateId,
      hasAttachments: !!params.attachments?.length,
    });
    return { success: true, messageId };
  }

  const client = getResendClient();
  if (!client) {
    return { success: false, error: 'Resend client not initialized' };
  }

  try {
    // Build the Resend API payload
    // Resend SDK v6+ uses nested `template` object, not separate templateId/templateVariables
    const payload: Record<string, any> = {
      from: params.from,
      to: params.to,
    };

    // For template-based emails, use the `template` object
    if (params.templateId) {
      payload.template = {
        id: params.templateId,
      };

      if (params.templateVariables) {
        // Convert all values to strings (Resend template variables are strings)
        const stringVars: Record<string, string | number> = {};
        for (const [key, value] of Object.entries(params.templateVariables)) {
          if (value !== undefined && value !== null) {
            stringVars[key] = typeof value === 'number' ? value : String(value);
          }
        }
        payload.template.variables = stringVars;
      }
    } else if (params.subject) {
      // Fallback for non-template emails (shouldn't happen in new architecture)
      payload.subject = params.subject;
    }

    if (params.attachments?.length) {
      payload.attachments = params.attachments.map((att) => ({
        filename: att.filename,
        content: att.content instanceof Buffer ? att.content : att.content,
        contentType: att.contentType,
      }));
    }

    // Log outgoing payload shape (redacted)
    sendLogger.debug('Resend API payload', {
      to: params.to.split('@')[0] + '@***',
      from: params.from,
      templateId: params.templateId,
      variableKeys: params.templateVariables ? Object.keys(params.templateVariables) : [],
      attachmentCount: params.attachments?.length || 0,
    });

    const result = await client.emails.send(payload);

    if (result?.error) {
      const errorMessage = result.error?.message || JSON.stringify(result.error);
      sendLogger.warn('Resend send failed', {
        to: params.to,
        templateId: params.templateId,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }

    if (!result?.data?.id) {
      sendLogger.warn('Resend returned no message ID', { to: params.to });
      return { success: false, error: 'No message ID returned' };
    }

    return { success: true, messageId: result.data.id };
  } catch (error: any) {
    sendLogger.error('Resend send exception', {
      error: error.message,
      to: params.to,
      templateId: params.templateId,
    });
    return { success: false, error: error.message };
  }
}

// ========================================
// MAIN SEND EMAIL FUNCTION
// ========================================

/**
 * Send an email with full policy enforcement, validation, and audit logging.
 *
 * Flow:
 * 1. Check consent policy (unless security email)
 * 2. Validate template variables against manifest
 * 3. Check idempotency (skip if already sent)
 * 4. Create/update TransactionalEmail record
 * 5. Send via Resend (or mock/skip based on mode)
 * 6. Update record with result
 *
 * @param email - Composed email from emailComposer
 * @returns Send result with status and message ID
 */
export async function sendEmail(email: ComposedEmail): Promise<SendEmailResult> {
  const mode = getEmailProviderMode();

  // 1. Check consent policy
  const consentCheck = await canSendEmail(email.userId, email.emailType);
  if (!consentCheck.canSend) {
    sendLogger.info('Email blocked by policy', {
      userId: email.userId,
      emailType: email.emailType,
      reason: consentCheck.reason,
    });
    return {
      success: false,
      skipped: true,
      reason: consentCheck.reason,
      mode,
    };
  }

  // 2. Validate template variables
  const validation = validateTemplateVariables(email.templateId, email.templateVariables);
  if (!validation.valid) {
    sendLogger.error('Template validation failed', {
      templateId: email.templateId,
      missingRequired: validation.missingRequired,
      providedKeys: validation.providedKeys,
      userId: email.userId,
      emailType: email.emailType,
    });

    // Create FAILED record for audit
    const failedRecord = await prisma.transactionalEmail.create({
      data: {
        userId: email.userId,
        toEmail: email.to,
        emailType: email.emailType,
        status: 'FAILED',
        provider: 'RESEND',
        idempotencyKey: email.idempotencyKey,
        errorJson: {
          type: 'TEMPLATE_VALIDATION_ERROR',
          missingRequired: validation.missingRequired,
          providedKeys: validation.providedKeys,
        },
      },
    });

    return {
      success: false,
      error: `Missing required template variables: ${validation.missingRequired.join(', ')}`,
      emailId: failedRecord.id,
      mode,
    };
  }

  // 3. Check idempotency
  const existing = await prisma.transactionalEmail.findUnique({
    where: { idempotencyKey: email.idempotencyKey },
  });

  if (existing) {
    if (existing.status === 'SENT') {
      sendLogger.debug('Email already sent - skipping (idempotent)', {
        userId: email.userId,
        emailType: email.emailType,
        existingEmailId: existing.id,
      });
      return {
        success: true,
        skipped: true,
        reason: 'Already sent',
        emailId: existing.id,
        messageId: existing.providerMessageId || undefined,
        mode,
      };
    }

    // Check retry limit
    if (existing.retryCount >= 3) {
      sendLogger.warn('Max retries reached', {
        userId: email.userId,
        emailType: email.emailType,
        retryCount: existing.retryCount,
      });
      return {
        success: false,
        error: 'Max retries reached',
        emailId: existing.id,
        mode,
      };
    }
  }

  // 4. Create or update record as PENDING/SENDING
  const emailRecord = await prisma.transactionalEmail.upsert({
    where: { idempotencyKey: email.idempotencyKey },
    create: {
      userId: email.userId,
      toEmail: email.to,
      emailType: email.emailType,
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey: email.idempotencyKey,
      payloadJson: {
        templateId: email.templateId,
        variableKeys: Object.keys(email.templateVariables),
        hasAttachments: !!email.attachments?.length,
      },
    },
    update: {
      status: 'SENDING',
      retryCount: { increment: 1 },
      updatedAt: new Date(),
    },
  });

  // 5. Send via Resend
  const sendResult = await sendViaResend({
    to: email.to,
    from: email.from,
    subject: email.subject,
    templateId: email.templateId,
    templateVariables: email.templateVariables,
    attachments: email.attachments,
  });

  // 6. Update record with result
  if (sendResult.success) {
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'SENT',
        providerMessageId: sendResult.messageId || null,
        sentAt: new Date(),
      },
    });

    sendLogger.info('Email sent successfully', {
      userId: email.userId,
      emailType: email.emailType,
      templateId: email.templateId,
      messageId: sendResult.messageId,
      mode,
    });

    return {
      success: true,
      emailId: emailRecord.id,
      messageId: sendResult.messageId,
      mode,
    };
  } else {
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: sendResult.error || 'Unknown error' },
      },
    });

    sendLogger.warn('Email send failed', {
      userId: email.userId,
      emailType: email.emailType,
      templateId: email.templateId,
      error: sendResult.error,
      mode,
    });

    return {
      success: false,
      error: sendResult.error,
      emailId: emailRecord.id,
      mode,
    };
  }
}

// ========================================
// BATCH OPERATIONS
// ========================================

/**
 * Send multiple emails (for batch operations like retry).
 * Sends sequentially to avoid rate limiting.
 */
export async function sendEmails(
  emails: ComposedEmail[]
): Promise<{ results: SendEmailResult[]; succeeded: number; failed: number }> {
  const results: SendEmailResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const email of emails) {
    const result = await sendEmail(email);
    results.push(result);
    if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  return { results, succeeded, failed };
}

// ========================================
// EXPORTS
// ========================================

export {
  getEmailProviderMode,
  sendViaResend,
};
