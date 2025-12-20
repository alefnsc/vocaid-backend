/**
 * Clerk Service
 * Handles Clerk webhook events and user synchronization
 */

import { clerkClient } from '@clerk/express';
import { Webhook } from 'svix';
import { prisma, dbLogger } from './databaseService';
import { authLogger } from '../utils/logger';
import { checkSignupAbuse, recordSignup, SignupInfo } from './signupAbuseService';

// ========================================
// TYPES
// ========================================

export interface ClerkUserData {
  id: string;
  email_addresses: Array<{ email_address: string; id: string }>;
  phone_numbers?: Array<{ phone_number: string; id: string; verification?: { status: string } }>;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  public_metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface ClerkSessionData {
  id: string;
  user_id: string;
  client_id: string;
  status: string;
  last_active_at: number;
  expire_at: number;
  abandon_at: number;
  created_at: number;
  updated_at: number;
}

export interface ClerkWebhookEvent {
  type: string;
  data: ClerkUserData | ClerkSessionData;
  object: string;
}

export interface WebhookVerificationHeaders {
  'svix-id': string;
  'svix-timestamp': string;
  'svix-signature': string;
}

// Track processed webhook IDs to prevent replay attacks (in production, use Redis)
const processedWebhookIds = new Set<string>();
const WEBHOOK_ID_TTL = 5 * 60 * 1000; // 5 minutes

// ========================================
// WEBHOOK VERIFICATION
// ========================================

/**
 * Verify Clerk webhook signature using Svix
 */
export function verifyWebhookSignature(
  payload: string,
  headers: WebhookVerificationHeaders,
  secret: string
): boolean {
  try {
    const wh = new Webhook(secret);
    wh.verify(payload, headers);
    return true;
  } catch (error) {
    authLogger.error('Webhook signature verification failed', { error });
    return false;
  }
}

/**
 * Check if webhook ID has been processed (prevent replay attacks)
 */
export function isWebhookProcessed(webhookId: string): boolean {
  return processedWebhookIds.has(webhookId);
}

/**
 * Mark webhook as processed
 */
export function markWebhookProcessed(webhookId: string): void {
  processedWebhookIds.add(webhookId);
  setTimeout(() => processedWebhookIds.delete(webhookId), WEBHOOK_ID_TTL);
}

// ========================================
// USER SYNCHRONIZATION
// ========================================

/**
 * Sync user from Clerk to local database
 * Called on user.created and user.updated events
 */
export async function syncUserToDatabase(clerkUser: ClerkUserData) {
  const clerkId = clerkUser.id;
  const email = clerkUser.email_addresses?.[0]?.email_address || '';
  const firstName = clerkUser.first_name;
  const lastName = clerkUser.last_name;
  const imageUrl = clerkUser.image_url;
  const credits = (clerkUser.public_metadata?.credits as number) || 0;

  dbLogger.info('Syncing user to database', { clerkId, email });

  try {
    const user = await prisma.user.upsert({
      where: { clerkId },
      create: {
        clerkId,
        email,
        firstName,
        lastName,
        imageUrl,
        credits
      },
      update: {
        email,
        firstName,
        lastName,
        imageUrl,
        credits
      }
    });

    dbLogger.info('User synced to database', { userId: user.id, clerkId });
    return user;
  } catch (error: any) {
    dbLogger.error('Failed to sync user to database', { clerkId, error: error.message });
    throw error;
  }
}

/**
 * Soft-delete user from local database
 * Called on user.deleted event
 * Sets isActive=false and deletedAt timestamp instead of hard-deleting
 * This preserves user data and related interviews/payments for analytics
 */
export async function deleteUserFromDatabase(clerkId: string) {
  dbLogger.warn('Soft-deleting user (setting inactive)', { clerkId });

  try {
    // Check if user exists first
    const existingUser = await prisma.user.findUnique({
      where: { clerkId }
    });

    if (!existingUser) {
      dbLogger.info('User not found in database, skipping deletion', { clerkId });
      return null;
    }

    // Check if already inactive
    if (!existingUser.isActive) {
      dbLogger.info('User already inactive', { clerkId });
      return existingUser;
    }

    // Soft-delete: Set isActive=false and record deletion timestamp
    const deactivatedUser = await prisma.user.update({
      where: { clerkId },
      data: {
        isActive: false,
        deletedAt: new Date(),
        // Clear sensitive data but keep record
        imageUrl: null
      }
    });

    dbLogger.info('User soft-deleted (set inactive)', { 
      userId: deactivatedUser.id, 
      clerkId,
      deletedAt: deactivatedUser.deletedAt 
    });
    return deactivatedUser;
  } catch (error: any) {
    dbLogger.error('Failed to soft-delete user from database', { clerkId, error: error.message });
    throw error;
  }
}

/**
 * Find or create user by Clerk ID
 * First checks local database, if not found, fetches from Clerk and creates
 * If user exists but is inactive, reactivates them
 */
export async function findOrCreateUserByClerkId(clerkId: string) {
  dbLogger.info('Finding or creating user', { clerkId });

  // First, try to find in local database (including inactive users)
  let user = await prisma.user.findUnique({
    where: { clerkId }
  });

  if (user) {
    // If user is inactive, reactivate them (they re-registered with Clerk)
    if (!user.isActive) {
      dbLogger.info('Reactivating previously deleted user', { userId: user.id, clerkId });
      user = await prisma.user.update({
        where: { clerkId },
        data: {
          isActive: true,
          deletedAt: null
        }
      });
      return { user, source: 'reactivated' as const };
    }
    
    dbLogger.info('User found in database', { userId: user.id, clerkId });
    return { user, source: 'database' as const };
  }

  // User not found, fetch from Clerk and create
  dbLogger.info('User not in database, fetching from Clerk', { clerkId });

  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    
    user = await prisma.user.create({
      data: {
        clerkId: clerkUser.id,
        email: clerkUser.emailAddresses[0]?.emailAddress || '',
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        imageUrl: clerkUser.imageUrl,
        credits: (clerkUser.publicMetadata?.credits as number) || 0
      }
    });

    dbLogger.info('User created from Clerk data', { userId: user.id, clerkId });
    return { user, source: 'clerk' as const };
  } catch (error: any) {
    dbLogger.error('Failed to create user from Clerk', { clerkId, error: error.message });
    throw new Error(`Failed to sync user from Clerk: ${error.message}`);
  }
}

