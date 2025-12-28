/**
 * Observability Middleware
 * 
 * Provides request-level metrics, tracking, and cost monitoring for:
 * - Request duration and payload sizes
 * - Slow request detection (>3s threshold)
 * - OpenAI token usage aggregation
 * - Retell call latency tracking
 * - Request deduplication detection
 * 
 * @module middleware/observabilityMiddleware
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger, { httpLogger } from '../utils/logger';

// ============================================
// TYPES
// ============================================

interface RequestMetrics {
  requestId: string;
  method: string;
  path: string;
  userId: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  statusCode?: number;
  requestSize: number;
  responseSize?: number;
  isSlow?: boolean;
}

interface AggregatedMetrics {
  totalRequests: number;
  slowRequests: number;
  totalDuration: number;
  totalRequestBytes: number;
  totalResponseBytes: number;
  openAiTokens: number;
  retellCallDuration: number;
  endpointStats: Map<string, EndpointStats>;
  duplicateRequests: Map<string, number>;
}

interface EndpointStats {
  count: number;
  totalDuration: number;
  avgDuration: number;
  maxDuration: number;
  totalResponseSize: number;
  slowCount: number;
}

// ============================================
// CONFIGURATION
// ============================================

const SLOW_REQUEST_THRESHOLD_MS = 3000;
const DUPLICATE_WINDOW_MS = 1000; // Detect duplicate requests within 1 second
const METRICS_REPORT_INTERVAL_MS = 60000; // Report metrics every minute

// ============================================
// IN-MEMORY METRICS STORE (for development/debugging)
// ============================================

const metrics: AggregatedMetrics = {
  totalRequests: 0,
  slowRequests: 0,
  totalDuration: 0,
  totalRequestBytes: 0,
  totalResponseBytes: 0,
  openAiTokens: 0,
  retellCallDuration: 0,
  endpointStats: new Map(),
  duplicateRequests: new Map()
};

// Track recent requests for duplicate detection
const recentRequests = new Map<string, number>();

// ============================================
// METRICS HELPERS
// ============================================

function getRequestFingerprint(req: Request): string {
  const userId = req.headers['x-user-id'] as string || 'anon';
  return `${req.method}:${req.path}:${userId}`;
}

function detectDuplicate(fingerprint: string): boolean {
  const now = Date.now();
  const lastTime = recentRequests.get(fingerprint);
  
  if (lastTime && (now - lastTime) < DUPLICATE_WINDOW_MS) {
    const count = metrics.duplicateRequests.get(fingerprint) || 0;
    metrics.duplicateRequests.set(fingerprint, count + 1);
    return true;
  }
  
  recentRequests.set(fingerprint, now);
  return false;
}

function updateEndpointStats(path: string, duration: number, responseSize: number, isSlow: boolean) {
  const normalizedPath = normalizePath(path);
  let stats = metrics.endpointStats.get(normalizedPath);
  
  if (!stats) {
    stats = {
      count: 0,
      totalDuration: 0,
      avgDuration: 0,
      maxDuration: 0,
      totalResponseSize: 0,
      slowCount: 0
    };
  }
  
  stats.count++;
  stats.totalDuration += duration;
  stats.avgDuration = stats.totalDuration / stats.count;
  stats.maxDuration = Math.max(stats.maxDuration, duration);
  stats.totalResponseSize += responseSize;
  if (isSlow) stats.slowCount++;
  
  metrics.endpointStats.set(normalizedPath, stats);
}

function normalizePath(path: string): string {
  // Replace UUIDs and IDs with placeholders for aggregation
  return path
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, ':id')
    .replace(/user_[a-zA-Z0-9]+/g, ':userId')
    .replace(/interview_[a-zA-Z0-9_]+/g, ':interviewId')
    .replace(/\/\d+/g, '/:num');
}

// ============================================
// MIDDLEWARE
// ============================================

/**
 * Request observability middleware
 * Tracks request metrics, detects slow requests, and logs performance data
 */
