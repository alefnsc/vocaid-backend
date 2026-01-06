/**
 * GraphQL Context
 * 
 * Handles authentication and provides user context to all resolvers.
 * Uses session-based authentication with httpOnly cookies only.
 * 
 * @module graphql/context
 */

import { Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { apiLogger } from '../utils/logger';
import { validateSession, getSessionToken } from '../services/sessionService';

const prisma = new PrismaClient();

/**
 * GraphQL context available to all resolvers
 */
export interface GraphQLContext {
  /** Database user UUID */
  userId: string;
  /** User email */
  email: string;
  /** Whether email is verified */
  emailVerified: boolean;
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
 * Create GraphQL context from Express request
 * 
 * Requires session cookie (first-party auth)
 */
export async function createContext({ req }: { req: Request }): Promise<GraphQLContext> {
  const requestId = (req as any).requestId || `gql-${Date.now()}`;
  
  // Session-based authentication only
  const sessionToken = getSessionToken(req.cookies || {});
  
  if (sessionToken) {
    const session = await validateSession(sessionToken);
    
    if (session) {
      apiLogger.debug('GraphQL: Session auth verified', { 
        requestId, 
        userId: session.userId.slice(0, 8) + '...' 
      });
      
      return {
        userId: session.userId,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        prisma,
        requestId,
      };
    }
  }
  
  // No valid authentication found
  apiLogger.warn('GraphQL: Missing authentication', { requestId });
  throw new GraphQLAuthError('Authentication required', 'UNAUTHENTICATED');
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
