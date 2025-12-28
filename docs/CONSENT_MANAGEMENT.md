# Consent Management System

## Overview

This document describes the implementation of a mandatory consent capture flow for new users (both custom form sign-up and Clerk OAuth). The system ensures compliance with legal requirements by capturing user acceptance of Terms of Use, Privacy Policy, and communication preferences before allowing access to the application.

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     USER AUTHENTICATION                          │
├─────────────────────────────────────────────────────────────────┤
│  Form Sign-up OR OAuth (Google/Apple/Microsoft)                 │
│       ↓                                                          │
│  Clerk Session Created                                          │
│       ↓                                                          │
│  Frontend: ConsentGuard checks /api/consent/status              │
│       ↓                                                          │
│  If no consent → Redirect to /onboarding/consent                │
│       ↓                                                          │
│  User accepts Terms + Privacy + Marketing choice                │
│       ↓                                                          │
│  POST /api/consent/submit                                       │
│       ↓                                                          │
│  Backend: Create UserConsent record                             │
│  Backend: Set User.onboardingCompletedAt                        │
│  Backend: Sync to Clerk publicMetadata                          │
│       ↓                                                          │
│  ✅ User can access protected routes                            │
└─────────────────────────────────────────────────────────────────┘
```

## Deliverables

### 1. Database (Prisma)

**New Model: `UserConsent`**
- Location: `prisma/schema.prisma`
- Table: `user_consents`
- Fields:
  - `termsAcceptedAt`, `privacyAcceptedAt` - Required consent timestamps
  - `termsVersion`, `privacyVersion` - Version tracking for re-consent
  - `transactionalOptIn` (default: true) - Essential emails
  - `marketingOptIn` (default: false) - Optional marketing
  - `ipAddress`, `userAgent` - Audit metadata
  - `source` - FORM or OAUTH enum

**Updated Model: `User`**
- Added: `onboardingCompletedAt` (DateTime, nullable)
- Added: `userConsent` relation

**Migration:**
- File: `prisma/migrations/20251223_add_user_consent/migration.sql`

### 2. Backend APIs

**Consent Routes** (`src/routes/consentRoutes.ts`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/consent/requirements` | GET | No | Returns current version requirements and URLs |
| `/api/consent/status` | GET | Yes | Returns user's consent status |
| `/api/consent/submit` | POST | Yes | Submits user consent |
| `/api/consent/marketing` | PATCH | Yes | Updates marketing preference only |

**Consent Service** (`src/services/consentService.ts`)
- `getConsentStatus(userId)` - Check user's consent state
- `submitConsent(params)` - Record consent with audit data
- `hasRequiredConsents(clerkId)` - Boolean check for middleware
- `canSendTransactional(userId)` - Email gating check
- `canSendMarketing(userId)` - Email gating check
- `getConsentByEmail(email)` - Lookup consent by email

**Consent Middleware** (`src/middleware/consentMiddleware.ts`)
- `requireConsent` - Global middleware to gate protected endpoints
- Returns `403 CONSENT_REQUIRED` if user hasn't completed consent
- Allowlist includes: `/api/users/validate`, `/api/consent/*`, `/api/leads`, health checks

**Version Constants** (`src/constants/consentVersions.ts`)
- `TERMS_VERSION = '2025-12-23'`
- `PRIVACY_VERSION = '2025-12-23'`
- `MARKETING_CONSENT_VERSION = '2025-12-23'`

### 3. Frontend

**Consent Page** (`src/pages/onboarding/ConsentPage.tsx`)
- 2-step micro-onboarding:
  - Step 1: Terms + Privacy acceptance (required)
  - Step 2: Communication preferences (marketing opt-in)
- Mobile-first design (full-width buttons, sticky CTA)
- Vocaid palette (white/black/zinc + purple-600)
- No icons

**Consent Guard** (`src/components/auth/ConsentGuard.tsx`)
- HOC that wraps protected routes
- Checks consent status on mount
- Redirects to `/onboarding/consent` if needed
- Caches consent status in sessionStorage (5 min TTL)
- Exports `useConsentStatus()` hook for manual checks

**API Service Updates** (`src/services/APIService.ts`)
- Added: `getConsentRequirements()`
- Added: `getConsentStatus(userId)`
- Added: `submitConsent(userId, params)`
- Added: `updateMarketingPreference(userId, marketingOptIn)`

