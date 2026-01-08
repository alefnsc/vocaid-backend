/**
 * Transactional Email Service
 *
 * Sends product emails via Resend and records audit logs in `TransactionalEmail`.
 * This service supports Resend dashboard templates by alias (e.g. `transactional`).
 */

import logger from '../utils/logger';
import { prisma } from './databaseService';
import { EMAIL_SENDERS, getCommonVariables, loadAndRenderTemplate, type TemplateLanguage } from '../templates/emails';
import { getConsentStatus } from './consentService';
import { downloadFeedbackPdf } from './azureBlobService';

// Logger
const emailLogger = logger.child({ component: 'transactional-email' });

// Environment
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://vocaid.ai';

// Resend dashboard template aliases
const RESEND_WELCOME_TEMPLATE_ID = 'welcome_b2c';

// Common variables (string values)
const COMMON_VARS = getCommonVariables();
const PRIVACY_URL = String(COMMON_VARS.PRIVACY_URL);
const TERMS_URL = String(COMMON_VARS.TERMS_URL);
const SUPPORT_EMAIL = String(COMMON_VARS.SUPPORT_EMAIL);

type EmailProviderMode = 'live' | 'mock' | 'disabled';

function getEmailProviderMode(): EmailProviderMode {
  const raw = (process.env.EMAIL_PROVIDER_MODE || 'live').toLowerCase();
  if (raw === 'mock') return 'mock';
  if (raw === 'disabled') return 'disabled';
  return 'live';
}

export function isEmailMockMode(): boolean {
  return getEmailProviderMode() === 'mock';
}

// Lazy Resend init
let resend: any = null;
let resendInitialized = false;

function getResendClient(): any {
  if (resendInitialized) return resend;
  resendInitialized = true;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    emailLogger.warn('RESEND_API_KEY not set');
    resend = null;
    return resend;
  }

  try {
    const { Resend } = require('resend');
    resend = new Resend(apiKey);
    return resend;
  } catch (error: any) {
    emailLogger.error('Failed to initialize Resend', { error: error.message });
    resend = null;
    return resend;
  }
}

async function canSendTransactional(userId: string): Promise<boolean> {
  try {
    const status = await getConsentStatus(userId);
    return status.transactionalOptIn;
  } catch (error: any) {
    emailLogger.warn('Consent check failed; defaulting to allow send', { userId, error: error.message });
    return true;
  }
}

type ResendAttachment = {
  filename: string;
  content: string | Buffer;
  contentType?: string;
};

function compactAndJoinWithDash(parts: Array<string | null | undefined>): string {
  return parts
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join('-');
}

