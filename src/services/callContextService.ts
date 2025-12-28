/**
 * Call Context Service
 * 
 * Stores call metadata (including preferred_language) server-side
 * so the Custom LLM WebSocket can retrieve it when the call starts.
 * 
 * Why this is needed:
 * - When Retell connects to our Custom LLM WebSocket, it may not forward
 *   all custom metadata fields from the original call registration
 * - By storing the context server-side keyed by callId, we can reliably
 *   retrieve the user's preferred language when the WebSocket connects
 */

import { wsLogger } from '../utils/logger';

interface CallContext {
  callId: string;
  preferredLanguage: string;
  candidateName: string;
  jobTitle: string;
  companyName: string;
  jobDescription?: string;
  intervieweeCV?: string;
  resumeFileName?: string;
  resumeMimeType?: string;
  createdAt: Date;
}

// In-memory store with TTL for cleanup
// For production, consider using Redis or Prisma
const callContextStore = new Map<string, CallContext>();

// TTL for call contexts (2 hours - calls shouldn't last longer than this)
const CALL_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Store call context when a call is registered
 */
export function storeCallContext(
  callId: string,
  metadata: {
    preferredLanguage?: string;
    first_name?: string;
    last_name?: string;
    job_title?: string;
    company_name?: string;
    job_description?: string;
    interviewee_cv?: string;
    resume_file_name?: string;
    resume_mime_type?: string;
  }
): void {
  const context: CallContext = {
    callId,
    preferredLanguage: metadata.preferredLanguage || 'en-US',
    candidateName: `${metadata.first_name || ''} ${metadata.last_name || ''}`.trim() || 'Candidate',
    jobTitle: metadata.job_title || 'Position',
    companyName: metadata.company_name || 'Company',
    jobDescription: metadata.job_description,
    intervieweeCV: metadata.interviewee_cv,
    resumeFileName: metadata.resume_file_name,
    resumeMimeType: metadata.resume_mime_type,
    createdAt: new Date(),
  };

  callContextStore.set(callId, context);
  
  wsLogger.info('Call context stored', {
    callId,
    preferredLanguage: context.preferredLanguage,
    candidateName: context.candidateName,
    jobTitle: context.jobTitle,
    companyName: context.companyName,
    storeSize: callContextStore.size,
  });

  // Schedule cleanup
  setTimeout(() => {
    cleanupCallContext(callId);
  }, CALL_CONTEXT_TTL_MS);
}

/**
 * Retrieve call context by callId
 */
export function getCallContext(callId: string): CallContext | null {
  const context = callContextStore.get(callId);
  
  if (context) {
    wsLogger.info('Call context retrieved', {
      callId,
      preferredLanguage: context.preferredLanguage,
      candidateName: context.candidateName,
      ageMs: Date.now() - context.createdAt.getTime(),
    });
  } else {
    wsLogger.warn('Call context not found', {
      callId,
      storeSize: callContextStore.size,
      availableCallIds: Array.from(callContextStore.keys()).slice(0, 5), // Log first 5 for debugging
    });
  }

  return context || null;
}

/**
 * Get preferred language for a call
 * Returns 'en-US' as fallback if context not found
 */
export function getCallLanguage(callId: string): string {
  const context = getCallContext(callId);
  const language = context?.preferredLanguage || 'en-US';
  
  wsLogger.debug('Call language resolved', {
    callId,
    language,
    fromContext: !!context,
  });

  return language;
}

/**
 * Clean up call context after call ends or TTL expires
 */
export function cleanupCallContext(callId: string): boolean {
  const deleted = callContextStore.delete(callId);
  
  if (deleted) {
    wsLogger.debug('Call context cleaned up', {
      callId,
      remainingSize: callContextStore.size,
    });
  }

  return deleted;
}

/**
 * Get current store size (for monitoring)
 */
export function getCallContextStoreSize(): number {
  return callContextStore.size;
}

/**
 * Cleanup all expired contexts (can be called periodically)
 */
export function cleanupExpiredContexts(): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [callId, context] of callContextStore.entries()) {
    if (now - context.createdAt.getTime() > CALL_CONTEXT_TTL_MS) {
      callContextStore.delete(callId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    wsLogger.info('Expired call contexts cleaned up', {
      cleanedCount,
      remainingSize: callContextStore.size,
    });
  }

  return cleanedCount;
}
