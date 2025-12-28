/**
 * Azure Redis Cache Service
 * 
 * Handles distributed caching via Azure Redis Cache for production.
 * Falls back to in-memory caching when Redis is disabled.
 * 
 * Features:
 * - Session caching
 * - Hot-path data caching (dashboard stats, user preferences)
 * - Automatic connection management
 * - Graceful fallback to in-memory cache
 * 
 * @module services/azureRedisService
 */

import { createClient, RedisClientType } from 'redis';
import { apiLogger } from '../utils/logger';

// ============================================
// CONFIGURATION
// ============================================

const config = {
  host: process.env.AZURE_REDIS_HOST || '',
  port: parseInt(process.env.AZURE_REDIS_PORT || '6380', 10),
  password: process.env.AZURE_REDIS_PASSWORD || '',
  tlsEnabled: process.env.AZURE_REDIS_TLS_ENABLED === 'true',
  enabled: process.env.AZURE_REDIS_ENABLED === 'true',
};

// ============================================
// CLIENT INITIALIZATION
// ============================================

let redisClient: RedisClientType | null = null;
let isConnected = false;

// In-memory fallback cache
const memoryCache = new Map<string, { value: string; expiresAt: number }>();
const MEMORY_CACHE_CLEANUP_INTERVAL = 60 * 1000; // 1 minute

/**
 * Initialize Redis client
 */