function sanitizeFilename(value: string): string {
  // Remove characters that are problematic across common file systems.
  return value
    .replace(/[\\/\n\r\t:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFeedbackPdfFilenameFromInterview(interview: {
  seniority?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
}): string {
  const joined = compactAndJoinWithDash([interview.seniority, interview.jobTitle, interview.companyName]);
  const base = joined ? `Vocational Aid - ${joined}` : 'Vocational Aid - Feedback';
  return sanitizeFilename(base);
}

type SendViaResendParams = {
  to: string;
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
  templateId?: string;
  templateVariables?: Record<string, any>;
  attachments?: ResendAttachment[];
};

async function sendViaResend(params: SendViaResendParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const mode = getEmailProviderMode();
  if (mode === 'disabled') {
    return { success: false, error: 'Email provider disabled' };
  }

  if (mode === 'mock') {
    const messageId = `mock-${Date.now()}`;
    emailLogger.info('MOCK MODE - Email send skipped', {
      to: params.to,
      from: params.from,
      subject: params.subject,
      templateId: params.templateId,
    });
    return { success: true, messageId };
  }

  const client = getResendClient();
  if (!client) {
    return { success: false, error: 'Resend client not initialized' };
  }

  try {
    const result = await client.emails.send({
      from: params.from || EMAIL_SENDERS.transactional,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      attachments: params.attachments,
      templateId: params.templateId,
      templateVariables: params.templateVariables,
    });

    if (result?.error) {
      emailLogger.warn('Resend send failed', {
        to: params.to,
        error: result.error?.message || JSON.stringify(result.error),
      });
      return { success: false, error: result.error?.message || JSON.stringify(result.error) };
    }

    if (!result?.data?.id) {
      emailLogger.warn('Resend returned no message ID', { to: params.to });
      return { success: false, error: 'No message ID returned' };
    }

    return { success: true, messageId: result.data.id };
  } catch (error: any) {
    emailLogger.error('Resend send exception', { error: error.message, to: params.to });
    return { success: false, error: error.message };
  }
}

// ========================================
// TYPES
// ========================================

export interface UserEmailData {
  id: string;           // DB UUID
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

function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    // Fallback if currency code is invalid
    return `${currency} ${amount.toFixed(2)}`;
  }
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
  duration: number; // in minutes
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

type SupportedLanguage = 'en' | 'pt';

// ========================================
// LANGUAGE DETECTION
// ========================================

function getLanguage(preferredLanguage?: string | null): SupportedLanguage {
  if (!preferredLanguage) return 'en';
  const lang = preferredLanguage.toLowerCase();
  if (lang.startsWith('pt')) return 'pt';
  // Add more languages as needed
  return 'en';
}

type TransactionalTemplateVariables = {
  preheader: string;
  subject: string;
  reason: string;
  header: string;
  header_highlight: string;
  content: string;
} & Record<string, string | number>;

function buildTransactionalTemplateVariables(vars: {
  preheader: string;
  subject: string;
  reason: string;
  header: string;
  header_highlight: string;
  content: string;
}): TransactionalTemplateVariables {
  return {
    ...(getCommonVariables() as Record<string, string | number>),
    ...vars,
  };
}

async function sendTransactionalTemplateEmail(params: {
  to: string;
  from?: string;
  templateVariables: TransactionalTemplateVariables;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  return sendViaResend({
    to: params.to,
    from: params.from || EMAIL_SENDERS.transactional,
    subject: String(params.templateVariables.subject),
    templateId: 'transactional',
    templateVariables: params.templateVariables,
  });
}

// ========================================
// EMAIL TEMPLATES
// ========================================

const welcomeTemplates: Record<SupportedLanguage, {
  subject: string;
  html: (data: { firstName: string; dashboardUrl: string; supportEmail: string }) => string;
  text: (data: { firstName: string; dashboardUrl: string; supportEmail: string }) => string;
}> = {
  en: {
    subject: 'Welcome to Vocaid – Your AI Interview Coach',
    html: ({ firstName, dashboardUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Vocaid</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: #71717a;">AI-Powered Interview Practice</p>
            </td>
          </tr>
        </table>

        <!-- Main Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fafafa; border: 1px solid #e4e4e7; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #18181b;">Welcome${firstName ? `, ${firstName}` : ''}!</h2>
              
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Thank you for joining Vocaid. We're excited to help you ace your next interview.
              </p>
              
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                <strong>What you can do with Vocaid:</strong>
              </p>
              
              <ul style="margin: 0 0 24px 0; padding-left: 20px; font-size: 16px; line-height: 1.8; color: #27272a;">
                <li>Practice with AI-powered mock interviews</li>
                <li>Get detailed feedback on your responses</li>
                <li>Track your progress over time</li>
                <li>Prepare for roles in tech, business, and more</li>
              </ul>
              
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                You've received <strong>1 free credit</strong> to try your first interview. Start practicing today!
              </p>
              
              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${dashboardUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Go to Dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Need help? Contact us at <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                © ${new Date().getFullYear()} Vocaid. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, dashboardUrl, supportEmail }) => `
Welcome${firstName ? `, ${firstName}` : ''}!

Thank you for joining Vocaid. We're excited to help you ace your next interview.

What you can do with Vocaid:
- Practice with AI-powered mock interviews
- Get detailed feedback on your responses
- Track your progress over time
- Prepare for roles in tech, business, and more

You've received 1 free credit to try your first interview. Start practicing today!

Go to Dashboard: ${dashboardUrl}

Need help? Contact us at ${supportEmail}

© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `.trim()
  },
  pt: {
    subject: 'Bem-vindo ao Vocaid – Seu Coach de Entrevistas com IA',
    html: ({ firstName, dashboardUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bem-vindo ao Vocaid</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: #71717a;">Prática de Entrevistas com IA</p>
            </td>
          </tr>
        </table>

        <!-- Main Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fafafa; border: 1px solid #e4e4e7; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #18181b;">Bem-vindo${firstName ? `, ${firstName}` : ''}!</h2>
              
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Obrigado por se juntar ao Vocaid. Estamos animados para ajudá-lo a arrasar na sua próxima entrevista.
              </p>
              
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                <strong>O que você pode fazer com o Vocaid:</strong>
              </p>
              
              <ul style="margin: 0 0 24px 0; padding-left: 20px; font-size: 16px; line-height: 1.8; color: #27272a;">
                <li>Praticar com entrevistas simuladas com IA</li>
                <li>Receber feedback detalhado sobre suas respostas</li>
                <li>Acompanhar seu progresso ao longo do tempo</li>
                <li>Preparar-se para vagas em tecnologia, negócios e mais</li>
              </ul>
              
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Você recebeu <strong>1 crédito grátis</strong> para experimentar sua primeira entrevista. Comece a praticar hoje!
              </p>
              
              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${dashboardUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Ir para o Painel
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Precisa de ajuda? Entre em contato em <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                © ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, dashboardUrl, supportEmail }) => `
Bem-vindo${firstName ? `, ${firstName}` : ''}!

Obrigado por se juntar ao Vocaid. Estamos animados para ajudá-lo a arrasar na sua próxima entrevista.

O que você pode fazer com o Vocaid:
- Praticar com entrevistas simuladas com IA
- Receber feedback detalhado sobre suas respostas
- Acompanhar seu progresso ao longo do tempo
- Preparar-se para vagas em tecnologia, negócios e mais

Você recebeu 1 crédito grátis para experimentar sua primeira entrevista. Comece a praticar hoje!

Ir para o Painel: ${dashboardUrl}

Precisa de ajuda? Entre em contato em ${supportEmail}

© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `.trim()
  }
};

const receiptTemplates: Record<SupportedLanguage, {
  subject: (data: { packageName: string }) => string;
  html: (data: {
    firstName: string;
    packageName: string;
    creditsAmount: number;
    amountPaid: string;
    currency: string;
    newBalance: number;
    transactionId: string;
    provider: string;
    paidAt: string;
    creditsPageUrl: string;
    supportEmail: string;
  }) => string;
  text: (data: {
    firstName: string;
    packageName: string;
    creditsAmount: number;
    amountPaid: string;
    currency: string;
    newBalance: number;
    transactionId: string;
    provider: string;
    paidAt: string;
    creditsPageUrl: string;
    supportEmail: string;
  }) => string;
}> = {
  en: {
    subject: ({ packageName }) => `Your Vocaid Purchase Receipt – ${packageName} Package`,
    html: ({ firstName, packageName, creditsAmount, amountPaid, currency, newBalance, transactionId, provider, paidAt, creditsPageUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Purchase Receipt</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: #71717a;">Purchase Receipt</p>
            </td>
          </tr>
        </table>

        <!-- Main Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fafafa; border: 1px solid #e4e4e7; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #18181b;">Thank you for your purchase${firstName ? `, ${firstName}` : ''}!</h2>
              
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Your credits have been added to your account and are ready to use.
              </p>
              
              <!-- Receipt Details -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Package</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${packageName}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Credits Purchased</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${creditsAmount} credits</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Amount Paid</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${currency} ${amountPaid}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Payment Provider</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${provider}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Date</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${paidAt}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Transaction ID</td>
                        <td style="font-size: 12px; font-weight: 500; color: #52525b; text-align: right; font-family: monospace;">${transactionId}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; background-color: #f4f4f5;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b;">New Balance</td>
                        <td style="font-size: 18px; font-weight: 700; color: #9333ea; text-align: right;">${newBalance} credits</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${creditsPageUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      View Credits
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Questions about your purchase? Contact us at <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                © ${new Date().getFullYear()} Vocaid. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, packageName, creditsAmount, amountPaid, currency, newBalance, transactionId, provider, paidAt, creditsPageUrl, supportEmail }) => `
Thank you for your purchase${firstName ? `, ${firstName}` : ''}!

Your credits have been added to your account and are ready to use.

RECEIPT DETAILS
---------------
Package: ${packageName}
Credits Purchased: ${creditsAmount} credits
Amount Paid: ${currency} ${amountPaid}
Payment Provider: ${provider}
Date: ${paidAt}
Transaction ID: ${transactionId}

NEW BALANCE: ${newBalance} credits

View Credits: ${creditsPageUrl}

Questions about your purchase? Contact us at ${supportEmail}

© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `.trim()
  },
  pt: {
    subject: ({ packageName }) => `Seu Recibo de Compra Vocaid – Pacote ${packageName}`,
    html: ({ firstName, packageName, creditsAmount, amountPaid, currency, newBalance, transactionId, provider, paidAt, creditsPageUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Recibo de Compra</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <!-- Header -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: #71717a;">Recibo de Compra</p>
            </td>
          </tr>
        </table>

        <!-- Main Content -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fafafa; border: 1px solid #e4e4e7; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #18181b;">Obrigado pela sua compra${firstName ? `, ${firstName}` : ''}!</h2>
              
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Seus créditos foram adicionados à sua conta e estão prontos para usar.
              </p>
              
              <!-- Receipt Details -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Pacote</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${packageName}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Créditos Comprados</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${creditsAmount} créditos</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Valor Pago</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${currency} ${amountPaid}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Forma de Pagamento</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${provider}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">Data</td>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${paidAt}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #71717a;">ID da Transação</td>
                        <td style="font-size: 12px; font-weight: 500; color: #52525b; text-align: right; font-family: monospace;">${transactionId}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; background-color: #f4f4f5;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; font-weight: 600; color: #18181b;">Novo Saldo</td>
                        <td style="font-size: 18px; font-weight: 700; color: #9333ea; text-align: right;">${newBalance} créditos</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${creditsPageUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Ver Créditos
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Dúvidas sobre sua compra? Entre em contato em <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                © ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, packageName, creditsAmount, amountPaid, currency, newBalance, transactionId, provider, paidAt, creditsPageUrl, supportEmail }) => `
Obrigado pela sua compra${firstName ? `, ${firstName}` : ''}!

Seus créditos foram adicionados à sua conta e estão prontos para usar.

DETALHES DO RECIBO
------------------
Pacote: ${packageName}
Créditos Comprados: ${creditsAmount} créditos
Valor Pago: ${currency} ${amountPaid}
Forma de Pagamento: ${provider}
Data: ${paidAt}
ID da Transação: ${transactionId}

NOVO SALDO: ${newBalance} créditos

Ver Créditos: ${creditsPageUrl}

Dúvidas sobre sua compra? Entre em contato em ${supportEmail}

© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `.trim()
  }
};

// ========================================
// LOW CREDITS WARNING TEMPLATES
// ========================================

const lowCreditsTemplates: Record<SupportedLanguage, {
  subject: string;
  html: (data: { firstName: string; currentCredits: number; threshold: number; creditsPageUrl: string; supportEmail: string }) => string;
  text: (data: { firstName: string; currentCredits: number; threshold: number; creditsPageUrl: string; supportEmail: string }) => string;
}> = {
  en: {
    subject: 'Your Vocaid Credits Are Running Low',
    html: ({ firstName, currentCredits, creditsPageUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Low Credits Warning</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #92400e;">Your Credits Are Running Low</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #78350f;">
                Hi${firstName ? ` ${firstName}` : ''}, you currently have <strong>${currentCredits} credit${currentCredits !== 1 ? 's' : ''}</strong> remaining in your Vocaid account.
              </p>
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #78350f;">
                To continue practicing interviews without interruption, consider topping up your credits.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${creditsPageUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Get More Credits
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Need help? <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">© ${new Date().getFullYear()} Vocaid. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, currentCredits, creditsPageUrl, supportEmail }) => `
Your Credits Are Running Low

Hi${firstName ? ` ${firstName}` : ''}, you currently have ${currentCredits} credit${currentCredits !== 1 ? 's' : ''} remaining in your Vocaid account.

To continue practicing interviews without interruption, consider topping up your credits.

Get More Credits: ${creditsPageUrl}

Need help? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `.trim()
  },
  pt: {
    subject: 'Seus Créditos Vocaid Estão Acabando',
    html: ({ firstName, currentCredits, creditsPageUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aviso de Créditos Baixos</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #92400e;">Seus Créditos Estão Acabando</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #78350f;">
                Olá${firstName ? ` ${firstName}` : ''}, você tem <strong>${currentCredits} crédito${currentCredits !== 1 ? 's' : ''}</strong> restante${currentCredits !== 1 ? 's' : ''} na sua conta Vocaid.
              </p>
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #78350f;">
                Para continuar praticando entrevistas sem interrupção, considere recarregar seus créditos.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${creditsPageUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Comprar Créditos
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Precisa de ajuda? <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, currentCredits, creditsPageUrl, supportEmail }) => `
Seus Créditos Estão Acabando

Olá${firstName ? ` ${firstName}` : ''}, você tem ${currentCredits} crédito${currentCredits !== 1 ? 's' : ''} restante${currentCredits !== 1 ? 's' : ''} na sua conta Vocaid.

Para continuar praticando entrevistas sem interrupção, considere recarregar seus créditos.

Comprar Créditos: ${creditsPageUrl}

Precisa de ajuda? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `.trim()
  }
};

// ========================================
// INTERVIEW REMINDER TEMPLATES
// ========================================

const interviewReminderTemplates: Record<SupportedLanguage, {
  subject: string;
  html: (data: { firstName: string; interviewTitle?: string; jobRole?: string; interviewUrl: string; supportEmail: string; isEngagementReminder?: boolean }) => string;
  text: (data: { firstName: string; interviewTitle?: string; jobRole?: string; interviewUrl: string; supportEmail: string; isEngagementReminder?: boolean }) => string;
}> = {
  en: {
    subject: 'Continue Your Interview Practice on Vocaid',
    html: ({ firstName, interviewTitle, jobRole, interviewUrl, supportEmail, isEngagementReminder }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Interview Reminder</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fafafa; border: 1px solid #e4e4e7; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              ${isEngagementReminder ? `
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #18181b;">Time to Practice Again!</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Hi${firstName ? ` ${firstName}` : ''}, it's been a while since your last interview practice. Regular practice is key to acing your next interview!
              </p>
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                <strong>Tip:</strong> Consistent practice helps you stay sharp and confident. Even a short session can make a big difference.
              </p>
              ` : `
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #18181b;">Ready to Continue?</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Hi${firstName ? ` ${firstName}` : ''}, you have an interview session waiting for you:
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: #18181b;">${interviewTitle || 'Interview Practice'}</p>
                    ${jobRole ? `<p style="margin: 0; font-size: 14px; color: #71717a;">Role: ${jobRole}</p>` : ''}
                  </td>
                </tr>
              </table>
              `}
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${interviewUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      ${isEngagementReminder ? 'Start Practicing' : 'Continue Interview'}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Need help? <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">© ${new Date().getFullYear()} Vocaid. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, interviewTitle, jobRole, interviewUrl, supportEmail, isEngagementReminder }) => isEngagementReminder ? `
Time to Practice Again!

Hi${firstName ? ` ${firstName}` : ''}, it's been a while since your last interview practice.

Regular practice is key to acing your next interview!

Start Practicing: ${interviewUrl}

Need help? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `.trim() : `
Ready to Continue?

Hi${firstName ? ` ${firstName}` : ''}, you have an interview session waiting for you:

Interview: ${interviewTitle || 'Interview Practice'}
${jobRole ? `Role: ${jobRole}` : ''}

Continue Interview: ${interviewUrl}

Need help? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `.trim()
  },
  pt: {
    subject: 'Continue Sua Prática de Entrevista no Vocaid',
    html: ({ firstName, interviewTitle, jobRole, interviewUrl, supportEmail, isEngagementReminder }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lembrete de Entrevista</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fafafa; border: 1px solid #e4e4e7; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              ${isEngagementReminder ? `
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #18181b;">Hora de Praticar!</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Olá${firstName ? ` ${firstName}` : ''}, faz um tempo desde sua última prática de entrevista. A prática regular é essencial para arrasar na sua próxima entrevista!
              </p>
              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                <strong>Dica:</strong> A prática constante ajuda você a se manter afiado e confiante. Até uma sessão curta pode fazer uma grande diferença.
              </p>
              ` : `
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #18181b;">Pronto para Continuar?</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #27272a;">
                Olá${firstName ? ` ${firstName}` : ''}, você tem uma sessão de entrevista esperando:
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: #18181b;">${interviewTitle || 'Prática de Entrevista'}</p>
                    ${jobRole ? `<p style="margin: 0; font-size: 14px; color: #71717a;">Cargo: ${jobRole}</p>` : ''}
                  </td>
                </tr>
              </table>
              `}
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${interviewUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      ${isEngagementReminder ? 'Começar a Praticar' : 'Continuar Entrevista'}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Precisa de ajuda? <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, interviewTitle, jobRole, interviewUrl, supportEmail, isEngagementReminder }) => isEngagementReminder ? `
Hora de Praticar!

Olá${firstName ? ` ${firstName}` : ''}, faz um tempo desde sua última prática de entrevista.

A prática regular é essencial para arrasar na sua próxima entrevista!

Começar a Praticar: ${interviewUrl}

Precisa de ajuda? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `.trim() : `
Pronto para Continuar?

Olá${firstName ? ` ${firstName}` : ''}, você tem uma sessão de entrevista esperando:

Entrevista: ${interviewTitle || 'Prática de Entrevista'}
${jobRole ? `Cargo: ${jobRole}` : ''}

Continuar Entrevista: ${interviewUrl}

Precisa de ajuda? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `.trim()
  }
};

// ========================================
// INTERVIEW COMPLETE TEMPLATES
// ========================================

const interviewCompleteTemplates: Record<SupportedLanguage, {
  subject: string;
  html: (data: { firstName: string; interviewTitle: string; jobRole: string; duration: number; overallScore?: number; feedbackUrl: string; supportEmail: string }) => string;
  text: (data: { firstName: string; interviewTitle: string; jobRole: string; duration: number; overallScore?: number; feedbackUrl: string; supportEmail: string }) => string;
}> = {
  en: {
    subject: 'Your Interview Results Are Ready!',
    html: ({ firstName, interviewTitle, jobRole, duration, overallScore, feedbackUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Interview Complete</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f0fdf4; border: 1px solid #22c55e; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #166534;">Interview Complete!</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #15803d;">
                Great job${firstName ? `, ${firstName}` : ''}! You've completed your interview practice.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Interview</p>
                    <p style="margin: 4px 0 0 0; font-size: 16px; font-weight: 600; color: #18181b;">${interviewTitle}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Role</p>
                    <p style="margin: 4px 0 0 0; font-size: 16px; font-weight: 600; color: #18181b;">${jobRole}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Duration</p>
                    <p style="margin: 4px 0 0 0; font-size: 16px; font-weight: 600; color: #18181b;">${duration} minutes</p>
                  </td>
                </tr>
                ${overallScore !== undefined ? `
                <tr>
                  <td style="padding: 16px; background-color: #f4f4f5;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Overall Score</p>
                    <p style="margin: 4px 0 0 0; font-size: 24px; font-weight: 700; color: #9333ea;">${overallScore}/100</p>
                  </td>
                </tr>
                ` : ''}
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${feedbackUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      View Full Feedback
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Need help? <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">© ${new Date().getFullYear()} Vocaid. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, interviewTitle, jobRole, duration, overallScore, feedbackUrl, supportEmail }) => `
Interview Complete!

Great job${firstName ? `, ${firstName}` : ''}! You've completed your interview practice.

Interview: ${interviewTitle}
Role: ${jobRole}
Duration: ${duration} minutes
${overallScore !== undefined ? `Overall Score: ${overallScore}/100` : ''}

View Full Feedback: ${feedbackUrl}

Need help? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `.trim()
  },
  pt: {
    subject: 'Seus Resultados da Entrevista Estão Prontos!',
    html: ({ firstName, interviewTitle, jobRole, duration, overallScore, feedbackUrl, supportEmail }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Entrevista Completa</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <tr>
      <td>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
          <tr>
            <td style="text-align: center;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #18181b;">Vocaid</h1>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f0fdf4; border: 1px solid #22c55e; border-radius: 8px; padding: 32px;">
          <tr>
            <td>
              <h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #166534;">Entrevista Concluída!</h2>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #15803d;">
                Ótimo trabalho${firstName ? `, ${firstName}` : ''}! Você completou sua prática de entrevista.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Entrevista</p>
                    <p style="margin: 4px 0 0 0; font-size: 16px; font-weight: 600; color: #18181b;">${interviewTitle}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Cargo</p>
                    <p style="margin: 4px 0 0 0; font-size: 16px; font-weight: 600; color: #18181b;">${jobRole}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px; border-bottom: 1px solid #e4e4e7;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Duração</p>
                    <p style="margin: 4px 0 0 0; font-size: 16px; font-weight: 600; color: #18181b;">${duration} minutos</p>
                  </td>
                </tr>
                ${overallScore !== undefined ? `
                <tr>
                  <td style="padding: 16px; background-color: #f4f4f5;">
                    <p style="margin: 0; font-size: 14px; color: #71717a;">Pontuação Geral</p>
                    <p style="margin: 4px 0 0 0; font-size: 24px; font-weight: 700; color: #9333ea;">${overallScore}/100</p>
                  </td>
                </tr>
                ` : ''}
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #9333ea;">
                    <a href="${feedbackUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Ver Feedback Completo
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 32px;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 14px; color: #71717a;">
                Precisa de ajuda? <a href="mailto:${supportEmail}" style="color: #9333ea; text-decoration: none;">${supportEmail}</a>
              </p>
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    text: ({ firstName, interviewTitle, jobRole, duration, overallScore, feedbackUrl, supportEmail }) => `
Entrevista Concluída!

Ótimo trabalho${firstName ? `, ${firstName}` : ''}! Você completou sua prática de entrevista.

Entrevista: ${interviewTitle}
Cargo: ${jobRole}
Duração: ${duration} minutos
${overallScore !== undefined ? `Pontuação Geral: ${overallScore}/100` : ''}

Ver Feedback Completo: ${feedbackUrl}

Precisa de ajuda? ${supportEmail}

© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `.trim()
  }
};

// ========================================
// IDEMPOTENCY KEY GENERATORS
// ========================================

export function generateWelcomeIdempotencyKey(userId: string): string {
  return `welcome:${userId}`;
}

export function generatePurchaseIdempotencyKey(provider: string, paymentId: string): string {
  return `purchase:${provider}:${paymentId}`;
}

export function generateLowCreditsIdempotencyKey(userId: string, threshold: number): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  // One email per user+threshold per day
  return `low-credits:${userId}:${threshold}:${yyyy}-${mm}-${dd}`;
}

export function generateInterviewCompleteIdempotencyKey(userId: string, interviewId: string): string {
  return `interview-complete:${userId}:${interviewId}`;
}

// ========================================
// CORE EMAIL FUNCTIONS
// ========================================

/**
 * Send welcome email to a new user
 * Idempotent: Will not send if already sent for this user
 * Respects consent: Checks transactional opt-in before sending
 */
export async function sendWelcomeEmail(user: UserEmailData): Promise<EmailResult> {
  // Check transactional consent before sending
  const canSend = await canSendTransactional(user.id);
  if (!canSend) {
    emailLogger.info('Welcome email blocked - user opted out of transactional emails', { 
      userId: user.id, 
      email: user.email 
    });
    return { 
      success: false, 
      skipped: true, 
      reason: 'Transactional emails disabled by user preference'
    };
  }

  const idempotencyKey = generateWelcomeIdempotencyKey(user.id);
  
  emailLogger.info('Attempting to send welcome email', { 
    userId: user.id, 
    email: user.email,
    idempotencyKey,
    templateId: RESEND_WELCOME_TEMPLATE_ID,
  });

  // Check if already sent
  const existing = await prisma.transactionalEmail.findUnique({
    where: { idempotencyKey }
  });

  if (existing) {
    if (existing.status === 'SENT') {
      emailLogger.info('Welcome email already sent - skipping (idempotent)', { 
        userId: user.id, 
        existingEmailId: existing.id 
      });
      return { 
        success: true, 
        skipped: true, 
        reason: 'Already sent',
        emailId: existing.id,
        messageId: existing.providerMessageId || undefined
      };
    }
    
    // If PENDING or FAILED, we can retry
    if (existing.retryCount >= 3) {
      emailLogger.warn('Welcome email max retries reached', { 
        userId: user.id, 
        retryCount: existing.retryCount 
      });
      return { 
        success: false, 
        error: 'Max retries reached',
        emailId: existing.id 
      };
    }
  }

  // Create or update email record as PENDING
  const emailRecord = await prisma.transactionalEmail.upsert({
    where: { idempotencyKey },
    create: {
      userId: user.id,
      toEmail: user.email,
      emailType: 'WELCOME',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey,
      language: getLanguage(user.preferredLanguage),
      payloadJson: {
        firstName: user.firstName,
        userId: user.id
      }
    },
    update: {
      status: 'SENDING',
      retryCount: { increment: 1 },
      updatedAt: new Date()
    }
  });

  // Build email content using local templates (Resend requires html/text)
  const lang: SupportedLanguage = getLanguage(user.preferredLanguage);
  const templateData = {
    firstName: user.firstName || '',
    dashboardUrl: `${FRONTEND_URL}/app/dashboard`,
    supportEmail: SUPPORT_EMAIL,
  };

  const template = welcomeTemplates[lang];
  const subject = template.subject;
  const html = template.html(templateData);
  const text = template.text(templateData);

  emailLogger.debug('Welcome email content prepared', {
    userId: user.id,
    lang,
    subject,
  });

  // Send via Resend with rendered html/text
  const sendResult = await sendViaResend({
    to: user.email,
    from: EMAIL_SENDERS.welcome,
    subject,
    html,
    text,
  });

  if (!sendResult.success) {
    emailLogger.warn('Welcome email failed to send', { 
      userId: user.id,
      error: sendResult.error,
    });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: sendResult.error || 'Unknown error' }
      }
    });
    
    return { 
      success: false, 
      error: sendResult.error || 'Email service not configured',
      emailId: emailRecord.id 
    };
  }

  // Update record as SENT
  await prisma.transactionalEmail.update({
    where: { id: emailRecord.id },
    data: {
      status: 'SENT',
      providerMessageId: sendResult.messageId || null,
      sentAt: new Date()
    }
  });

  emailLogger.info('Welcome email sent successfully', { 
    userId: user.id, 
    messageId: sendResult.messageId 
  });

  return { 
    success: true, 
    emailId: emailRecord.id,
    messageId: sendResult.messageId 
  };
}

/**
 * Send purchase receipt email
 * Idempotent: Will not send if already sent for this payment
 * Respects consent: Checks transactional opt-in before sending
 */
export async function sendPurchaseReceiptEmail(data: PurchaseEmailData): Promise<EmailResult> {
  const idempotencyKey = generatePurchaseIdempotencyKey(data.provider, data.paymentId);
  
  emailLogger.info('Attempting to send purchase receipt email', { 
    userId: data.user.id, 
    paymentId: data.paymentId,
    provider: data.provider,
    idempotencyKey 
  });

  // Check if already sent
  const existing = await prisma.transactionalEmail.findUnique({
    where: { idempotencyKey }
  });

  if (existing) {
    if (existing.status === 'SENT') {
      emailLogger.info('Purchase receipt already sent - skipping (idempotent)', { 
        userId: data.user.id, 
        existingEmailId: existing.id 
      });
      return { 
        success: true, 
        skipped: true, 
        reason: 'Already sent',
        emailId: existing.id,
        messageId: existing.providerMessageId || undefined
      };
    }
    
    if (existing.retryCount >= 3) {
      emailLogger.warn('Purchase receipt max retries reached', { 
        userId: data.user.id, 
        retryCount: existing.retryCount 
      });
      return { 
        success: false, 
        error: 'Max retries reached',
        emailId: existing.id 
      };
    }
  }

  // Create or update email record as PENDING
  const emailRecord = await prisma.transactionalEmail.upsert({
    where: { idempotencyKey },
    create: {
      userId: data.user.id,
      toEmail: data.user.email,
      emailType: 'CREDITS_PURCHASE_RECEIPT',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey,
      language: getLanguage(data.user.preferredLanguage),
      payloadJson: {
        paymentId: data.paymentId,
        provider: data.provider,
        creditsAmount: data.creditsAmount,
        amountPaid: data.amountPaid,
        currency: data.currency,
        newBalance: data.newBalance
      }
    },
    update: {
      status: 'SENDING',
      retryCount: { increment: 1 },
      updatedAt: new Date()
    }
  });

  // Build template variables for Resend Dashboard template alias `transactional`
  const lang = getLanguage(data.user.preferredLanguage);
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US';
  const providerDisplayName = data.provider === 'mercadopago' ? 'Mercado Pago' : 'PayPal';

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  const subject = lang === 'pt'
    ? 'Recibo de compra de créditos'
    : 'Credits purchase receipt';

  const preheader = lang === 'pt'
    ? 'Sua compra foi confirmada e os créditos já estão disponíveis.'
    : 'Your purchase is confirmed and credits are now available.';

  const contentLabels = {
    creditsPurchased: lang === 'pt' ? 'Créditos comprados' : 'Credits Purchased',
    amountPaid: lang === 'pt' ? 'Valor pago' : 'Amount Paid',
    provider: lang === 'pt' ? 'Provedor' : 'Provider',
    newBalance: lang === 'pt' ? 'Novo saldo' : 'New Balance',
    transactionId: lang === 'pt' ? 'ID da transação' : 'Transaction ID',
    paidAt: lang === 'pt' ? 'Data' : 'Paid At',
  };

  const formattedPaidAt = dateFormatter.format(data.paidAt);
  const formattedAmountPaid = formatMoney(data.amountPaid, data.currency, locale);

  // Keep the “product” collapsed into a single Credits Purchased line (no tier/package name)
  const contentHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${contentLabels.creditsPurchased}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${data.creditsAmount}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${contentLabels.amountPaid}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${formattedAmountPaid}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${contentLabels.provider}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${providerDisplayName}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${contentLabels.newBalance}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${data.newBalance}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${contentLabels.transactionId}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${data.paymentId}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; font-size: 14px; color: #18181b;">${contentLabels.paidAt}</td>
        <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #18181b; text-align: right;">${formattedPaidAt}</td>
      </tr>
    </table>
  `.trim();

  const templateVariables = buildTransactionalTemplateVariables({
    preheader,
    subject,
    reason: lang === 'pt' ? 'Recibo de Compra' : 'Purchase Receipt',
    header: lang === 'pt' ? 'Recibo' : 'Receipt',
    header_highlight: lang === 'pt' ? 'Créditos' : 'Credits',
    content: contentHtml,
  });

  const sendResult = await sendTransactionalTemplateEmail({
    to: data.user.email,
    from: EMAIL_SENDERS.transactional,
    templateVariables,
  });

  if (!sendResult.success) {
    emailLogger.warn('Purchase receipt email failed to send', { 
      userId: data.user.id,
      paymentId: data.paymentId,
      error: sendResult.error,
    });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: sendResult.error || 'Unknown error' }
      }
    });
    
    return { 
      success: false, 
      error: sendResult.error || 'Email send failed',
      emailId: emailRecord.id 
    };
  }

  // Update record as SENT
  await prisma.transactionalEmail.update({
    where: { id: emailRecord.id },
    data: {
      status: 'SENT',
      providerMessageId: sendResult.messageId || null,
      sentAt: new Date()
    }
  });

  emailLogger.info('Purchase receipt email sent successfully', { 
    userId: data.user.id, 
    paymentId: data.paymentId,
    messageId: sendResult.messageId 
  });

  return { 
    success: true, 
    emailId: emailRecord.id,
    messageId: sendResult.messageId 
  };
}

// ========================================
// ADMIN / DEBUG FUNCTIONS
// ========================================

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
      createdAt: true
    }
  });
}

/**
 * Get email by idempotency key
 */
export async function getEmailByIdempotencyKey(idempotencyKey: string) {
  return prisma.transactionalEmail.findUnique({
    where: { idempotencyKey }
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
            lastName: true
          }
        }
      }
    }),
    prisma.transactionalEmail.count({ where })
  ]);

  return {
    emails,
    total,
    limit,
    offset,
    hasMore: offset + emails.length < total
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
    // Group by email type
    prisma.transactionalEmail.groupBy({
      by: ['emailType'],
      where: dateFilter,
      _count: { id: true }
    }),
    // Group by status
    prisma.transactionalEmail.groupBy({
      by: ['status'],
      where: dateFilter,
      _count: { id: true }
    }),
    // Recent failures
    prisma.transactionalEmail.findMany({
      where: {
        ...dateFilter,
        status: 'FAILED'
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        toEmail: true,
        emailType: true,
        errorJson: true,
        retryCount: true,
        createdAt: true
      }
    })
  ]);

  return {
    byType: Object.fromEntries(byType.map(t => [t.emailType, t._count.id])),
    byStatus: Object.fromEntries(byStatus.map(s => [s.status, s._count.id])),
    recentFailures
  };
}

