/**
 * Email Template Manifest & Validator
 *
 * Defines required and optional variables for each Resend template alias.
 * Validates template variables before sending to prevent blank/broken emails.
 *
 * @module services/email/templateManifest
 */

import logger from '../../utils/logger';

const manifestLogger = logger.child({ component: 'template-manifest' });

// ========================================
// TEMPLATE ALIASES
// ========================================

/**
 * Resend dashboard template aliases.
 * These must match the exact alias names configured in Resend.
 */
export const TEMPLATE_ALIASES = {
  welcome: 'welcome_b2c',
  feedback: 'feedback',
  transactional: 'transactional',
} as const;

export type TemplateAlias = (typeof TEMPLATE_ALIASES)[keyof typeof TEMPLATE_ALIASES];

// ========================================
// TEMPLATE MANIFEST
// ========================================

/**
 * Template manifest defining required and optional variables for each template.
 * 
 * - required: Variables that MUST be present (fail-fast if missing)
 * - optional: Variables that may be present (no error if missing)
 * 
 * Variable names use triple-stash Mustache syntax: {{{VARIABLE_NAME}}}
 */
export const TEMPLATE_MANIFEST: Record<TemplateAlias, {
  required: string[];
  optional: string[];
}> = {
  // Welcome email (alias: welcome_b2c)
  welcome_b2c: {
    required: [
      'free_credits',
      'CANDIDATE_FIRST_NAME',
      'DASHBOARD_URL',
      'CURRENT_YEAR',
      'PRIVACY_URL',
      'TERMS_URL',
    ],
    optional: [],
  },

  // Feedback email (alias: feedback)
  feedback: {
    required: [
      'CANDIDATE_FIRST_NAME',
      'ROLE_TITLE',
      'DASHBOARD_URL',
      'CURRENT_YEAR',
      'PRIVACY_URL',
      'TERMS_URL',
    ],
    optional: [
      // Interview details (may not be available for all interviews)
      'TARGET_COMPANY',
      'INTERVIEW_LANGUAGE',
      'OVERALL_SCORE',
      'DURATION_MIN',
      'INTERVIEW_DATE',
      'TOPICS_COVERED',
      // Strengths (up to 3, with timestamps)
      'STRENGTH_1',
      'STRENGTH_1_TS',
      'STRENGTH_2',
      'STRENGTH_2_TS',
      'STRENGTH_3',
      'STRENGTH_3_TS',
      // Improvements (up to 3)
      'IMPROVEMENT_1',
      'IMPROVEMENT_2',
      'IMPROVEMENT_3',
      // Rubric scores (up to 3 rubrics)
      'RUBRIC_1_NAME',
      'RUBRIC_1_SCORE',
      'RUBRIC_1_PCT',
      'RUBRIC_1_EVIDENCE_TS',
      'RUBRIC_1_EVIDENCE_NOTE',
      'RUBRIC_2_NAME',
      'RUBRIC_2_SCORE',
      'RUBRIC_2_PCT',
      'RUBRIC_2_EVIDENCE_TS',
      'RUBRIC_2_EVIDENCE_NOTE',
      'RUBRIC_3_NAME',
      'RUBRIC_3_SCORE',
      'RUBRIC_3_PCT',
      'RUBRIC_3_EVIDENCE_TS',
      'RUBRIC_3_EVIDENCE_NOTE',
      // Feedback URL (alternative to dashboard)
      'FEEDBACK_URL',
      // Seniority level
      'SENIORITY',
    ],
  },

  // Transactional email (alias: transactional)
  transactional: {
    required: [
      'content', // Main HTML content block
    ],
    optional: [
      'preheader',
      'subject',
      'reason',
      'header',
      'header_highlight',
      'CURRENT_YEAR',
      'PRIVACY_URL',
      'TERMS_URL',
      'SUPPORT_EMAIL',
    ],
  },
};

// ========================================
// VALIDATION TYPES
// ========================================

export interface ValidationResult {
  valid: boolean;
  missingRequired: string[];
  providedKeys: string[];
  templateAlias: TemplateAlias;
}