**App.tsx Updates**
- Added: `/onboarding/consent` route
- Wrapped all protected routes with `<ConsentGuard>`
- Protected: `/app/*`, `/interview*`, `/account`, etc.
- Unprotected: `/`, `/about`, `/privacy-policy`, `/terms-of-use`, `/payment/*`

### 4. Email Gating

**transactionalEmailService.ts**
- `sendWelcomeEmail` - Checks `canSendTransactional()` before sending
- `sendPurchaseReceiptEmail` - Checks `canSendTransactional()` before sending

**emailService.ts**
- `sendFeedbackEmail` - Checks `getConsentByEmail()` before sending

### 5. Clerk Metadata Sync

When consent is submitted:
1. DB `User.onboardingCompletedAt` is set
2. DB `UserConsent` record is created
3. Clerk `publicMetadata` is updated with:
   - `onboardingComplete: true`
   - `termsVersionAccepted: "2025-12-23"`
   - `privacyVersionAccepted: "2025-12-23"`
   - `consentRecordedAt: ISO timestamp`

## Updating Legal Documents

When Terms or Privacy documents change:

1. Update version constant in `src/constants/consentVersions.ts`:
   ```typescript
   export const TERMS_VERSION = '2026-01-15'; // New version
   ```

2. Users with older versions will:
   - Have `needsReConsent: true` in their status
   - Be redirected to consent page on next protected route visit
   - Must re-accept to continue using the app

## Testing Checklist

### Manual Tests

1. **Form sign-up → first login**
   - [ ] Redirected to consent page
   - [ ] Cannot access dashboard until accepted

2. **OAuth sign-up (Google/Apple/Microsoft)**
   - [ ] Redirected to consent page after OAuth callback
   - [ ] Cannot access dashboard until accepted

3. **Decline required checkboxes**
   - [ ] Continue button disabled
   - [ ] Validation message shown

4. **Accept required only (no marketing)**
   - [ ] Can use product
   - [ ] `marketingOptIn: false` in DB

5. **Opt-in to marketing**
   - [ ] `marketingOptIn: true` in DB
   - [ ] `marketingOptInAt` timestamp set

6. **Protected API endpoints**
   - [ ] Return `403 CONSENT_REQUIRED` without consent
   - [ ] Return normal response with consent

7. **Email sending**
   - [ ] Welcome email respects transactional consent
   - [ ] Purchase receipt respects transactional consent
   - [ ] Marketing emails only sent if opted in

### API Tests

```bash
# Get requirements (no auth)
curl http://localhost:3001/api/consent/requirements

# Get status (with auth header)
curl -H "x-user-id: user_xxx" http://localhost:3001/api/consent/status

# Submit consent
curl -X POST http://localhost:3001/api/consent/submit \
  -H "x-user-id: user_xxx" \
  -H "Content-Type: application/json" \
  -d '{"acceptTerms": true, "acceptPrivacy": true, "marketingOptIn": false}'
```

## Security Considerations

1. **Audit Trail**: All consent events include IP address, user agent, timestamps, and version numbers
2. **Idempotency**: Consent can be submitted multiple times safely (upsert logic)
3. **Backend Enforcement**: Middleware blocks API access, not just frontend
4. **Fail-Safe**: Transactional emails fail open (essential for account security)
5. **Marketing Fail-Closed**: Marketing emails require explicit opt-in

## Files Modified/Created

### Created
- `prisma/migrations/20251223_add_user_consent/migration.sql`
- `src/constants/consentVersions.ts`
- `src/middleware/consentMiddleware.ts`
- `src/routes/consentRoutes.ts`
- `src/services/consentService.ts`
- `src/pages/onboarding/ConsentPage.tsx`
- `src/components/auth/ConsentGuard.tsx`

### Modified
- `prisma/schema.prisma` - Added UserConsent model and ConsentSource enum
- `src/server.ts` - Added consent routes and middleware
- `src/services/clerkService.ts` - Added updateUserPublicMetadata function
- `src/services/transactionalEmailService.ts` - Added consent checks
- `src/services/emailService.ts` - Added consent checks
- `src/services/APIService.ts` - Added consent API methods
- `src/App.tsx` - Added consent route and wrapped protected routes
