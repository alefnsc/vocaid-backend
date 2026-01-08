/**
 * Email Composer Service
 *
 * Pure functions for composing email payloads.
 * No side effects - just builds the data structures needed for sending.
 *
 * @module services/email/emailComposer
 */

import { EMAIL_SENDERS } from '../../templates/emails';
import {
  TEMPLATE_ALIASES,
  getCommonTemplateVariables,
  withCommonVariables,
  type TemplateAlias,
} from './templateManifest';
import { type EmailType } from './emailPolicy';

// ========================================
// TYPES
// ========================================

export interface EmailAttachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface ComposedEmail {
  to: string;
  from: string;
  templateId: TemplateAlias;
  templateVariables: Record<string, any>;
  subject?: string;
  attachments?: EmailAttachment[];
  emailType: EmailType;
  idempotencyKey: string;
  userId: string;
}

export interface UserContext {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  preferredLanguage?: string | null;
}

// ========================================
// IDEMPOTENCY KEY GENERATORS
// ========================================

export function generateWelcomeIdempotencyKey(userId: string): string {
  return `welcome:${userId}`;
}

export function generateFeedbackIdempotencyKey(userId: string, interviewId: string): string {
  return `interview-complete:${userId}:${interviewId}`;
}

export function generatePurchaseIdempotencyKey(provider: string, paymentId: string): string {
  return `purchase:${provider}:${paymentId}`;
}

export function generateLowCreditsIdempotencyKey(userId: string, threshold: number): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `low-credits:${userId}:${threshold}:${dateStr}`;
}

export function generatePasswordResetIdempotencyKey(userId: string, tokenHash: string): string {
  return `password_reset_${userId}_${tokenHash.substring(0, 16)}`;
}

export function generateEmailVerificationIdempotencyKey(userId: string, tokenHash: string): string {
  return `email_verify_${userId}_${tokenHash.substring(0, 16)}`;
}

// ========================================
// LANGUAGE HELPERS
// ========================================

export type SupportedLanguage = 'en' | 'pt';

export function getLanguage(preferredLanguage?: string | null): SupportedLanguage {
  if (!preferredLanguage) return 'en';
  const lang = preferredLanguage.toLowerCase();
  if (lang.startsWith('pt')) return 'pt';
  return 'en';
}

// ========================================
// WELCOME EMAIL COMPOSER
// ========================================

export interface WelcomeEmailData {
  user: UserContext;
  freeCredits?: number;
}

/**
 * Compose a welcome email using the Resend `welcome_b2c` template.
 *
 * @param data - Welcome email data
 * @returns Composed email ready for sending
 */
export function composeWelcomeEmail(data: WelcomeEmailData): ComposedEmail {
  const common = getCommonTemplateVariables();
  const firstName = data.user.firstName?.trim() || 'there';
  const freeCredits = data.freeCredits ?? 1;

  const templateVariables = {
    free_credits: String(freeCredits),
    CANDIDATE_FIRST_NAME: firstName,
    DASHBOARD_URL: common.DASHBOARD_URL,
    CURRENT_YEAR: common.CURRENT_YEAR,
    PRIVACY_URL: common.PRIVACY_URL,
    TERMS_URL: common.TERMS_URL,
  };

  return {
    to: data.user.email,
    from: EMAIL_SENDERS.welcome,
    templateId: TEMPLATE_ALIASES.welcome,
    templateVariables,
    emailType: 'WELCOME',
    idempotencyKey: generateWelcomeIdempotencyKey(data.user.id),
    userId: data.user.id,
  };
}

// ========================================
// FEEDBACK EMAIL COMPOSER
// ========================================

export interface FeedbackEmailData {
  user: UserContext;
  interviewId: string;
  interview: {
    jobTitle?: string | null;
    companyName?: string | null;
    seniority?: string | null;
    language?: string | null;
    duration?: number | null;
    completedAt?: Date | null;
  };
  feedback?: {
    overallScore?: number | null;
    strengths?: Array<{ text: string; timestamp?: string }>;
    improvements?: string[];
    topicsCovered?: string[];
    rubrics?: Array<{
      name: string;
      score: number;
      percentage: number;
      evidenceTimestamp?: string;
      evidenceNote?: string;
    }>;
  };
  pdfAttachment: {
    filename: string;
    content: Buffer;
    contentType?: string;
  };
}

/**
 * Compose a feedback email using the Resend `feedback` template.
 *
 * @param data - Feedback email data including PDF attachment
 * @returns Composed email ready for sending
 */
