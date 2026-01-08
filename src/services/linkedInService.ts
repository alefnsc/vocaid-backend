/**
 * LinkedIn Integration Service
 * 
 * Handles LinkedIn OAuth using OpenID Connect (OIDC).
 * Provides resume import from LinkedIn profile data.
 * 
 * Implementation:
 * 1. Primary: LinkedIn OIDC with openid, profile, email scopes
 * 2. Fallback: Manual PDF upload or form-based entry
 * 
 * Two flows are supported:
 * - SSO Login: Uses LINKEDIN_REDIRECT_URI (/api/auth/linkedin/callback)
 * - Onboarding Import: Uses LINKEDIN_PROFILE_REDIRECT_URI (/api/auth/linkedin-profile/callback)
 * 
 * Note: LinkedIn's richer profile data (work history, skills) requires
 * special partnership access. This implementation uses the standard
 * OIDC userinfo endpoint which provides basic profile information.
 * 
 * @module services/linkedInService
 */

import logger from '../utils/logger';
import crypto from 'crypto';

const linkedInLogger = logger.child({ component: 'linkedin' });

// ========================================
// CONFIGURATION
// ========================================

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;

// SSO redirect URI (for login)
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://api.vocaid.io/api/auth/linkedin/callback'
    : 'http://localhost:3001/api/auth/linkedin/callback');

// Profile import redirect URI (for onboarding)
const LINKEDIN_PROFILE_REDIRECT_URI = process.env.LINKEDIN_PROFILE_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://api.vocaid.io/api/auth/linkedin-profile/callback'
    : 'http://localhost:3001/api/auth/linkedin-profile/callback');

// LinkedIn OIDC endpoints
const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

// OIDC scopes (standard OpenID Connect)
const LINKEDIN_SCOPES = ['openid', 'profile', 'email'];

// ========================================
// FLOW TYPES
// ========================================

export type LinkedInFlowType = 'sso' | 'import';

// ========================================
// INTERFACES
// ========================================

export interface LinkedInOAuthConfig {
  clientId: string;
  redirectUri: string;
  state: string;
}

export interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export interface LinkedInUserInfo {
  sub: string;           // LinkedIn member ID
  name?: string;         // Full name
  given_name?: string;   // First name
  family_name?: string;  // Last name
  email?: string;        // Email address
  email_verified?: boolean;
  picture?: string;      // Profile picture URL
  locale?: {
    country: string;
    language: string;
  };
}

export interface LinkedInProfileData {
  linkedInId: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  pictureUrl?: string;
  profileUrl?: string;
  headline?: string;
  summary?: string;
}

// ========================================
// OAUTH FLOW
// ========================================

/**
 * Check if LinkedIn OAuth is configured
 */
export function isLinkedInConfigured(): boolean {
  return !!(LINKEDIN_CLIENT_ID && LINKEDIN_CLIENT_SECRET);
}

/**
 * Get the redirect URI for a given flow type
 */
export function getRedirectUriForFlow(flowType: LinkedInFlowType): string {
  return flowType === 'import' ? LINKEDIN_PROFILE_REDIRECT_URI : LINKEDIN_REDIRECT_URI;
}

/**
 * Generate LinkedIn OAuth authorization URL
 * @param state - CSRF protection state token
 * @param flowType - 'sso' for login or 'import' for onboarding profile import
 */
