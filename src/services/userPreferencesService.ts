/**
 * User Preferences Service
 * 
 * Manages user language and region preferences in Clerk metadata.
 * Follows the "edge-first" approach by storing preferences in Clerk
 * so they're available in the JWT session without database calls.
 * 
 * @module services/userPreferencesService
 */

import { clerkClient } from '@clerk/express';
import { prisma, dbLogger } from './databaseService';
import { authLogger } from '../utils/logger';
import {
  SupportedLanguageCode,
  RegionCode,
  PaymentProviderType,
  ClerkPublicMetadata,
  ClerkPrivateMetadata,
  UserPreferences,
  LANGUAGE_CONFIGS,
  COUNTRY_CONFIGS,
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
// CLERK METADATA OPERATIONS
// ========================================

/**
 * Get user preferences from Clerk metadata
 * Combines public and private metadata into a unified preferences object
 */
export async function getUserPreferences(clerkId: string): Promise<UserPreferences | null> {
  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    
    const publicMeta = clerkUser.publicMetadata as Partial<ClerkPublicMetadata>;
    const privateMeta = clerkUser.privateMetadata as Partial<ClerkPrivateMetadata>;
    
    const language = publicMeta.preferredLanguage || 'en-US';
    const region = publicMeta.detectedRegion || 'GLOBAL';
    const country = publicMeta.detectedCountry || 'US';
    
    // Determine payment provider from private metadata or region
    const paymentProvider = 
      privateMeta.paymentProviderPreference || 
      getPaymentProviderForRegion(region);
    
    return {
      language: language as SupportedLanguageCode,
      languageConfig: getLanguageConfig(language),
      region: region as RegionCode,
      country,
      paymentProvider,
      timezone: publicMeta.timezone,
    };
  } catch (error: any) {
    authLogger.error('Failed to get user preferences from Clerk', {
      clerkId,
      error: error.message,
    });
    return null;
  }
}

/**
 * Update user preferences in Clerk metadata
 * Also syncs to local database for analytics
 */
export async function updateUserPreferences(
  clerkId: string,
  params: UpdatePreferencesParams
): Promise<UserPreferences> {
  authLogger.info('Updating user preferences', { clerkId, params });
  
  try {
    // Get current metadata
    const clerkUser = await clerkClient.users.getUser(clerkId);
    const currentPublicMeta = clerkUser.publicMetadata as Partial<ClerkPublicMetadata>;
    const currentPrivateMeta = clerkUser.privateMetadata as Partial<ClerkPrivateMetadata>;
    
    // Build updated metadata
    const updatedPublicMeta: Partial<ClerkPublicMetadata> = {
      ...currentPublicMeta,
    };
    
    const updatedPrivateMeta: Partial<ClerkPrivateMetadata> = {
      ...currentPrivateMeta,
      lastGeoUpdate: new Date().toISOString(),
    };
    
    if (params.language) {
      updatedPublicMeta.preferredLanguage = params.language;
      updatedPublicMeta.languageSetByUser = params.setByUser ?? true;
    }
    
    if (params.country) {
      updatedPublicMeta.detectedCountry = params.country;
      updatedPublicMeta.detectedRegion = getRegionFromCountry(params.country);
      
      // Update payment provider preference based on region
      updatedPrivateMeta.paymentProviderPreference = 
        getPaymentProviderForRegion(updatedPublicMeta.detectedRegion);
    }
    
    if (params.timezone) {
      updatedPublicMeta.timezone = params.timezone;
    }
    
    // Update Clerk metadata
    await clerkClient.users.updateUserMetadata(clerkId, {
      publicMetadata: updatedPublicMeta,
      privateMetadata: updatedPrivateMeta,
    });
    
    authLogger.info('User preferences updated in Clerk', {
      clerkId,
      language: updatedPublicMeta.preferredLanguage,
      region: updatedPublicMeta.detectedRegion,
    });
    
    // Return updated preferences
    return {
      language: updatedPublicMeta.preferredLanguage || 'en-US',
      languageConfig: getLanguageConfig(updatedPublicMeta.preferredLanguage || 'en-US'),
      region: updatedPublicMeta.detectedRegion || 'GLOBAL',
      country: updatedPublicMeta.detectedCountry || 'US',
      paymentProvider: updatedPrivateMeta.paymentProviderPreference || 'paypal',
      timezone: updatedPublicMeta.timezone,
    };
  } catch (error: any) {
    authLogger.error('Failed to update user preferences', {
      clerkId,
      error: error.message,
    });
    throw new Error(`Failed to update preferences: ${error.message}`);
  }
}

/**
 * Initialize user preferences on first login
 * Auto-detects language and region from request context
 */
export async function initializeUserPreferences(
  clerkId: string,
  ip: string,
  headers?: Record<string, string>
): Promise<UserPreferences> {
  authLogger.info('Initializing user preferences', { clerkId });
  
  try {
    // Check if preferences already exist
    const clerkUser = await clerkClient.users.getUser(clerkId);
    const publicMeta = clerkUser.publicMetadata as Partial<ClerkPublicMetadata>;
    
    // If user has manually set language, don't override
    if (publicMeta.languageSetByUser && publicMeta.preferredLanguage) {
      authLogger.info('User has existing manual preferences, skipping auto-detection', { clerkId });
      return await getUserPreferences(clerkId) as UserPreferences;
    }
    
    // Auto-detect from request context
    const geoResult = await detectUserGeoFromIP(ip, headers);
    
    // Check Accept-Language header for language preference
    const headerLanguage = headers ? detectLanguageFromHeader(headers['accept-language']) : null;
    const preferredLanguage = headerLanguage || geoResult.language;
    
    // Update preferences with auto-detected values
    return await updateUserPreferences(clerkId, {
      language: preferredLanguage,
      country: geoResult.country,
      timezone: geoResult.timezone,
      setByUser: false, // Auto-detected, not manually set
    });
  } catch (error: any) {
    authLogger.error('Failed to initialize user preferences', {
      clerkId,
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
 */
export async function getPreferredPaymentProvider(
  clerkId: string
): Promise<{ provider: PaymentProviderType; isFallback: boolean }> {
  const preferences = await getUserPreferences(clerkId);
  
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
    clerkId,
    primary: primaryProvider,
    fallback: fallbackProvider,
  });
  
  // Record that we used fallback
  try {
    await clerkClient.users.updateUserMetadata(clerkId, {
      privateMetadata: {
        paymentProviderFallbackUsed: true,
      },
    });
  } catch (error) {
    // Non-critical, continue with fallback
  }
  
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
 */
export async function bulkUpdateRegionPreferences(
  updates: Array<{ clerkId: string; country: string }>
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  
  for (const { clerkId, country } of updates) {
    try {
      await updateUserPreferences(clerkId, { country, setByUser: false });
      success++;
    } catch (error) {
      failed++;
      authLogger.error('Failed to update user preferences in bulk', { clerkId, error });
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
