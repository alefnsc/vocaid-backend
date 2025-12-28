/**
 * Caching Middleware
 * 
 * Adds appropriate Cache-Control headers to reduce bandwidth and Azure costs.
 * Works with:
 * - Browser caching
 * - CDN edge caching (Azure Front Door, Cloudflare)
 * - React Query client-side caching
 * 
 * @module middleware/cachingMiddleware
 */

import { Request, Response, NextFunction } from 'express';

// ============================================
// CACHE CONFIGURATION
// ============================================

/**
 * Cache durations in seconds
 */
const CACHE_DURATIONS = {
  // Static data (rarely changes)
  STATIC: 86400, // 24 hours
  
  // Semi-static data (changes occasionally)
  SEMI_STATIC: 3600, // 1 hour
  
  // Dynamic but cacheable (user-specific but stable)
  SHORT: 60, // 1 minute
  
  // Very short cache (prevents thundering herd)
  MICRO: 10, // 10 seconds
  
  // No cache
  NONE: 0,
} as const;

/**
 * Cache rules by endpoint pattern
 * Order matters - first match wins
 */
const CACHE_RULES: Array<{
  pattern: RegExp;
  duration: number;
  private: boolean;
  staleWhileRevalidate?: number;
  description: string;
}> = [
  // =========================================
  // NO CACHE - Mutations and sensitive data
  // =========================================
  {
    pattern: /^\/api\/(auth|login|logout|signup)/,
    duration: CACHE_DURATIONS.NONE,
    private: true,
    description: 'Authentication - no cache',
  },
  {
    pattern: /^\/api\/email\//,
    duration: CACHE_DURATIONS.NONE,
    private: true,
    description: 'Email endpoints - no cache',
  },
  {
    pattern: /^\/api\/credits\/(purchase|spend|restore)/,
    duration: CACHE_DURATIONS.NONE,
    private: true,
    description: 'Credit mutations - no cache',
  },
  {
    pattern: /^\/api\/multilingual\/payment/,
    duration: CACHE_DURATIONS.NONE,
    private: true,
    description: 'Payment endpoints - no cache',
  },
  {
    pattern: /^\/chat\//,
    duration: CACHE_DURATIONS.NONE,
    private: true,
    description: 'Chat endpoints - no cache',
  },
  
  // =========================================
  // STATIC DATA - Long cache
  // =========================================
  {
    pattern: /^\/api\/multilingual\/packages$/,
    duration: CACHE_DURATIONS.STATIC,
    private: false,
    staleWhileRevalidate: 86400, // Allow stale for 1 day
    description: 'Credit packages - static',
  },
  {
    pattern: /^\/api\/config\//,
    duration: CACHE_DURATIONS.STATIC,
    private: false,
    description: 'Configuration - static',
  },
  {
    pattern: /^\/health$/,
    duration: CACHE_DURATIONS.MICRO,
    private: false,
    description: 'Health check - short cache',
  },
  
  // =========================================
  // SEMI-STATIC - Medium cache
  // =========================================
  {
    pattern: /^\/api\/multilingual\/preferences$/,
    duration: CACHE_DURATIONS.SEMI_STATIC,
    private: true,
    staleWhileRevalidate: 3600,
    description: 'User preferences - medium cache',
  },
  
  // =========================================
  // SHORT CACHE - User-specific data
  // =========================================
  {
    pattern: /^\/api\/dashboard\/candidate$/,
    duration: CACHE_DURATIONS.SHORT,
    private: true,
    staleWhileRevalidate: 60,
    description: 'Dashboard - short cache with SWR',
  },
  {
    pattern: /^\/api\/credits\/balance$/,
    duration: CACHE_DURATIONS.SHORT,
    private: true,
    description: 'Credit balance - short cache',
  },
  {
    pattern: /^\/api\/credits\/history$/,
    duration: CACHE_DURATIONS.SHORT,
    private: true,
    description: 'Credit history - short cache',
  },
  {
    pattern: /^\/api\/resumes$/,
    duration: CACHE_DURATIONS.SHORT,
    private: true,
    staleWhileRevalidate: 60,
    description: 'Resume list - short cache',
  },
  {
    pattern: /^\/api\/users\/[^/]+\/interviews$/,
    duration: CACHE_DURATIONS.SHORT,
    private: true,
    staleWhileRevalidate: 30,
    description: 'Interview list - short cache',
  },
  {
    pattern: /^\/api\/users\/[^/]+\/stats$/,
    duration: CACHE_DURATIONS.SHORT,
    private: true,
    description: 'User stats - short cache',
  },
  
  // =========================================
  // MICRO CACHE - Prevents thundering herd
  // =========================================
  {
    pattern: /^\/api\/analytics\//,
    duration: CACHE_DURATIONS.MICRO,
    private: true,
    staleWhileRevalidate: 30,
    description: 'Analytics - micro cache',
  },
  {
    pattern: /^\/api\/interviews\/[^/]+$/,
    duration: CACHE_DURATIONS.MICRO,
    private: true,
    description: 'Interview detail - micro cache',
  },
  {
    pattern: /^\/api\/resumes\/[^/]+$/,
    duration: CACHE_DURATIONS.MICRO,
    private: true,
    description: 'Resume detail - micro cache',
  },
];

