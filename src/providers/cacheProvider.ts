/**
 * Cache Provider Abstraction
 * 
 * Provides a unified caching interface with environment-aware implementations:
 * - Production: RedisCacheProvider (Azure Redis Cache)
 * - Development/Staging: InMemoryCacheProvider (local Map-based cache)
 * 
 * Usage:
 *   import { cacheProvider } from './providers/cacheProvider';
 *   await cacheProvider.set('key', { data: 'value' }, 300);
 *   const data = await cacheProvider.get('key');
 * 
 * @module providers/cacheProvider
 */

import { config } from '../config/env';
import { apiLogger } from '../utils/logger';

// ========================================
// CACHE PROVIDER INTERFACE
// ========================================

export interface CacheProvider {
  /** Check if provider is connected/available */
  isAvailable(): boolean;
  
  /** Get a value from cache */
  get<T>(key: string): Promise<T | null>;
  
  /** Set a value in cache with TTL in seconds */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  
  /** Delete a key from cache */
  del(key: string): Promise<void>;
  
  /** Check if a key exists */
  exists(key: string): Promise<boolean>;
  
  /** Get all keys matching a pattern */
  keys(pattern: string): Promise<string[]>;
  
  /** Clear all keys (with optional pattern) */
  flush(pattern?: string): Promise<void>;
  
  /** Increment a counter */
  incr(key: string, amount?: number): Promise<number>;
  
  /** Set expiration on a key */
  expire(key: string, ttlSeconds: number): Promise<void>;
  
  /** Get provider name for diagnostics */
  getName(): string;
}

// ========================================
// IN-MEMORY CACHE PROVIDER (DEV/STAGING)
// ========================================

interface MemoryCacheEntry {
  value: string;
  expiresAt: number;
}

class InMemoryCacheProvider implements CacheProvider {
  private cache = new Map<string, MemoryCacheEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    apiLogger.info('[cache] In-memory cache provider initialized');
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt > 0 && entry.expiresAt < now) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      apiLogger.debug(`[cache] Cleaned ${cleaned} expired entries`);
    }
  }

  getName(): string {
    return 'InMemoryCacheProvider';
  }

  isAvailable(): boolean {
    return true;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return entry.value as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = 3600): Promise<void> {
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    this.cache.set(key, {
      value: JSON.stringify(value),
      expiresAt,
    });
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    const now = Date.now();
    return Array.from(this.cache.keys()).filter((key) => {
      const entry = this.cache.get(key);
      if (entry && entry.expiresAt > 0 && entry.expiresAt < now) {
        return false;
      }
      return regex.test(key);
    });
  }

  async flush(pattern?: string): Promise<void> {
    if (!pattern || pattern === '*') {
      this.cache.clear();
    } else {
      const keysToDelete = await this.keys(pattern);
      keysToDelete.forEach((key) => this.cache.delete(key));
    }
  }

  async incr(key: string, amount = 1): Promise<number> {
    const entry = this.cache.get(key);
    let value = 0;
    
    if (entry) {
      try {
        value = parseInt(entry.value, 10) || 0;
      } catch {
        value = 0;
      }
    }
    
    value += amount;
    this.cache.set(key, {
      value: String(value),
      expiresAt: entry?.expiresAt || 0,
    });
    
    return value;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.cache.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + ttlSeconds * 1000;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cache.clear();
  }
}

// ========================================
// REDIS CACHE PROVIDER (PRODUCTION)
// ========================================

class RedisCacheProvider implements CacheProvider {
  private client: import('redis').RedisClientType | null = null;
  private connected = false;
  private readonly prefix = 'vocaid:';

  constructor() {
    if (!config.features.redisEnabled) {
      apiLogger.info('[cache] Redis is disabled, using in-memory fallback');
      return;
    }

    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const { createClient } = await import('redis');

      const redisConfig = config.redis;
      
      let url: string;
      if (redisConfig.url) {
        url = redisConfig.url;
      } else if (redisConfig.host && redisConfig.password) {
        const protocol = redisConfig.tlsEnabled ? 'rediss' : 'redis';
        url = `${protocol}://:${redisConfig.password}@${redisConfig.host}:${redisConfig.port || 6380}`;
      } else {
        apiLogger.warn('[cache] Redis configuration incomplete, using in-memory fallback');
        return;
      }

      this.client = createClient({ url }) as import('redis').RedisClientType;

      this.client.on('error', (err: Error) => {
        apiLogger.error('[cache] Redis error', { error: err.message });
        this.connected = false;
      });

      this.client.on('connect', () => {
        apiLogger.info('[cache] Connected to Redis');
        this.connected = true;
      });

      await this.client.connect();
    } catch (error) {
      apiLogger.error('[cache] Failed to initialize Redis', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  getName(): string {
    return 'RedisCacheProvider';
  }

  isAvailable(): boolean {
    return this.connected && this.client !== null;
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) return null;
    
    try {
      const value = await this.client!.get(this.getKey(key));
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      apiLogger.error('[cache] Redis get error', { key, error });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = 3600): Promise<void> {
    if (!this.isAvailable()) return;
    
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await this.client!.setEx(this.getKey(key), ttlSeconds, serialized);
      } else {
        await this.client!.set(this.getKey(key), serialized);
      }
    } catch (error) {
      apiLogger.error('[cache] Redis set error', { key, error });
    }
  }

  async del(key: string): Promise<void> {
    if (!this.isAvailable()) return;
    
    try {
      await this.client!.del(this.getKey(key));
    } catch (error) {
      apiLogger.error('[cache] Redis del error', { key, error });
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    
    try {
      const result = await this.client!.exists(this.getKey(key));
      return result === 1;
    } catch (error) {
      apiLogger.error('[cache] Redis exists error', { key, error });
      return false;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.isAvailable()) return [];
    
    try {
      const fullPattern = this.getKey(pattern);
      return await this.client!.keys(fullPattern);
    } catch (error) {
      apiLogger.error('[cache] Redis keys error', { pattern, error });
      return [];
    }
  }

  async flush(pattern?: string): Promise<void> {
    if (!this.isAvailable()) return;
    
    try {
      if (!pattern || pattern === '*') {
        const keys = await this.keys('*');
        if (keys.length > 0) {
          await this.client!.del(keys);
        }
      } else {
        const keys = await this.keys(pattern);
        if (keys.length > 0) {
          await this.client!.del(keys);
        }
      }
    } catch (error) {
      apiLogger.error('[cache] Redis flush error', { pattern, error });
    }
  }

  async incr(key: string, amount = 1): Promise<number> {
    if (!this.isAvailable()) return 0;
    
    try {
      return await this.client!.incrBy(this.getKey(key), amount);
    } catch (error) {
      apiLogger.error('[cache] Redis incr error', { key, error });
      return 0;
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this.isAvailable()) return;
    
    try {
      await this.client!.expire(this.getKey(key), ttlSeconds);
    } catch (error) {
      apiLogger.error('[cache] Redis expire error', { key, error });
    }
  }
}

// ========================================
// PROVIDER FACTORY
// ========================================

function createCacheProvider(): CacheProvider {
  if (config.features.redisEnabled) {
    const redis = new RedisCacheProvider();
    // If Redis fails to connect, fall back to in-memory
    if (!redis.isAvailable()) {
      apiLogger.warn('[cache] Redis unavailable, using in-memory fallback');
      return new InMemoryCacheProvider();
    }
    return redis;
  }
  
  return new InMemoryCacheProvider();
}

// Export singleton instance
export const cacheProvider = createCacheProvider();

export default cacheProvider;