async function initializeRedis(): Promise<boolean> {
  if (!config.enabled) {
    apiLogger.info('[azure-redis] Redis caching is disabled, using in-memory cache');
    return false;
  }

  if (!config.host || !config.password) {
    apiLogger.warn('[azure-redis] Missing Redis configuration, falling back to in-memory cache');
    return false;
  }

  try {
    const url = config.tlsEnabled
      ? `rediss://:${config.password}@${config.host}:${config.port}`
      : `redis://:${config.password}@${config.host}:${config.port}`;

    // Configure socket options based on TLS setting
    const socketConfig = config.tlsEnabled
      ? {
          tls: true as const,
          rejectUnauthorized: false, // Azure Redis uses self-signed certs
          connectTimeout: 10000,
          reconnectStrategy: (retries: number) => {
            if (retries > 10) {
              apiLogger.error('[azure-redis] Max reconnection attempts reached');
              return new Error('Max retries reached');
            }
            return Math.min(retries * 100, 3000);
          },
        }
      : {
          connectTimeout: 10000,
          reconnectStrategy: (retries: number) => {
            if (retries > 10) {
              apiLogger.error('[azure-redis] Max reconnection attempts reached');
              return new Error('Max retries reached');
            }
            return Math.min(retries * 100, 3000);
          },
        };

    redisClient = createClient({
      url,
      socket: socketConfig,
    });

    redisClient.on('error', (error) => {
      apiLogger.error('[azure-redis] Redis client error', {
        error: error.message,
      });
      isConnected = false;
    });

    redisClient.on('connect', () => {
      apiLogger.info('[azure-redis] Connected to Azure Redis Cache');
      isConnected = true;
    });

    redisClient.on('reconnecting', () => {
      apiLogger.info('[azure-redis] Reconnecting to Redis...');
    });

    await redisClient.connect();
    isConnected = true;

    apiLogger.info('[azure-redis] Azure Redis Cache initialized', {
      host: config.host,
      port: config.port,
      tls: config.tlsEnabled,
    });

    return true;
  } catch (error) {
    apiLogger.error('[azure-redis] Failed to initialize Redis', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    isConnected = false;
    return false;
  }
}

/**
 * Check if Redis is available
 */
export function isRedisEnabled(): boolean {
  return config.enabled && isConnected && redisClient !== null;
}

// ============================================
// CACHE OPERATIONS
// ============================================

/**
 * Get a value from cache
 */
export async function get<T>(key: string): Promise<T | null> {
  const prefixedKey = `vocaid:${key}`;

  // Try Redis first
  if (isRedisEnabled()) {
    try {
      const value = await redisClient!.get(prefixedKey);
      if (value) {
        return JSON.parse(value) as T;
      }
      return null;
    } catch (error) {
      apiLogger.error('[azure-redis] Get error, falling back to memory', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Fall back to memory cache
  const cached = memoryCache.get(prefixedKey);
  if (cached && cached.expiresAt > Date.now()) {
    return JSON.parse(cached.value) as T;
  }
  
  // Clean up expired entry
  if (cached) {
    memoryCache.delete(prefixedKey);
  }
  
  return null;
}

/**
 * Set a value in cache with TTL
 */
export async function set(
  key: string,
  value: unknown,
  ttlSeconds: number = 300
): Promise<boolean> {
  const prefixedKey = `vocaid:${key}`;
  const serialized = JSON.stringify(value);

  // Try Redis first
  if (isRedisEnabled()) {
    try {
      await redisClient!.setEx(prefixedKey, ttlSeconds, serialized);
      return true;
    } catch (error) {
      apiLogger.error('[azure-redis] Set error, falling back to memory', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Fall back to memory cache
  memoryCache.set(prefixedKey, {
    value: serialized,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  
  return true;
}

/**
 * Delete a value from cache
 */
export async function del(key: string): Promise<boolean> {
  const prefixedKey = `vocaid:${key}`;

  // Delete from Redis
  if (isRedisEnabled()) {
    try {
      await redisClient!.del(prefixedKey);
    } catch (error) {
      apiLogger.error('[azure-redis] Delete error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Always delete from memory cache too
  memoryCache.delete(prefixedKey);
  return true;
}

/**
 * Delete all keys matching a pattern
 */
export async function delPattern(pattern: string): Promise<number> {
  const prefixedPattern = `vocaid:${pattern}`;
  let deletedCount = 0;

  // Delete from Redis
  if (isRedisEnabled()) {
    try {
      const keys = await redisClient!.keys(prefixedPattern);
      if (keys.length > 0) {
        deletedCount = await redisClient!.del(keys);
      }
    } catch (error) {
      apiLogger.error('[azure-redis] Delete pattern error', {
        pattern,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Delete from memory cache
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefixedPattern.replace('*', ''))) {
      memoryCache.delete(key);
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * Check if a key exists in cache
 */
export async function exists(key: string): Promise<boolean> {
  const prefixedKey = `vocaid:${key}`;

  if (isRedisEnabled()) {
    try {
      return (await redisClient!.exists(prefixedKey)) === 1;
    } catch (error) {
      apiLogger.error('[azure-redis] Exists error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  const cached = memoryCache.get(prefixedKey);
  return cached !== undefined && cached.expiresAt > Date.now();
}

// ============================================
// SPECIALIZED CACHE METHODS
// ============================================

/**
 * Cache user session data
 */
export async function cacheSession(
  userId: string,
  sessionData: Record<string, unknown>,
  ttlSeconds: number = 3600
): Promise<boolean> {
  return set(`session:${userId}`, sessionData, ttlSeconds);
}

/**
 * Get cached session data
 */
export async function getSession(userId: string): Promise<Record<string, unknown> | null> {
  return get<Record<string, unknown>>(`session:${userId}`);
}

/**
 * Cache dashboard analytics for a user
 */
export async function cacheDashboard(
  userId: string,
  dashboardData: unknown,
  ttlSeconds: number = 300
): Promise<boolean> {
  return set(`dashboard:${userId}`, dashboardData, ttlSeconds);
}

/**
 * Get cached dashboard analytics
 */
export async function getDashboard(userId: string): Promise<unknown | null> {
  return get(`dashboard:${userId}`);
}

/**
 * Invalidate all cache for a user
 */
export async function invalidateUserCache(userId: string): Promise<void> {
  await delPattern(`session:${userId}*`);
  await delPattern(`dashboard:${userId}*`);
  await delPattern(`user:${userId}*`);
}

// ============================================
// MEMORY CACHE CLEANUP
// ============================================

function cleanupMemoryCache() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, entry] of memoryCache.entries()) {
    if (entry.expiresAt < now) {
      memoryCache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    apiLogger.debug('[azure-redis] Memory cache cleanup', { cleaned });
  }
}

// Start memory cache cleanup interval
setInterval(cleanupMemoryCache, MEMORY_CACHE_CLEANUP_INTERVAL);

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

async function disconnect(): Promise<void> {
  if (redisClient && isConnected) {
    try {
      await redisClient.quit();
      isConnected = false;
      apiLogger.info('[azure-redis] Disconnected from Redis');
    } catch (error) {
      apiLogger.error('[azure-redis] Error disconnecting', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

// Handle graceful shutdown
process.on('SIGTERM', disconnect);
process.on('SIGINT', disconnect);

// ============================================
// INITIALIZATION
// ============================================

// Initialize on module load if enabled
if (config.enabled && config.host && config.password) {
  initializeRedis().catch((error) => {
    apiLogger.error('[azure-redis] Initialization failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  });
}

export default {
  isRedisEnabled,
  get,
  set,
  del,
  delPattern,
  exists,
  cacheSession,
  getSession,
  cacheDashboard,
  getDashboard,
  invalidateUserCache,
  initializeRedis,
  disconnect,
};
