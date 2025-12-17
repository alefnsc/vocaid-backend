/**
 * Multilingual Platform Types
 * 
 * Comprehensive type definitions for:
 * - Supported languages and regions
 * - Clerk metadata structure
 * - Retell language configurations
 * - Payment provider strategy
 */

// ========================================
// SUPPORTED LANGUAGES
// ========================================

/**
 * ISO 639-1 language codes with regional variants
 * Used for Retell TTS/STT and app localization
 */
export type SupportedLanguageCode = 
  | 'pt-BR'  // Portuguese (Brazil)
  | 'en-US'  // English (United States)
  | 'en-GB'  // English (United Kingdom)
  | 'es-ES'  // Spanish (Spain)
  | 'es-MX'  // Spanish (Mexico)
  | 'es-AR'  // Spanish (Argentina)
  | 'fr-FR'  // French (France)
  | 'ru-RU'  // Russian
  | 'zh-CN'  // Chinese (Simplified)
  | 'zh-TW'  // Chinese (Traditional)
  | 'hi-IN'; // Hindi (India)

/**
 * Base language codes for app localization (without region)
 */
export type BaseLanguageCode = 'pt' | 'en' | 'es' | 'fr' | 'ru' | 'zh' | 'hi';

/**
 * Language configuration for display and voice
 */
export interface LanguageConfig {
  code: SupportedLanguageCode;
  baseCode: BaseLanguageCode;
  name: string;           // Native name
  englishName: string;    // English name for logs
  flag: string;           // Emoji flag
  rtl: boolean;           // Right-to-left language
  retellVoiceId?: string; // Default Retell voice for this language
  retellAgentId?: string; // Retell agent configured for this language
}

/**
 * Complete language configurations
 */
export const LANGUAGE_CONFIGS: Record<SupportedLanguageCode, LanguageConfig> = {
  'pt-BR': {
    code: 'pt-BR',
    baseCode: 'pt',
    name: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
    flag: '🇧🇷',
    rtl: false,
  },
  'en-US': {
    code: 'en-US',
    baseCode: 'en',
    name: 'English (US)',
    englishName: 'English (United States)',
    flag: '🇺🇸',
    rtl: false,
  },
  'en-GB': {
    code: 'en-GB',
    baseCode: 'en',
    name: 'English (UK)',
    englishName: 'English (United Kingdom)',
    flag: '🇬🇧',
    rtl: false,
  },
  'es-ES': {
    code: 'es-ES',
    baseCode: 'es',
    name: 'Español (España)',
    englishName: 'Spanish (Spain)',
    flag: '🇪🇸',
    rtl: false,
  },
  'es-MX': {
    code: 'es-MX',
    baseCode: 'es',
    name: 'Español (México)',
    englishName: 'Spanish (Mexico)',
    flag: '🇲🇽',
    rtl: false,
  },
  'es-AR': {
    code: 'es-AR',
    baseCode: 'es',
    name: 'Español (Argentina)',
    englishName: 'Spanish (Argentina)',
    flag: '🇦🇷',
    rtl: false,
  },
  'fr-FR': {
    code: 'fr-FR',
    baseCode: 'fr',
    name: 'Français',
    englishName: 'French',
    flag: '🇫🇷',
    rtl: false,
  },
  'ru-RU': {
    code: 'ru-RU',
    baseCode: 'ru',
    name: 'Русский',
    englishName: 'Russian',
    flag: '🇷🇺',
    rtl: false,
  },
  'zh-CN': {
    code: 'zh-CN',
    baseCode: 'zh',
    name: '简体中文',
    englishName: 'Chinese (Simplified)',
    flag: '🇨🇳',
    rtl: false,
  },
  'zh-TW': {
    code: 'zh-TW',
    baseCode: 'zh',
    name: '繁體中文',
    englishName: 'Chinese (Traditional)',
    flag: '🇹🇼',
    rtl: false,
  },
  'hi-IN': {
    code: 'hi-IN',
    baseCode: 'hi',
    name: 'हिन्दी',
    englishName: 'Hindi',
    flag: '🇮🇳',
    rtl: false,
  },
};

// ========================================
// REGIONS AND GEO-LOCATION
// ========================================

/**
 * Region codes for payment gateway routing
 */
