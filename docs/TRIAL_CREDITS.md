# Trial Credits System

This document describes the free trial credits system for B2C users, including the Open Beta promotional period and abuse prevention measures.

## Overview

New **personal (B2C) users** receive free trial credits upon email verification. The number of credits depends on whether the user signs up during the Open Beta promotional period.

### Credit Amounts

| Period | Credits Granted | Dates |
|--------|-----------------|-------|
| **Open Beta Promo** | 5 credits | Dec 28, 2025 → Jan 14, 2026 (inclusive) |
| **Post-Promo** | 1 credit | Jan 15, 2026 onwards |

## Eligibility Rules

Trial credits are granted only when **all** of the following conditions are met:

1. **User Type**: Must be `PERSONAL` (B2C users only)
   - B2B accounts (`COMPANY_ADMIN`, `HR_MANAGER`, `RECRUITER`, etc.) do **not** receive trial credits
   - B2B customers should purchase credits or use enterprise billing

2. **Email Verified**: Email address must be verified via Clerk
   - This is enforced by Clerk's email verification flow
   - Users cannot receive credits until email is confirmed

3. **Not Already Granted**: User must not have previously received trial credits
   - Checked via `CreditLedger` entries with `referenceType = 'signup'`
   - Idempotency key format: `trial_signup_${userId}`

4. **Abuse Checks Pass**: User must pass abuse prevention checks
   - Device fingerprint not reused (max 1 account per fingerprint)
   - IP address not exceeding limits (max 2 accounts per IP)
   - Not using a disposable email domain
   - No high-velocity subnet activity

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `src/services/trialPolicyService.ts` | **Central policy module** - all trial credit logic |
| `src/services/clerkService.ts` | Webhook handler that calls trial policy |
| `src/services/signupAbuseService.ts` | Basic IP/fingerprint abuse detection |
| `src/services/enhancedAbuseService.ts` | Advanced abuse detection (disposable email, subnet velocity) |
| `src/services/creditsWalletService.ts` | Atomic credit operations with ledger |
| `src/routes/creditsRoutes.ts` | API endpoints including `/trial-status` |

### Frontend Files

| File | Purpose |
|------|---------|
| `src/config/openBeta.ts` | Promo period configuration and helpers |
| `src/config/credits.ts` | Credit display constants |
| `src/hooks/use-trial-status/` | Hook for fetching trial status |
| `src/services/APIService.ts` | API client methods |

## API Endpoints

### GET /api/credits/trial-status (Authenticated)

Returns the user's trial credit status.

**Response:**
```json
{
  "status": "success",
  "data": {
    "trialCreditsGranted": true,
    "trialCreditsAmount": 5,
    "trialCreditsGrantedAt": "2025-12-29T10:30:00.000Z",
    "isPromoActive": true,
    "promoEndsAt": "2026-01-15T00:00:00.000Z",
    "promoRemainingDays": 14,
    "currentBalance": 4,
    "riskLevel": "low"
  }
}
```

### GET /api/credits/promo-info (Public)

Returns current promo period information.

**Response:**
```json
{
  "status": "success",
  "data": {
    "isPromoActive": true,
    "promoEndsAt": "2026-01-15T00:00:00.000Z",
    "promoRemainingDays": 14,
    "promoCredits": 5,
    "standardCredits": 1
  }
}
```

## Idempotency

The trial credit granting system is **fully idempotent**:

1. **Idempotency Key**: Each grant uses key format `trial_signup_${userId}`
2. **Row-Level Locking**: Prisma transactions prevent race conditions
3. **Ledger Check**: Before granting, checks if entry with idempotency key exists
4. **Clerk Metadata**: `freeTrialUsed` flag prevents re-processing

If `handleUserCreated` is called multiple times for the same user (e.g., webhook retry), only the first call will grant credits.

## Abuse Prevention

### Layer 1: Device Fingerprint
- Frontend captures canvas + audio fingerprint
- Sent with signup request
- Limited to 1 account per unique fingerprint

### Layer 2: IP Address
- Captures user's IP from request headers
- Limited to 2 accounts per IP address
- Uses `SignupRecord` table for tracking

