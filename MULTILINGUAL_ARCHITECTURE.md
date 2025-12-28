# Multilingual Voice-Agent Platform Architecture

This document describes the implementation of a scalable multilingual voice-agent platform using Retell AI, Clerk for user management, and a dynamic Payment Provider strategy (PayPal/Mercado Pago).

## Table of Contents

1. [Overview](#overview)
2. [Database/Metadata Schema](#databasemetadata-schema)
3. [Backend Architecture](#backend-architecture)
4. [Payment Strategy Pattern](#payment-strategy-pattern)
5. [Retell Agent System Prompts](#retell-agent-system-prompts)
6. [Frontend i18n Configuration](#frontend-i18n-configuration)
7. [API Reference](#api-reference)
8. [Environment Configuration](#environment-configuration)

---

## Overview

### Supported Languages
- **Portuguese (Brazil)** - `pt-BR`
- **English (US/UK)** - `en-US`, `en-GB`
- **Spanish (Spain/Mexico/Argentina)** - `es-ES`, `es-MX`, `es-AR`
- **French** - `fr-FR`
- **Russian** - `ru-RU`
- **Chinese (Simplified/Traditional)** - `zh-CN`, `zh-TW`
- **Hindi** - `hi-IN`

### Payment Routing
- **LATAM Region** → Mercado Pago (Pix, local cards, Boleto)
- **Rest of World** → PayPal (global coverage)

---

## Database/Metadata Schema

### Clerk Public Metadata
```typescript
interface ClerkPublicMetadata {
  credits: number;                    // User's interview credits
  preferredLanguage: SupportedLanguageCode;  // e.g., 'pt-BR'
  detectedRegion: RegionCode;         // 'LATAM' | 'NORTH_AMERICA' | 'EUROPE' | 'ASIA_PACIFIC' | 'GLOBAL'
  detectedCountry: string;            // ISO 2-letter code, e.g., 'BR'
  timezone?: string;                  // e.g., 'America/Sao_Paulo'
  onboardingCompleted?: boolean;
  languageSetByUser?: boolean;        // true if manually selected
}
```

### Clerk Private Metadata (Server-side only)
```typescript
interface ClerkPrivateMetadata {
  paymentProviderPreference?: PaymentProviderType;  // 'mercadopago' | 'paypal'
  paymentProviderFallbackUsed?: boolean;
  lastGeoUpdate?: string;             // ISO date
  ipHistory?: string[];               // For fraud detection
  internalNotes?: string;
}
```

### Why Clerk Metadata?
- **Edge-first**: Preferences are available in the JWT session without database calls
- **Low latency**: No additional network hop for common operations
- **Automatic sync**: Updates propagate to all sessions automatically

---

## Backend Architecture

### File Structure
```
src/
├── types/
│   └── multilingual.ts          # Type definitions for languages, regions, payments
├── services/
│   ├── userPreferencesService.ts    # Clerk metadata management
│   ├── multilingualRetellService.ts # Language-aware Retell integration
│   └── paymentStrategyService.ts    # Payment provider strategy pattern
├── prompts/
│   └── multilingualPrompts.ts   # XML-tagged AI agent prompts
└── routes/
    └── multilingualRoutes.ts    # API endpoints
```

### Server-side Language Initialization

```typescript
// Initialize user preferences on first login
async function initializeUserPreferences(
  clerkId: string,
  ip: string,
  headers?: Record<string, string>
): Promise<UserPreferences> {
  // 1. Check existing preferences
  const existing = await getUserPreferences(clerkId);
  if (existing?.languageSetByUser) return existing;
  
  // 2. Auto-detect from geo/headers
  const geo = await detectUserGeoFromIP(ip, headers);
  const headerLang = detectLanguageFromHeader(headers?.['accept-language']);
  
  // 3. Update Clerk metadata
  return updateUserPreferences(clerkId, {
    language: headerLang || geo.language,
    country: geo.country,
    timezone: geo.timezone,
    setByUser: false,
  });
}
```

### Registering a Multilingual Call

```typescript
async registerMultilingualCall(params: MultilingualRetellCallParams) {
  const { userId, language, metadata } = params;
  
  // Get language-specific agent
  const agentId = getAgentIdForLanguage(language);
  const voiceId = getVoiceIdForLanguage(language);
  const languageConfig = getLanguageConfig(language);
  
  // Create call with language context
  const callResponse = await this.retell.call.createWebCall({
    agent_id: agentId,
    voice_id: voiceId,
    metadata: {
      ...metadata,
      preferred_language: language,
      language_config: languageConfig,
    },
    retell_llm_dynamic_variables: {
      first_name: metadata.first_name,
      preferred_language: language,
      language_name: languageConfig.englishName,
    },
  });
  
  return {
    call_id: callResponse.call_id,
    access_token: callResponse.access_token,
    language: languageConfig,
  };
}
```

---

## Payment Strategy Pattern

### Design Pattern: Strategy
```
┌─────────────────────────────────────────────────────────────┐
│                     PaymentGateway                          │
│  (Strategy Context)                                         │
├─────────────────────────────────────────────────────────────┤
│  + getProviderForUser(clerkId): IPaymentProvider            │
│  + getProviderForRegion(region): IPaymentProvider           │
│  + createPayment(clerkId, params): PaymentPreferenceResponse│
└───────────────────────────┬─────────────────────────────────┘
                            │
           ┌────────────────┴────────────────┐
           │                                 │
           ▼                                 ▼
┌─────────────────────┐           ┌─────────────────────┐
│  MercadoPagoProvider│           │    PayPalProvider   │
│  implements         │           │    implements       │
│  IPaymentProvider   │           │    IPaymentProvider │
├─────────────────────┤           ├─────────────────────┤
│  type: 'mercadopago'│           │  type: 'paypal'     │
│  regions: ['LATAM'] │           │  regions: [GLOBAL]  │
│  currencies: [BRL]  │           │  currencies: [USD]  │
└─────────────────────┘           └─────────────────────┘
```

### Provider Interface
```typescript
interface IPaymentProvider {
  readonly type: PaymentProviderType;
  readonly name: string;
  readonly supportedCurrencies: string[];
  readonly supportedRegions: RegionCode[];
  
  isAvailable(): boolean;
  supportsRegion(region: RegionCode): boolean;
  createPaymentPreference(params: CreatePaymentParams): Promise<PaymentPreferenceResponse>;
  handleWebhook(payload: any, headers: Record<string, string>): Promise<WebhookResult>;
  getPaymentStatus(paymentId: string): Promise<PaymentStatusResult>;
}
```

### Geo-Payment Routing Logic
```typescript
async function getProviderForUser(clerkId: string): Promise<IPaymentProvider> {
  // 1. Get user's region from Clerk metadata
  const preferences = await getUserPreferences(clerkId);
  const region = preferences?.region || 'GLOBAL';
  
  // 2. Select provider based on region
  const providerType = region === 'LATAM' ? 'mercadopago' : 'paypal';
  
  // 3. Check availability and fallback if needed
  const provider = this.getProvider(providerType);
  if (!provider.isAvailable()) {
    return this.getProvider(providerType === 'mercadopago' ? 'paypal' : 'mercadopago');
  }
  
  return provider;
}
```

### Adding a New Provider (e.g., Stripe)
```typescript
// 1. Create new provider class
class StripeProvider implements IPaymentProvider {
  readonly type: PaymentProviderType = 'stripe';
  readonly supportedRegions: RegionCode[] = ['EUROPE', 'NORTH_AMERICA'];
  // ... implement interface methods
}

// 2. Register in PaymentGateway constructor
constructor() {
  this.registerProvider(new MercadoPagoProvider());
  this.registerProvider(new PayPalProvider());
  this.registerProvider(new StripeProvider());  // New!
}

// 3. Update routing logic if needed
// No changes required! Open/Closed principle in action.
```

---

## Retell Agent System Prompts

### XML-Tagged Prompt Structure
```xml
<agent_identity>
  <name>Vocaid</name>
  <role>Professional AI Interview Coach</role>
</agent_identity>

<language_configuration>
  <primary_language>Português (Brasil)</primary_language>
  <language_code>pt-BR</language_code>
</language_configuration>

<language_instructions>
  <rule priority="critical">
    You MUST conduct this ENTIRE interview in Português (Brasil).
    All questions, responses, and feedback must be in Português (Brasil).
  </rule>
  <rule>Use culturally appropriate expressions and idioms.</rule>
  <rule>Technical terms may remain in English if commonly used.</rule>
  <rule>If candidate switches languages, gently redirect back.</rule>
</language_instructions>

<interview_persona>
  <personality>Professional, encouraging, constructive</personality>
  <voice_characteristics>
    - Speak naturally and conversationally
    - Use clear, concise language suitable for speech
    - Include natural speech patterns like brief acknowledgments
  </voice_characteristics>
</interview_persona>

<core_interview_rules>
  <rule id="one_question">Ask ONE clear question at a time</rule>
  <rule id="wait_for_answer">Wait for complete answer before responding</rule>
  <rule id="concise_responses">Keep responses to 1-2 sentences</rule>
  <rule id="no_repetition">NEVER repeat yourself</rule>
</core_interview_rules>

<field_specific_instructions>
  <!-- Injected based on job field (engineering, marketing, etc.) -->
</field_specific_instructions>
```

### Language-Specific Greetings
```typescript
const greetings = {
  'pt-BR': "Olá {candidateName}! Bem-vindo à sua entrevista simulada com a Vocaid...",
  'es-ES': "¡Hola {candidateName}! Bienvenido a tu entrevista simulada con Vocaid...",
  'fr-FR': "Bonjour {candidateName} ! Bienvenue à votre entretien simulé avec Vocaid...",
  'zh-CN': "您好 {candidateName}！欢迎参加 Vocaid 模拟面试...",
  // ...
};
```

---

## Frontend i18n Configuration

### Setup with react-i18next
```typescript
// src/lib/i18n.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en-US',
    supportedLngs: ['en-US', 'en-GB', 'pt-BR', 'es-ES', 'fr-FR', 'ru-RU', 'zh-CN', 'hi-IN'],
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: 'Vocaid_language',
      caches: ['localStorage'],
    },
  });
```

### Language Hook Usage
```tsx
import { useLanguage } from '@/hooks/use-language';
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t } = useTranslation();
  const { currentLanguage, changeLanguage } = useLanguage();
  
  return (
    <div>
      <h1>{t('home.hero.title')}</h1>
      <LanguageSelector />
    </div>
  );
}
```

### Translation File Structure
```
src/lib/locales/
├── en-US.json
├── en-GB.json
├── pt-BR.json
├── es-ES.json
├── fr-FR.json
├── ru-RU.json
├── zh-CN.json
└── hi-IN.json
```

---

## API Reference

### Preferences Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/multilingual/preferences` | Get user preferences |
| PUT | `/api/multilingual/preferences` | Update preferences |
| POST | `/api/multilingual/preferences/initialize` | Auto-detect & initialize |

### Interview Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/multilingual/call/register` | Register multilingual call |
| GET | `/api/multilingual/languages` | List supported languages |

### Payment Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/multilingual/payment/provider` | Get preferred provider |
| GET | `/api/multilingual/payment/packages` | Get localized packages |
| POST | `/api/multilingual/payment/create` | Create geo-payment |
| GET | `/api/multilingual/payment/status/:id` | Check payment status |

---

## Environment Configuration

See `.env.multilingual.example` for all required variables:

```bash
# Retell - Language-specific agents
RETELL_AGENT_ID_PT_BR=agent_xxx
RETELL_AGENT_ID_EN_US=agent_yyy

# Mercado Pago (LATAM)
MERCADOPAGO_ACCESS_TOKEN=xxx
MERCADOPAGO_TEST_ACCESS_TOKEN=TEST-xxx

# PayPal (Global)
PAYPAL_CLIENT_ID=xxx
PAYPAL_SANDBOX_CLIENT_ID=xxx
```

---

## Best Practices

### Performance
1. **Edge-first preferences**: Store in Clerk metadata to avoid DB calls
2. **Language-specific agents**: Use Retell's native TTS for accurate accents
3. **Lazy provider initialization**: Only initialize payment providers when needed

### SOLID Principles Applied
- **Single Responsibility**: Each service handles one concern
- **Open/Closed**: Add new payment providers without modifying existing code
- **Dependency Inversion**: High-level modules depend on `IPaymentProvider` interface

### Security
- Payment provider credentials in environment variables
- Clerk private metadata for sensitive data
- Webhook signature verification for all providers
