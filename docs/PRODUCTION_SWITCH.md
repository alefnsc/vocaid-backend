# Vocaid Production Switch Guide

Complete documentation for switching Vocaid from development to production environment.

---

## Table of Contents

1. [Backend API Route Map](#1-backend-api-route-map)
2. [Frontend API Calls Map](#2-frontend-api-calls-map)
3. [Environment Variables Reference](#3-environment-variables-reference)
4. [Environment Logic Analysis](#4-environment-logic-analysis)
5. [Identified Gaps & Inconsistencies](#5-identified-gaps--inconsistencies)
6. [Production Switch Checklist](#6-production-switch-checklist)
7. [Testing Checklist](#7-testing-checklist)

---

## 1. Backend API Route Map

### Server.ts Direct Endpoints

| Method | Endpoint | Auth | Rate Limit | Purpose |
|--------|----------|------|------------|---------|
| GET | `/health` | ❌ | General | Health check endpoint |
| POST | `/register-call` | ✅ verifyUserAuth | General | Register Retell call for interview |
| GET | `/get-call/:callId` | ❌ | General | Get Retell call details |
| GET | `/get-feedback-for-interview/:callId` | ❌ | General | Generate AI feedback for interview |
| POST | `/create-payment-preference` | ✅ verifyUserAuth | Sensitive | Create MercadoPago payment preference |
| POST | `/webhook/mercadopago` | ❌ | Webhook | MercadoPago IPN/webhook handler |
| GET | `/webhook/mercadopago` | ❌ | General | Webhook endpoint info |
| GET | `/payment/status/:preferenceId` | ❌ | Sensitive | Check payment status |
| POST | `/payment/verify/:paymentId` | ❌ | General | Manual payment verification |
| GET | `/payment/history/:userId` | ✅ verifyUserAuth | Sensitive | Get user payment history |
| POST | `/api/users/sync` | ✅ verifyUserAuth | General | Sync user on login |
| GET | `/api/users/me` | ✅ verifyUserAuth | General | Get current user data |
| POST | `/api/users/validate` | ✅ verifyUserAuth | General | Validate user session |
| POST | `/consume-credit` | ✅ verifyUserAuth | Sensitive | Consume credit for interview |
| POST | `/restore-credit` | ✅ verifyUserAuth | Sensitive | Restore credit (cancelled interview) |
| WS | `/llm-websocket/:call_id` | ❌ | - | Custom LLM WebSocket for Retell |
| WS | `/llm-websocket/:placeholder/:actual_call_id` | ❌ | - | Alternative WebSocket pattern |

### API Routes (/api prefix - from apiRoutes.ts)

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/users/me` | ✅ requireAuth | Get current user profile |
| GET | `/api/users/me/dashboard` | ✅ requireAuth | Get user dashboard stats |
| GET | `/api/users/:userId/stats` | ✅ requireAuth | Get user dashboard stats (frontend format) |
| GET | `/api/users/:userId/interviews` | ✅ requireAuth | Get user's interviews (frontend format) |
| GET | `/api/users/:userId/payments` | ✅ requireAuth | Get user's payments |
| GET | `/api/users/:userId/score-evolution` | ✅ requireAuth | Get score evolution chart data |
| GET | `/api/users/:userId/spending` | ✅ requireAuth | Get spending history |
| GET | `/api/interviews` | ✅ requireAuth | Get user's interviews |
| GET | `/api/interviews/:interviewId` | ✅ requireAuth | Get interview details |
| POST | `/api/interviews` | ✅ requireAuth | Create new interview record |
| PATCH | `/api/interviews/:interviewId` | ✅ requireAuth | Update interview |
| GET | `/api/interviews/:interviewId/download/feedback` | ✅ requireAuth | Download feedback PDF |
| GET | `/api/interviews/:interviewId/download/resume` | ✅ requireAuth | Download resume |
| GET | `/api/interviews/stats` | ✅ requireAuth | Get interview statistics |
| GET | `/api/payments` | ✅ requireAuth | Get user's payments |
| GET | `/api/payments/stats` | ✅ requireAuth | Get payment statistics |

---

## 2. Frontend API Calls Map

### APIService.ts Methods

| Method | Backend Endpoint | Auth Header | Purpose |
|--------|------------------|-------------|---------|
| `registerCall()` | POST `/register-call` | x-user-id | Register Retell interview call |
| `getUserInfo()` | GET `/get-user-info/:userId` | ❌ | **⚠️ DEPRECATED - endpoint doesn't exist** |
| `getCall()` | GET `/get-call/:callId` | ❌ | Get Retell call data |
| `getFeedback()` | GET `/get-feedback-for-interview/:callId` | ❌ | Get AI-generated feedback |
| `restoreCredit()` | POST `/restore-credit` | x-user-id | Restore credit on cancellation |
| `consumeCredit()` | POST `/consume-credit` | x-user-id | Consume credit for interview |
| `startCall()` | Retell SDK | - | Start Retell WebRTC call |
| `getDashboardStats()` | GET `/api/users/:userId/stats` | x-user-id | Dashboard statistics |
| `getUserInterviews()` | GET `/api/users/:userId/interviews` | x-user-id | Interview list |
| `getInterviewDetails()` | GET `/api/interviews/:interviewId` | x-user-id | Interview details |
| `getPaymentHistory()` | GET `/api/users/:userId/payments` | x-user-id | Payment history |
| `getScoreEvolution()` | GET `/api/users/:userId/score-evolution` | x-user-id | Score chart data |
| `getSpendingHistory()` | GET `/api/users/:userId/spending` | x-user-id | Spending chart data |
| `syncUser()` | POST `/api/users/sync` | x-user-id | Sync user to database |
| `validateUser()` | POST `/api/users/validate` | x-user-id | Validate user session |
| `getCurrentUser()` | GET `/api/users/me` | x-user-id | Get current user |

### MercadoPagoService.ts Methods

| Method | Backend Endpoint | Auth Header | Purpose |
|--------|------------------|-------------|---------|
| `createPreference()` | POST `/create-payment-preference` | ❌ | Create payment preference |
| `getPaymentUrl()` | POST `/create-payment-preference` | ❌ | Get payment redirect URL |

---

## 3. Environment Variables Reference

### Backend (.env)

| Variable | Required | Prod Switch | Description |
|----------|----------|-------------|-------------|
| `PORT` | ✅ | Same | Server port (default: 3001) |
| `NODE_ENV` | ✅ | `production` | **CRITICAL: Switch to 'production'** |
| `DATABASE_URL` | ✅ | Update | PostgreSQL connection string |
| `POSTGRES_USER` | ⚠️ Docker | Update | PostgreSQL user |
| `POSTGRES_PASSWORD` | ⚠️ Docker | Update | PostgreSQL password |
| `POSTGRES_DB` | ⚠️ Docker | Update | PostgreSQL database name |
| `OPENAI_API_KEY` | ✅ | Same | OpenAI API key for feedback |
| `GEMINI_API_KEY` | ⚡ Optional | Same | Fallback for feedback generation |
| `RETELL_API_KEY` | ✅ | Same | Retell AI API key |
| `RETELL_AGENT_ID` | ✅ | Same | Retell Agent ID |
| `MERCADOPAGO_ACCESS_TOKEN` | ✅ | **PROD KEY** | **Production access token** |
| `MERCADOPAGO_PUBLIC_KEY` | ✅ | **PROD KEY** | **Production public key** |
| `MERCADOPAGO_TEST_ACCESS_TOKEN` | ⚡ Dev only | Remove | Test access token |
| `MERCADOPAGO_TEST_PUBLIC_KEY` | ⚡ Dev only | Remove | Test public key |
| `FRONTEND_URL` | ✅ | **PROD URL** | Frontend URL for CORS/redirects |
| `WEBHOOK_BASE_URL` | ✅ | **PROD URL** | Backend URL for webhooks |
| `LOG_LEVEL` | ⚡ Optional | `warn` | Reduce logging in production |

### Frontend (.env)

| Variable | Required | Prod Switch | Description |
|----------|----------|-------------|-------------|
| `REACT_APP_ENV` | ✅ | `production` | **CRITICAL: Switch to 'production'** |
| `REACT_APP_RECAPTCHA_SITE_KEY` | ⚡ Optional | Same | reCAPTCHA site key |
| `REACT_APP_MERCADOPAGO_PUBLIC_KEY` | ✅ | **PROD KEY** | Production MP public key |
| `REACT_APP_MERCADOPAGO_TEST_PUBLIC_KEY` | ⚡ Dev only | Remove | Test MP public key |
| `REACT_APP_BACKEND_URL` | ✅ | **PROD URL** | Production backend URL |
| `REACT_APP_BACKEND_URL_DEV` | ⚡ Dev only | Remove | Development backend URL |

---

## 4. Environment Logic Analysis

### Backend Environment Logic

```typescript
// MercadoPago Service (mercadoPagoService.ts)
const isProduction = process.env.NODE_ENV === 'production';

const accessToken = isProduction
  ? process.env.MERCADOPAGO_ACCESS_TOKEN
  : process.env.MERCADOPAGO_TEST_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN;

const publicKey = isProduction
  ? process.env.MERCADOPAGO_PUBLIC_KEY
  : process.env.MERCADOPAGO_TEST_PUBLIC_KEY || process.env.MERCADOPAGO_PUBLIC_KEY;
```

**Logic Flow:**
- If `NODE_ENV === 'production'`: Uses production MercadoPago keys
- Otherwise: Prefers TEST keys, falls back to production keys

```typescript
// CORS Configuration (server.ts)
if (process.env.NODE_ENV === 'development') {
  return callback(null, true); // Allow all origins
}
```

**Logic Flow:**
- Development: Allows all origins
- Production: Strict CORS with FRONTEND_URL whitelist

```typescript
// Database Service (databaseService.ts)
const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';
```

**Logic Flow:**
- Controls logging verbosity based on environment

### Frontend Environment Logic

```typescript
// Config (lib/config.ts)
const isProduction = process.env.REACT_APP_ENV === 'production';

function getBackendUrl(): string {
  if (isProduction) {
    return process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
  }
  return process.env.REACT_APP_BACKEND_URL_DEV || 
         process.env.REACT_APP_BACKEND_URL || 
         'http://localhost:3001';
}

function getMercadoPagoPublicKey(): string {
  if (isProduction) {
    return process.env.REACT_APP_MERCADOPAGO_PUBLIC_KEY || '';
  }
  return process.env.REACT_APP_MERCADOPAGO_TEST_PUBLIC_KEY || 
         process.env.REACT_APP_MERCADOPAGO_PUBLIC_KEY || 
         '';
}
```

**Logic Flow:**
- Uses `REACT_APP_ENV` (not `NODE_ENV`) to determine production mode
- Development: Prefers DEV/TEST variants, falls back to main keys
- Production: Uses main keys only

---

## 5. Identified Gaps & Inconsistencies

### ⚠️ Critical Issues

#### 1. Dead Endpoint Reference
**File:** `src/services/APIService.ts` (line 179)
**Issue:** `getUserInfo()` method calls `/get-user-info/:userId` which doesn't exist in backend
**Impact:** Method will always fail if called
**Recommendation:** Remove or mark as deprecated, use the authenticated session user instead

#### 2. Missing Authentication on Sensitive Endpoints
**Endpoints:**
- `GET /get-feedback-for-interview/:callId` - No auth, could expose interview data
- `GET /payment/status/:preferenceId` - No user verification
- `POST /payment/verify/:paymentId` - No auth, could be abused

**Recommendation:** Add `verifyUserAuth` middleware to these endpoints

#### 3. Inconsistent User ID Validation
**File:** `apiRoutes.ts` vs `server.ts`
- `server.ts` uses `verifyUserAuth` middleware
- `apiRoutes.ts` uses `requireAuth` middleware
- Both do similar validation but differently

**Recommendation:** Consolidate into single auth middleware

### ⚡ Minor Issues

#### 4. Frontend/Backend Environment Variable Mismatch
- Frontend uses `REACT_APP_ENV` for production detection
- Backend uses `NODE_ENV`
- This is correct but could be confusing

#### 5. Hardcoded localhost Fallback
- Both frontend and backend fall back to `http://localhost:3001`
- In production, this could cause silent failures

**Recommendation:** Remove fallbacks or log warnings when using them

#### 6. MercadoPago Preference Auth
**File:** `MercadoPagoService.ts` (frontend)
**Issue:** `createPreference()` doesn't send `x-user-id` header
**Impact:** Backend receives request without user context in header

```typescript
// Current (missing x-user-id):
headers: {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true'
}

// Should be:
headers: {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true',
  'x-user-id': userId  // Add this
}
```

---

## 6. Production Switch Checklist

### Phase 1: Backend Preparation

- [ ] **Update NODE_ENV**
  ```bash
  # In .env
  NODE_ENV=production
  ```

- [ ] **Update MercadoPago Keys**
  ```bash
  MERCADOPAGO_ACCESS_TOKEN=<production_access_token>
  MERCADOPAGO_PUBLIC_KEY=<production_public_key>
  # Remove or comment out test keys
  # MERCADOPAGO_TEST_ACCESS_TOKEN=...
  # MERCADOPAGO_TEST_PUBLIC_KEY=...
  ```

- [ ] **Update URLs**
  ```bash
  FRONTEND_URL=https://your-production-domain.com
  WEBHOOK_BASE_URL=https://your-api-domain.com
  ```

- [ ] **Update Database**
  ```bash
  DATABASE_URL=postgresql://user:pass@production-host:5432/Vocaid_prod
  ```

- [ ] **Reduce Logging**
  ```bash
  LOG_LEVEL=warn
  ```

### Phase 2: Frontend Preparation

- [ ] **Update REACT_APP_ENV**
  ```bash
  REACT_APP_ENV=production
  ```

- [ ] **Update MercadoPago Key**
  ```bash
  REACT_APP_MERCADOPAGO_PUBLIC_KEY=<production_public_key>
  # Remove test key
  # REACT_APP_MERCADOPAGO_TEST_PUBLIC_KEY=...
  ```

- [ ] **Update Backend URL**
  ```bash
  REACT_APP_BACKEND_URL=https://your-api-domain.com
  # Remove dev URL
  # REACT_APP_BACKEND_URL_DEV=...
  ```

### Phase 3: Vercel Configuration

1. **Go to Vercel Dashboard > Project Settings > Environment Variables**
2. **Add Production Variables:**
   - `REACT_APP_ENV` = `production`
   - `REACT_APP_MERCADOPAGO_PUBLIC_KEY` = `<production key>`
   - `REACT_APP_BACKEND_URL` = `<production backend URL>`
   - `REACT_APP_RECAPTCHA_SITE_KEY` = `<site key>`

3. **Redeploy:**
   ```bash
   cd Vocaid-frontend
   npx vercel --prod
   ```

### Phase 4: External Services

- [ ] **MercadoPago Dashboard**
  1. Switch to Production Mode
  2. Update webhook URL to `WEBHOOK_BASE_URL/webhook/mercadopago`
  3. Enable IPN notifications

- [ ] **Retell Dashboard**
  1. Update Custom LLM URL to `wss://your-api-domain.com/llm-websocket/{call_id}`

---

## 7. Testing Checklist

### Pre-Production Tests

- [ ] **Health Check**
  ```bash
  curl https://your-api-domain.com/health
  ```

- [ ] **User Authentication Flow**
  1. Sign up with new account
  2. Verify user created in database
  3. Verify 1 free credit granted
  4. Sign out and sign in

- [ ] **Payment Flow**
  1. Select credit package
  2. Complete MercadoPago payment (use test cards first)
  3. Verify webhook received
  4. Verify credits added to user

- [ ] **Interview Flow**
  1. Start interview with credit
  2. Verify credit consumed
  3. Complete interview
  4. Verify feedback generated
  5. Test interview cancellation (credit restoration)

- [ ] **Dashboard Data**
  1. Verify stats display correctly
  2. Verify charts render with data
  3. Verify interview history loads

### Production Smoke Tests

After going live, verify:

- [ ] Sign up works with real email
- [ ] Real payment processes correctly
- [ ] Interview starts and records properly
- [ ] Feedback generates without errors
- [ ] All webhooks fire correctly

---

## Quick Reference: Environment Switch Commands

```bash
# Backend: Switch to production
cd Vocaid-backend
sed -i '' 's/NODE_ENV=development/NODE_ENV=production/' .env

# Frontend: Switch to production
cd Vocaid-frontend
sed -i '' 's/REACT_APP_ENV=development/REACT_APP_ENV=production/' .env

# Deploy frontend to Vercel production
cd Vocaid-frontend
npx vercel --prod

# Backend: Run in production mode
cd Vocaid-backend
NODE_ENV=production npm start
```

---

*Last Updated: $(date +%Y-%m-%d)*
*Version: 1.0.0*