/**
 * Get user from database, return null if not found
 */
export async function getUserFromDatabase(clerkId: string) {
  return prisma.user.findUnique({
    where: { clerkId },
    include: {
      _count: {
        select: {
          interviews: true,
          payments: true
        }
      }
    }
  });
}

/**
 * Update user public metadata (role, preferredLanguage)
 * Used for profile updates from frontend
 */
export async function updateUserMetadata(
  clerkId: string,
  metadata: { role?: string; preferredLanguage?: string }
) {
  dbLogger.info('Updating user metadata', { clerkId, metadata });

  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    
    // Merge with existing metadata
    const updatedMetadata = {
      ...clerkUser.publicMetadata,
      ...(metadata.role && { role: metadata.role }),
      ...(metadata.preferredLanguage && { preferredLanguage: metadata.preferredLanguage }),
    };

    await clerkClient.users.updateUser(clerkId, {
      publicMetadata: updatedMetadata,
    });

    dbLogger.info('User metadata updated successfully', { clerkId, updatedMetadata });
    return { success: true, metadata: updatedMetadata };
  } catch (error: any) {
    dbLogger.error('Failed to update user metadata', { clerkId, error: error.message });
    throw new Error(`Failed to update metadata: ${error.message}`);
  }
}

/**
 * Update user credits in both Clerk and local database
 */
