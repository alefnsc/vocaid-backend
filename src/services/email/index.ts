/**
 * Email Module
 *
 * Clean architecture for transactional emails using Resend.
 *
 * Architecture layers:
 * 1. Policy (emailPolicy.ts) - Consent rules, security classification
 * 2. Manifest (templateManifest.ts) - Template variable validation
 * 3. Composer (emailComposer.ts) - Pure email composition
 * 4. Sender (emailSender.ts) - Unified send with logging
 *
 * @module services/email
 */

// Policy layer
export {
  type EmailType,
  type TemplateCategory,
  isSecurityEmail,
  isMustSendEmail,
  isProductEssentialEmail,
  requiresConsent,
  getTemplateCategory,
  canSendEmail,
  getPolicySummary,
} from './emailPolicy';

// Template manifest
export {
  TEMPLATE_ALIASES,
  TEMPLATE_MANIFEST,
  type TemplateAlias,
  validateTemplateVariables,
  assertValidTemplateVariables,
  getTemplateManifest,
  isValidTemplateAlias,
  getCommonTemplateVariables,
  withCommonVariables,
  TemplateValidationError,
} from './templateManifest';

// Composer layer
export {
  type ComposedEmail,
  type EmailAttachment,
  type UserContext,
  type SupportedLanguage,
  // Compose functions
  composeWelcomeEmail,
  composeFeedbackEmail,
  composeTransactionalEmail,
  composePurchaseReceiptEmail,
  composeLowCreditsEmail,
  composePasswordResetEmail,
  composeEmailVerificationEmail,
  // Idempotency key generators
  generateWelcomeIdempotencyKey,
  generateFeedbackIdempotencyKey,
  generatePurchaseIdempotencyKey,
  generateLowCreditsIdempotencyKey,
  generatePasswordResetIdempotencyKey,
  generateEmailVerificationIdempotencyKey,
  // Helpers
  getLanguage,
  // Data types
  type WelcomeEmailData,
  type FeedbackEmailData,
  type TransactionalEmailData,
  type PurchaseReceiptData,
  type LowCreditsEmailData,
  type PasswordResetEmailData,
  type EmailVerificationData,
} from './emailComposer';

// Sender layer
export {
  type EmailProviderMode,
  type SendEmailResult,
  sendEmail,
  sendEmails,
  getEmailProviderMode,
  isEmailMockMode,
  isEmailDisabled,
} from './emailSender';
