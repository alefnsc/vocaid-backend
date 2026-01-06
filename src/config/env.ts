/**
 * Environment Configuration Module
 * 
 * Single source of truth for all environment variables.
 * Validates and normalizes configuration with sensible defaults.
 * Uses Zod for type-safe validation.
 * 
 * Usage:
 *   import { env, config } from './config/env';
 *   console.log(config.database.url);
 *   console.log(config.features.redisEnabled);
 * 
 * @module config/env
 */

import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables immediately when this module is imported
dotenv.config();

// ========================================
// ENVIRONMENT SCHEMA
// ========================================

const AppEnvEnum = z.enum(['development', 'staging', 'production']);
type AppEnv = z.infer<typeof AppEnvEnum>;

const envSchema = z.object({
  // Core
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_ENV: AppEnvEnum.default('development'),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3001'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),

  // Database - accept any postgresql connection string
  DATABASE_URL: z.string().refine(
    (val) => val.startsWith('postgresql://') || val.startsWith('postgres://'),
    { message: 'DATABASE_URL must be a valid PostgreSQL connection string' }
  ),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Feature Toggles
  ENABLE_REDIS_CACHE: z.string().transform((v) => v === 'true').default('false'),
  ENABLE_BLOB_STORAGE: z.string().transform((v) => v === 'true').default('false'),
  ANALYTICS_SCHEDULED_JOBS_ENABLED: z.string().transform((v) => v === 'true').default('false'),

  // Redis (only required if ENABLE_REDIS_CACHE=true)
  REDIS_URL: z.string().optional(),
  AZURE_REDIS_HOST: z.string().optional(),
  AZURE_REDIS_PORT: z.string().regex(/^\d+$/).transform(Number).optional(),
  AZURE_REDIS_PASSWORD: z.string().optional(),
  AZURE_REDIS_TLS_ENABLED: z.string().transform((v) => v === 'true').default('true'),

  // Azure Blob Storage (only required if ENABLE_BLOB_STORAGE=true)
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_ACCOUNT: z.string().optional(),
  AZURE_STORAGE_CONTAINER_RESUMES: z.string().default('resumes'),
  AZURE_STORAGE_CONTAINER_EXPORTS: z.string().default('exports'),
  AZURE_STORAGE_SAS: z.string().optional(),

  // Retell AI
  RETELL_API_KEY: z.string().optional(),
  RETELL_AGENT_ID: z.string().optional(),
  RETELL_AGENT_ID_ZH: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  // MercadoPago
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_TEST_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_PUBLIC_KEY: z.string().optional(),
  MERCADOPAGO_TEST_PUBLIC_KEY: z.string().optional(),

  // PayPal
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  // URLs
  BASE_PUBLIC_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),

  // Email
  RESEND_API_KEY: z.string().optional(),

  // Credits
  FREE_TRIAL_CREDITS: z.string().regex(/^\d+$/).transform(Number).default('1'),

  // Analytics
  ANALYTICS_CACHE_TTL_DASHBOARD: z.string().regex(/^\d+$/).transform(Number).default('300'),
  ANALYTICS_CACHE_TTL_GLOBAL: z.string().regex(/^\d+$/).transform(Number).default('3600'),
  ANALYTICS_SNAPSHOT_CRON: z.string().default('0 * * * *'),

  // Twilio (SMS verification - Verify API with API Key auth)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_API_SID: z.string().optional(),
  TWILIO_API_SECRET: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),
  PHONE_VERIFICATION_CREDITS: z.string().regex(/^\d+$/).transform(Number).default('5'),
  // Legacy (deprecated - use API Key auth instead)
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
});

// ========================================
// PARSE AND VALIDATE
// ========================================

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    result.error.issues.forEach((issue) => {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    });
    
    // In development, warn but continue with defaults where possible
    if (process.env.NODE_ENV === 'development') {
      console.warn('⚠️ Continuing with partial configuration in development mode');
      return envSchema.parse({
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://voxly:voxly_dev_password@localhost:5432/voxly',
      });
    }
    
    throw new Error('Invalid environment configuration');
  }

  return result.data;
}

export const env = parseEnv();

// ========================================
// DERIVED CONFIGURATION
// ========================================

/**
 * Typed configuration object derived from environment variables
 */
