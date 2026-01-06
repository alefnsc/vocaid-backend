/**
 * Email Templates Module
 * 
 * Loads HTML/text email templates from files and provides rendering utilities.
 * Templates use Mustache-style {{{VARIABLE}}} placeholders for variable substitution.
 * 
 * @module templates/emails
 */

import * as fs from 'fs';
import * as path from 'path';

// ========================================
// EMAIL SENDER ADDRESSES
// ========================================
// Different sender addresses for different email types
// All must be on the verified subdomain: contact.vocaid.ai

export const EMAIL_SENDERS = {
  welcome: 'Vocaid <welcome@contact.vocaid.ai>',
  feedback: 'Vocaid <feedback@contact.vocaid.ai>',
  transactional: 'Vocaid <transactional@contact.vocaid.ai>',
} as const;

export type EmailSenderType = keyof typeof EMAIL_SENDERS;

// ========================================
// TEMPLATE TYPES
// ========================================

export type EmailTemplateName = 
  | 'welcome'
  | 'feedback'
  | 'password-reset'
  | 'purchase-receipt'
  | 'low-credits'
  | 'interview-reminder';

export type TemplateLanguage = 'en' | 'pt';
export type TemplateFormat = 'html' | 'txt';

export interface TemplateVariables {
  [key: string]: string | number | undefined;
}

// ========================================
// TEMPLATE CACHE
// ========================================

// Cache loaded templates to avoid repeated file reads
const templateCache = new Map<string, string>();

/**
 * Get the file path for a template
 */
function getTemplatePath(
  name: EmailTemplateName, 
  language: TemplateLanguage, 
  format: TemplateFormat
): string {
  return path.join(__dirname, name, `${language}.${format}`);
}

/**
 * Generate cache key for a template
 */
function getCacheKey(
  name: EmailTemplateName, 
  language: TemplateLanguage, 
  format: TemplateFormat
): string {
  return `${name}:${language}:${format}`;
}

/**
 * Load a template from file
 * Falls back to English if requested language doesn't exist
 * 
 * @param name - Template name (e.g., 'welcome', 'feedback')
 * @param language - Language code ('en' or 'pt')
 * @param format - Template format ('html' or 'txt')
 * @returns Template content as string
 */
export function loadTemplate(
  name: EmailTemplateName,
  language: TemplateLanguage = 'en',
  format: TemplateFormat = 'html'
): string {
  const cacheKey = getCacheKey(name, language, format);
  
  // Check cache first
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey)!;
  }
  
  // Try to load the requested language
  let templatePath = getTemplatePath(name, language, format);
  
  if (!fs.existsSync(templatePath)) {
    // Fall back to English
    if (language !== 'en') {
      templatePath = getTemplatePath(name, 'en', format);
    }
    
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Email template not found: ${name}/${language}.${format}`);
    }
  }
  
  const content = fs.readFileSync(templatePath, 'utf-8');
  
  // Cache the loaded template
  templateCache.set(cacheKey, content);
  
  return content;
}

/**
 * Render a template with variables
 * Replaces {{{VARIABLE_NAME}}} with corresponding values
 * 
 * @param template - Template string with placeholders
 * @param variables - Object with variable values
 * @returns Rendered template string
 */
export function renderTemplate(
  template: string,
  variables: TemplateVariables
): string {
  let rendered = template;
  
  for (const [key, value] of Object.entries(variables)) {
    // Replace {{{KEY}}} with value
    const placeholder = new RegExp(`\\{\\{\\{${key}\\}\\}\\}`, 'g');
    rendered = rendered.replace(placeholder, String(value ?? ''));
  }
  
  return rendered;
}

/**
 * Load and render a template in one call
 * 
 * @param name - Template name
 * @param language - Language code
 * @param format - Template format
 * @param variables - Variables to substitute
 * @returns Rendered template string
 */
export function loadAndRenderTemplate(
  name: EmailTemplateName,
  language: TemplateLanguage,
  format: TemplateFormat,
  variables: TemplateVariables
): string {
  const template = loadTemplate(name, language, format);
  return renderTemplate(template, variables);
}

/**
 * Check if a template exists for a given language
 * 
 * @param name - Template name
 * @param language - Language code
 * @param format - Template format
 * @returns true if template exists
 */
export function templateExists(
  name: EmailTemplateName,
  language: TemplateLanguage,
  format: TemplateFormat
): boolean {
  const templatePath = getTemplatePath(name, language, format);
  return fs.existsSync(templatePath);
}

/**
 * Clear the template cache
 * Useful for development/testing
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}

/**
 * Get common variables used in all email templates
 */
export function getCommonVariables(): TemplateVariables {
  return {
    CURRENT_YEAR: new Date().getFullYear().toString(),
    PRIVACY_URL: 'https://vocaid.ai/privacy-policy',
    TERMS_URL: 'https://vocaid.ai/terms-of-use',
    SUPPORT_EMAIL: 'support@vocaid.ai',
  };
}