export type RegionCode = 
  | 'LATAM'     // Latin America (Mercado Pago priority)
  | 'NORTH_AMERICA'
  | 'EUROPE'
  | 'ASIA_PACIFIC'
  | 'GLOBAL';   // Fallback for unknown regions

/**
 * LATAM countries that should use Mercado Pago
 */
export const LATAM_COUNTRIES = [
  'BR', 'MX', 'AR', 'CO', 'CL', 'PE', 'UY', 'VE', 'EC', 'BO', 
  'PY', 'PA', 'CR', 'GT', 'HN', 'SV', 'NI', 'DO', 'CU', 'PR'
] as const;

export type LatamCountryCode = typeof LATAM_COUNTRIES[number];

/**
 * Country to region mapping
 */
export interface CountryConfig {
  code: string;
  name: string;
  region: RegionCode;
  defaultLanguage: SupportedLanguageCode;
  currency: string;
  paymentProvider: PaymentProviderType;
}

/**
 * Common country configurations
 */
export const COUNTRY_CONFIGS: Record<string, CountryConfig> = {
  'BR': { code: 'BR', name: 'Brazil', region: 'LATAM', defaultLanguage: 'pt-BR', currency: 'BRL', paymentProvider: 'mercadopago' },
  'MX': { code: 'MX', name: 'Mexico', region: 'LATAM', defaultLanguage: 'es-MX', currency: 'MXN', paymentProvider: 'mercadopago' },
  'AR': { code: 'AR', name: 'Argentina', region: 'LATAM', defaultLanguage: 'es-AR', currency: 'ARS', paymentProvider: 'mercadopago' },
  'US': { code: 'US', name: 'United States', region: 'NORTH_AMERICA', defaultLanguage: 'en-US', currency: 'USD', paymentProvider: 'paypal' },
  'GB': { code: 'GB', name: 'United Kingdom', region: 'EUROPE', defaultLanguage: 'en-GB', currency: 'GBP', paymentProvider: 'paypal' },
  'ES': { code: 'ES', name: 'Spain', region: 'EUROPE', defaultLanguage: 'es-ES', currency: 'EUR', paymentProvider: 'paypal' },
  'FR': { code: 'FR', name: 'France', region: 'EUROPE', defaultLanguage: 'fr-FR', currency: 'EUR', paymentProvider: 'paypal' },
  'RU': { code: 'RU', name: 'Russia', region: 'EUROPE', defaultLanguage: 'ru-RU', currency: 'RUB', paymentProvider: 'paypal' },
  'CN': { code: 'CN', name: 'China', region: 'ASIA_PACIFIC', defaultLanguage: 'zh-CN', currency: 'CNY', paymentProvider: 'paypal' },
  'TW': { code: 'TW', name: 'Taiwan', region: 'ASIA_PACIFIC', defaultLanguage: 'zh-TW', currency: 'TWD', paymentProvider: 'paypal' },
  'IN': { code: 'IN', name: 'India', region: 'ASIA_PACIFIC', defaultLanguage: 'hi-IN', currency: 'INR', paymentProvider: 'paypal' },
};

// ========================================
// CLERK METADATA SCHEMA
// ========================================

/**
 * Clerk publicMetadata structure (accessible client-side)
 * Stores non-sensitive user preferences
 */
export interface ClerkPublicMetadata {
  credits: number;
  preferredLanguage: SupportedLanguageCode;
  detectedRegion: RegionCode;
  detectedCountry: string;
  timezone?: string;
  onboardingCompleted?: boolean;
  languageSetByUser?: boolean; // true if user manually selected, false if auto-detected
}

/**
 * Clerk privateMetadata structure (server-side only)
 * Stores sensitive or internal data
 */
export interface ClerkPrivateMetadata {
  paymentProviderPreference?: PaymentProviderType;
  paymentProviderFallbackUsed?: boolean;
  lastGeoUpdate?: string; // ISO date string
  ipHistory?: string[];   // For fraud detection
  internalNotes?: string;
}

/**
 * Combined user preferences (from both metadata types)
 */
export interface UserPreferences {
  language: SupportedLanguageCode;
  languageConfig: LanguageConfig;
  region: RegionCode;
  country: string;
  paymentProvider: PaymentProviderType;
  timezone?: string;
}

// ========================================
// PAYMENT PROVIDER STRATEGY
// ========================================

/**
 * Supported payment provider types
 */