export async function updateUserCredits(
  clerkId: string, 
  credits: number, 
  operation: 'add' | 'subtract' | 'set'
) {
  dbLogger.info('Updating user credits', { clerkId, credits, operation });

  // Calculate new credits value
  const currentUser = await prisma.user.findUnique({
    where: { clerkId },
    select: { credits: true }
  });

  if (!currentUser) {
    throw new Error('User not found in database');
  }

  let newCredits: number;
  switch (operation) {
    case 'add':
      newCredits = currentUser.credits + credits;
      break;
    case 'subtract':
      newCredits = Math.max(0, currentUser.credits - credits);
      break;
    case 'set':
      newCredits = credits;
      break;
  }

  // Update local database
  const updatedUser = await prisma.user.update({
    where: { clerkId },
    data: { credits: newCredits }
  });

  // Update Clerk metadata
  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    await clerkClient.users.updateUser(clerkId, {
      publicMetadata: {
        ...clerkUser.publicMetadata,
        credits: newCredits
      }
    });
  } catch (error: any) {
    dbLogger.warn('Failed to sync credits to Clerk', { clerkId, error: error.message });
    // Don't throw - local DB is source of truth for credits
  }

  dbLogger.info('User credits updated', { clerkId, newCredits });
  return updatedUser;
}

// ========================================
// WEBHOOK EVENT HANDLERS
// ========================================

/**
 * Handle user.created webhook event
 * Now includes abuse prevention for free credits
 */
export async function handleUserCreated(userData: ClerkUserData, signupInfo?: SignupInfo) {
  authLogger.info('Processing user.created event', { userId: userData.id });

  // Sync user to database
  const user = await syncUserToDatabase(userData);

  // Grant 1 free credit to new user (if not already granted)
  const existingCredits = (userData.public_metadata?.credits as number) || 0;
  
  if (existingCredits === 0 && !userData.public_metadata?.freeTrialUsed) {
    try {
      // Check for abuse if signup info is provided
      let allowFreeCredit = true;
      let isSuspicious = false;
      let suspicionReason: string | undefined;

      if (signupInfo && (signupInfo.ipAddress || signupInfo.deviceFingerprint)) {
        const abuseCheck = await checkSignupAbuse(signupInfo);
        allowFreeCredit = abuseCheck.allowFreeCredit;
        isSuspicious = abuseCheck.isSuspicious;
        suspicionReason = abuseCheck.suspicionReason;

        if (!allowFreeCredit) {
          authLogger.warn('Free credit blocked due to abuse detection', {
            userId: userData.id,
            reason: suspicionReason
          });
        }
      }

      // Record signup info (even if we don't have fingerprint yet)
      await recordSignup(
        user.id,
        signupInfo || {},
        allowFreeCredit,
        isSuspicious,
        suspicionReason
      );

      if (allowFreeCredit) {
        // Update Clerk with free credit
        await clerkClient.users.updateUser(userData.id, {
          publicMetadata: {
            ...userData.public_metadata,
            credits: 1,
            freeTrialUsed: true,
            registrationDate: new Date().toISOString()
          }
        });

        // Update local database
        await prisma.user.update({
          where: { clerkId: userData.id },
          data: { credits: 1 }
        });

        authLogger.info('Free trial credit granted', { userId: userData.id });
      } else {
        // Mark freeTrialUsed but don't grant credits
        await clerkClient.users.updateUser(userData.id, {
          publicMetadata: {
            ...userData.public_metadata,
            credits: 0,
            freeTrialUsed: true, // Mark as used to prevent future attempts
            freeCreditBlocked: true,
            registrationDate: new Date().toISOString()
          }
        });

        authLogger.info('Free trial blocked (abuse detected)', { userId: userData.id });
      }
    } catch (error: any) {
      authLogger.error('Failed to process free trial credit', { 
        userId: userData.id, 
        error: error.message 
      });
    }
  }

  return user;
}

/**
 * Handle user.updated webhook event
 */
export async function handleUserUpdated(userData: ClerkUserData) {
  authLogger.info('Processing user.updated event', { userId: userData.id });

  // Sync updated user data to database
  const user = await syncUserToDatabase(userData);

  return user;
}

/**
 * Handle user.deleted webhook event
 */
export async function handleUserDeleted(userData: ClerkUserData) {
  authLogger.info('Processing user.deleted event', { userId: userData.id });

  // Delete user from database
  const deletedUser = await deleteUserFromDatabase(userData.id);

  return deletedUser;
}