/**
 * Retry failed emails with exponential backoff
 * Max retries: 3
 */
export async function retryFailedEmails(maxRetries: number = 3): Promise<RetryResult> {
  const failedEmails = await prisma.transactionalEmail.findMany({
    where: {
      status: 'FAILED',
      retryCount: { lt: maxRetries }
    },
    include: {
      user: true
    }
  });

  const result: RetryResult = {
    totalFailed: failedEmails.length,
    retried: 0,
    succeeded: 0,
    stillFailing: 0,
    details: []
  };

  for (const email of failedEmails) {
    try {
      // Mark as pending for retry
      await prisma.transactionalEmail.update({
        where: { id: email.id },
        data: {
          status: 'PENDING',
          retryCount: email.retryCount + 1
        }
      });

      // Re-send based on type
      let sendResult: EmailResult;

      // Skip if no email address or user ID
      if (!email.toEmail || !email.userId) {
        result.details.push({
          id: email.id,
          status: 'error',
          error: 'No email address or user ID available'
        });
        result.stillFailing++;
        continue;
      }

      const toEmail = email.toEmail;
      const userId = email.userId; // Now guaranteed to be string

      switch (email.emailType) {
        case 'WELCOME':
          sendResult = await sendWelcomeEmail({
            id: userId,
            email: toEmail,
            firstName: email.user?.firstName,
            lastName: email.user?.lastName,
            preferredLanguage: email.language || undefined
          });
          break;

        case 'CREDITS_PURCHASE_RECEIPT':
          const payload = email.payloadJson as any;
          sendResult = await sendPurchaseReceiptEmail({
            user: {
              id: userId,
              email: toEmail,
              firstName: email.user?.firstName,
              lastName: email.user?.lastName,
              preferredLanguage: email.language || undefined
            },
            paymentId: payload?.paymentId || email.id,
            provider: payload?.provider || 'mercadopago',
            creditsAmount: payload?.creditsAmount || 0,
            amountPaid: payload?.amountPaid || 0,
            currency: payload?.currency || 'USD',
            newBalance: payload?.newBalance || 0,
            paidAt: new Date()
          });
          break;

        case 'LOW_CREDITS_WARNING':
          const lcPayload = email.payloadJson as any;
          sendResult = await sendLowCreditsEmail({
            user: {
              id: userId,
              email: toEmail,
              firstName: email.user?.firstName,
              lastName: email.user?.lastName,
              preferredLanguage: email.language || undefined
            },
            currentCredits: lcPayload?.currentCredits || 0,
            threshold: lcPayload?.threshold || 1
          });
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
// ADDITIONAL EMAIL FUNCTIONS
// ========================================

/**
 * Send low credits warning email
 * Idempotent: Only one per user per threshold per day
 */
export async function sendLowCreditsEmail(data: LowCreditsData): Promise<EmailResult> {
  const idempotencyKey = generateLowCreditsIdempotencyKey(data.user.id, data.threshold);
  const language = getLanguage(data.user.preferredLanguage);

  // Check for existing
  const existing = await prisma.transactionalEmail.findUnique({
    where: { idempotencyKey }
  });

  if (existing?.status === 'SENT') {
    return { success: true, skipped: true, reason: 'Already sent today', emailId: existing.id };
  }

  // Create record
  const emailRecord = await prisma.transactionalEmail.upsert({
    where: { idempotencyKey },
    create: {
      userId: data.user.id,
      toEmail: data.user.email,
      emailType: 'LOW_CREDITS_WARNING',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey,
      language,
      payloadJson: {
        currentCredits: data.currentCredits,
        threshold: data.threshold
      }
    },
    update: {
      status: 'PENDING',
      retryCount: { increment: 1 }
    }
  });

  const creditsPageUrl = `${FRONTEND_URL}/credits`;
  const subject = language === 'pt' ? 'Seus créditos estão acabando' : 'Your credits are running low';
  const preheader = language === 'pt'
    ? 'Recarregue agora para continuar praticando sem interrupções.'
    : 'Top up now to keep practicing without interruptions.';

  const contentHtml = `
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${language === 'pt'
        ? `Olá${data.user.firstName ? ` ${data.user.firstName}` : ''},`
        : `Hi${data.user.firstName ? ` ${data.user.firstName}` : ''},`}
    </p>
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${language === 'pt'
        ? `Você tem <strong>${data.currentCredits}</strong> crédito${data.currentCredits !== 1 ? 's' : ''} restante${data.currentCredits !== 1 ? 's' : ''}.`
        : `You have <strong>${data.currentCredits}</strong> credit${data.currentCredits !== 1 ? 's' : ''} remaining.`}
    </p>
    <p style="margin:0 0 16px; font-size:14px; color:#111827;">
      ${language === 'pt'
        ? `Recarregue seus créditos para continuar praticando entrevistas com o Vocaid.`
        : `Top up your credits to keep practicing interviews with Vocaid.`}
    </p>
    <p style="margin:0; font-size:14px;">
      <a href="${creditsPageUrl}" style="color:#6D28D9; font-weight:600; text-decoration:none;">
        ${language === 'pt' ? 'Comprar créditos' : 'Buy credits'}
      </a>
    </p>
  `.trim();

  const templateVariables = buildTransactionalTemplateVariables({
    preheader,
    subject,
    reason: language === 'pt' ? 'Aviso de créditos' : 'Credits warning',
    header: language === 'pt' ? 'Créditos' : 'Credits',
    header_highlight: language === 'pt' ? 'acabando' : 'running low',
    content: contentHtml,
  });

  const sendResult = await sendTransactionalTemplateEmail({
    to: data.user.email,
    from: EMAIL_SENDERS.transactional,
    templateVariables,
  });

  if (!sendResult.success) {
    emailLogger.warn('Low credits email failed to send', { 
      userId: data.user.id,
      error: sendResult.error,
    });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: sendResult.error || 'Unknown error' }
      }
    });
    
    return { success: false, error: sendResult.error, emailId: emailRecord.id };
  }

  await prisma.transactionalEmail.update({
    where: { id: emailRecord.id },
    data: {
      status: 'SENT',
      providerMessageId: sendResult.messageId || null,
      sentAt: new Date()
    }
  });

  emailLogger.info('Low credits warning email sent', { userId: data.user.id, messageId: sendResult.messageId });
  return { success: true, emailId: emailRecord.id, messageId: sendResult.messageId };
}

