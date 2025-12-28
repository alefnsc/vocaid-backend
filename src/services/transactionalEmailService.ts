/**
 * Transactional Email Service
 * 
 * Handles sending transactional emails (welcome, purchase receipts) with:
 * - Idempotency to prevent duplicate sends
 * - Multi-language support (EN default, PT-BR)
 * - Audit logging via TransactionalEmail model
 * - Resend SDK integration
 * 
 * Design: Vocaid brand - white background, black text, zinc borders, purple-600 accents
 * 
 * @module services/transactionalEmailService
 */

import { PrismaClient, EmailSendStatus, TransactionalEmailType, EmailProvider, User } from '@prisma/client';
import logger from '../utils/logger';
import { canSendTransactional, canSendMarketing } from './consentService';

// Create email logger
const emailLogger = logger.child({ component: 'transactional-email' });

// Prisma client
const prisma = new PrismaClient();

// ========================================
// EMAIL PROVIDER MODE
// ========================================
// EMAIL_PROVIDER_MODE=mock  -> Log emails but don't send (still creates DB records)
// EMAIL_PROVIDER_MODE=resend -> Actually send via Resend SDK (default when API key present)
// If not set, defaults to 'resend' if RESEND_API_KEY exists, otherwise 'mock'

type EmailProviderMode = 'mock' | 'resend';

function getEmailProviderMode(): EmailProviderMode {
  const envMode = process.env.EMAIL_PROVIDER_MODE?.toLowerCase();
  
  // Explicit mode takes precedence
  if (envMode === 'mock') {
    return 'mock';
  }
  if (envMode === 'resend') {
    return 'resend';
  }
  
  // Default: use resend if API key exists, otherwise mock
  return process.env.RESEND_API_KEY ? 'resend' : 'mock';
}

// Log the current mode on startup
const currentMode = getEmailProviderMode();
emailLogger.info('Email provider mode', { 
  mode: currentMode, 
  explicit: !!process.env.EMAIL_PROVIDER_MODE,
  hasApiKey: !!process.env.RESEND_API_KEY
});

// Lazy-load Resend to avoid initialization errors when API key is missing
let resend: any = null;
let resendInitialized = false;

function getResendClient(): any {
  // Return null immediately in mock mode
  if (getEmailProviderMode() === 'mock') {
    if (!resendInitialized) {
      emailLogger.info('Email provider in MOCK mode - emails will be logged but not sent');
      resendInitialized = true;
    }
    return null;
  }
  
  if (resendInitialized) return resend;
  
  resendInitialized = true;
  const apiKey = process.env.RESEND_API_KEY;
  
  if (apiKey) {
    try {
      const { Resend } = require('resend');
      resend = new Resend(apiKey);
      emailLogger.info('Resend transactional email service initialized');
    } catch (error: any) {
      emailLogger.error('Failed to initialize Resend for transactional emails', { error: error.message });
      resend = null;
    }
  } else {
    emailLogger.warn('RESEND_API_KEY not set - transactional emails will be logged but not sent');
  }
  
  return resend;
}

/**
 * Check if emails are being sent in mock mode
 * Useful for testing and logging
 */
export function isEmailMockMode(): boolean {
  return getEmailProviderMode() === 'mock';
}

// Configuration
const EMAIL_FROM = process.env.EMAIL_FROM || 'Vocaid <alex@vocaid.ai>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://vocaid.ai';
const SUPPORT_EMAIL = 'support@vocaid.ai';

// ========================================
// TYPES
// ========================================

export interface UserEmailData {
  id: string;           // DB UUID
  clerkId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  preferredLanguage?: string | null;
}

export interface PurchaseEmailData {
  user: UserEmailData;
  paymentId: string;
  provider: 'mercadopago' | 'paypal';
  packageName: string;
  creditsAmount: number;
  amountPaid: number;
  currency: string;
  newBalance: number;
  paidAt: Date;
}