export class TemplateValidationError extends Error {
  constructor(
    public templateAlias: TemplateAlias,
    public missingKeys: string[],
    public providedKeys: string[]
  ) {
    super(
      `Template validation failed for '${templateAlias}': missing required keys [${missingKeys.join(', ')}]`
    );
    this.name = 'TemplateValidationError';
  }
}

// ========================================
// VALIDATION FUNCTIONS
// ========================================

/**
 * Validate template variables against the manifest.
 *
 * @param templateAlias - The Resend template alias
 * @param variables - The variables object to validate
 * @returns Validation result with details
 */
export function validateTemplateVariables(
  templateAlias: TemplateAlias,
  variables: Record<string, any>
): ValidationResult {
  const manifest = TEMPLATE_MANIFEST[templateAlias];

  if (!manifest) {
    manifestLogger.error('Unknown template alias', { templateAlias });
    return {
      valid: false,
      missingRequired: [],
      providedKeys: Object.keys(variables),
      templateAlias,
    };
  }

  const providedKeys = Object.keys(variables);
  const missingRequired: string[] = [];

  for (const requiredKey of manifest.required) {
    const value = variables[requiredKey];
    // Check for missing, undefined, null, or empty string
    if (value === undefined || value === null || value === '') {
      missingRequired.push(requiredKey);
    }
  }

  const valid = missingRequired.length === 0;

  if (!valid) {
    manifestLogger.warn('Template validation failed', {
      templateAlias,
      missingRequired,
      providedKeys,
    });
  }

  return {
    valid,
    missingRequired,
    providedKeys,
    templateAlias,
  };
}

/**
 * Validate template variables and throw if invalid.
 * Use this for fail-fast validation before sending.
 *
 * @param templateAlias - The Resend template alias
 * @param variables - The variables object to validate
 * @throws TemplateValidationError if validation fails
 */
export function assertValidTemplateVariables(
  templateAlias: TemplateAlias,
  variables: Record<string, any>
): void {
  const result = validateTemplateVariables(templateAlias, variables);

  if (!result.valid) {
    throw new TemplateValidationError(
      templateAlias,
      result.missingRequired,
      result.providedKeys
    );
  }
}

/**
 * Get the manifest for a template alias.
 *
 * @param templateAlias - The Resend template alias
 * @returns The manifest definition
 */
export function getTemplateManifest(
  templateAlias: TemplateAlias
): { required: string[]; optional: string[] } | undefined {
  return TEMPLATE_MANIFEST[templateAlias];
}

/**
 * Check if a template alias is valid.
 *
 * @param alias - The alias to check
 * @returns true if this is a known template alias
 */
export function isValidTemplateAlias(alias: string): alias is TemplateAlias {
  return alias in TEMPLATE_MANIFEST;
}

// ========================================
// COMMON VARIABLES BUILDER
// ========================================

/**
 * Get common variables that are used across all templates.
 * These values come from environment configuration.
 */
export function getCommonTemplateVariables(): {
  CURRENT_YEAR: string;
  PRIVACY_URL: string;
  TERMS_URL: string;
  SUPPORT_EMAIL: string;
  DASHBOARD_URL: string;
} {
  const frontendUrl = process.env.FRONTEND_URL || 'https://vocaid.ai';

  return {
    CURRENT_YEAR: new Date().getFullYear().toString(),
    PRIVACY_URL: `${frontendUrl}/privacy`,
    TERMS_URL: `${frontendUrl}/terms`,
    SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || 'support@vocaid.ai',
    DASHBOARD_URL: `${frontendUrl}/app/dashboard`,
  };
}

/**
 * Merge common variables with specific variables.
 * Common variables will not override specific ones if already present.
 */
export function withCommonVariables<T extends Record<string, any>>(
  specificVariables: T
): T & ReturnType<typeof getCommonTemplateVariables> {
  const common = getCommonTemplateVariables();
  return {
    ...common,
    ...specificVariables, // Specific variables take precedence
  };
}