// ============================================
// MIDDLEWARE
// ============================================

/**
 * Caching middleware - adds Cache-Control headers based on endpoint
 * 
 * Only applies to GET requests. POST/PUT/DELETE always get no-cache.
 */
export function cachingMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only cache GET/HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return next();
  }
  
  // Skip if already has Cache-Control header
  if (res.getHeader('Cache-Control')) {
    return next();
  }
  
  // Find matching rule
  const rule = CACHE_RULES.find(r => r.pattern.test(req.path));
  
  if (rule) {
    const cacheControl = buildCacheControl(rule.duration, rule.private, rule.staleWhileRevalidate);
    res.setHeader('Cache-Control', cacheControl);
    
    // Add Vary header for user-specific responses
    if (rule.private) {
      res.setHeader('Vary', 'Authorization, Accept-Language, X-Country-Code');
    }
  } else {
    // Default: short private cache
    res.setHeader('Cache-Control', 'private, max-age=30');
  }
  
  next();
}

/**
 * Build Cache-Control header value
 */
function buildCacheControl(duration: number, isPrivate: boolean, staleWhileRevalidate?: number): string {
  const parts: string[] = [];
  
  if (duration === 0) {
    return 'no-store, no-cache, must-revalidate';
  }
  
  // Private vs Public
  parts.push(isPrivate ? 'private' : 'public');
  
  // Max age
  parts.push(`max-age=${duration}`);
  
  // Stale-while-revalidate for better UX
  if (staleWhileRevalidate) {
    parts.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }
  
  return parts.join(', ');
}

// ============================================
// CACHE INVALIDATION HELPERS
// ============================================

/**
 * Add cache-busting headers for mutation responses
 * Call this in POST/PUT/DELETE handlers that should invalidate client cache
 */
export function invalidateCacheHeaders(res: Response, patterns: string[]): void {
  res.setHeader('Cache-Control', 'no-store');
  
  // Tell CDN to purge related cached content
  // This header is understood by Azure Front Door and Cloudflare
  if (patterns.length > 0) {
    res.setHeader('X-Cache-Invalidate', patterns.join(', '));
  }
}

/**
 * Add ETag support for conditional requests
 * Reduces bandwidth when content hasn't changed
 */
export function addETag(res: Response, content: string | Buffer): string {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(content).digest('hex');
  const etag = `"${hash}"`;
  
  res.setHeader('ETag', etag);
  return etag;
}

/**
 * Check If-None-Match header for conditional request
 * Returns true if client cache is still valid
 */
export function checkETag(req: Request, etag: string): boolean {
  const clientEtag = req.get('If-None-Match');
  return clientEtag === etag;
}

// ============================================
// UTILITY: ENDPOINT CACHE INFO
// ============================================

/**
 * Get cache configuration for an endpoint (useful for debugging)
 */
export function getCacheInfo(path: string): {
  duration: number;
  private: boolean;
  description: string;
} | null {
  const rule = CACHE_RULES.find(r => r.pattern.test(path));
  
  if (rule) {
    return {
      duration: rule.duration,
      private: rule.private,
      description: rule.description,
    };
  }
  
  return null;
}

export default cachingMiddleware;
