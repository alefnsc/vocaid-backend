/**
 * Consent Version Constants
 * 
 * Single source of truth for legal document versions.
 * Update these when Terms of Use or Privacy Policy are modified.
 * 
 * When updating:
 * 1. Increment the version string (e.g., "2025-12-23" → "2026-01-15")
 * 2. Users with older versions will be prompted to re-consent
 * 3. All consent events are logged with the version for audit purposes
 */

// Terms of Use version - update when Terms document changes
export const TERMS_VERSION = '2025-12-23';

// Privacy Policy version - update when Privacy document changes
export const PRIVACY_VERSION = '2025-12-23';

// Marketing consent text version - update when marketing opt-in wording changes
export const MARKETING_CONSENT_VERSION = '2025-12-23';

// URLs for legal documents (used in frontend consent UI)
export const LEGAL_DOCUMENT_URLS = {
  termsOfUse: '/terms-of-use',
  privacyPolicy: '/privacy-policy',
} as const;

// Consent requirements configuration
export const CONSENT_REQUIREMENTS = {
  // Terms acceptance is always required
  termsRequired: true,
  // Privacy acceptance is always required
  privacyRequired: true,
  // Transactional emails are essential and cannot be opted out
  transactionalRequired: true,
  // Marketing is optional opt-in
  marketingOptional: true,
} as const;

/**
 * Check if user's accepted versions are current
 */
export function isConsentVersionCurrent(
  acceptedTermsVersion: string | null,
  acceptedPrivacyVersion: string | null
): boolean {
  return (
    acceptedTermsVersion === TERMS_VERSION &&
    acceptedPrivacyVersion === PRIVACY_VERSION
  );
}

/**
 * Get current consent requirements for API response
 */
export function getConsentRequirements() {
  return {
    versions: {
      terms: TERMS_VERSION,
      privacy: PRIVACY_VERSION,
      marketing: MARKETING_CONSENT_VERSION,
    },
    urls: LEGAL_DOCUMENT_URLS,
    requirements: CONSENT_REQUIREMENTS,
  };
}
