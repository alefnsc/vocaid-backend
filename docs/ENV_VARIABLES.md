# Environment Variables Documentation

This document describes all environment variables required for the Vocaid Backend application.

## Core Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`, `test`) |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `WEBHOOK_BASE_URL` | Yes | - | Base URL for webhooks (e.g., `https://api.vocaid.io`) |
| `FRONTEND_URL` | No | `http://localhost:3000` / `https://vocaid.io` | Frontend URL for redirects and email links |

## First-Party Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_SECRET` | Yes | - | Secret key for signing session cookies (min 32 chars) |
| `SESSION_COOKIE_NAME` | No | `vocaid_session` | Name of the session cookie |
| `SESSION_TTL_DAYS` | No | `30` | Session time-to-live in days |

## Google OAuth

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | Yes* | - | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Yes* | - | Google OAuth 2.0 Client Secret |
| `GOOGLE_REDIRECT_URI` | No | Auto | OAuth callback URL (defaults to `{BACKEND_URL}/api/auth/google/callback`) |

> *Required if Google SSO login is enabled

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth 2.0 Client ID**
5. Select **Web application** as the application type
6. Add authorized redirect URIs:
   - Development: `http://localhost:3001/api/auth/google/callback`
   - Production: `https://api.vocaid.io/api/auth/google/callback`
7. Copy the Client ID and Client Secret to your `.env` file

## LinkedIn OAuth

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINKEDIN_CLIENT_ID` | Yes* | - | LinkedIn OAuth 2.0 Client ID |
| `LINKEDIN_CLIENT_SECRET` | Yes* | - | LinkedIn OAuth 2.0 Client Secret |
| `LINKEDIN_REDIRECT_URI` | No | Auto | OAuth callback URL (defaults to `{BACKEND_URL}/api/auth/linkedin/callback`) |

> *Required if LinkedIn SSO login is enabled

### LinkedIn OAuth Setup

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/)
2. Create a new app or select an existing one
3. Navigate to **Auth** tab
4. Under **OAuth 2.0 settings**, add authorized redirect URLs:
   - Development: `http://localhost:3001/api/auth/linkedin/callback`
   - Production: `https://api.vocaid.io/api/auth/linkedin/callback`
5. Request the following products under **Products** tab:
   - **Sign In with LinkedIn using OpenID Connect**
6. Copy the Client ID and Client Secret to your `.env` file

## Retell AI (Voice Interview)

| Variable | Required | Description |
|----------|----------|-------------|
| `RETELL_API_KEY` | Yes | Retell API key for voice calls |
| `RETELL_AGENT_ID` | Yes | Default Retell agent ID for interviews |

## OpenAI (GPT-4)

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4 (resume scoring, feedback) |

## Anthropic (Claude)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No | Anthropic API key for study recommendations |

## Email Service (Resend)

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | Resend API key for sending emails |
| `EMAIL_PROVIDER_MODE` | No | Email provider mode: `mock` (log only, no send) or `resend` (send via Resend). If not set, defaults to `resend` when RESEND_API_KEY is present, otherwise `mock`. Useful for local development and testing. |
| `EMAIL_FROM_ADDRESS` | No | Default sender email (default: `Vocaid <noreply@Vocaid.com>`) |
| `EMAIL_REPLY_TO` | No | Reply-to email address |

## Payment Services

### Mercado Pago

| Variable | Required | Description |
|----------|----------|-------------|
| `MERCADOPAGO_ACCESS_TOKEN` | Yes* | Mercado Pago API access token |
| `MERCADOPAGO_PUBLIC_KEY` | No | Mercado Pago public key for frontend |
| `MERCADOPAGO_WEBHOOK_SECRET` | Yes* | Webhook signing secret |

### Stripe (Alternative)

| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_SECRET_KEY` | No | Stripe secret API key |
| `STRIPE_PUBLISHABLE_KEY` | No | Stripe publishable key for frontend |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |

> *Required if using Mercado Pago as payment provider

## Phone Verification (Twilio Verify)

Uses Twilio Verify API with API Key authentication (recommended approach).

| Variable | Required | Description |
|----------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes* | Twilio account SID (starts with `AC`) |
| `TWILIO_API_SID` | Yes* | Twilio API Key SID (starts with `SK`) |
| `TWILIO_API_SECRET` | Yes* | Twilio API Key Secret |
| `TWILIO_VERIFY_SERVICE_SID` | Yes* | Twilio Verify Service SID (starts with `VA`) |
| `PHONE_VERIFICATION_CREDITS` | No | Credits granted on phone verification (default: `15`) |

> *Required if phone verification feature is enabled

### Setup Instructions

1. Go to [Twilio Console](https://console.twilio.com/)
2. Create a Verify Service under **Verify > Services**
3. Create an API Key under **Account > API keys & tokens > Create API Key**
4. Use the Standard Key type for server-side authentication

### Deprecated Variables (Auth Token method)

| Variable | Status | Description |
|----------|--------|-------------|
| `TWILIO_AUTH_TOKEN` | Deprecated | Twilio authentication token (use API Key instead) |
| `TWILIO_PHONE_NUMBER` | Deprecated | Not needed for Verify API |
| `TWILIO_MESSAGING_SERVICE_SID` | Deprecated | Not needed for Verify API |

## Security & Fraud Prevention

| Variable | Required | Description |
|----------|----------|-------------|
| `FINGERPRINT_API_KEY` | No | FingerprintJS Pro API key (optional for enhanced device detection) |
| `ADMIN_SECRET_KEY` | No | Secret key for admin-only operations (device blocking, etc.) |

## Feature Flags

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENABLE_PHONE_VERIFICATION` | No | `false` | Enable SMS phone verification |
| `ENABLE_DEVICE_FINGERPRINTING` | No | `true` | Enable device fingerprint tracking |
| `ENABLE_PREAUTH` | No | `false` | Enable card pre-authorization |
| `ENABLE_AUTOMATED_EMAILS` | No | `true` | Enable automated feedback emails |
| `ENABLE_RESUME_REPOSITORY` | No | `true` | Enable resume library feature |
| `BETA_FEEDBACK_ENABLED` | No | `true` | Enable closed beta feedback endpoint. Set to `false` to disable after beta. |

## Beta Feedback (Closed Beta)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BETA_FEEDBACK_ENABLED` | No | `true` | Feature flag for beta feedback route |
| `FORMSPREE_BETA_FEEDBACK_URL` | No | - | Formspree endpoint for beta feedback. If not set, feedback is logged but not emailed. |

## Logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `LOG_FORMAT` | No | `json` | Log format (`json`, `pretty`) |

## Rate Limiting

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | No | `100` | Max requests per window |

---

## Example `.env` File

```env
# Core
PORT=3001
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/Vocaid
WEBHOOK_BASE_URL=https://api.Vocaid.com

# Retell
RETELL_API_KEY=key_...
RETELL_AGENT_ID=agent_...

# OpenAI
OPENAI_API_KEY=sk-...

# Anthropic (optional)
ANTHROPIC_API_KEY=sk-ant-...

# Resend
RESEND_API_KEY=re_...

# Mercado Pago
MERCADOPAGO_ACCESS_TOKEN=APP_USR-...
MERCADOPAGO_WEBHOOK_SECRET=...

# Twilio (optional)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+15551234567

# Feature Flags
ENABLE_PHONE_VERIFICATION=false
ENABLE_DEVICE_FINGERPRINTING=true
ENABLE_PREAUTH=false
ENABLE_AUTOMATED_EMAILS=true
ENABLE_RESUME_REPOSITORY=true

# Logging
LOG_LEVEL=info
```

---

## Usage Quota Tiers

The usage quota system supports the following tiers (configured in code):

| Tier | Monthly Interview Minutes | Monthly API Tokens | Monthly Uploads | Daily Interviews |
|------|---------------------------|-------------------|-----------------|------------------|
| FREE | 30 | 10,000 | 5 | 2 |
| BASIC | 120 | 50,000 | 20 | 5 |
| PROFESSIONAL | 300 | 200,000 | 50 | 10 |
| ENTERPRISE | Unlimited | Unlimited | Unlimited | Unlimited |

---

## Notes

1. **Database Migrations**: After adding new env vars, run `npx prisma migrate dev` to apply any schema changes.

2. **Secrets Management**: In production, use a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.) instead of `.env` files.

3. **Local Development**: Copy `.env.example` to `.env` and fill in the values.

4. **Testing**: Create a `.env.test` file with test-specific values (test API keys, test database).
