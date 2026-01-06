/**
 * User Preferences Service
 * 
 * Manages user language and region preferences in the database.
 * Preferences are stored directly on the User model for efficient access.
 * 
 * @module services/userPreferencesService
 */

import { prisma, dbLogger } from './databaseService';
import { authLogger } from '../utils/logger';
import {
  SupportedLanguageCode,
  RegionCode,
  PaymentProviderType,
  UserPreferences,
  LANGUAGE_CONFIGS,
  getRegionFromCountry,
  getDefaultLanguageForCountry,
  getPaymentProviderForRegion,
  getLanguageConfig,
  isValidLanguageCode,
} from '../types/multilingual';

// ========================================
// TYPES
// ========================================

export interface UpdatePreferencesParams {
  language?: SupportedLanguageCode;
  country?: string;
  timezone?: string;
  setByUser?: boolean; // Whether user manually selected the language
  preferredPhoneCountry?: string; // ISO2 country code for phone verification
}

export interface GeoDetectionResult {
  country: string;
  region: RegionCode;
  language: SupportedLanguageCode;
  timezone: string;
  ip?: string;
}

// ========================================
// GEO-DETECTION
// ========================================

/**
 * Detect user's location from IP address
 * Uses request headers (works behind proxies like Cloudflare)
 */
