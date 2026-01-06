/**
 * Analytics Caching Service
 * 
 * Provides caching layer for expensive analytics computations.
 * Uses database-backed cache with TTL for pre-computed analytics.
 * 
 * Benefits:
 * - Reduces Azure PostgreSQL compute costs
 * - Faster dashboard loading (cached data vs real-time aggregation)
 * - Background refresh via scheduled jobs
 * 
 * @module services/analyticsCachingService
 */

import { dbLogger } from './databaseService';

// ============================================
// CONSTANTS
// ============================================

/** Cache key constants */
export const CACHE_KEYS = {
  DASHBOARD: 'dashboard',
  SCORES_BY_ROLE: 'scores_by_role',
  SCORES_BY_COMPANY: 'scores_by_company',
  SCORE_TIME_SERIES: 'score_time_series',
  INTERVIEW_VOLUME: 'interview_volume',
  PERCENTILE: 'percentile',
  FILTERS: 'filters',
} as const;

export type CacheKey = typeof CACHE_KEYS[keyof typeof CACHE_KEYS];

/** Cache TTL configuration (in milliseconds) */
export const CACHE_TTL = {
  [CACHE_KEYS.DASHBOARD]: 5 * 60 * 1000,      // 5 minutes
  [CACHE_KEYS.SCORES_BY_ROLE]: 10 * 60 * 1000, // 10 minutes
  [CACHE_KEYS.SCORES_BY_COMPANY]: 10 * 60 * 1000,
  [CACHE_KEYS.SCORE_TIME_SERIES]: 15 * 60 * 1000, // 15 minutes
  [CACHE_KEYS.INTERVIEW_VOLUME]: 15 * 60 * 1000,
  [CACHE_KEYS.PERCENTILE]: 30 * 60 * 1000,    // 30 minutes (expensive)
  [CACHE_KEYS.FILTERS]: 60 * 60 * 1000,       // 1 hour
} as const;

/** Global snapshot types */
export const SNAPSHOT_TYPES = {
  ROLE_BENCHMARKS: 'role_benchmarks',
  GLOBAL_PERCENTILES: 'global_percentiles',
  COMPANY_STATS: 'company_stats',
} as const;

export type SnapshotType = typeof SNAPSHOT_TYPES[keyof typeof SNAPSHOT_TYPES];

// ============================================
// TYPES
// ============================================

interface CacheEntry<T = unknown> {
  data: T;
  computedAt: Date;
  expiresAt: Date;
  version: number;
}

interface CacheOptions {
  /** Force refresh even if cache is valid */
  forceRefresh?: boolean;
  /** Custom TTL in milliseconds */
  ttlMs?: number;
}

type UserCacheKey = `${string}:${CacheKey}`;

const userCache = new Map<UserCacheKey, CacheEntry>();

interface GlobalSnapshotEntry<T = unknown> {
  data: T;
  recordCount: number;
  computedAt: Date;
}

const globalSnapshots = new Map<SnapshotType, GlobalSnapshotEntry>();

// ============================================
// USER CACHE OPERATIONS
// ============================================

/**
 * Get cached analytics data for a user
 * Returns null if cache miss or expired
 */