export function observabilityMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();
  const fingerprint = getRequestFingerprint(req);
  const isDuplicate = detectDuplicate(fingerprint);
  
  // Attach request ID and metrics to request object
  (req as any).requestId = requestId;
  (req as any).metricsStartTime = startTime;
  
  // Extract user ID for correlation
  const userId = req.headers['x-user-id'] as string || 'anonymous';
  const userIdShort = userId.startsWith('user_') ? userId.slice(0, 15) + '...' : userId;
  
  // Calculate request payload size
  const requestSize = parseInt(req.headers['content-length'] || '0', 10);
  
  // Log incoming request
  const logData: Record<string, unknown> = {
    requestId,
    userId: userIdShort,
    contentLength: requestSize || undefined,
    origin: req.headers.origin || req.headers.referer || 'direct'
  };
  
  if (Object.keys(req.query).length > 0) {
    logData.query = req.query;
  }
  
  if (isDuplicate) {
    logData.duplicate = true;
    httpLogger.warn(`⚡ Duplicate request detected: ${req.method} ${req.path}`, logData);
  } else {
    httpLogger.info(`→ ${req.method} ${req.path}`, logData);
  }
  
  // Capture response metrics
  const originalSend = res.send.bind(res);
  res.send = function(body: any) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    const statusCode = res.statusCode;
    const responseSize = typeof body === 'string' ? body.length : 
                         Buffer.isBuffer(body) ? body.length :
                         JSON.stringify(body || {}).length;
    
    const isSlow = duration > SLOW_REQUEST_THRESHOLD_MS;
    
    // Update aggregated metrics
    metrics.totalRequests++;
    metrics.totalDuration += duration;
    metrics.totalRequestBytes += requestSize;
    metrics.totalResponseBytes += responseSize;
    if (isSlow) metrics.slowRequests++;
    
    updateEndpointStats(req.path, duration, responseSize, isSlow);
    
    // Determine log level based on status and duration
    const logLevel = statusCode >= 500 ? 'error' : 
                     statusCode >= 400 ? 'warn' : 
                     isSlow ? 'warn' : 'info';
    
    const responseLog: Record<string, unknown> = {
      requestId,
      userId: userIdShort,
      status: statusCode,
      duration: `${duration}ms`,
      size: responseSize > 1024 ? `${Math.round(responseSize / 1024)}KB` : `${responseSize}B`
    };
    
    if (isSlow) {
      responseLog.slow = true;
      httpLogger.warn(`⚠ SLOW: ${req.method} ${req.path} took ${duration}ms`, responseLog);
    } else {
      httpLogger[logLevel](`← ${req.method} ${req.path} ${statusCode}`, responseLog);
    }
    
    return originalSend(body);
  };
  
  next();
}

// ============================================
// OPENAI TOKEN TRACKING
// ============================================

/**
 * Track OpenAI API token usage
 */
export function trackOpenAiTokens(tokens: number, model: string, operation: string) {
  metrics.openAiTokens += tokens;
  httpLogger.debug('OpenAI tokens used', { tokens, model, operation, totalTokens: metrics.openAiTokens });
}

// ============================================
// RETELL LATENCY TRACKING
// ============================================

/**
 * Track Retell call latency
 */
export function trackRetellLatency(durationMs: number, callId: string) {
  metrics.retellCallDuration += durationMs;
  httpLogger.debug('Retell call tracked', { durationMs, callId, totalDuration: metrics.retellCallDuration });
}

// ============================================
// METRICS REPORTING
// ============================================

/**
 * Get current metrics snapshot
 */
export function getMetricsSnapshot(): {
  summary: Record<string, unknown>;
  topSlowEndpoints: Array<{ path: string; avgDuration: number; slowCount: number }>;
  topLargePayloads: Array<{ path: string; avgSize: number }>;
  duplicateRequests: Array<{ fingerprint: string; count: number }>;
} {
  const topSlowEndpoints = Array.from(metrics.endpointStats.entries())
    .map(([path, stats]) => ({ path, avgDuration: stats.avgDuration, slowCount: stats.slowCount }))
    .sort((a, b) => b.avgDuration - a.avgDuration)
    .slice(0, 10);
  
  const topLargePayloads = Array.from(metrics.endpointStats.entries())
    .map(([path, stats]) => ({ path, avgSize: stats.totalResponseSize / stats.count }))
    .sort((a, b) => b.avgSize - a.avgSize)
    .slice(0, 10);
  
  const duplicateRequests = Array.from(metrics.duplicateRequests.entries())
    .map(([fingerprint, count]) => ({ fingerprint, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  
  return {
    summary: {
      totalRequests: metrics.totalRequests,
      slowRequests: metrics.slowRequests,
      slowPercentage: metrics.totalRequests > 0 
        ? ((metrics.slowRequests / metrics.totalRequests) * 100).toFixed(2) + '%'
        : '0%',
      avgDuration: metrics.totalRequests > 0 
        ? (metrics.totalDuration / metrics.totalRequests).toFixed(2) + 'ms'
        : '0ms',
      totalRequestBytes: formatBytes(metrics.totalRequestBytes),
      totalResponseBytes: formatBytes(metrics.totalResponseBytes),
      openAiTokens: metrics.openAiTokens,
      retellCallDuration: `${Math.round(metrics.retellCallDuration / 1000)}s`
    },
    topSlowEndpoints,
    topLargePayloads,
    duplicateRequests
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * Reset metrics (for testing or periodic cleanup)
 */
export function resetMetrics() {
  metrics.totalRequests = 0;
  metrics.slowRequests = 0;
  metrics.totalDuration = 0;
  metrics.totalRequestBytes = 0;
  metrics.totalResponseBytes = 0;
  metrics.openAiTokens = 0;
  metrics.retellCallDuration = 0;
  metrics.endpointStats.clear();
  metrics.duplicateRequests.clear();
  recentRequests.clear();
}

// Periodic metrics logging (in development)
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const snapshot = getMetricsSnapshot();
    if (metrics.totalRequests > 0) {
      logger.info('📊 Metrics Report', snapshot.summary);
    }
  }, METRICS_REPORT_INTERVAL_MS);
}

// Clean up old request fingerprints periodically
setInterval(() => {
  const now = Date.now();
  for (const [fingerprint, time] of recentRequests.entries()) {
    if (now - time > DUPLICATE_WINDOW_MS * 10) {
      recentRequests.delete(fingerprint);
    }
  }
}, 30000);

export default observabilityMiddleware;
