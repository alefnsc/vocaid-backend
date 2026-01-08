# LinkedIn OAuth Flows Documentation

This document describes the two LinkedIn OAuth flows implemented in Vocaid.

## Overview

Vocaid uses LinkedIn OAuth in two separate contexts:

1. **SSO Login** - User authentication/registration
2. **Profile Import** - Onboarding profile data prefill

Each flow uses its own redirect URI to maintain clear separation and prevent state confusion.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SSO Login Flow                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Browser                  Backend                    LinkedIn                │
│  ───────                  ───────                    ────────                │
│                                                                              │
│  Click "Sign in           GET /api/auth/linkedin                             │
│  with LinkedIn"   ───────────────────────►   Generate state,                 │
│                                              store in memory                 │
│                   ◄─────────────────────     Redirect 302                    │
│                                                                              │
│                   ────────────────────────────────────►  Authorization       │
│                                                          Screen              │
│                                                                              │
│                   ◄────────────────────────────────────  Redirect with       │
│                                                          code + state        │
│                                                                              │
│                   GET /api/auth/linkedin/callback                            │
│                   ─────────────────────►  Validate state,                    │
│                                          Exchange code,                      │
│                                          Fetch userinfo,                     │
│                                          Create/update user,                 │
│                                          Create session                      │
│                   ◄─────────────────────  Set cookie,                        │
│                                          Redirect to app                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        Profile Import Flow                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Browser                  Backend                    LinkedIn                │
│  ───────                  ───────                    ────────                │
│                                                                              │
│  (Already logged in)                                                         │
│                                                                              │
│  Click "Import from       GET /api/auth/linkedin-profile                     │
│  LinkedIn"        ────────────────────►   Verify session,                    │
│                                          Generate state,                     │
│                                          Store with userId                   │
│                   ◄────────────────────   Redirect 302                       │
│                                                                              │
│                   ────────────────────────────────────►  Authorization       │
│                                                          Screen              │
│                                                                              │
│                   ◄────────────────────────────────────  Redirect with       │
│                                                          code + state        │
│                                                                              │
│                   GET /api/auth/linkedin-profile/callback                    │
│                   ─────────────────────►  Validate state,                    │
│                                          Get userId from state,              │
│                                          Exchange code,                      │
│                                          Fetch userinfo,                     │
│                                          Save LinkedInProfile,               │
│                                          Update UserConsent                  │
│                   ◄─────────────────────  Redirect to onboarding             │
│                                          with success param                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Endpoints

### SSO Login

| Endpoint | Method | Auth Required | Purpose |
|----------|--------|---------------|---------|
| `/api/auth/linkedin` | GET | No | Start LinkedIn SSO flow |
| `/api/auth/linkedin/callback` | GET | No | Handle LinkedIn SSO callback |

### Profile Import

| Endpoint | Method | Auth Required | Purpose |
|----------|--------|---------------|---------|
| `/api/auth/linkedin-profile` | GET | Yes (session) | Start profile import flow |
| `/api/auth/linkedin-profile/callback` | GET | No* | Handle import callback |

*Callback validates state token which contains userId from the initiating session.

## Environment Variables

```bash
# LinkedIn OAuth Credentials (shared between flows)
LINKEDIN_CLIENT_ID=your_client_id
LINKEDIN_CLIENT_SECRET=your_client_secret

# SSO Login Redirect URI
LINKEDIN_REDIRECT_URI=http://localhost:3001/api/auth/linkedin/callback

# Profile Import Redirect URI (separate!)
LINKEDIN_PROFILE_REDIRECT_URI=http://localhost:3001/api/auth/linkedin-profile/callback
```

## LinkedIn Developer Portal Configuration

Both redirect URIs must be registered in the LinkedIn Developer Portal:

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/)
2. Select your app
3. Navigate to **Auth** tab
4. Under **OAuth 2.0 settings**, add both redirect URLs:
   - `http://localhost:3001/api/auth/linkedin/callback` (dev SSO)
   - `http://localhost:3001/api/auth/linkedin-profile/callback` (dev import)
   - `https://api.vocaid.io/api/auth/linkedin/callback` (prod SSO)
   - `https://api.vocaid.io/api/auth/linkedin-profile/callback` (prod import)

5. Under **Products** tab, ensure **Sign In with LinkedIn using OpenID Connect** is enabled

## OAuth Scopes

Both flows use the same OIDC scopes:

```
openid profile email
```