export function composeFeedbackEmail(data: FeedbackEmailData): ComposedEmail {
  const common = getCommonTemplateVariables();
  const firstName = data.user.firstName?.trim() || 'Candidate';
  const lang = getLanguage(data.user.preferredLanguage);
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US';

  // Build template variables
  const templateVariables: Record<string, any> = {
    // Required
    CANDIDATE_FIRST_NAME: firstName,
    ROLE_TITLE: data.interview.jobTitle?.trim() || 'Interview',
    DASHBOARD_URL: common.DASHBOARD_URL,
    CURRENT_YEAR: common.CURRENT_YEAR,
    PRIVACY_URL: common.PRIVACY_URL,
    TERMS_URL: common.TERMS_URL,
  };

  // Optional interview details
  if (data.interview.companyName?.trim()) {
    templateVariables.TARGET_COMPANY = data.interview.companyName.trim();
  }
  if (data.interview.language?.trim()) {
    templateVariables.INTERVIEW_LANGUAGE = data.interview.language.trim();
  }
  if (data.interview.seniority?.trim()) {
    templateVariables.SENIORITY = data.interview.seniority.trim();
  }
  if (data.interview.duration) {
    templateVariables.DURATION_MIN = String(data.interview.duration);
  }
  if (data.interview.completedAt) {
    const dateFormatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    templateVariables.INTERVIEW_DATE = dateFormatter.format(data.interview.completedAt);
  }

  // Feedback details
  if (data.feedback) {
    if (data.feedback.overallScore !== undefined && data.feedback.overallScore !== null) {
      templateVariables.OVERALL_SCORE = String(data.feedback.overallScore);
    }

    // Topics covered
    if (data.feedback.topicsCovered?.length) {
      templateVariables.TOPICS_COVERED = data.feedback.topicsCovered.join(', ');
    }

    // Strengths (up to 3)
    if (data.feedback.strengths?.length) {
      data.feedback.strengths.slice(0, 3).forEach((strength, index) => {
        const num = index + 1;
        templateVariables[`STRENGTH_${num}`] = strength.text;
        if (strength.timestamp) {
          templateVariables[`STRENGTH_${num}_TS`] = strength.timestamp;
        }
      });
    }

    // Improvements (up to 3)
    if (data.feedback.improvements?.length) {
      data.feedback.improvements.slice(0, 3).forEach((improvement, index) => {
        templateVariables[`IMPROVEMENT_${index + 1}`] = improvement;
      });
    }

    // Rubrics (up to 3)
    if (data.feedback.rubrics?.length) {
      data.feedback.rubrics.slice(0, 3).forEach((rubric, index) => {
        const num = index + 1;
        templateVariables[`RUBRIC_${num}_NAME`] = rubric.name;
        templateVariables[`RUBRIC_${num}_SCORE`] = String(rubric.score);
        templateVariables[`RUBRIC_${num}_PCT`] = String(rubric.percentage);
        if (rubric.evidenceTimestamp) {
          templateVariables[`RUBRIC_${num}_EVIDENCE_TS`] = rubric.evidenceTimestamp;
        }
        if (rubric.evidenceNote) {
          templateVariables[`RUBRIC_${num}_EVIDENCE_NOTE`] = rubric.evidenceNote;
        }
      });
    }
  }

  // Feedback URL
  const frontendUrl = process.env.FRONTEND_URL || 'https://vocaid.ai';
  templateVariables.FEEDBACK_URL = `${frontendUrl}/interviews/${data.interviewId}/feedback`;

  return {
    to: data.user.email,
    from: EMAIL_SENDERS.feedback,
    templateId: TEMPLATE_ALIASES.feedback,
    templateVariables,
    emailType: 'INTERVIEW_COMPLETE',
    idempotencyKey: generateFeedbackIdempotencyKey(data.user.id, data.interviewId),
    userId: data.user.id,
    attachments: [
      {
        filename: data.pdfAttachment.filename,
        content: data.pdfAttachment.content,
        contentType: data.pdfAttachment.contentType || 'application/pdf',
      },
    ],
  };
}

// ========================================
// TRANSACTIONAL EMAIL COMPOSER
// ========================================

export interface TransactionalEmailData {
  user: UserContext;
  emailType: EmailType;
  subject: string;
  preheader: string;
  header: string;
  headerHighlight: string;
  reason: string;
  contentHtml: string;
  idempotencyKey: string;
}

/**
 * Compose a transactional email using the Resend `transactional` template.
 *
 * @param data - Transactional email data with HTML content block
 * @returns Composed email ready for sending
 */
export function composeTransactionalEmail(data: TransactionalEmailData): ComposedEmail {
  const common = getCommonTemplateVariables();

  const templateVariables = withCommonVariables({
    preheader: data.preheader,
    subject: data.subject,
    reason: data.reason,
    header: data.header,
    header_highlight: data.headerHighlight,
    content: data.contentHtml,
  });

  return {
    to: data.user.email,
    from: EMAIL_SENDERS.transactional,
    templateId: TEMPLATE_ALIASES.transactional,
    templateVariables,
    subject: data.subject,
    emailType: data.emailType,
    idempotencyKey: data.idempotencyKey,
    userId: data.user.id,
  };
}

