/**
 * GraphQL Context
 * 
 * Handles authentication and provides user context to all resolvers.
 * Uses the same header-based authentication as REST API for consistency.
 * 
 * @module graphql/context
 */

import { Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { apiLogger } from '../utils/logger';

const prisma = new PrismaClient();

// Clerk ID format validation (same as REST API)
const CLERK_USER_ID_REGEX = /^user_[a-zA-Z0-9]+$/;

/**
 * GraphQL context available to all resolvers
 */
export interface GraphQLContext {
  /** Clerk user ID (e.g., user_xxx) */
  clerkId: string;
  /** Database user UUID */
  userId: string;
  /** Prisma client instance */
  prisma: PrismaClient;
  /** Request ID for logging */
  requestId: string;
}

/**
 * GraphQL authentication error
 */
class GraphQLAuthError extends Error {
  code: string;
  
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'GraphQLAuthError';
  }
}

/**
 * Extract Clerk user ID from request headers
 * Supports both x-user-id header and Authorization header
 */
function getClerkUserId(req: Request): string | null {
  // Primary: x-user-id header (used by frontend)
  const headerUserId = req.headers['x-user-id'] as string;
  if (headerUserId) return headerUserId;
  
  // Fallback: Authorization header (Bearer token as Clerk ID for dev)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // In development, token might be the clerk ID directly
    if (CLERK_USER_ID_REGEX.test(token)) {
      return token;
    }
  }
  
  return null;
}

/**
 * Create GraphQL context from Express request
 * 
 * Extracts Clerk user ID from headers and looks up database user.
 */
export async function createContext({ req }: { req: Request }): Promise<GraphQLContext> {
  const requestId = (req as any).requestId || `gql-${Date.now()}`;
  
  // Extract Clerk user ID
  const clerkId = getClerkUserId(req);
  
  if (!clerkId) {
    apiLogger.warn('GraphQL: Missing authentication', { requestId });
    throw new GraphQLAuthError('Authentication required', 'UNAUTHENTICATED');
  }

  // Validate Clerk ID format
  if (!CLERK_USER_ID_REGEX.test(clerkId)) {
    apiLogger.warn('GraphQL: Invalid Clerk ID format', { requestId, clerkId: clerkId.slice(0, 10) });
    throw new GraphQLAuthError('Invalid user ID format', 'UNAUTHENTICATED');
  }

  apiLogger.debug('GraphQL: Auth verified', { 
    requestId, 
    clerkId: clerkId.slice(0, 15) + '...' 
  });

  try {
    // Look up database user
    const user = await prisma.user.findUnique({
      where: { clerkId },
      select: { id: true },
    });

    if (!user) {
      apiLogger.warn('GraphQL: User not found in database', { requestId, clerkId });
      throw new GraphQLAuthError('User not found', 'UNAUTHENTICATED');
    }

    return {
      clerkId,
      userId: user.id,
      prisma,
      requestId,
    };
  } catch (error: any) {
    // Re-throw auth errors
    if (error instanceof GraphQLAuthError) {
      throw error;
    }

    apiLogger.error('GraphQL: Authentication error', { 
      requestId, 
      error: error.message 
    });
    
    throw new GraphQLAuthError('Authentication failed', 'INTERNAL_ERROR');
  }
}

/**
 * Create context for unauthenticated queries (if any)
 * Currently not used - all queries require authentication
 */
export function createPublicContext({ req }: { req: Request }): Partial<GraphQLContext> {
  return {
    prisma,
    requestId: (req as any).requestId || `gql-${Date.now()}`,
  };
}