/**
 * Send interview complete email with results
 * Idempotent: Only one per interview
 */
export async function sendInterviewCompleteEmail(interviewId: string): Promise<EmailResult> {
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: {
      id: true,
      jobTitle: true,
      companyName: true,
      seniority: true,
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

  const canSend = await canSendTransactional(interview.user.id);
  if (!canSend) {
    emailLogger.info('Post-interview email blocked - user opted out of transactional emails', {
      userId: interview.user.id,
      interviewId,
    });
    return { success: false, skipped: true, reason: 'Transactional emails disabled by user preference' };
  }

  const idempotencyKey = generateInterviewCompleteIdempotencyKey(interview.user.id, interviewId);
  const language: TemplateLanguage = getLanguage(interview.user.preferredLanguage);

  const existing = await prisma.transactionalEmail.findUnique({
    where: { idempotencyKey },
  });

  if (existing?.status === 'SENT') {
    return { success: true, skipped: true, reason: 'Already sent', emailId: existing.id };
  }

  const emailRecord = await prisma.transactionalEmail.upsert({
    where: { idempotencyKey },
    create: {
      userId: interview.user.id,
      toEmail: interview.user.email,
      emailType: 'INTERVIEW_COMPLETE',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey,
      language,
      payloadJson: {
        interviewId,
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        seniority: interview.seniority,
        pdfStorageKey: interview.feedbackDocument?.pdfStorageKey,
      },
    },
    update: {
      status: 'PENDING',
      retryCount: { increment: 1 },
    },
  });

  const pdfStorageKey = interview.feedbackDocument?.pdfStorageKey;
  if (!pdfStorageKey) {
    const errorMessage = 'Feedback PDF storage key not found for interview';
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: errorMessage },
      },
    });
    return { success: false, error: errorMessage, emailId: emailRecord.id };
  }

  const pdfDownload = await downloadFeedbackPdf(pdfStorageKey);
  if (!pdfDownload.success || !pdfDownload.data) {
    const errorMessage = pdfDownload.error || 'Failed to download feedback PDF';
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: errorMessage },
      },
    });
    return { success: false, error: errorMessage, emailId: emailRecord.id };
  }

  const feedbackUrl = `${FRONTEND_URL}/interviews/${interviewId}/feedback`;

  const templateVariables: Record<string, any> = {
    ...getCommonVariables(),
    FEEDBACK_URL: feedbackUrl,
  };

  if (interview.user.firstName?.trim()) templateVariables.CANDIDATE_FIRST_NAME = interview.user.firstName.trim();
  if (interview.seniority?.trim()) templateVariables.SENIORITY = interview.seniority.trim();
  if (interview.jobTitle?.trim()) templateVariables.ROLE_TITLE = interview.jobTitle.trim();
  if (interview.companyName?.trim()) templateVariables.TARGET_COMPANY = interview.companyName.trim();

  const attachmentFilename = buildFeedbackPdfFilenameFromInterview({
    seniority: interview.seniority,
    jobTitle: interview.jobTitle,
    companyName: interview.companyName,
  });

  const sendResult = await sendViaResend({
    to: interview.user.email,
    from: EMAIL_SENDERS.feedback,
    templateId: 'feedback',
    templateVariables,
    attachments: [
      {
        filename: attachmentFilename,
        content: pdfDownload.data,
        contentType: pdfDownload.contentType || 'application/pdf',
      },
    ],
  });

  if (!sendResult.success) {
    emailLogger.warn('Post-interview feedback email failed to send', {
      userId: interview.user.id,
      interviewId,
      error: sendResult.error,
    });

    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: sendResult.error || 'Unknown error' },
      },
    });

    return { success: false, error: sendResult.error, emailId: emailRecord.id };
  }

  await prisma.transactionalEmail.update({
    where: { id: emailRecord.id },
    data: {
      status: 'SENT',
      providerMessageId: sendResult.messageId || null,
      sentAt: new Date(),
    },
  });

  emailLogger.info('Post-interview feedback email sent', { userId: interview.user.id, interviewId });
  return { success: true, emailId: emailRecord.id, messageId: sendResult.messageId };
}

