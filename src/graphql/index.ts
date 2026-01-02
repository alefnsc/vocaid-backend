/**
 * GraphQL Server Setup
 * 
 * Configures Apollo Server with Express integration.
 * Uses Clerk JWT for authentication in the context.
 * 
 * @module graphql/index
 */

import { ApolloServer, GraphQLRequestContext } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Express, Request as ExpressRequest, Response } from 'express';
import http from 'http';
import cors from 'cors';
import bodyParser from 'body-parser';
import { GraphQLFormattedError } from 'graphql';

// Context
import { createContext, GraphQLContext } from './context';

// Resolvers
import { dashboardResolver } from './resolvers/dashboardResolver';
import { interviewResolver } from './resolvers/interviewResolver';
import { benchmarkResolver } from './resolvers/benchmarkResolver';

// Logger
import logger from '../utils/logger';

// Load schema from .graphql file
const typeDefs = readFileSync(
  join(__dirname, 'schema.graphql'),
  'utf-8'
);

// Merge all resolvers
const resolvers = {
  Query: {
    ...dashboardResolver.Query,
    ...interviewResolver.Query,
    ...benchmarkResolver.Query,
  },
  Mutation: {
    ...(dashboardResolver.Mutation || {}),
  },
};

// Create executable schema
const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
});

/**
 * Initialize Apollo Server and attach to Express app
 * 
 * @param app - Express application instance
 * @param httpServer - HTTP server for drain plugin
 * @returns Apollo Server instance
 */
export async function setupGraphQL(
  app: Express,
  httpServer: http.Server
): Promise<ApolloServer<GraphQLContext>> {
  // Create Apollo Server with drain plugin for graceful shutdown
  const server = new ApolloServer<GraphQLContext>({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        // Request lifecycle logging
        async requestDidStart(requestContext: GraphQLRequestContext<GraphQLContext>) {
          const operationName = requestContext.request.operationName || 'anonymous';
          logger.info('GraphQL request started', {
            operationName,
            requestId: requestContext.contextValue?.requestId,
          });

          return {
            async didEncounterErrors(errorContext: { errors: readonly any[] }) {
              errorContext.errors.forEach((error: any) => {
                logger.error('GraphQL error', {
                  message: error.message,
                  path: error.path?.join('.'),
                  requestId: requestContext.contextValue?.requestId,
                });
              });
            },
            async willSendResponse(responseContext: { response: any }) {
              logger.debug('GraphQL response', {
                operationName,
                hasErrors: responseContext.response.body?.kind === 'single' 
                  && !!responseContext.response.body?.singleResult?.errors,
                requestId: requestContext.contextValue?.requestId,
              });
            },
          };
        },
      },
    ],
    // Format errors for client consumption
    formatError: (formattedError: GraphQLFormattedError, _error: unknown): GraphQLFormattedError => {
      // Log the full error server-side
      logger.error('GraphQL formatted error', {
        message: formattedError.message,
        code: formattedError.extensions?.code,
        path: formattedError.path,
      });

      // In production, hide internal error details
      if (process.env.NODE_ENV === 'production') {
        // Keep certain safe error codes
        const safeErrorCodes = [
          'UNAUTHENTICATED',
          'FORBIDDEN',
          'BAD_USER_INPUT',
          'NOT_FOUND',
        ];

        if (
          formattedError.extensions?.code &&
          safeErrorCodes.includes(formattedError.extensions.code as string)
        ) {
          return formattedError;
        }

        // Generic error for internal server errors
        return {
          message: 'An internal error occurred',
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        };
      }

      return formattedError;
    },
    // Introspection enabled in development only
    introspection: process.env.NODE_ENV !== 'production',
  });

  // Start the server
  await server.start();

  // Define allowed origins for GraphQL (same as main server)
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    process.env.FRONTEND_URL
  ].filter(Boolean) as string[];

  // Mount GraphQL middleware at /graphql
  app.use(
    '/graphql',
    cors<cors.CorsRequest>({
      origin: function (origin, callback) {
        // Allow requests with no origin (server-to-server, health checks)
        if (!origin) {
          return callback(null, true);
        }
        
        // Allow ngrok URLs in development
        if (origin.includes('ngrok') || origin.includes('ngrok-free.app')) {
          return callback(null, true);
        }
        
        // Allow configured origins
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        
        // Allow all origins in development
        if (process.env.NODE_ENV === 'development') {
          return callback(null, true);
        }
        
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    }),
    bodyParser.json(),
    // Type cast to resolve Express version mismatch between packages
    expressMiddleware(server, {
      context: async ({ req }) => createContext({ req: req as any }),
    }) as any
  );

  logger.info('GraphQL server mounted at /graphql', {
    introspection: process.env.NODE_ENV !== 'production',
  });

  return server;
}

/**
 * GraphQL health check endpoint
 */
export function graphqlHealthCheck(req: Request, res: Response): void {
  res.json({
    status: 'ok',
    service: 'graphql',
    timestamp: new Date().toISOString(),
  });
}