### Layer 3: Subnet Velocity
- Tracks `/24` subnet activity
- Blocks if >3 signups from same subnet in 1 hour
- Uses `SubnetTracker` table

### Layer 4: Disposable Email
- Checks email domain against known disposable providers
- ~100+ domains in default blocklist
- Additional domains in `DisposableEmailDomain` table

### Risk Levels

| Level | Risk Score | Result |
|-------|------------|--------|
| Low | 0-19 | Full credits granted |
| Medium | 20-49 | Credits granted, flagged for review |
| High | 50-79 | Throttled credits, requires verification |
| Blocked | 80+ | No credits, account flagged |

## Database Models

### CreditLedger (Immutable Audit Trail)

```prisma
model CreditLedger {
  id            String   @id @default(uuid())
  userId        String
  type          CreditTransactionType  // GRANT, PURCHASE, SPEND, etc.
  amount        Int
  balanceAfter  Int
  description   String
  referenceType String?  // 'signup' for trial grants
  referenceId   String?  // clerkId for trial grants
  metadata      Json?    // { isPromoActive, promoEndsAt, riskLevel }
  idempotencyKey String? @unique
  createdAt     DateTime @default(now())
}
```

### SignupRecord (Abuse Tracking)

```prisma
model SignupRecord {
  id                String   @id @default(uuid())
  userId            String   @unique
  ipAddress         String?
  deviceFingerprint String?
  emailDomain       String?
  freeCreditGranted Boolean  @default(false)
  creditTier        String   @default("full")  // full, throttled, blocked
  isSuspicious      Boolean  @default(false)
  suspicionReason   String?
  createdAt         DateTime @default(now())
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROMO_TRIAL_CREDITS` | `5` | Credits during promo period |
| `DEFAULT_TRIAL_CREDITS` | `1` | Credits after promo period |
| `MAX_ACCOUNTS_PER_IP` | `2` | IP limit for abuse detection |
| `MAX_ACCOUNTS_PER_FINGERPRINT` | `1` | Device fingerprint limit |
| `MAX_SIGNUPS_PER_SUBNET_HOUR` | `3` | Subnet velocity limit |

### Promo Dates (Hardcoded)

```typescript
// Backend: src/services/trialPolicyService.ts
export const PROMO_START_DATE = new Date('2025-12-28T00:00:00Z');
export const PROMO_END_DATE = new Date('2026-01-15T00:00:00Z');

// Frontend: src/config/openBeta.ts
export const PROMO_END_DATE = new Date('2026-01-15T00:00:00Z');
```

**Important**: Both frontend and backend must use the same cutoff date. The promo is **exclusive** of the end date (i.e., signups at exactly midnight UTC on Jan 15 get 1 credit, not 5).

## Testing

Run trial policy tests:

```bash
cd voxly-backend
npm test -- --testPathPattern=trialPolicyService
```

Test coverage includes:
- Promo period boundary conditions
- Credit amount calculations
- Timezone handling (UTC)
- Idempotency verification
- Abuse blocking scenarios

## Monitoring

### Key Metrics to Track

1. **Trial Grants per Day** - Track spike patterns
2. **Blocked Grants** - Monitor abuse attempts
3. **Promo vs Standard Grants** - Verify cutoff working
4. **Risk Level Distribution** - Catch abuse patterns early

### Logs to Monitor

```
[trialPolicyService] Trial credits granted successfully
[trialPolicyService] Trial blocked: abuse detected
[trialPolicyService] Trial grant already processed (idempotency hit)
[clerkService] Trial blocked by policy
```

## Troubleshooting

### User didn't receive trial credits

1. Check `SignupRecord` for `isSuspicious = true`
2. Check `CreditLedger` for existing signup grant
3. Verify user type is `PERSONAL`
4. Check Clerk metadata for `freeTrialUsed`

### Credits granted twice

This should not happen due to idempotency, but if it does:
1. Check `CreditLedger` for duplicate entries
2. Verify idempotency key was correctly generated
3. Check for database transaction issues

### Promo not working after cutoff

1. Verify server time is correct (use UTC)
2. Check `PROMO_END_DATE` constant
3. Run date comparison tests manually