These scopes provide access to:
- `sub` - LinkedIn member ID
- `name` - Full name
- `given_name` - First name
- `family_name` - Last name
- `email` - Email address
- `email_verified` - Email verification status
- `picture` - Profile picture URL

## State Management

### SSO Login State

State is encoded as base64url JSON containing `returnTo`:

```typescript
const state = Buffer.from(JSON.stringify({ returnTo })).toString('base64url');
```

State is **not** stored server-side for SSO (stateless for simplicity).

### Profile Import State

State is a random hex string stored server-side with TTL:

```typescript
interface LinkedInImportState {
  userId: string;      // User who initiated the import
  returnTo: string;    // Path to redirect after import
  expiresAt: number;   // Expiration timestamp (10 min TTL)
}

const linkedinImportStates = new Map<string, LinkedInImportState>();
```

**Note**: In production, use Redis or database for state storage to support multi-instance deployments.

## Persistence

### SSO Login

Creates or updates:
- `User` - User account
- `LinkedInProfile` - LinkedIn linkage with `source: 'oauth'`

### Profile Import

Creates or updates:
- `LinkedInProfile` - Profile data with `source: 'import'`
- `UserConsent.linkedinConnectedAt` - Connection timestamp
- `UserConsent.linkedinMemberId` - LinkedIn member ID
- `User` - Optionally updates firstName, lastName, imageUrl if empty

## Error Handling

### SSO Login Errors

| Error Code | Meaning | User Message |
|------------|---------|--------------|
| `linkedin_oauth_denied` | User denied or cancelled | "LinkedIn sign-in was cancelled" |
| `missing_code` | No auth code in callback | "Invalid response from LinkedIn" |
| `oauth_not_configured` | Server not configured | "LinkedIn sign-in unavailable" |
| `token_exchange_failed` | Token exchange failed | "Failed to connect to LinkedIn" |
| `userinfo_failed` | Could not fetch profile | "Failed to retrieve profile" |
| `no_email` | No email in response | "Email required for sign-in" |
| `callback_failed` | Generic error | "Something went wrong" |

### Profile Import Errors

Same error codes, but redirects to `/onboarding?import=linkedin&error=<code>`.

## Frontend Integration

### SSO Login Button

```tsx
<a href={`${API_BASE}/api/auth/linkedin`}>
  Sign in with LinkedIn
</a>
```

### Profile Import Button

```tsx
import apiService from 'services/APIService';

// In component:
<button onClick={() => apiService.startLinkedInProfileImport('/onboarding')}>
  Import from LinkedIn
</button>
```

### Handling Import Results

```tsx
import { useSearchParams } from 'react-router-dom';

function OnboardingPage() {
  const [searchParams] = useSearchParams();
  
  const importSuccess = searchParams.get('import') === 'linkedin' && 
                       searchParams.get('success') === '1';
  const importError = searchParams.get('import') === 'linkedin' 
                     ? searchParams.get('error') 
                     : null;
  
  if (importSuccess) {
    // Refresh profile data, show success message
  }
  
  if (importError) {
    // Show error message based on error code
  }
}
```

## Onboarding Status API

To check if user needs onboarding:

```typescript
const status = await apiService.getOnboardingStatus();

// status = {
//   onboardingComplete: boolean,
//   hasResume: boolean,
//   hasLinkedInProfile: boolean,
//   isLinkedInConnected: boolean,
//   hasCompleteName: boolean,
//   phoneVerified: boolean,
//   linkedInProfile: { name, email, pictureUrl, source, connectedAt } | null
// }
```

## Testing Checklist

### SSO Login

- [ ] Click "Sign in with LinkedIn" → redirects to LinkedIn
- [ ] Authorize app → redirects back to app
- [ ] Session cookie is set
- [ ] User is logged in
- [ ] LinkedIn profile linked in database
- [ ] Cancel on LinkedIn → shows appropriate error

### Profile Import

- [ ] Must be logged in to access `/api/auth/linkedin-profile`
- [ ] Click "Import from LinkedIn" → redirects to LinkedIn
- [ ] Authorize app → redirects to `/onboarding?import=linkedin&success=1`
- [ ] LinkedInProfile created/updated with `source: 'import'`
- [ ] UserConsent updated with connection info
- [ ] Cancel on LinkedIn → redirects with `error=cancelled`
- [ ] Expired state → redirects with `error=invalid_state`

### Cookie/Session

- [ ] Session cookie persists across OAuth redirect (check SameSite/Secure)
- [ ] Works behind proxy (trust proxy enabled)
- [ ] Works with HTTPS in production
