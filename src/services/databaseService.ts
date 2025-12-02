/**
 * Database Service
 * Handles all database connections and provides a centralized Prisma client
 */

import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

// Create database logger
export const dbLogger = logger.child({ component: 'database' });

// Environment-based configuration
const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';

// Prisma client configuration
const prismaClientSingleton = () => {
  return new PrismaClient({
    log: isDevelopment
      ? [
          { level: 'query', emit: 'event' },
          { level: 'error', emit: 'stdout' },
          { level: 'info', emit: 'stdout' },
          { level: 'warn', emit: 'stdout' },
        ]
      : [{ level: 'error', emit: 'stdout' }],
  });
};

// Use global variable to prevent multiple instances in development (hot reload)
declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: ReturnType<typeof prismaClientSingleton> | undefined;
}

// Create singleton instance
const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

// In development, preserve the client across hot reloads
if (isDevelopment) {
  globalThis.prismaGlobal = prisma;
}

// Log queries in development
if (isDevelopment) {
  // @ts-ignore - Prisma event types
  prisma.$on('query', (e: any) => {
    dbLogger.debug('Query executed', {
      query: e.query,
      params: e.params,
      duration: `${e.duration}ms`
    });
  });
}

/**
 * Connect to database with retry logic
 */
export async function connectDatabase(maxRetries = 5, retryDelay = 5000): Promise<void> {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      await prisma.$connect();
      dbLogger.info('✅ Database connected successfully', {
        environment: process.env.NODE_ENV,
        host: process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'hidden'
      });
      return;
    } catch (error: any) {
      retries++;
      dbLogger.error(`❌ Database connection failed (attempt ${retries}/${maxRetries})`, {
        error: error.message
      });
      
      if (retries >= maxRetries) {
        dbLogger.error('🚨 Max database connection retries exceeded');
        throw error;
      }
      
      dbLogger.info(`⏳ Retrying database connection in ${retryDelay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

/**
 * Disconnect from database gracefully
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    dbLogger.info('Database disconnected successfully');
  } catch (error: any) {
    dbLogger.error('Error disconnecting from database', { error: error.message });
    throw error;
  }
}

/**
 * Health check for database connection
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    dbLogger.error('Database health check failed', { error });
    return false;
  }
}

/**
 * Run database migrations (for production deployments)
 */
export async function runMigrations(): Promise<void> {
  if (!isProduction) {
    dbLogger.warn('Migrations should typically only run in production');
  }
  
  // Note: In production, migrations should be run via CLI or CI/CD pipeline
  // This is just a helper for manual deployment scenarios
  dbLogger.info('Database migrations should be run via: npx prisma migrate deploy');
}

// Export the Prisma client instance
export { prisma };
export default prisma;