export async function getCachedAnalytics<T>(
  userId: string,
  cacheKey: CacheKey
): Promise<T | null> {
  try {
    const key: UserCacheKey = `${userId}:${cacheKey}`;
    const cached = userCache.get(key);
    if (!cached) {
      dbLogger.debug('Analytics cache miss', { userId, cacheKey });
      return null;
    }

    // Check if expired
    if (new Date() > cached.expiresAt) {
      dbLogger.debug('Analytics cache expired', { 
        userId, 
        cacheKey, 
        expiredAt: cached.expiresAt 
      });
      userCache.delete(key);
      return null;
    }

    dbLogger.debug('Analytics cache hit', { userId, cacheKey });
    return cached.data as T;
  } catch (error) {
    dbLogger.error('Failed to get cached analytics', { 
      userId, 
      cacheKey, 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    return null;
  }
}

/**
 * Store computed analytics in cache
 */
export async function setCachedAnalytics<T>(
  userId: string,
  cacheKey: CacheKey,
  data: T,
  options?: { ttlMs?: number }
): Promise<void> {
  const ttlMs = options?.ttlMs ?? CACHE_TTL[cacheKey] ?? 5 * 60 * 1000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    const key: UserCacheKey = `${userId}:${cacheKey}`;
    const existing = userCache.get(key);
    userCache.set(key, {
      data,
      computedAt: now,
      expiresAt,
      version: (existing?.version ?? 0) + 1,
    });

    dbLogger.debug('Analytics cache set', { userId, cacheKey, expiresAt });
  } catch (error) {
    dbLogger.error('Failed to set cached analytics', { 
      userId, 
      cacheKey, 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    // Don't throw - caching failure shouldn't break the request
  }
}

/**
 * Invalidate all analytics cache for a user
 * Call after interview completion or score update
 */
export async function invalidateUserCache(userId: string): Promise<void> {
  try {
    let deletedCount = 0;
    for (const key of userCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        userCache.delete(key);
        deletedCount++;
      }
    }

    dbLogger.info('User analytics cache invalidated', { 
      userId, 
      deletedCount
    });
  } catch (error) {
    dbLogger.error('Failed to invalidate user cache', { 
      userId, 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
  }
}

/**
 * Invalidate specific cache key for a user
 */
export async function invalidateCacheKey(
  userId: string, 
  cacheKey: CacheKey
): Promise<void> {
  try {
    const key: UserCacheKey = `${userId}:${cacheKey}`;
    userCache.delete(key);

    dbLogger.debug('Cache key invalidated', { userId, cacheKey });
  } catch (error) {
    dbLogger.error('Failed to invalidate cache key', { 
      userId, 
      cacheKey, 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
  }
}

// ============================================
// GLOBAL SNAPSHOT OPERATIONS
// ============================================

/**
 * Get global analytics snapshot
 * These are pre-computed by background jobs
 */
export async function getGlobalSnapshot<T>(
  snapshotType: SnapshotType
): Promise<T | null> {
  try {
    const snapshot = globalSnapshots.get(snapshotType);

    if (!snapshot) {
      dbLogger.debug('Global snapshot miss', { snapshotType });
      return null;
    }

    // Check if snapshot is too stale (> 24 hours)
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (new Date().getTime() - snapshot.computedAt.getTime() > maxAge) {
      dbLogger.warn('Global snapshot is stale', { 
        snapshotType, 
        computedAt: snapshot.computedAt 
      });
      // Return stale data but log warning
    }

    return snapshot.data as T;
  } catch (error) {
    dbLogger.error('Failed to get global snapshot', { 
      snapshotType, 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    return null;
  }
}

/**
 * Store global analytics snapshot
 * Called by scheduled background jobs
 */
export async function setGlobalSnapshot<T>(
  snapshotType: SnapshotType,
  data: T,
  recordCount: number
): Promise<void> {
  try {
    globalSnapshots.set(snapshotType, {
      data,
      recordCount,
      computedAt: new Date(),
    });

    dbLogger.info('Global snapshot updated', { snapshotType, recordCount });
  } catch (error) {
    dbLogger.error('Failed to set global snapshot', { 
      snapshotType, 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    throw error; // Propagate error for background job handling
  }
}

// ============================================
// CACHE-THROUGH PATTERN
// ============================================

/**
 * Get or compute analytics with caching
 * Implements cache-aside pattern with stale-while-revalidate
 */
export async function getOrComputeAnalytics<T>(
  userId: string,
  cacheKey: CacheKey,
  computeFn: () => Promise<T>,
  options?: CacheOptions
): Promise<T> {
  // Check cache first (unless force refresh)
  if (!options?.forceRefresh) {
    const cached = await getCachedAnalytics<T>(userId, cacheKey);
    if (cached !== null) {
      return cached;
    }
  }

  // Cache miss or forced refresh - compute fresh data
  const startTime = Date.now();
  const freshData = await computeFn();
  const computeTimeMs = Date.now() - startTime;

  dbLogger.info('Analytics computed', { 
    userId, 
    cacheKey, 
    computeTimeMs,
    cached: false 
  });

  // Store in cache (async, don't block response)
  setCachedAnalytics(userId, cacheKey, freshData, { ttlMs: options?.ttlMs })
    .catch(err => dbLogger.error('Background cache set failed', { err }));

  return freshData;
}

// ============================================
// CACHE MAINTENANCE
// ============================================

/**
 * Clean up expired cache entries
 * Run as scheduled job
 */
export async function cleanupExpiredCache(): Promise<number> {
  try {
    const now = new Date();
    let deletedCount = 0;
    for (const [key, entry] of userCache.entries()) {
      if (entry.expiresAt < now) {
        userCache.delete(key);
        deletedCount++;
      }
    }

    dbLogger.info('Expired cache entries cleaned up', { 
      deletedCount
    });

    return deletedCount;
  } catch (error) {
    dbLogger.error('Failed to cleanup expired cache', { 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    return 0;
  }
}

/**
 * Get cache statistics for monitoring
 */
export async function getCacheStats(): Promise<{
  totalEntries: number;
  expiredEntries: number;
  entriesByKey: Record<string, number>;
}> {
  try {
    const now = new Date();
    const entriesByKey: Record<string, number> = {};
    let expiredEntries = 0;

    for (const entry of userCache.values()) {
      if (entry.expiresAt < now) expiredEntries++;
    }

    for (const key of userCache.keys()) {
      const cacheKey = key.split(':').slice(1).join(':');
      entriesByKey[cacheKey] = (entriesByKey[cacheKey] ?? 0) + 1;
    }

    return {
      totalEntries: userCache.size,
      expiredEntries,
      entriesByKey
    };
  } catch (error) {
    dbLogger.error('Failed to get cache stats', { 
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    return {
      totalEntries: 0,
      expiredEntries: 0,
      entriesByKey: {}
    };
  }
}

// ============================================
// WARM CACHE ON USER LOGIN
// ============================================

/**
 * Pre-warm cache for a user
 * Call on login to prepare dashboard data
 */
export async function warmUserCache(
  userId: string,
  computeFunctions: {
    dashboard?: () => Promise<unknown>;
    scoresByRole?: () => Promise<unknown>;
    filters?: () => Promise<unknown>;
  }
): Promise<void> {
  const warmupTasks: Promise<void>[] = [];

  if (computeFunctions.dashboard) {
    warmupTasks.push(
      getOrComputeAnalytics(userId, CACHE_KEYS.DASHBOARD, computeFunctions.dashboard)
        .then(() => { /* warmup complete */ })
        .catch(err => { dbLogger.error('Dashboard warmup failed', { err }); })
    );
  }

  if (computeFunctions.scoresByRole) {
    warmupTasks.push(
      getOrComputeAnalytics(userId, CACHE_KEYS.SCORES_BY_ROLE, computeFunctions.scoresByRole)
        .then(() => { /* warmup complete */ })
        .catch(err => { dbLogger.error('Scores warmup failed', { err }); })
    );
  }

  if (computeFunctions.filters) {
    warmupTasks.push(
      getOrComputeAnalytics(userId, CACHE_KEYS.FILTERS, computeFunctions.filters)
        .then(() => { /* warmup complete */ })
        .catch(err => { dbLogger.error('Filters warmup failed', { err }); })
    );
  }

  // Run warmup tasks in parallel (don't await - background)
  Promise.all(warmupTasks).catch(() => {
    // Ignore warmup errors - they're non-critical
  });
}
