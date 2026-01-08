# Email System Refactoring - Migration Guide

## Overview

The email system has been refactored to follow a clean 3-layer architecture that strictly uses Resend dashboard templates. This document describes the new architecture and migration path.

## Template Strategy (REQUIRED)

There are **exactly 3 template categories** configured in Resend Dashboard:

| Template Alias | Usage | Variables |
|----------------|-------|-----------|
| `welcome_b2c` | Welcome emails for new users | `free_credits`, `CANDIDATE_FIRST_NAME`, `DASHBOARD_URL`, `CURRENT_YEAR`, `PRIVACY_URL`, `TERMS_URL` |
| `feedback` | Interview feedback with PDF attachment | See full list below |
| `transactional` | All other emails (receipts, password reset, etc.) | `content` (HTML block) + optional `preheader`, `subject`, `header`, etc. |

### Feedback Template Variables (alias: `feedback`)

**Required:**
- `CANDIDATE_FIRST_NAME`
- `ROLE_TITLE`
- `DASHBOARD_URL`
- `CURRENT_YEAR`
- `PRIVACY_URL`
- `TERMS_URL`

**Optional:**
- `TARGET_COMPANY`, `INTERVIEW_LANGUAGE`, `OVERALL_SCORE`, `DURATION_MIN`, `INTERVIEW_DATE`, `TOPICS_COVERED`
- `STRENGTH_1`, `STRENGTH_1_TS`, `STRENGTH_2`, `STRENGTH_2_TS`, `STRENGTH_3`, `STRENGTH_3_TS`
- `IMPROVEMENT_1`, `IMPROVEMENT_2`, `IMPROVEMENT_3`
- `RUBRIC_1_NAME`, `RUBRIC_1_SCORE`, `RUBRIC_1_PCT`, `RUBRIC_1_EVIDENCE_TS`, `RUBRIC_1_EVIDENCE_NOTE`
- (same pattern for RUBRIC_2, RUBRIC_3)
- `FEEDBACK_URL`, `SENIORITY`

## Architecture

The new email system is organized into 4 layers:

```
src/services/email/
├── index.ts              # Module exports
├── emailPolicy.ts        # Consent & security rules
├── templateManifest.ts   # Variable validation
├── emailComposer.ts      # Pure composition functions
└── emailSender.ts        # Unified send with logging
```

### 1. Policy Layer (`emailPolicy.ts`)

Single source of truth for:
- Which emails are "security" (always send): `PASSWORD_RESET`, `EMAIL_VERIFICATION`
- Which emails are "must-send" (ignore marketing consent): `CREDITS_PURCHASE_RECEIPT`
- Consent checking via `canSendEmail(userId, emailType)`

### 2. Template Manifest (`templateManifest.ts`)

- Defines required/optional variables for each template alias
- `validateTemplateVariables()` - returns validation result
- `assertValidTemplateVariables()` - throws on failure
- Prevents blank/broken emails by failing fast

### 3. Composer Layer (`emailComposer.ts`)

Pure functions that build email payloads without side effects:

```typescript
composeWelcomeEmail(data)     -> ComposedEmail (uses welcome_b2c)
composeFeedbackEmail(data)    -> ComposedEmail (uses feedback)
composeTransactionalEmail(data) -> ComposedEmail (uses transactional)
composePurchaseReceiptEmail(data) -> ComposedEmail
composeLowCreditsEmail(data)  -> ComposedEmail
composePasswordResetEmail(data) -> ComposedEmail
composeEmailVerificationEmail(data) -> ComposedEmail
```

### 4. Sender Layer (`emailSender.ts`)

Unified send function with:
- Provider mode enforcement (`live`/`mock`/`disabled`)
- Template variable validation
- Idempotency checking
- Prisma `TransactionalEmail` audit logging
- Structured logging (template ID, variable keys, result)

```typescript
sendEmail(composedEmail) -> SendEmailResult
```

## Migration from Old Service

### Option A: Use New Service Directly

Replace imports:
```typescript
// OLD
import { sendWelcomeEmail } from './transactionalEmailService';

// NEW
import { sendWelcomeEmail } from './transactionalEmailServiceNew';
```

### Option B: Rename and Replace

1. Rename old service: `transactionalEmailService.ts` → `transactionalEmailService.legacy.ts`
2. Rename new service: `transactionalEmailServiceNew.ts` → `transactionalEmailService.ts`
3. Update any remaining imports

### Breaking Changes

1. **Welcome Email**: Now uses Resend `welcome_b2c` template instead of local HTML
   - Old: `sendWelcomeEmail(user)` - sent bespoke HTML
   - New: `sendWelcomeEmail(user, freeCredits?)` - uses Resend template

2. **Template Variables**: Must match Resend dashboard template variable names exactly

3. **Consent Policy**: Now centralized in `emailPolicy.ts`
   - Security emails (password reset, email verification) always send
   - Purchase receipts always send (legally required)
   - Other emails respect `transactionalOptIn` consent

## Environment Variables

```bash
# Required for live mode
RESEND_API_KEY=re_xxxxxxxxxx

# Provider mode (default: live)
EMAIL_PROVIDER_MODE=live|mock|disabled

# Frontend URL for email links
FRONTEND_URL=https://vocaid.ai

# Support email shown in emails
SUPPORT_EMAIL=support@vocaid.ai
```

## Resend Dashboard Setup

1. Go to [Resend Dashboard](https://resend.com/dashboard)
2. Create 3 templates with these **exact** aliases:
   - `welcome_b2c`
   - `feedback`
   - `transactional`
3. Configure variables using `{{{VARIABLE_NAME}}}` syntax (triple-stash for HTML)
4. Verify sender domains are configured correctly

## Testing

### Mock Mode

Set `EMAIL_PROVIDER_MODE=mock` to skip actual sends while still:
- Validating template variables
- Writing audit records to `TransactionalEmail` table
- Logging all operations

### Validation

The template manifest prevents sending if required variables are missing:

```typescript
import { validateTemplateVariables } from './email';

const result = validateTemplateVariables('welcome_b2c', {
  free_credits: '1',
  CANDIDATE_FIRST_NAME: 'John',
  // Missing DASHBOARD_URL, CURRENT_YEAR, etc.
});

console.log(result.valid); // false
console.log(result.missingRequired); // ['DASHBOARD_URL', 'CURRENT_YEAR', ...]
```

## Rollback Plan

If issues occur after migration:

1. Revert to the old service by renaming files back
2. The old `transactionalEmailService.ts` contains local HTML templates that don't require Resend dashboard templates
3. Both services write to the same `TransactionalEmail` table for audit

## File Changes Summary

| File | Action |
|------|--------|
| `src/services/email/index.ts` | NEW - Module exports |
| `src/services/email/emailPolicy.ts` | NEW - Consent rules |
| `src/services/email/templateManifest.ts` | NEW - Variable validation |
| `src/services/email/emailComposer.ts` | NEW - Pure composition |
| `src/services/email/emailSender.ts` | NEW - Unified send |
| `src/services/transactionalEmailServiceNew.ts` | NEW - Backward-compatible wrapper |
| `src/services/transactionalEmailService.ts` | KEEP - Legacy service (can be replaced) |
