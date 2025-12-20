# Environment Variables Documentation

This document describes all environment variables required for the Voxly Backend application.

## Core Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`, `test`) |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `WEBHOOK_BASE_URL` | Yes | - | Base URL for webhooks (e.g., `https://api.voxly.com`) |

## Clerk Authentication

| Variable | Required | Description |
|----------|----------|-------------|
| `CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable API key |
| `CLERK_SECRET_KEY` | Yes | Clerk secret API key |
| `CLERK_WEBHOOK_SECRET` | Yes | Webhook signing secret for Clerk events |

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
| `EMAIL_FROM_ADDRESS` | No | Default sender email (default: `Voxly <noreply@voxly.com>`) |
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

## Phone Verification (Twilio)

| Variable | Required | Description |
|----------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | No* | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | No* | Twilio authentication token |
| `TWILIO_PHONE_NUMBER` | No* | Twilio phone number for sending SMS (e.g., `+15551234567`) |

> *Required if phone verification feature is enabled

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
DATABASE_URL=postgresql://user:password@localhost:5432/voxly
WEBHOOK_BASE_URL=https://api.voxly.com

# Clerk
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...

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