// ========================================
// SESSION EVENT HANDLERS
// ========================================

/**
 * Handle session.created webhook event
 * Ensures user exists in database when a new session starts
 */
export async function handleSessionCreated(sessionData: ClerkSessionData) {
  const userId = sessionData.user_id;
  authLogger.info('Processing session.created event', { sessionId: sessionData.id, userId });

  // Ensure user exists in database
  try {
    const { user, source } = await findOrCreateUserByClerkId(userId);
    authLogger.info('Session user validated', { 
      sessionId: sessionData.id, 
      userId,
      dbUserId: user.id,
      source 
    });
    return { session: sessionData, user };
  } catch (error: any) {
    authLogger.error('Failed to validate session user', { 
      sessionId: sessionData.id, 
      userId, 
      error: error.message 
    });
    throw error;
  }
}

/**
 * Handle session.ended webhook event
 * Log session end for analytics
 */
export async function handleSessionEnded(sessionData: ClerkSessionData) {
  authLogger.info('Processing session.ended event', { 
    sessionId: sessionData.id, 
    userId: sessionData.user_id,
    status: sessionData.status
  });
  
  // Could track session duration for analytics in future
  return { session: sessionData, action: 'logged' };
}

/**
 * Handle session.removed webhook event
 */
export async function handleSessionRemoved(sessionData: ClerkSessionData) {
  authLogger.info('Processing session.removed event', { 
    sessionId: sessionData.id, 
    userId: sessionData.user_id 
  });
  return { session: sessionData, action: 'logged' };
}

/**
 * Handle session.revoked webhook event
 */
export async function handleSessionRevoked(sessionData: ClerkSessionData) {
  authLogger.warn('Processing session.revoked event', { 
    sessionId: sessionData.id, 
    userId: sessionData.user_id 
  });
  return { session: sessionData, action: 'logged' };
}

/**
 * Handle session.pending webhook event
 */
export async function handleSessionPending(sessionData: ClerkSessionData) {
  authLogger.info('Processing session.pending event', { 
    sessionId: sessionData.id, 
    userId: sessionData.user_id 
  });
  return { session: sessionData, action: 'logged' };
}

/**
 * Process Clerk webhook event
 */
export async function processWebhookEvent(event: ClerkWebhookEvent) {
  const { type, data } = event;

  // User events
  if (type.startsWith('user.')) {
    const userData = data as ClerkUserData;
    switch (type) {
      case 'user.created':
        return handleUserCreated(userData);
      case 'user.updated':
        return handleUserUpdated(userData);
      case 'user.deleted':
        return handleUserDeleted(userData);
    }
  }

  // Session events
  if (type.startsWith('session.')) {
    const sessionData = data as ClerkSessionData;
    switch (type) {
      case 'session.created':
        return handleSessionCreated(sessionData);
      case 'session.ended':
        return handleSessionEnded(sessionData);
      case 'session.removed':
        return handleSessionRemoved(sessionData);
      case 'session.revoked':
        return handleSessionRevoked(sessionData);
      case 'session.pending':
        return handleSessionPending(sessionData);
    }
  }

  authLogger.info('Unhandled webhook event type', { type });
  return null;
}

// ========================================
// SUPPORTED WEBHOOK EVENTS
// ========================================

/**
 * List of Clerk webhook events that should be subscribed to
 * Configure these in Clerk Dashboard > Webhooks
 */
export const SUPPORTED_WEBHOOK_EVENTS = [
  // User events
  'user.created',   // New user registration
  'user.updated',   // User profile updates (email, name, image, metadata)
  'user.deleted',   // User account deletion
  // Session events
  'session.created',  // User login / new session
  'session.ended',    // Session ended
  'session.pending',  // Session pending verification
  'session.removed',  // Session removed
  'session.revoked',  // Session revoked (security)
] as const;

export type SupportedWebhookEvent = typeof SUPPORTED_WEBHOOK_EVENTS[number];

// ========================================
// USER VALIDATION & SYNC
// ========================================