// ========================================
// PASSWORD RESET EMAIL
// ========================================

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

// Password reset templates
const passwordResetTemplates: Record<SupportedLanguage, {
  subject: string;
  html: (data: any) => string;
  text: (data: any) => string;
}> = {
  en: {
    subject: 'Reset your Vocaid password',
    html: (data) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; font-family:Arial, Helvetica, sans-serif; background-color:#FAFAFA;">
  <div style="display:none;font-size:1px;color:#F7F5FF;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Reset your Vocaid password - this link expires in 1 hour
  </div>
  
  <center style="width:100%; background-color:#FAFAFA;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; background-color:#FAFAFA; border-collapse:collapse; table-layout:fixed; margin:0 auto;">
      <tr>
        <td align="center" valign="top" style="padding:16px 0;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" align="center" style="width:600px; max-width:600px; margin:0 auto; background-color:#FFFFFF; border-radius:18px; overflow:hidden; border-collapse:separate; box-shadow:0 10px 30px rgba(17,24,39,0.06);">
            
            <!-- Header -->
            <tr>
              <td style="background-color:#ffffff; padding:18px 20px; border-bottom:1px solid #E5E7EB;">
                <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" align="center" style="width:560px; max-width:560px; margin:0 auto; border-collapse:collapse;">
                  <tr>
                    <td align="left" style="vertical-align:middle;">
                      <img src="https://resend-attachments.s3.amazonaws.com/6JI1baUnCt05bRK" width="140" alt="Vocaid" style="width:140px; height:auto; display:block;">
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <span style="display:inline-block; padding:6px 10px; background-color:#9333EA; border:1px solid rgba(255,255,255,0.25); border-radius:999px; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:12px; font-weight:700;">
                        Password Reset
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            
            <!-- Content -->
            <tr>
              <td style="padding:18px 20px 8px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:30px; line-height:38px; font-weight:800; color:#111827;">
                  Reset your <span style="color:#6D28D9;">password</span>.
                </div>
                
                <div style="margin-top:12px; font-size:16px; line-height:24px; color:#374151;">
                  <p style="margin:0 0 16px;">Hi${data.firstName ? ' ' + data.firstName : ''},</p>
                  <p style="margin:0 0 16px;">We received a request to reset the password for your Vocaid account. Click the button below to create a new password:</p>
                </div>
                
                <!-- CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0; border-collapse:separate;">
                  <tr>
                    <td align="center" bgcolor="#6D28D9" style="border-radius:12px;">
                      <a href="${data.resetUrl}" style="display:inline-block; padding:14px 28px; font-family:Arial, Helvetica, sans-serif; font-size:16px; font-weight:800; color:#FFFFFF; background-color:#6D28D9; border-radius:12px; border:1px solid #6D28D9; text-decoration:none;">
                        Reset Password
                      </a>
                    </td>
                  </tr>
                </table>
                
                <div style="font-size:14px; line-height:22px; color:#6B7280;">
                  <p style="margin:0 0 12px;">Or copy and paste this link into your browser:</p>
                  <p style="margin:0 0 16px; word-break:break-all;">
                    <a href="${data.resetUrl}" style="color:#6D28D9; font-weight:600;">${data.resetUrl}</a>
                  </p>
                  <p style="margin:0 0 12px;"><strong>This link will expire in 1 hour.</strong></p>
                  <p style="margin:0;">If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.</p>
                </div>
              </td>
            </tr>
            
            <!-- Divider -->
            <tr>
              <td style="padding:0 20px;">
                <div style="height:1px; background-color:#E5E7EB; line-height:1px;">&nbsp;</div>
              </td>
            </tr>
            
            <!-- Footer -->
            <tr>
              <td style="padding:16px 20px 20px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:12px; line-height:18px; color:#6B7280;">
                  This is an automated security email. If you didn't request a password reset, please contact
                  <a href="mailto:${data.supportEmail}" style="color:#6D28D9; font-weight:700;">${data.supportEmail}</a>.
                </div>
                <div style="margin-top:10px; font-size:12px; line-height:18px; color:#9CA3AF;">
                  © ${new Date().getFullYear()} Vocaid. All rights reserved.
                  &nbsp;•&nbsp;
                  <a href="${data.privacyUrl}" style="color:#6D28D9;">Privacy</a>
                  &nbsp;•&nbsp;
                  <a href="${data.termsUrl}" style="color:#6D28D9;">Terms</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>
    `,
    text: (data) => `
Reset your Vocaid password

Hi${data.firstName ? ' ' + data.firstName : ''},

We received a request to reset the password for your Vocaid account.

Click here to reset your password: ${data.resetUrl}

This link will expire in 1 hour.

If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.

---
© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `
  },
  pt: {
    subject: 'Redefinir sua senha Vocaid',
    html: (data) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; font-family:Arial, Helvetica, sans-serif; background-color:#FAFAFA;">
  <div style="display:none;font-size:1px;color:#F7F5FF;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Redefinir sua senha Vocaid - este link expira em 1 hora
  </div>
  
  <center style="width:100%; background-color:#FAFAFA;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; background-color:#FAFAFA; border-collapse:collapse; table-layout:fixed; margin:0 auto;">
      <tr>
        <td align="center" valign="top" style="padding:16px 0;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" align="center" style="width:600px; max-width:600px; margin:0 auto; background-color:#FFFFFF; border-radius:18px; overflow:hidden; border-collapse:separate; box-shadow:0 10px 30px rgba(17,24,39,0.06);">
            
            <!-- Header -->
            <tr>
              <td style="background-color:#ffffff; padding:18px 20px; border-bottom:1px solid #E5E7EB;">
                <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" align="center" style="width:560px; max-width:560px; margin:0 auto; border-collapse:collapse;">
                  <tr>
                    <td align="left" style="vertical-align:middle;">
                      <img src="https://resend-attachments.s3.amazonaws.com/6JI1baUnCt05bRK" width="140" alt="Vocaid" style="width:140px; height:auto; display:block;">
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <span style="display:inline-block; padding:6px 10px; background-color:#9333EA; border:1px solid rgba(255,255,255,0.25); border-radius:999px; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:12px; font-weight:700;">
                        Redefinir Senha
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            
            <!-- Content -->
            <tr>
              <td style="padding:18px 20px 8px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:30px; line-height:38px; font-weight:800; color:#111827;">
                  Redefinir sua <span style="color:#6D28D9;">senha</span>.
                </div>
                
                <div style="margin-top:12px; font-size:16px; line-height:24px; color:#374151;">
                  <p style="margin:0 0 16px;">Olá${data.firstName ? ' ' + data.firstName : ''},</p>
                  <p style="margin:0 0 16px;">Recebemos uma solicitação para redefinir a senha da sua conta Vocaid. Clique no botão abaixo para criar uma nova senha:</p>
                </div>
                
                <!-- CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0; border-collapse:separate;">
                  <tr>
                    <td align="center" bgcolor="#6D28D9" style="border-radius:12px;">
                      <a href="${data.resetUrl}" style="display:inline-block; padding:14px 28px; font-family:Arial, Helvetica, sans-serif; font-size:16px; font-weight:800; color:#FFFFFF; background-color:#6D28D9; border-radius:12px; border:1px solid #6D28D9; text-decoration:none;">
                        Redefinir Senha
                      </a>
                    </td>
                  </tr>
                </table>
                
                <div style="font-size:14px; line-height:22px; color:#6B7280;">
                  <p style="margin:0 0 12px;">Ou copie e cole este link no seu navegador:</p>
                  <p style="margin:0 0 16px; word-break:break-all;">
                    <a href="${data.resetUrl}" style="color:#6D28D9; font-weight:600;">${data.resetUrl}</a>
                  </p>
                  <p style="margin:0 0 12px;"><strong>Este link expira em 1 hora.</strong></p>
                  <p style="margin:0;">Se você não solicitou esta redefinição de senha, pode ignorar este email com segurança. Sua senha permanecerá inalterada.</p>
                </div>
              </td>
            </tr>
            
            <!-- Divider -->
            <tr>
              <td style="padding:0 20px;">
                <div style="height:1px; background-color:#E5E7EB; line-height:1px;">&nbsp;</div>
              </td>
            </tr>
            
            <!-- Footer -->
            <tr>
              <td style="padding:16px 20px 20px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:12px; line-height:18px; color:#6B7280;">
                  Este é um email automático de segurança. Se você não solicitou uma redefinição de senha, entre em contato com
                  <a href="mailto:${data.supportEmail}" style="color:#6D28D9; font-weight:700;">${data.supportEmail}</a>.
                </div>
                <div style="margin-top:10px; font-size:12px; line-height:18px; color:#9CA3AF;">
                  © ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
                  &nbsp;•&nbsp;
                  <a href="${data.privacyUrl}" style="color:#6D28D9;">Privacidade</a>
                  &nbsp;•&nbsp;
                  <a href="${data.termsUrl}" style="color:#6D28D9;">Termos</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>
    `,
    text: (data) => `
Redefinir sua senha Vocaid

Olá${data.firstName ? ' ' + data.firstName : ''},

Recebemos uma solicitação para redefinir a senha da sua conta Vocaid.

Clique aqui para redefinir sua senha: ${data.resetUrl}

Este link expira em 1 hora.

Se você não solicitou esta redefinição de senha, pode ignorar este email com segurança. Sua senha permanecerá inalterada.

---
© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `
  }
};