export interface InterviewReminderData {
  user: UserEmailData;
  interviewId?: string;           // Optional - for scheduled interview reminders
  interviewTitle?: string;        // Optional - for scheduled interview reminders
  jobRole?: string;               // Optional - for scheduled interview reminders
  scheduledAt?: Date;             // Optional - for scheduled interview reminders
  resumeUrl?: string;
  // For engagement reminders (come back and practice)
  lastInterviewDate?: Date;       // When they last practiced
  lastInterviewTitle?: string;    // Title of their last interview
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

export function generateWelcomeIdempotencyKey(clerkUserId: string): string {
  return `welcome:${clerkUserId}`;
}

export function generatePurchaseIdempotencyKey(provider: string, paymentId: string): string {
  return `purchase:${provider}:${paymentId}`;
}

export function generateLowCreditsIdempotencyKey(userId: string, threshold: number): string {
  // Only one low credits email per user per threshold level per day
  const date = new Date().toISOString().split('T')[0];
  return `low-credits:${userId}:${threshold}:${date}`;
}

export function generateInterviewReminderIdempotencyKey(userId: string, interviewId?: string): string {
  if (interviewId) {
    // For scheduled interview reminders - one per interview
    return `interview-reminder:${userId}:${interviewId}`;
  }
  // For engagement reminders - one per user per week
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start of week
  const weekKey = weekStart.toISOString().split('T')[0];
  return `engagement-reminder:${userId}:${weekKey}`;
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
  const canSend = await canSendTransactional(user.clerkId);
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

  const idempotencyKey = generateWelcomeIdempotencyKey(user.clerkId);
  
  emailLogger.info('Attempting to send welcome email', { 
    userId: user.id, 
    email: user.email,
    idempotencyKey 
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
        clerkId: user.clerkId
      }
    },
    update: {
      status: 'SENDING',
      retryCount: { increment: 1 },
      updatedAt: new Date()
    }
  });

  // Get Resend client
  const resendClient = getResendClient();
  
  if (!resendClient) {
    emailLogger.warn('Resend not configured - welcome email logged but not sent', { 
      userId: user.id 
    });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: 'Resend not configured' }
      }
    });
    
    return { 
      success: false, 
      error: 'Email service not configured',
      emailId: emailRecord.id 
    };
  }

  // Build email content
  const lang = getLanguage(user.preferredLanguage);
  const template = welcomeTemplates[lang];
  const templateData = {
    firstName: user.firstName || '',
    dashboardUrl: `${FRONTEND_URL}/app/dashboard`,
    supportEmail: SUPPORT_EMAIL
  };

  try {
    // Send via Resend
    const result = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: user.email,
      subject: template.subject,
      html: template.html(templateData),
      text: template.text(templateData)
    });

    // Update record as SENT
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'SENT',
        providerMessageId: result.data?.id || null,
        sentAt: new Date()
      }
    });

    emailLogger.info('Welcome email sent successfully', { 
      userId: user.id, 
      messageId: result.data?.id 
    });

    return { 
      success: true, 
      emailId: emailRecord.id,
      messageId: result.data?.id 
    };

  } catch (error: any) {
    emailLogger.error('Failed to send welcome email', { 
      userId: user.id, 
      error: error.message 
    });

    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { 
          message: error.message,
          stack: error.stack?.slice(0, 500)
        }
      }
    });

    return { 
      success: false, 
      error: error.message,
      emailId: emailRecord.id 
    };
  }
}

/**
 * Send purchase receipt email
 * Idempotent: Will not send if already sent for this payment
 * Respects consent: Checks transactional opt-in before sending
 */