export type PaymentProviderType = 'mercadopago' | 'paypal';

/**
 * Payment preference creation response
 */
export interface PaymentPreferenceResponse {
  id: string;
  initPoint: string;       // Redirect URL for payment
  provider: PaymentProviderType;
  sandboxMode: boolean;
}

/**
 * Payment provider interface (Strategy Pattern)
 * Each provider must implement these methods
 */
export interface IPaymentProvider {
  readonly type: PaymentProviderType;
  readonly name: string;
  readonly supportedCurrencies: string[];
  readonly supportedRegions: RegionCode[];
  
  /**
   * Check if this provider is available and configured
   */
  isAvailable(): boolean;
  
  /**
   * Check if provider supports the given region
   */
  supportsRegion(region: RegionCode): boolean;
  
  /**
   * Create a payment preference/session
   */
  createPaymentPreference(params: CreatePaymentParams): Promise<PaymentPreferenceResponse>;
  
  /**
   * Process webhook notification
   */
  handleWebhook(payload: any, headers: Record<string, string>): Promise<WebhookResult>;
  
  /**
   * Get payment status
   */
  getPaymentStatus(paymentId: string): Promise<PaymentStatusResult>;
}

export interface CreatePaymentParams {
  userId: string;
  userEmail: string;
  packageId: string;
  packageName: string;
  credits: number;
  amountUSD: number;
  amountLocal: number;
  currency: string;
  language: SupportedLanguageCode;
  successUrl: string;
  failureUrl: string;
  pendingUrl?: string;
  webhookUrl?: string;
}

export interface WebhookResult {
  success: boolean;
  paymentId: string;
  externalId: string;
  status: 'approved' | 'pending' | 'rejected' | 'cancelled';
  statusDetail?: string;
  creditsToAdd?: number;
  userId?: string;
}

export interface PaymentStatusResult {
  status: 'approved' | 'pending' | 'rejected' | 'cancelled' | 'unknown';
  statusDetail?: string;
  paidAt?: Date;
  amount?: number;
  currency?: string;
}

// ========================================
// RETELL LANGUAGE CONFIGURATION
// ========================================

/**
 * Retell agent configuration per language
 */
export interface RetellLanguageConfig {
  language: SupportedLanguageCode;
  agentId: string;
  voiceId?: string;
  llmModel?: string;
  responseDelayMs?: number; // Adjust for language complexity
}

/**
 * Retell call parameters with language support
 */
export interface MultilingualRetellCallParams {
  userId: string;
  language: SupportedLanguageCode;
  metadata: {
    first_name: string;
    last_name?: string;
    job_title: string;
    company_name: string;
    job_description: string;
    interviewee_cv: string;
    resume_file_name?: string;
    resume_mime_type?: string;
    interview_id?: string;
    preferred_language: SupportedLanguageCode;
  };
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Get region from country code
 */
export function getRegionFromCountry(countryCode: string): RegionCode {
  if (LATAM_COUNTRIES.includes(countryCode as LatamCountryCode)) {
    return 'LATAM';
  }
  
  const config = COUNTRY_CONFIGS[countryCode];
  return config?.region || 'GLOBAL';
}

/**
 * Get default language for a country
 */
export function getDefaultLanguageForCountry(countryCode: string): SupportedLanguageCode {
  const config = COUNTRY_CONFIGS[countryCode];
  return config?.defaultLanguage || 'en-US';
}

/**
 * Get payment provider for region
 */
export function getPaymentProviderForRegion(region: RegionCode): PaymentProviderType {
  return region === 'LATAM' ? 'mercadopago' : 'paypal';
}

/**
 * Get base language code from full code
 */
export function getBaseLanguageCode(code: SupportedLanguageCode): BaseLanguageCode {
  return LANGUAGE_CONFIGS[code]?.baseCode || 'en';
}

/**
 * Validate if a string is a supported language code
 */
export function isValidLanguageCode(code: string): code is SupportedLanguageCode {
  return code in LANGUAGE_CONFIGS;
}

/**
 * Get language config with fallback
 */
export function getLanguageConfig(code: string): LanguageConfig {
  if (isValidLanguageCode(code)) {
    return LANGUAGE_CONFIGS[code];
  }
  return LANGUAGE_CONFIGS['en-US']; // Default fallback
}