// ========================================
// SPECIFIC TRANSACTIONAL COMPOSERS
// ========================================

export interface PurchaseReceiptData {
  user: UserContext;
  paymentId: string;
  provider: 'mercadopago' | 'paypal';
  creditsAmount: number;
  amountPaid: number;
  currency: string;
  newBalance: number;
  paidAt: Date;
}

/**
 * Compose a purchase receipt email.
 */
export function composePurchaseReceiptEmail(data: PurchaseReceiptData): ComposedEmail {
  const lang = getLanguage(data.user.preferredLanguage);
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US';
  const providerDisplayName = data.provider === 'mercadopago' ? 'Mercado Pago' : 'PayPal';

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const formattedPaidAt = dateFormatter.format(data.paidAt);
  const formattedAmountPaid = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: data.currency,
  }).format(data.amountPaid);

  const labels = {
    creditsPurchased: lang === 'pt' ? 'Créditos comprados' : 'Credits Purchased',
    amountPaid: lang === 'pt' ? 'Valor pago' : 'Amount Paid',
    provider: lang === 'pt' ? 'Provedor' : 'Provider',
    newBalance: lang === 'pt' ? 'Novo saldo' : 'New Balance',
    transactionId: lang === 'pt' ? 'ID da transação' : 'Transaction ID',
    paidAt: lang === 'pt' ? 'Data' : 'Paid At',
  };

  const contentHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${labels.creditsPurchased}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${data.creditsAmount}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${labels.amountPaid}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${formattedAmountPaid}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${labels.provider}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${providerDisplayName}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${labels.newBalance}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${data.newBalance}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${labels.transactionId}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${data.paymentId}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${labels.paidAt}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${formattedPaidAt}</td>
      </tr>
    </table>
  `.trim();

  return composeTransactionalEmail({
    user: data.user,
    emailType: 'CREDITS_PURCHASE_RECEIPT',
    subject: lang === 'pt' ? 'Recibo de compra de créditos' : 'Credits purchase receipt',
    preheader: lang === 'pt'
      ? 'Sua compra foi confirmada e os créditos já estão disponíveis.'
      : 'Your purchase is confirmed and credits are now available.',
    header: lang === 'pt' ? 'Recibo' : 'Receipt',
    headerHighlight: lang === 'pt' ? 'Créditos' : 'Credits',
    reason: lang === 'pt' ? 'Recibo de Compra' : 'Purchase Receipt',
    contentHtml,
    idempotencyKey: generatePurchaseIdempotencyKey(data.provider, data.paymentId),
  });
}

export interface LowCreditsEmailData {
  user: UserContext;
  currentCredits: number;
  threshold: number;
}

/**
 * Compose a low credits warning email.
 */
export function composeLowCreditsEmail(data: LowCreditsEmailData): ComposedEmail {
  const lang = getLanguage(data.user.preferredLanguage);
  const frontendUrl = process.env.FRONTEND_URL || 'https://vocaid.ai';
  const creditsPageUrl = `${frontendUrl}/credits`;
  const firstName = data.user.firstName?.trim() || '';

  const contentHtml = `
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? `Olá${firstName ? ` ${firstName}` : ''},`
        : `Hi${firstName ? ` ${firstName}` : ''},`}
    </p>
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? `Você tem <strong>${data.currentCredits}</strong> crédito${data.currentCredits !== 1 ? 's' : ''} restante${data.currentCredits !== 1 ? 's' : ''}.`
        : `You have <strong>${data.currentCredits}</strong> credit${data.currentCredits !== 1 ? 's' : ''} remaining.`}
    </p>
    <p style="margin:0 0 16px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? 'Recarregue seus créditos para continuar praticando entrevistas com o Vocaid.'
        : 'Top up your credits to keep practicing interviews with Vocaid.'}
    </p>
    <p style="margin:0; font-size:14px;">
      <a href="${creditsPageUrl}" style="color:#6D28D9; font-weight:600; text-decoration:none;">
        ${lang === 'pt' ? 'Comprar créditos' : 'Buy credits'}
      </a>
    </p>
  `.trim();

  return composeTransactionalEmail({
    user: data.user,
    emailType: 'LOW_CREDITS_WARNING',
    subject: lang === 'pt' ? 'Seus créditos estão acabando' : 'Your credits are running low',
    preheader: lang === 'pt'
      ? 'Recarregue agora para continuar praticando sem interrupções.'
      : 'Top up now to keep practicing without interruptions.',
    header: lang === 'pt' ? 'Créditos' : 'Credits',
    headerHighlight: lang === 'pt' ? 'acabando' : 'running low',
    reason: lang === 'pt' ? 'Aviso de créditos' : 'Credits warning',
    contentHtml,
    idempotencyKey: generateLowCreditsIdempotencyKey(data.user.id, data.threshold),
  });
}

export interface PasswordResetEmailData {
  user: UserContext;
  resetToken: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Compose a password reset email.
 */
export function composePasswordResetEmail(data: PasswordResetEmailData): ComposedEmail {
  const lang = getLanguage(data.user.preferredLanguage);
  const frontendUrl = process.env.FRONTEND_URL || 'https://vocaid.ai';
  const resetUrl = `${frontendUrl}/auth/password-confirm?token=${data.resetToken}`;
  const firstName = data.user.firstName?.trim() || '';

  const contentHtml = `
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? `Olá${firstName ? ` ${firstName}` : ''},`
        : `Hi${firstName ? ` ${firstName}` : ''},`}
    </p>
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? 'Recebemos uma solicitação para redefinir a senha da sua conta Vocaid.'
        : 'We received a request to reset your Vocaid account password.'}
    </p>
    <p style="margin:0 0 16px; font-size:14px;">
      <a href="${resetUrl}" style="color:#6D28D9; font-weight:700; text-decoration:none;">
        ${lang === 'pt' ? 'Redefinir senha' : 'Reset password'}
      </a>
    </p>
    <p style="margin:0; font-size:13px; color:#6B7280;">
      ${lang === 'pt'
        ? 'Este link expira em 1 hora. Se você não solicitou esta alteração, ignore este email.'
        : "This link expires in 1 hour. If you didn't request this, you can safely ignore this email."}
    </p>
  `.trim();

  const tokenHash = require('crypto')
    .createHash('sha256')
    .update(data.resetToken)
    .digest('hex');

  return composeTransactionalEmail({
    user: data.user,
    emailType: 'PASSWORD_RESET',
    subject: lang === 'pt' ? 'Redefinir sua senha Vocaid' : 'Reset your Vocaid password',
    preheader: lang === 'pt'
      ? 'Link de redefinição de senha (expira em 1 hora)'
      : 'Password reset link (expires in 1 hour)',
    header: lang === 'pt' ? 'Redefinir' : 'Reset',
    headerHighlight: lang === 'pt' ? 'senha' : 'password',
    reason: lang === 'pt' ? 'Segurança da conta' : 'Account security',
    contentHtml,
    idempotencyKey: generatePasswordResetIdempotencyKey(data.user.id, tokenHash),
  });
}

export interface EmailVerificationData {
  user: UserContext;
  verificationCode: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Compose an email verification email.
 */
export function composeEmailVerificationEmail(data: EmailVerificationData): ComposedEmail {
  const lang = getLanguage(data.user.preferredLanguage);
  const frontendUrl = process.env.FRONTEND_URL || 'https://vocaid.ai';
  const verifyUrl = `${frontendUrl}/auth/verify-email?email=${encodeURIComponent(data.user.email)}`;
  const firstName = data.user.firstName?.trim() || '';

  const contentHtml = `
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? `Olá${firstName ? ` ${firstName}` : ''},`
        : `Hi${firstName ? ` ${firstName}` : ''},`}
    </p>
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? 'Bem-vindo ao Vocaid! Use este código para verificar seu email:'
        : 'Welcome to Vocaid! Use this code to verify your email:'}
    </p>
    <p style="margin:0 0 16px; font-size:22px; font-weight:800; letter-spacing:0.2em; color:#111827;">
      ${data.verificationCode}
    </p>
    <p style="margin:0; font-size:13px; color:#6B7280;">
      <a href="${verifyUrl}" style="color:#6D28D9; font-weight:700; text-decoration:none;">
        ${lang === 'pt' ? 'Abrir página de verificação' : 'Open verification page'}
      </a>
    </p>
  `.trim();

  const tokenHash = require('crypto')
    .createHash('sha256')
    .update(`${data.user.id}:${data.verificationCode}`)
    .digest('hex');

  return composeTransactionalEmail({
    user: data.user,
    emailType: 'EMAIL_VERIFICATION',
    subject: lang === 'pt' ? 'Verifique seu email Vocaid' : 'Verify your Vocaid email',
    preheader: lang === 'pt'
      ? 'Use o código para ativar sua conta.'
      : 'Use the code to activate your account.',
    header: lang === 'pt' ? 'Verifique' : 'Verify',
    headerHighlight: lang === 'pt' ? 'email' : 'email',
    reason: lang === 'pt' ? 'Verificação de email' : 'Email verification',
    contentHtml,
    idempotencyKey: generateEmailVerificationIdempotencyKey(data.user.id, tokenHash),
  });
}