export async function sendPurchaseReceiptEmail(data: PurchaseEmailData): Promise<EmailResult> {
  // Check transactional consent before sending
  const canSend = await canSendTransactional(data.user.clerkId);
  if (!canSend) {
    emailLogger.info('Purchase receipt blocked - user opted out of transactional emails', { 
      userId: data.user.id, 
      paymentId: data.paymentId 
    });
    return { 
      success: false, 
      skipped: true, 
      reason: 'Transactional emails disabled by user preference'
    };
  }

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
        packageName: data.packageName,
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

  // Get Resend client
  const resendClient = getResendClient();
  
  if (!resendClient) {
    emailLogger.warn('Resend not configured - purchase receipt logged but not sent', { 
      userId: data.user.id 
    });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: 'Resend not configured' }
      }
    });
    
    return { 
      success: false, 
      error: 'Email service not configured',
      emailId: emailRecord.id 
    };
  }

  // Build email content
  const lang = getLanguage(data.user.preferredLanguage);
  const template = receiptTemplates[lang];
  
  // Format amount
  const formattedAmount = data.amountPaid.toFixed(2);
  
  // Format date
  const dateFormatter = new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  const formattedDate = dateFormatter.format(data.paidAt);
  
  // Provider display name
  const providerDisplayName = data.provider === 'mercadopago' ? 'Mercado Pago' : 'PayPal';

  const templateData = {
    firstName: data.user.firstName || '',
    packageName: data.packageName,
    creditsAmount: data.creditsAmount,
    amountPaid: formattedAmount,
    currency: data.currency,
    newBalance: data.newBalance,
    transactionId: data.paymentId,
    provider: providerDisplayName,
    paidAt: formattedDate,
    creditsPageUrl: `${FRONTEND_URL}/app/b2c/billing`,
    supportEmail: SUPPORT_EMAIL
  };

  try {
    // Send via Resend
    const result = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: data.user.email,
      subject: template.subject({ packageName: data.packageName }),
      html: template.html(templateData),
      text: template.text(templateData)
    });

    // Update record as SENT
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'SENT',
        providerMessageId: result.data?.id || null,
        sentAt: new Date()
      }
    });

    emailLogger.info('Purchase receipt email sent successfully', { 
      userId: data.user.id, 
      paymentId: data.paymentId,
      messageId: result.data?.id 
    });

    return { 
      success: true, 
      emailId: emailRecord.id,
      messageId: result.data?.id 
    };

  } catch (error: any) {
    emailLogger.error('Failed to send purchase receipt email', { 
      userId: data.user.id, 
      paymentId: data.paymentId,
      error: error.message 
    });

    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { 
          message: error.message,
          stack: error.stack?.slice(0, 500)
        }
      }
    });

    return { 
      success: false, 
      error: error.message,
      emailId: emailRecord.id 
    };
  }
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
            clerkId: true,
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
            clerkId: email.user?.clerkId || '',
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
              clerkId: email.user?.clerkId || '',
              email: toEmail,
              firstName: email.user?.firstName,
              lastName: email.user?.lastName,
              preferredLanguage: email.language || undefined
            },
            paymentId: payload?.paymentId || email.id,
            provider: payload?.provider || 'mercadopago',
            packageName: payload?.packageName || 'Credits',
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
              clerkId: email.user?.clerkId || '',
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
  const template = lowCreditsTemplates[language];

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

  try {
    const resendClient = getResendClient();
    if (!resendClient) {
      emailLogger.warn('Resend not configured - logging low credits email', { userId: data.user.id });
      return { success: false, error: 'Email service not configured', emailId: emailRecord.id };
    }

    const creditsPageUrl = `${FRONTEND_URL}/credits`;
    const htmlContent = template.html({
      firstName: data.user.firstName || '',
      currentCredits: data.currentCredits,
      threshold: data.threshold,
      creditsPageUrl,
      supportEmail: SUPPORT_EMAIL
    });
    const textContent = template.text({
      firstName: data.user.firstName || '',
      currentCredits: data.currentCredits,
      threshold: data.threshold,
      creditsPageUrl,
      supportEmail: SUPPORT_EMAIL
    });

    const response = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: data.user.email,
      subject: template.subject,
      html: htmlContent,
      text: textContent
    });

    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'SENT',
        providerMessageId: response.id,
        sentAt: new Date()
      }
    });

    emailLogger.info('Low credits warning email sent', { userId: data.user.id, messageId: response.id });
    return { success: true, emailId: emailRecord.id, messageId: response.id };

  } catch (error: any) {
    emailLogger.error('Failed to send low credits email', { userId: data.user.id, error: error.message });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: error.message, stack: error.stack?.slice(0, 500) }
      }
    });

    return { success: false, error: error.message, emailId: emailRecord.id };
  }
}

/**
 * Send interview reminder email
 * Idempotent: Only one per interview, or one per user per week for engagement reminders
 */
export async function sendInterviewReminderEmail(data: InterviewReminderData): Promise<EmailResult> {
  const isEngagementReminder = !data.interviewId;
  const idempotencyKey = generateInterviewReminderIdempotencyKey(data.user.id, data.interviewId);
  const language = getLanguage(data.user.preferredLanguage);
  const template = interviewReminderTemplates[language];

  const existing = await prisma.transactionalEmail.findUnique({
    where: { idempotencyKey }
  });

  if (existing?.status === 'SENT') {
    return { success: true, skipped: true, reason: 'Already sent', emailId: existing.id };
  }

  const emailRecord = await prisma.transactionalEmail.upsert({
    where: { idempotencyKey },
    create: {
      userId: data.user.id,
      toEmail: data.user.email,
      emailType: 'INTERVIEW_REMINDER',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey,
      language,
      payloadJson: {
        interviewId: data.interviewId,
        interviewTitle: data.interviewTitle,
        jobRole: data.jobRole,
        isEngagementReminder,
        lastInterviewDate: data.lastInterviewDate?.toISOString()
      }
    },
    update: {
      status: 'PENDING',
      retryCount: { increment: 1 }
    }
  });

  try {
    const resendClient = getResendClient();
    if (!resendClient) {
      return { success: false, error: 'Email service not configured', emailId: emailRecord.id };
    }

    // For engagement reminders, link to interview setup; for specific interviews, link to that interview
    const interviewUrl = isEngagementReminder 
      ? `${FRONTEND_URL}/interview-setup`
      : `${FRONTEND_URL}/interviews/${data.interviewId}`;

    const htmlContent = template.html({
      firstName: data.user.firstName || '',
      interviewTitle: data.interviewTitle,
      jobRole: data.jobRole,
      interviewUrl,
      supportEmail: SUPPORT_EMAIL,
      isEngagementReminder
    });
    const textContent = template.text({
      firstName: data.user.firstName || '',
      interviewTitle: data.interviewTitle,
      jobRole: data.jobRole,
      interviewUrl,
      supportEmail: SUPPORT_EMAIL,
      isEngagementReminder
    });

    const response = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: data.user.email,
      subject: template.subject,
      html: htmlContent,
      text: textContent
    });

    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'SENT',
        providerMessageId: response.id,
        sentAt: new Date()
      }
    });

    emailLogger.info('Interview reminder email sent', { userId: data.user.id, interviewId: data.interviewId });
    return { success: true, emailId: emailRecord.id, messageId: response.id };

  } catch (error: any) {
    emailLogger.error('Failed to send interview reminder', { userId: data.user.id, error: error.message });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: error.message }
      }
    });

    return { success: false, error: error.message, emailId: emailRecord.id };
  }
}