/**
 * Generate idempotency key for password reset email
 */
function generatePasswordResetIdempotencyKey(userId: string, tokenHash: string): string {
  // Use first 16 chars of token hash for uniqueness
  return `password_reset_${userId}_${tokenHash.substring(0, 16)}`;
}

/**
 * Send password reset email
 * NOT idempotent by design - each reset request should send a new email
 * Does NOT require consent (security/account access email)
 */
export async function sendPasswordResetEmail(data: PasswordResetEmailData): Promise<EmailResult> {
  const lang: TemplateLanguage = getLanguage(data.user.preferredLanguage);
  
  // Ensure FRONTEND_URL has proper scheme
  let frontendUrl = FRONTEND_URL;
  if (!frontendUrl.startsWith('http://') && !frontendUrl.startsWith('https://')) {
    frontendUrl = process.env.NODE_ENV === 'production' ? `https://${frontendUrl}` : `http://${frontendUrl}`;
  }
  
  // Use /auth/password-confirm path for password reset (matches frontend route)
  const resetUrl = `${frontendUrl}/auth/password-confirm?token=${data.resetToken}`;
  
  emailLogger.info('Attempting to send password reset email', { 
    userId: data.user.id, 
    email: data.user.email 
  });

  // Create email record for audit (password reset doesn't use idempotency)
  const emailRecord = await prisma.transactionalEmail.create({
    data: {
      userId: data.user.id,
      toEmail: data.user.email,
      emailType: 'PASSWORD_RESET',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey: generatePasswordResetIdempotencyKey(data.user.id, data.resetToken),
      language: lang,
      payloadJson: {
        expiresAt: data.expiresAt.toISOString(),
        ipAddress: data.ipAddress,
        userAgent: data.userAgent?.substring(0, 200),
      }
    }
  });

  // In dev/mock mode, log the reset URL for testing
  if (process.env.NODE_ENV === 'development' || getEmailProviderMode() === 'mock') {
    emailLogger.info('DEV MODE - Password reset URL (copy this):', { resetUrl });
  }

  const subject = lang === 'pt' ? 'Redefinir sua senha Vocaid' : 'Reset your Vocaid password';
  const preheader = lang === 'pt'
    ? 'Link de redefinição de senha (expira em 1 hora)'
    : 'Password reset link (expires in 1 hour)';

  const contentHtml = `
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? `Olá${data.user.firstName ? ` ${data.user.firstName}` : ''},`
        : `Hi${data.user.firstName ? ` ${data.user.firstName}` : ''},`}
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

  const templateVariables = buildTransactionalTemplateVariables({
    preheader,
    subject,
    reason: lang === 'pt' ? 'Segurança da conta' : 'Account security',
    header: lang === 'pt' ? 'Redefinir' : 'Reset',
    header_highlight: lang === 'pt' ? 'senha' : 'password',
    content: contentHtml,
  });

  const sendResult = await sendTransactionalTemplateEmail({
    to: data.user.email,
    from: EMAIL_SENDERS.transactional,
    templateVariables,
  });

  if (!sendResult.success) {
    emailLogger.warn('Password reset email failed to send', { 
      userId: data.user.id,
      error: sendResult.error,
    });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: sendResult.error || 'Unknown error' }
      }
    });
    
    return { 
      success: false, 
      error: sendResult.error || 'Email send failed',
      emailId: emailRecord.id 
    };
  }

  // Update record as SENT
  await prisma.transactionalEmail.update({
    where: { id: emailRecord.id },
    data: {
      status: 'SENT',
      providerMessageId: sendResult.messageId || null,
      sentAt: new Date()
    }
  });

  emailLogger.info('Password reset email sent successfully', { 
    userId: data.user.id, 
    messageId: sendResult.messageId 
  });

  return { 
    success: true, 
    emailId: emailRecord.id,
    messageId: sendResult.messageId 
  };
}

// ========================================
// EMAIL VERIFICATION EMAIL
// ========================================

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

// Email verification templates
const emailVerificationTemplates: Record<SupportedLanguage, {
  subject: string;
  html: (data: any) => string;
  text: (data: any) => string;
}> = {
  en: {
    subject: 'Verify your Vocaid email',
    html: (data) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; font-family:Arial, Helvetica, sans-serif; background-color:#FAFAFA;">
  <div style="display:none;font-size:1px;color:#F7F5FF;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Verify your email to start practicing interviews with Vocaid
  </div>
  
  <center style="width:100%; background-color:#FAFAFA;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; background-color:#FAFAFA; border-collapse:collapse; table-layout:fixed; margin:0 auto;">
      <tr>
        <td align="center" valign="top" style="padding:16px 0;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" align="center" style="width:600px; max-width:600px; margin:0 auto; background-color:#FFFFFF; border-radius:18px; overflow:hidden; border-collapse:separate; box-shadow:0 10px 30px rgba(17,24,39,0.06);">
            
            <!-- Header -->
            <tr>
              <td style="background-color:#ffffff; padding:18px 20px; border-bottom:1px solid #E5E7EB;">
                <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" align="center" style="width:560px; max-width:560px; margin:0 auto; border-collapse:collapse;">
                  <tr>
                    <td align="left" style="vertical-align:middle;">
                      <img src="https://resend-attachments.s3.amazonaws.com/6JI1baUnCt05bRK" width="140" alt="Vocaid" style="width:140px; height:auto; display:block;">
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <span style="display:inline-block; padding:6px 10px; background-color:#9333EA; border:1px solid rgba(255,255,255,0.25); border-radius:999px; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:12px; font-weight:700;">
                        Email Verification
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            
            <!-- Content -->
            <tr>
              <td style="padding:18px 20px 8px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:30px; line-height:38px; font-weight:800; color:#111827;">
                  Verify your <span style="color:#6D28D9;">email</span>.
                </div>
                
                <div style="margin-top:12px; font-size:16px; line-height:24px; color:#374151;">
                  <p style="margin:0 0 16px;">Hi${data.firstName ? ' ' + data.firstName : ''},</p>
                  <p style="margin:0 0 16px;">Welcome to Vocaid! Enter this verification code to activate your account:</p>
                </div>

                <div style="margin:0 0 8px; padding:14px 16px; border:1px solid #E5E7EB; border-radius:12px; background-color:#F9FAFB; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:22px; font-weight:800; letter-spacing:0.25em; color:#111827; text-align:center;">
                  ${data.verificationCode}
                </div>
                
                <!-- CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0; border-collapse:separate;">
                  <tr>
                    <td align="center" bgcolor="#6D28D9" style="border-radius:12px;">
                      <a href="${data.verifyUrl}" style="display:inline-block; padding:14px 28px; font-family:Arial, Helvetica, sans-serif; font-size:16px; font-weight:800; color:#FFFFFF; background-color:#6D28D9; border-radius:12px; border:1px solid #6D28D9; text-decoration:none;">
                        Enter Code
                      </a>
                    </td>
                  </tr>
                </table>
                
                <div style="font-size:14px; line-height:22px; color:#6B7280;">
                  <p style="margin:0 0 12px;">Or copy and paste this link into your browser:</p>
                  <p style="margin:0 0 16px; word-break:break-all;">
                    <a href="${data.verifyUrl}" style="color:#6D28D9; font-weight:600;">${data.verifyUrl}</a>
                  </p>
                  <p style="margin:0 0 12px;"><strong>This code will expire in 24 hours.</strong></p>
                  <p style="margin:0;">If you didn't create a Vocaid account, you can safely ignore this email.</p>
                </div>
              </td>
            </tr>
            
            <!-- Divider -->
            <tr>
              <td style="padding:0 20px;">
                <div style="height:1px; background-color:#E5E7EB; line-height:1px;">&nbsp;</div>
              </td>
            </tr>
            
            <!-- Footer -->
            <tr>
              <td style="padding:16px 20px 20px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:12px; line-height:18px; color:#6B7280;">
                  Need help? Contact us at
                  <a href="mailto:${data.supportEmail}" style="color:#6D28D9; font-weight:700;">${data.supportEmail}</a>.
                </div>
                <div style="margin-top:10px; font-size:12px; line-height:18px; color:#9CA3AF;">
                  © ${new Date().getFullYear()} Vocaid. All rights reserved.
                  &nbsp;•&nbsp;
                  <a href="${data.privacyUrl}" style="color:#6D28D9;">Privacy</a>
                  &nbsp;•&nbsp;
                  <a href="${data.termsUrl}" style="color:#6D28D9;">Terms</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>
    `,
    text: (data) => `
Verify your Vocaid email

Hi${data.firstName ? ' ' + data.firstName : ''},

Welcome to Vocaid! Please verify your email address to activate your account and start practicing interviews with our AI coach.

Your verification code: ${data.verificationCode}

Verification page: ${data.verifyUrl}

This code will expire in 24 hours.

If you didn't create a Vocaid account, you can safely ignore this email.

---
© ${new Date().getFullYear()} Vocaid. All rights reserved.
    `
  },
  pt: {
    subject: 'Verifique seu email Vocaid',
    html: (data) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; font-family:Arial, Helvetica, sans-serif; background-color:#FAFAFA;">
  <div style="display:none;font-size:1px;color:#F7F5FF;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Verifique seu email para começar a praticar entrevistas com o Vocaid
  </div>
  
  <center style="width:100%; background-color:#FAFAFA;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%; background-color:#FAFAFA; border-collapse:collapse; table-layout:fixed; margin:0 auto;">
      <tr>
        <td align="center" valign="top" style="padding:16px 0;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" align="center" style="width:600px; max-width:600px; margin:0 auto; background-color:#FFFFFF; border-radius:18px; overflow:hidden; border-collapse:separate; box-shadow:0 10px 30px rgba(17,24,39,0.06);">
            
            <!-- Header -->
            <tr>
              <td style="background-color:#ffffff; padding:18px 20px; border-bottom:1px solid #E5E7EB;">
                <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" align="center" style="width:560px; max-width:560px; margin:0 auto; border-collapse:collapse;">
                  <tr>
                    <td align="left" style="vertical-align:middle;">
                      <img src="https://resend-attachments.s3.amazonaws.com/6JI1baUnCt05bRK" width="140" alt="Vocaid" style="width:140px; height:auto; display:block;">
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <span style="display:inline-block; padding:6px 10px; background-color:#10B981; border:1px solid rgba(255,255,255,0.25); border-radius:999px; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:12px; font-weight:700;">
                        Verificação de Email
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            
            <!-- Content -->
            <tr>
              <td style="padding:18px 20px 8px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:30px; line-height:38px; font-weight:800; color:#111827;">
                  Verifique seu <span style="color:#6D28D9;">email</span>.
                </div>
                
                <div style="margin-top:12px; font-size:16px; line-height:24px; color:#374151;">
                  <p style="margin:0 0 16px;">Olá${data.firstName ? ' ' + data.firstName : ''},</p>
                  <p style="margin:0 0 16px;">Bem-vindo ao Vocaid! Use este código de verificação para ativar sua conta:</p>
                </div>

                <div style="margin:0 0 8px; padding:14px 16px; border:1px solid #E5E7EB; border-radius:12px; background-color:#F9FAFB; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:22px; font-weight:800; letter-spacing:0.25em; color:#111827; text-align:center;">
                  ${data.verificationCode}
                </div>
                
                <!-- CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0; border-collapse:separate;">
                  <tr>
                    <td align="center" bgcolor="#6D28D9" style="border-radius:12px;">
                      <a href="${data.verifyUrl}" style="display:inline-block; padding:14px 28px; font-family:Arial, Helvetica, sans-serif; font-size:16px; font-weight:800; color:#FFFFFF; background-color:#6D28D9; border-radius:12px; border:1px solid #6D28D9; text-decoration:none;">
                        Inserir Código
                      </a>
                    </td>
                  </tr>
                </table>
                
                <div style="font-size:14px; line-height:22px; color:#6B7280;">
                  <p style="margin:0 0 12px;">Ou copie e cole este link no seu navegador:</p>
                  <p style="margin:0 0 16px; word-break:break-all;">
                    <a href="${data.verifyUrl}" style="color:#6D28D9; font-weight:600;">${data.verifyUrl}</a>
                  </p>
                  <p style="margin:0 0 12px;"><strong>Este código expira em 24 horas.</strong></p>
                  <p style="margin:0;">Se você não criou uma conta Vocaid, pode ignorar este email com segurança.</p>
                </div>
              </td>
            </tr>
            
            <!-- Divider -->
            <tr>
              <td style="padding:0 20px;">
                <div style="height:1px; background-color:#E5E7EB; line-height:1px;">&nbsp;</div>
              </td>
            </tr>
            
            <!-- Footer -->
            <tr>
              <td style="padding:16px 20px 20px; font-family:Arial, Helvetica, sans-serif;">
                <div style="font-size:12px; line-height:18px; color:#6B7280;">
                  Precisa de ajuda? Entre em contato conosco em
                  <a href="mailto:${data.supportEmail}" style="color:#6D28D9; font-weight:700;">${data.supportEmail}</a>.
                </div>
                <div style="margin-top:10px; font-size:12px; line-height:18px; color:#9CA3AF;">
                  © ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
                  &nbsp;•&nbsp;
                  <a href="${data.privacyUrl}" style="color:#6D28D9;">Privacidade</a>
                  &nbsp;•&nbsp;
                  <a href="${data.termsUrl}" style="color:#6D28D9;">Termos</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>
    `,
    text: (data) => `
Verifique seu email Vocaid

Olá${data.firstName ? ' ' + data.firstName : ''},

Bem-vindo ao Vocaid! Por favor, verifique seu endereço de email para ativar sua conta e começar a praticar entrevistas com nosso coach de IA.

Seu código de verificação: ${data.verificationCode}

Página de verificação: ${data.verifyUrl}

Este código expira em 24 horas.

Se você não criou uma conta Vocaid, pode ignorar este email com segurança.

---
© ${new Date().getFullYear()} Vocaid. Todos os direitos reservados.
    `
  }
};

/**
 * Generate idempotency key for email verification
 */
function generateEmailVerificationIdempotencyKey(userId: string, tokenHash: string): string {
  return `email_verify_${userId}_${tokenHash.substring(0, 16)}`;
}

/**
 * Send email verification email
 * Does NOT require consent (account security email)
 */
export async function sendEmailVerificationEmail(data: EmailVerificationData): Promise<EmailResult> {
  const lang = getLanguage(data.user.preferredLanguage);
  
  // Ensure FRONTEND_URL has proper scheme
  let frontendUrl = FRONTEND_URL;
  if (!frontendUrl.startsWith('http://') && !frontendUrl.startsWith('https://')) {
    frontendUrl = process.env.NODE_ENV === 'production' ? `https://${frontendUrl}` : `http://${frontendUrl}`;
  }
  
  // Use /auth/verify-email path for email verification (code-based)
  const verifyUrl = `${frontendUrl}/auth/verify-email?email=${encodeURIComponent(data.user.email)}`;
  
  emailLogger.info('Attempting to send email verification email', { 
    userId: data.user.id, 
    email: data.user.email 
  });

  // Create email record for audit
  const tokenHash = require('crypto')
    .createHash('sha256')
    .update(`${data.user.id}:${data.verificationCode}`)
    .digest('hex');
  const emailRecord = await prisma.transactionalEmail.create({
    data: {
      userId: data.user.id,
      toEmail: data.user.email,
      emailType: 'EMAIL_VERIFICATION',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey: generateEmailVerificationIdempotencyKey(data.user.id, tokenHash),
      language: lang,
      payloadJson: {
        expiresAt: data.expiresAt.toISOString(),
        ipAddress: data.ipAddress,
        userAgent: data.userAgent?.substring(0, 200),
      }
    }
  });

  // In dev/mock mode, log the verification code for testing
  if (process.env.NODE_ENV === 'development' || getEmailProviderMode() === 'mock') {
    emailLogger.info('DEV MODE - Email verification code:', { code: data.verificationCode, verifyUrl });
  }

  const subject = lang === 'pt' ? 'Verifique seu email Vocaid' : 'Verify your Vocaid email';
  const preheader = lang === 'pt'
    ? 'Use o código para ativar sua conta.'
    : 'Use the code to activate your account.';

  const contentHtml = `
    <p style="margin:0 0 12px; font-size:14px; color:#111827;">
      ${lang === 'pt'
        ? `Olá${data.user.firstName ? ` ${data.user.firstName}` : ''},`
        : `Hi${data.user.firstName ? ` ${data.user.firstName}` : ''},`}
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

  const templateVariables = buildTransactionalTemplateVariables({
    preheader,
    subject,
    reason: lang === 'pt' ? 'Verificação de email' : 'Email verification',
    header: lang === 'pt' ? 'Verifique' : 'Verify',
    header_highlight: lang === 'pt' ? 'email' : 'email',
    content: contentHtml,
  });

  const sendResult = await sendTransactionalTemplateEmail({
    to: data.user.email,
    from: EMAIL_SENDERS.transactional,
    templateVariables,
  });

  if (!sendResult.success) {
    emailLogger.warn('Email verification email failed to send', { 
      userId: data.user.id,
      error: sendResult.error,
    });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: sendResult.error || 'Unknown error' }
      }
    });
    
    return { 
      success: false, 
      error: sendResult.error || 'Email send failed',
      emailId: emailRecord.id 
    };
  }

  // Update record as SENT
  await prisma.transactionalEmail.update({
    where: { id: emailRecord.id },
    data: {
      status: 'SENT',
      providerMessageId: sendResult.messageId || null,
      sentAt: new Date()
    }
  });

  emailLogger.info('Email verification email sent successfully', { 
    userId: data.user.id, 
    messageId: sendResult.messageId 
  });

  return { 
    success: true, 
    emailId: emailRecord.id,
    messageId: sendResult.messageId 
  };
}

// ========================================
// EMAIL PREVIEW FUNCTIONS (For Testing)
// ========================================

export type PreviewableEmailType = 'welcome' | 'purchase' | 'low-credits' | 'interview-complete';

/**
 * Generate a preview of an email template (for admin testing)
 */
export function previewEmail(
  type: PreviewableEmailType,
  language: SupportedLanguage = 'en',
  sampleData?: Record<string, any>
): { subject: string; html: string; text: string } {
  const defaults = {
    firstName: 'John',
    dashboardUrl: `${FRONTEND_URL}/dashboard`,
    creditsPageUrl: `${FRONTEND_URL}/credits`,
    interviewUrl: `${FRONTEND_URL}/interviews/sample-id`,
    feedbackUrl: `${FRONTEND_URL}/interviews/sample-id/feedback`,
    supportEmail: SUPPORT_EMAIL,
    packageName: 'Professional',
    creditsAmount: 15,
    amountPaid: '7.99',
    currency: 'USD',
    provider: 'PayPal',
    transactionId: 'TXN-123456789',
    paidAt: new Date().toLocaleDateString(language === 'pt' ? 'pt-BR' : 'en-US'),
    newBalance: 20,
    currentCredits: 1,
    threshold: 2,
    interviewTitle: 'Software Engineer Interview',
    jobRole: 'Senior Software Engineer',
    duration: 25,
    overallScore: 78
  };

  const data = { ...defaults, ...sampleData };

  switch (type) {
    case 'welcome':
      return {
        subject: welcomeTemplates[language].subject,
        html: welcomeTemplates[language].html(data),
        text: welcomeTemplates[language].text(data)
      };
    case 'purchase':
      return {
        subject: receiptTemplates[language].subject(data),
        html: receiptTemplates[language].html(data),
        text: receiptTemplates[language].text(data)
      };
    case 'low-credits':
      return {
        subject: lowCreditsTemplates[language].subject,
        html: lowCreditsTemplates[language].html(data),
        text: lowCreditsTemplates[language].text(data)
      };
    case 'interview-complete':
      return {
        subject: interviewCompleteTemplates[language].subject,
        html: interviewCompleteTemplates[language].html(data),
        text: interviewCompleteTemplates[language].text(data)
      };
    default:
      throw new Error(`Unknown email type: ${type}`);
  }
}

/**
 * Get list of all available email types for preview
 */
export function getAvailableEmailTypes(): Array<{
  type: PreviewableEmailType;
  name: string;
  description: string;
}> {
  return [
    { type: 'welcome', name: 'Welcome Email', description: 'Sent when a new user registers' },
    { type: 'purchase', name: 'Purchase Receipt', description: 'Sent after successful credit purchase' },
    { type: 'low-credits', name: 'Low Credits Warning', description: 'Sent when credits fall below threshold' },
    { type: 'interview-complete', name: 'Interview Complete', description: 'Sent after completing an interview with results' }
  ];
}