export const config = {
  // Environment
  appEnv: env.APP_ENV as AppEnv,
  nodeEnv: env.NODE_ENV,
  isDevelopment: env.APP_ENV === 'development',
  isStaging: env.APP_ENV === 'staging',
  isProduction: env.APP_ENV === 'production',

  // Server
  server: {
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
  },

  // Database
  database: {
    url: env.DATABASE_URL,
  },

  // CORS
  cors: {
    allowedOrigins: env.CORS_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) || [
      'http://localhost:3000',
      'http://localhost:3001',
    ],
  },

  // Feature Flags
  features: {
    redisEnabled: env.ENABLE_REDIS_CACHE,
    blobStorageEnabled: env.ENABLE_BLOB_STORAGE,
    scheduledJobsEnabled: env.ANALYTICS_SCHEDULED_JOBS_ENABLED,
  },

  // Redis
  redis: {
    enabled: env.ENABLE_REDIS_CACHE,
    url: env.REDIS_URL,
    host: env.AZURE_REDIS_HOST,
    port: env.AZURE_REDIS_PORT,
    password: env.AZURE_REDIS_PASSWORD,
    tlsEnabled: env.AZURE_REDIS_TLS_ENABLED,
  },

  // Azure Blob Storage
  blobStorage: {
    enabled: env.ENABLE_BLOB_STORAGE,
    connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
    accountName: env.AZURE_STORAGE_ACCOUNT,
    containers: {
      resumes: env.AZURE_STORAGE_CONTAINER_RESUMES,
      exports: env.AZURE_STORAGE_CONTAINER_EXPORTS,
    },
    sasToken: env.AZURE_STORAGE_SAS,
  },

  // AI Services
  ai: {
    openaiApiKey: env.OPENAI_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
  },

  // Retell
  retell: {
    apiKey: env.RETELL_API_KEY,
    agentId: env.RETELL_AGENT_ID,
    agentIdZh: env.RETELL_AGENT_ID_ZH,
  },

  // Payments
  mercadoPago: {
    accessToken: env.APP_ENV === 'production'
      ? env.MERCADOPAGO_ACCESS_TOKEN
      : env.MERCADOPAGO_TEST_ACCESS_TOKEN,
    publicKey: env.APP_ENV === 'production'
      ? env.MERCADOPAGO_PUBLIC_KEY
      : env.MERCADOPAGO_TEST_PUBLIC_KEY,
  },
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    mode: env.PAYPAL_MODE,
  },

  // URLs
  urls: {
    publicBase: env.BASE_PUBLIC_URL,
    frontend: env.FRONTEND_URL,
  },

  // Email
  email: {
    resendApiKey: env.RESEND_API_KEY,
  },

  // Credits
  credits: {
    freeTrialCredits: env.FREE_TRIAL_CREDITS,
  },

  // Analytics
  analytics: {
    cacheTtlDashboard: env.ANALYTICS_CACHE_TTL_DASHBOARD,
    cacheTtlGlobal: env.ANALYTICS_CACHE_TTL_GLOBAL,
    snapshotCron: env.ANALYTICS_SNAPSHOT_CRON,
  },

  // Twilio (SMS verification - Verify API with API Key auth)
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiSid: env.TWILIO_API_SID,
    apiSecret: env.TWILIO_API_SECRET,
    verifyServiceSid: env.TWILIO_VERIFY_SERVICE_SID,
    phoneVerificationCredits: env.PHONE_VERIFICATION_CREDITS,
    // Legacy (deprecated)
    authToken: env.TWILIO_AUTH_TOKEN,
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
  },
} as const;

// ========================================
// DIAGNOSTICS (DEV ONLY)
// ========================================

/**
 * Log environment diagnostics (safe for dev, redacts secrets)
 */
export function logEnvDiagnostics() {
  if (config.isDevelopment || config.isStaging) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  🔧 ENVIRONMENT DIAGNOSTICS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  APP_ENV:            ${config.appEnv}`);
    console.log(`  NODE_ENV:           ${config.nodeEnv}`);
    console.log(`  PORT:               ${config.server.port}`);
    console.log(`  DATABASE:           ${config.database.url.replace(/:[^:@]+@/, ':****@')}`);
    console.log(`  REDIS_ENABLED:      ${config.features.redisEnabled}`);
    console.log(`  BLOB_STORAGE:       ${config.features.blobStorageEnabled}`);
    console.log(`  SCHEDULED_JOBS:     ${config.features.scheduledJobsEnabled}`);
    console.log(`  CORS_ORIGINS:       ${config.cors.allowedOrigins.join(', ')}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
  }
}

export default config;