/**
 * Send interview complete email with results
 * Idempotent: Only one per interview
 */
export async function sendInterviewCompleteEmail(data: InterviewCompleteData): Promise<EmailResult> {
  const idempotencyKey = generateInterviewCompleteIdempotencyKey(data.user.id, data.interviewId);
  const language = getLanguage(data.user.preferredLanguage);
  const template = interviewCompleteTemplates[language];

  const existing = await prisma.transactionalEmail.findUnique({
    where: { idempotencyKey }
  });

  if (existing?.status === 'SENT') {
    return { success: true, skipped: true, reason: 'Already sent', emailId: existing.id };
  }

  const emailRecord = await prisma.transactionalEmail.upsert({
    where: { idempotencyKey },
    create: {
      userId: data.user.id,
      toEmail: data.user.email,
      emailType: 'INTERVIEW_COMPLETE',
      status: 'PENDING',
      provider: 'RESEND',
      idempotencyKey,
      language,
      payloadJson: {
        interviewId: data.interviewId,
        interviewTitle: data.interviewTitle,
        jobRole: data.jobRole,
        duration: data.duration,
        overallScore: data.overallScore
      }
    },
    update: {
      status: 'PENDING',
      retryCount: { increment: 1 }
    }
  });

  try {
    const resendClient = getResendClient();
    if (!resendClient) {
      return { success: false, error: 'Email service not configured', emailId: emailRecord.id };
    }

    const feedbackUrl = `${FRONTEND_URL}/interviews/${data.interviewId}/feedback`;
    const htmlContent = template.html({
      firstName: data.user.firstName || '',
      interviewTitle: data.interviewTitle,
      jobRole: data.jobRole,
      duration: data.duration,
      overallScore: data.overallScore,
      feedbackUrl,
      supportEmail: SUPPORT_EMAIL
    });
    const textContent = template.text({
      firstName: data.user.firstName || '',
      interviewTitle: data.interviewTitle,
      jobRole: data.jobRole,
      duration: data.duration,
      overallScore: data.overallScore,
      feedbackUrl,
      supportEmail: SUPPORT_EMAIL
    });

    const response = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: data.user.email,
      subject: template.subject,
      html: htmlContent,
      text: textContent
    });

    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'SENT',
        providerMessageId: response.id,
        sentAt: new Date()
      }
    });

    emailLogger.info('Interview complete email sent', { userId: data.user.id, interviewId: data.interviewId });
    return { success: true, emailId: emailRecord.id, messageId: response.id };

  } catch (error: any) {
    emailLogger.error('Failed to send interview complete email', { userId: data.user.id, error: error.message });
    
    await prisma.transactionalEmail.update({
      where: { id: emailRecord.id },
      data: {
        status: 'FAILED',
        errorJson: { message: error.message }
      }
    });

    return { success: false, error: error.message, emailId: emailRecord.id };
  }
}

// ========================================
// EMAIL PREVIEW FUNCTIONS (For Testing)
// ========================================

export type PreviewableEmailType = 'welcome' | 'purchase' | 'low-credits' | 'interview-reminder' | 'interview-complete';

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
    case 'interview-reminder':
      return {
        subject: interviewReminderTemplates[language].subject,
        html: interviewReminderTemplates[language].html(data),
        text: interviewReminderTemplates[language].text(data)
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
    { type: 'interview-reminder', name: 'Interview Reminder', description: 'Sent to remind users about pending interviews' },
    { type: 'interview-complete', name: 'Interview Complete', description: 'Sent after completing an interview with results' }
  ];
}
