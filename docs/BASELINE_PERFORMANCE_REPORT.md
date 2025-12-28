# Baseline Performance Report
Generated: December 26, 2025

## Executive Summary

This report identifies the top performance bottlenecks in the Voxly application to guide optimization efforts. The focus is on reducing Azure runtime costs, minimizing bandwidth, and improving user experience.

---

## 🐢 Top 10 Slow Endpoints

### 1. GET /api/dashboard/candidate (CRITICAL)
**Service:** `dashboardRoutes.ts`
**Issue:** Executes 6 parallel database queries per request:
- Filtered interviews with nested resume includes
- All completed interviews (without limit)
- All payments
- All resumes with interview counts
- Distinct job titles
- Distinct seniorities

**Impact:** High - Every dashboard load triggers significant DB load
**Recommendation:** 
- Add Redis caching with 60s TTL
- Use database-level aggregations
- Implement incremental loading

### 2. GET /api/analytics/dashboard (HIGH)
**Service:** `analyticsRoutes.ts`
**Issue:** Complex aggregations on every request:
- Score grouping by role (2 queries)
- Score grouping by company (2 queries)
- Time series calculations
- Volume analytics

**Recommendation:**
- Pre-compute analytics daily via background job
- Store in analytics table
- Return cached data with "last updated" timestamp

### 3. POST /chat/performance (HIGH)
**Service:** `analyticsRoutes.ts`
**Issue:** Fetches up to 10 interviews with full transcripts (5000+ chars each)
**Recommendation:**
- Summarize transcripts before LLM processing
- Cache context for 5 minutes
- Stream responses

### 4. GET /api/users/:id/stats (MEDIUM-HIGH)
**Service:** `userService.ts`
**Issue:** Fetches ALL completed interviews and payments, processes in-memory
**Recommendation:**
- Use COUNT() and SUM() aggregations
- Limit to last 12 months
- Paginate historical data

### 5. GET /api/analytics/performance/* (MEDIUM)
**Issue:** Double queries for trend calculation (current + previous period)
**Recommendation:**
- Cache previous period scores
- Single query with date grouping

### 6. GET /api/users/:id/interviews (MEDIUM)
**Issue:** Selects feedbackPdf field then removes it
**Recommendation:**
- Add hasFeedbackPdf computed field
- Don't fetch blob just to check existence

### 7. GET /api/analytics/time-series (MEDIUM)
**Issue:** Fetches all scores, groups in JavaScript
**Recommendation:**
- Use database DATE_TRUNC grouping
- Limit data points (max 100)

### 8. POST /api/interviews (MEDIUM)
**Issue:** Calls ensureUserExists() on every creation (Clerk API)
**Recommendation:**
- Cache user verification (5 min)
- Skip if recently verified

### 9. GET /api/credits/summary (LOW-MEDIUM)
**Issue:** Fetches complete transaction history
**Recommendation:**
- Paginate history
- Cache balance, update on transactions

### 10. GET /api/interviews/:id (LOW-MEDIUM)
**Issue:** Regex parsing of feedback on every request
**Recommendation:**
- Pre-parse on interview completion
- Store structured JSON

---

## 📦 Top 5 Large Payload Endpoints

| Endpoint | Payload Size | Issue |
|----------|-------------|-------|
| GET /api/interviews/:id/pdf | 2-5 MB | Full base64 PDF in JSON |
| POST /api/email/feedback | 2-5 MB | PDF sent in request body |
| GET /api/resumes/:id/download | Up to 5 MB | Resume as base64 |
| POST /api/resumes/upload | Up to 5 MB | Base64 stored in DB |
| POST /chat/performance | Variable | Full transcripts in context |

**Recommendations:**
- Move file storage to S3/Azure Blob
- Use presigned URLs for downloads
- Stream large files instead of base64

---

## 🔄 Missing Caching

| Data | Current | Recommended TTL |
|------|---------|-----------------|
| User profile/credits | No cache | 5 minutes |
| Dashboard filter options | No cache | 10 minutes |
| Analytics aggregations | No cache | Pre-compute nightly |
| Credit packages | No cache | 24 hours (static) |
| FAQ/Knowledge base | No cache | Until deployment |

---

## 🔁 Frontend Duplicate Request Patterns

### 1. Dashboard Data
Multiple pages fetch `useDashboardQuery` independently:
- Dashboard.tsx
- CandidateDashboard.tsx
- AnalyticsPage.tsx

**Fix:** React Query cache (IMPLEMENTED)

### 2. Resume List
Fetched in both InterviewSetup and ResumeManager

**Fix:** Shared React Query hook (IMPLEMENTED)

### 3. Multiple useEffects
- InterviewRoom.tsx: 6 useEffects
- InterviewSetup.tsx: 3 useEffects

**Fix:** Consolidate, use parallel fetching

### 4. User Data Fetched Twice
Pages fetch getUserProfile while UserContext also fetches

**Fix:** Single source of truth

---

## 🎯 Priority Matrix

| Priority | Optimization | Est. Impact | Effort | Status |
|----------|-------------|-------------|--------|--------|
| 🔴 P0 | React Query caching | 50% fewer requests | Low | ✅ DONE |
| 🔴 P0 | Observability middleware | Baseline metrics | Low | ✅ DONE |
| 🔴 P1 | Add Cache-Control headers | CDN caching | Low | ⏳ TODO |
| 🔴 P1 | Dashboard API caching | 70% latency reduction | Medium | ⏳ TODO |
| 🟡 P2 | Move files to blob storage | 50% payload reduction | High | ⏳ TODO |
| 🟡 P2 | Pre-compute analytics | 60% DB load reduction | Medium | ⏳ TODO |
| 🟢 P3 | Add pagination limits | Prevents timeouts | Low | ⏳ TODO |
| 🟢 P3 | Consolidate useEffects | Fewer waterfall requests | Low | ⏳ TODO |

---

## Quick Wins (Low Effort, Good Impact)

1. ✅ Add React Query for automatic request deduplication
2. ✅ Add observability middleware for metrics
3. ⏳ Add Cache-Control headers for static endpoints
4. ⏳ Add `hasFeedbackPdf` boolean field
5. ⏳ Limit interview history to 100 in analytics
6. ⏳ Add database indexes on frequently filtered columns
7. ⏳ Enable Prisma query logging in development

---

## Metrics to Track

After optimizations, measure:
- Average response time per endpoint
- P95/P99 latency
- Request count per endpoint
- Cache hit rate
- Error rate
- Payload sizes

The observability middleware at `/metrics` will provide this data.