export async function detectUserGeoFromIP(
  ip: string,
  headers?: Record<string, string>
): Promise<GeoDetectionResult> {
  authLogger.info('Detecting user geo from IP', { ip: ip.substring(0, 10) + '...' });
  
  // Try Cloudflare headers first (most accurate)
  if (headers) {
    const cfCountry = headers['cf-ipcountry'];
    const cfTimezone = headers['cf-timezone'];
    
    if (cfCountry && cfCountry !== 'XX') {
      const country = cfCountry.toUpperCase();
      const region = getRegionFromCountry(country);
      const language = getDefaultLanguageForCountry(country);
      
      authLogger.info('Geo detected from Cloudflare headers', { country, region, language });
      
      return {
        country,
        region,
        language,
        timezone: cfTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        ip,
      };
    }
  }
  
  // Fallback to IP geolocation API (free tier)
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,timezone`);
    if (response.ok) {
      const data = await response.json() as { countryCode?: string; timezone?: string };
      const country = data.countryCode || 'US';
      const region = getRegionFromCountry(country);
      const language = getDefaultLanguageForCountry(country);
      
      authLogger.info('Geo detected from IP API', { country, region, language });
      
      return {
        country,
        region,
        language,
        timezone: data.timezone || 'America/New_York',
        ip,
      };
    }
  } catch (error) {
    authLogger.warn('IP geolocation API failed, using defaults', { error });
  }
  
  // Default fallback
  return {
    country: 'US',
    region: 'NORTH_AMERICA',
    language: 'en-US',
    timezone: 'America/New_York',
    ip,
  };
}

/**
 * Detect language from Accept-Language header
 */
export function detectLanguageFromHeader(acceptLanguage?: string): SupportedLanguageCode | null {
  if (!acceptLanguage) return null;
  
  // Parse Accept-Language header (e.g., "pt-BR,pt;q=0.9,en-US;q=0.8")
  const languages = acceptLanguage
    .split(',')
    .map(lang => {
      const [code, qValue] = lang.trim().split(';q=');
      return {
        code: code.trim(),
        quality: qValue ? parseFloat(qValue) : 1.0,
      };
    })
    .sort((a, b) => b.quality - a.quality);
  
  // Find first matching supported language
  for (const { code } of languages) {
    // Try exact match first
    if (isValidLanguageCode(code)) {
      return code;
    }
    
    // Try base language match (e.g., "pt" -> "pt-BR")
    const baseCode = code.split('-')[0];
    const matchingLang = Object.values(LANGUAGE_CONFIGS).find(
      config => config.baseCode === baseCode
    );
    
    if (matchingLang) {
      return matchingLang.code;
    }
  }
  
  return null;
}

// ========================================
// DATABASE OPERATIONS
// ========================================

/**
 * Get user preferences from database
 * @param userId - Database user ID (UUID)
 */
export async function getUserPreferences(userId: string): Promise<UserPreferences | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        preferredLanguage: true,
        registrationRegion: true,
        registrationCountry: true,
        countryCode: true,
      },
    });

    if (!user) {
      authLogger.warn('User not found for preferences lookup', { userId });
      return null;
    }

    const language = (user.preferredLanguage || 'en-US') as SupportedLanguageCode;
    const region = (user.registrationRegion || 'GLOBAL') as RegionCode;
    const country = user.registrationCountry || user.countryCode || 'US';
    
    // Payment provider is derived from region (no persisted preference in schema)
    const paymentProvider = getPaymentProviderForRegion(region);

    return {
      language,
      languageConfig: getLanguageConfig(language),
      region,
      country,
      paymentProvider,
      timezone: undefined,
      preferredPhoneCountry: undefined,
    };
  } catch (error: any) {
    authLogger.error('Failed to get user preferences from database', {
      userId,
      error: error.message,
    });
    return null;
  }
}

/**
 * Update user preferences in database
 * @param userId - Database user ID (UUID)
 * @param params - Preference updates
 */
export async function updateUserPreferences(
  userId: string,
  params: UpdatePreferencesParams
): Promise<UserPreferences> {
  authLogger.info('Updating user preferences', { userId, params });
  
  try {
    // Build update data
    const updateData: Record<string, any> = {};

    if (params.language) {
      updateData.preferredLanguage = params.language;
    }

    if (params.country) {
      updateData.registrationCountry = params.country;
      updateData.registrationRegion = getRegionFromCountry(params.country);
      updateData.countryCode = params.country;
    }

    // Update database
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        preferredLanguage: true,
        registrationRegion: true,
        registrationCountry: true,
        countryCode: true,
      },
    });

    authLogger.info('User preferences updated in database', {
      userId,
      language: updatedUser.preferredLanguage,
      region: updatedUser.registrationRegion,
    });

    const language = (updatedUser.preferredLanguage || 'en-US') as SupportedLanguageCode;
    const region = (updatedUser.registrationRegion || 'GLOBAL') as RegionCode;
    const paymentProvider = getPaymentProviderForRegion(region);

    return {
      language,
      languageConfig: getLanguageConfig(language),
      region,
      country: updatedUser.registrationCountry || updatedUser.countryCode || 'US',
      paymentProvider,
      timezone: undefined,
      preferredPhoneCountry: undefined,
    };
  } catch (error: any) {
    authLogger.error('Failed to update user preferences', {
      userId,
      error: error.message,
    });
    throw new Error(`Failed to update preferences: ${error.message}`);
  }
}

/**
 * Initialize user preferences on first login
 * Auto-detects language and region from request context
 * @param userId - Database user ID (UUID)
 */
export async function initializeUserPreferences(
  userId: string,
  ip: string,
  headers?: Record<string, string>
): Promise<UserPreferences> {
  authLogger.info('Initializing user preferences', { userId });
  
  try {
    // Check if preferences already exist
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        preferredLanguage: true,
      },
    });

    // If already set, don't override
    if (user?.preferredLanguage) {
      authLogger.info('User already has preferredLanguage, skipping auto-detection', { userId });
      return (await getUserPreferences(userId)) as UserPreferences;
    }

    // Auto-detect from request context
    const geoResult = await detectUserGeoFromIP(ip, headers);

    // Check Accept-Language header for language preference
    const headerLanguage = headers ? detectLanguageFromHeader(headers['accept-language']) : null;
    const preferredLanguage = headerLanguage || geoResult.language;

    // Update preferences with auto-detected values
    return await updateUserPreferences(userId, {
      language: preferredLanguage,
      country: geoResult.country,
      setByUser: false, // Auto-detected, not manually set
    });
  } catch (error: any) {
    authLogger.error('Failed to initialize user preferences', {
      userId,
      error: error.message,
    });

    // Return defaults on error
    return {
      language: 'en-US',
      languageConfig: getLanguageConfig('en-US'),
      region: 'GLOBAL',
      country: 'US',
      paymentProvider: 'paypal',
    };
  }
}

/**
 * Get user's preferred payment provider
 * With fallback logic if primary provider is unavailable
 * @param userId - Database user ID (UUID)
 */
export async function getPreferredPaymentProvider(
  userId: string
): Promise<{ provider: PaymentProviderType; isFallback: boolean }> {
  const preferences = await getUserPreferences(userId);
  
  if (!preferences) {
    return { provider: 'paypal', isFallback: true };
  }
  
  // Check if preferred provider is available
  const primaryProvider = preferences.paymentProvider;
  const isAvailable = await checkPaymentProviderAvailability(primaryProvider);
  
  if (isAvailable) {
    return { provider: primaryProvider, isFallback: false };
  }
  
  // Fallback to alternative provider
  const fallbackProvider: PaymentProviderType = primaryProvider === 'mercadopago' ? 'paypal' : 'mercadopago';
  
  authLogger.warn('Primary payment provider unavailable, using fallback', {
    userId,
    primary: primaryProvider,
    fallback: fallbackProvider,
  });
  
  return { provider: fallbackProvider, isFallback: true };
}

/**
 * Check if a payment provider is available and configured
 */
async function checkPaymentProviderAvailability(
  provider: PaymentProviderType
): Promise<boolean> {
  switch (provider) {
    case 'mercadopago':
      return !!(
        process.env.MERCADOPAGO_ACCESS_TOKEN || 
        process.env.MERCADOPAGO_TEST_ACCESS_TOKEN
      );
    case 'paypal':
      return !!(
        process.env.PAYPAL_CLIENT_ID && 
        process.env.PAYPAL_CLIENT_SECRET
      );
    default:
      return false;
  }
}

// ========================================
// BULK OPERATIONS (Admin)
// ========================================

/**
 * Update preferences for multiple users (admin operation)
 * @param updates - Array of {userId, country} pairs
 */
export async function bulkUpdateRegionPreferences(
  updates: Array<{ userId: string; country: string }>
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  
  for (const { userId, country } of updates) {
    try {
      await updateUserPreferences(userId, { country, setByUser: false });
      success++;
    } catch (error) {
      failed++;
      authLogger.error('Failed to update user preferences in bulk', { userId, error });
    }
  }
  
  return { success, failed };
}

// ========================================
// EXPORT DEFAULT
// ========================================

export default {
  getUserPreferences,
  updateUserPreferences,
  initializeUserPreferences,
  getPreferredPaymentProvider,
  detectUserGeoFromIP,
  detectLanguageFromHeader,
};