export function getLinkedInAuthUrl(state: string, flowType: LinkedInFlowType = 'sso'): string {
  if (!LINKEDIN_CLIENT_ID) {
    throw new Error('LinkedIn client ID not configured');
  }
  
  const redirectUri = getRedirectUriForFlow(flowType);
  
  linkedInLogger.info('Building LinkedIn auth URL', { 
    flowType, 
    redirectUri,
    hasState: !!state 
  });
  
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(' ')
  });
  
  return `${LINKEDIN_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 * @param code - Authorization code from LinkedIn callback
 * @param flowType - 'sso' for login or 'import' for onboarding profile import
 */
export async function exchangeCodeForToken(code: string, flowType: LinkedInFlowType = 'sso'): Promise<LinkedInTokenResponse | null> {
  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
    linkedInLogger.error('LinkedIn credentials not configured');
    return null;
  }
  
  const redirectUri = getRedirectUriForFlow(flowType);
  
  linkedInLogger.info('Exchanging code for token', { flowType, redirectUri });
  
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
      redirect_uri: redirectUri
    });
    
    const response = await fetch(LINKEDIN_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    
    if (!response.ok) {
      const error = await response.text();
      linkedInLogger.error('Failed to exchange code for token', { error, status: response.status });
      return null;
    }
    
    const data = await response.json();
    linkedInLogger.info('Token exchanged successfully');
    
    return data as LinkedInTokenResponse;
  } catch (error: any) {
    linkedInLogger.error('Token exchange failed', { error: error.message });
    return null;
  }
}

/**
 * Get user info from LinkedIn using access token
 */
export async function getUserInfo(accessToken: string): Promise<LinkedInUserInfo | null> {
  try {
    const response = await fetch(LINKEDIN_USERINFO_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (!response.ok) {
      const error = await response.text();
      linkedInLogger.error('Failed to get user info', { error });
      return null;
    }
    
    const data = await response.json();
    linkedInLogger.info('User info retrieved successfully');
    
    return data as LinkedInUserInfo;
  } catch (error: any) {
    linkedInLogger.error('User info request failed', { error: error.message });
    return null;
  }
}

/**
 * Convert LinkedIn userinfo to profile data for resume creation
 */
export function userInfoToProfileData(userInfo: LinkedInUserInfo): LinkedInProfileData {
  return {
    linkedInId: userInfo.sub,
    name: userInfo.name,
    firstName: userInfo.given_name,
    lastName: userInfo.family_name,
    email: userInfo.email,
    pictureUrl: userInfo.picture,
    profileUrl: `https://www.linkedin.com/in/${userInfo.sub}`,
    // Note: headline and summary are not available through standard OIDC
    // They require LinkedIn's Marketing API or special partnerships
    headline: undefined,
    summary: undefined
  };
}

/**
 * Complete OAuth flow: exchange code and get profile data
 * @param code - Authorization code from LinkedIn callback
 * @param flowType - 'sso' for login or 'import' for onboarding profile import
 */
export async function completeOAuthFlow(code: string, flowType: LinkedInFlowType = 'sso'): Promise<LinkedInProfileData | null> {
  const tokenResponse = await exchangeCodeForToken(code, flowType);
  
  if (!tokenResponse) {
    return null;
  }
  
  const userInfo = await getUserInfo(tokenResponse.access_token);
  
  if (!userInfo) {
    return null;
  }
  
  return userInfoToProfileData(userInfo);
}

// ========================================
// FALLBACK OPTIONS
// ========================================

/**
 * Generate state token for OAuth flow
 */
export function generateStateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate state token to prevent CSRF
 */
export function validateStateToken(state: string, expectedState: string): boolean {
  return state === expectedState;
}

/**
 * Parse LinkedIn profile URL to extract member ID
 */
export function parseLinkedInUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    
    if (!urlObj.hostname.includes('linkedin.com')) {
      return null;
    }
    
    // Extract from /in/{member-id} pattern
    const match = urlObj.pathname.match(/\/in\/([^/]+)/);
    
    if (match) {
      return match[1];
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a "manual" LinkedIn resume from user-provided data
 * Use when OAuth is not available or user prefers manual entry
 */
export function createManualLinkedInData(
  name: string,
  email: string,
  linkedInUrl?: string,
  headline?: string,
  summary?: string
): LinkedInProfileData {
  const memberId = linkedInUrl ? parseLinkedInUrl(linkedInUrl) : undefined;
  
  return {
    linkedInId: memberId || `manual_${Date.now()}`,
    name,
    email,
    profileUrl: linkedInUrl,
    headline,
    summary
  };
}

// ========================================
// EXPORT DETECTION
// ========================================

/**
 * Detect if uploaded file is a LinkedIn PDF export
 * LinkedIn exports have specific patterns in their content
 */
export function isLinkedInExport(base64Data: string, mimeType: string): boolean {
  if (mimeType !== 'application/pdf') {
    return false;
  }
  
  try {
    // Decode a portion of the PDF to check for LinkedIn markers
    const decoded = Buffer.from(base64Data.slice(0, 10000), 'base64').toString('utf-8');
    
    // LinkedIn PDF exports typically contain these markers
    const linkedInMarkers = [
      'linkedin.com',
      'LinkedIn',
      'Profile.pdf',
      'Experience',
      'Education'
    ];
    
    const matchCount = linkedInMarkers.filter(marker => 
      decoded.toLowerCase().includes(marker.toLowerCase())
    ).length;
    
    // If we find multiple markers, it's likely a LinkedIn export
    return matchCount >= 3;
  } catch {
    return false;
  }
}

export default {
  isLinkedInConfigured,
  getLinkedInAuthUrl,
  getRedirectUriForFlow,
  exchangeCodeForToken,
  getUserInfo,
  userInfoToProfileData,
  completeOAuthFlow,
  generateStateToken,
  validateStateToken,
  parseLinkedInUrl,
  createManualLinkedInData,
  isLinkedInExport
};