/**
 * Validate user session and ensure user exists in database
 * Called by frontend on page load, interview start, etc.
 * 
 * @param clerkId - The Clerk user ID from the session
 * @param signupInfo - Optional IP/fingerprint for abuse detection
 * @returns The user from database (created if not exists)
 */
export async function validateAndSyncUser(clerkId: string, signupInfo?: SignupInfo) {
  authLogger.info('Validating and syncing user', { clerkId });

  // Find or create user
  const { user, source } = await findOrCreateUserByClerkId(clerkId);

  // If user was created from Clerk, check if they need free credit
  if (source === 'clerk' && user.credits === 0) {
    try {
      const clerkUser = await clerkClient.users.getUser(clerkId);
      const freeTrialUsed = clerkUser.publicMetadata?.freeTrialUsed as boolean;
      
      if (!freeTrialUsed) {
        // Check for abuse if signup info is provided
        let allowFreeCredit = true;
        let isSuspicious = false;
        let suspicionReason: string | undefined;
        let phoneVerificationRequired = false;

        // Check if phone verification is required for free credits
        const requirePhoneVerification = process.env.REQUIRE_PHONE_FOR_FREE_CREDIT === 'true';
        
        if (requirePhoneVerification) {
          // Check if user has a verified phone number
          const phoneNumbers = clerkUser.phoneNumbers || [];
          const hasVerifiedPhone = phoneNumbers.some(
            (phone: any) => phone.verification?.status === 'verified'
          );
          
          if (!hasVerifiedPhone) {
            allowFreeCredit = false;
            phoneVerificationRequired = true;
            authLogger.info('Free credit requires phone verification', { clerkId });
          }
        }

        if (allowFreeCredit && signupInfo && (signupInfo.ipAddress || signupInfo.deviceFingerprint)) {
          const abuseCheck = await checkSignupAbuse(signupInfo);
          allowFreeCredit = abuseCheck.allowFreeCredit;
          isSuspicious = abuseCheck.isSuspicious;
          suspicionReason = abuseCheck.suspicionReason;

          if (!allowFreeCredit) {
            authLogger.warn('Free credit blocked due to abuse detection', {
              clerkId,
              reason: suspicionReason
            });
          }
        }

        // Record signup info
        await recordSignup(
          user.id,
          signupInfo || {},
          allowFreeCredit,
          isSuspicious,
          suspicionReason
        );

        if (allowFreeCredit) {
          // Grant free trial credit
          await prisma.user.update({
            where: { clerkId },
            data: { credits: 1 }
          });
          
          await clerkClient.users.updateUser(clerkId, {
            publicMetadata: {
              ...clerkUser.publicMetadata,
              credits: 1,
              freeTrialUsed: true,
              registrationDate: new Date().toISOString()
            }
          });
          
          authLogger.info('Free trial credit granted during validation', { clerkId });
          
          // Return updated user
          const updatedUser = await prisma.user.findUnique({ where: { clerkId } });
          return { user: updatedUser!, source, freeTrialGranted: true };
        } else {
          // Mark freeTrialUsed but don't grant credits
          await clerkClient.users.updateUser(clerkId, {
            publicMetadata: {
              ...clerkUser.publicMetadata,
              credits: 0,
              freeTrialUsed: !phoneVerificationRequired, // Don't mark used if waiting for phone
              freeCreditBlocked: !phoneVerificationRequired,
              phoneVerificationPending: phoneVerificationRequired,
              registrationDate: new Date().toISOString()
            }
          });
          
          if (phoneVerificationRequired) {
            authLogger.info('Free trial pending phone verification', { clerkId });
            return { user, source, freeTrialGranted: false, phoneVerificationRequired: true };
          } else {
            authLogger.info('Free trial blocked (abuse detected) during validation', { clerkId });
            return { user, source, freeTrialGranted: false, freeCreditBlocked: true };
          }
        }
      }
    } catch (error: any) {
      authLogger.warn('Failed to check/grant free trial during validation', { 
        clerkId, 
        error: error.message 
      });
    }
  }

  return { user, source, freeTrialGranted: false };
}
