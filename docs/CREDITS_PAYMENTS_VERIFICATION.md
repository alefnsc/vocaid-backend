# Credits & Payments System Verification Checklist

## Summary of Changes Made

### Backend (Vocaid-backend)

1. **FREE_TRIAL_CREDITS updated to 15** (was 1)
   - `src/services/creditsWalletService.ts` - Default FREE_TRIAL_CREDITS
   - `src/services/clerkService.ts` - Clerk webhook user creation
   - `src/services/enhancedAbuseService.ts` - All INITIAL_CREDITS_* defaults

2. **PayPal endpoints added to server.ts**
   - `POST /webhook/paypal` - Webhook for PayPal IPN notifications
   - `POST /payments/paypal/capture` - Capture approved PayPal orders

### Frontend (Vocaid-frontend)

1. **FREE_TRIAL_CREDITS updated to 15**
   - `src/config/credits.ts`

2. **Billing page completely rewritten** (`src/pages/app/billing/index.tsx`)
   - Removed hardcoded `CREDIT_PACKS` mock data
   - Uses real APIs: `getPreferredPaymentProvider()`, `getLocalizedPackages()`
   - Provider selection UI with MercadoPago/PayPal toggle
   - Auto-detects provider by user location
   - Vocaid design system (white/zinc/purple-600)
   - Real transaction history from `useCreditsWallet` hook

---

## Manual Verification Steps

### 1. New User Free Trial Credits

**Test:** Verify new users receive 15 free trial credits

```bash
# 1. Create a new Clerk account (or delete existing test user)
# 2. Sign up through the app
# 3. Check credits balance
```

**Expected Result:**
- New user should have 15 credits
- `CreditLedger` entry with `type: 'TRIAL_GRANT'`

**API Check:**
```bash
curl -X GET "http://localhost:3001/api/credits/balance" \
  -H "Authorization: Bearer <clerk_token>"
```

---

### 2. Payment Provider Detection

**Test:** Verify location-based provider detection

**Expected Results by Region:**
| Region | Expected Provider |
|--------|------------------|
| Argentina, Mexico, Brazil, Chile, Colombia | MercadoPago |
| USA, Europe, Rest of World | PayPal |

**API Check:**
```bash
curl -X GET "http://localhost:3001/api/multilingual/payment/provider" \
  -H "Authorization: Bearer <clerk_token>"
```

**Expected Response:**
```json
{
  "provider": "mercadopago", // or "paypal"
  "providerName": "Mercado Pago",
  "country": "AR",
  "currency": "ARS"
}
```

---

### 3. Package Loading

**Test:** Verify packages load from backend with correct currency

**API Check:**
```bash
curl -X GET "http://localhost:3001/api/multilingual/payment/packages" \
  -H "Authorization: Bearer <clerk_token>"
```

**Expected Response:**
```json
{
  "packages": [
    {
      "id": "basic",
      "name": "Basic Pack",
      "credits": 5,
      "price": 9.99,
      "currency": "USD",
      "popular": false
    },
    // ... more packages
  ],
  "currency": "USD",
  "country": "US"
}
```

---

### 4. MercadoPago Payment Flow

**Prerequisites:**
- User in LATAM region (or override for testing)
- Valid MercadoPago sandbox credentials

**Test Steps:**
1. Navigate to `/app/billing`
2. Select a credit package
3. Click "Buy Now"
4. Complete MercadoPago checkout
5. Verify redirect to `/payment/success`
6. Check credits were added

**API for Creating Payment:**
```bash
curl -X POST "http://localhost:3001/api/multilingual/payment/create" \
  -H "Authorization: Bearer <clerk_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "packageId": "basic",
    "provider": "mercadopago"
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "paymentUrl": "https://www.mercadopago.com.ar/checkout/..."
}
```

---

### 5. PayPal Payment Flow

**Prerequisites:**
- User outside LATAM (or select PayPal manually)
- Valid PayPal sandbox credentials

**Test Steps:**
1. Navigate to `/app/billing`
2. Select PayPal provider (if not auto-detected)
3. Select a credit package
4. Click "Buy Now"
5. Complete PayPal checkout
6. Verify redirect to `/payment/success?provider=paypal`
7. Check credits were added

**Capture Endpoint (called after PayPal approval):**
```bash
curl -X POST "http://localhost:3001/payments/paypal/capture" \
  -H "Authorization: Bearer <clerk_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "<paypal_order_id>",
    "userId": "<clerk_user_id>"
  }'
```

---

### 6. Transaction History

**Test:** Verify transaction history displays correctly

**API Check:**
```bash
curl -X GET "http://localhost:3001/api/credits/history?limit=10" \
  -H "Authorization: Bearer <clerk_token>"
```

**Expected Response:**
```json
{
  "transactions": [
    {
      "id": "uuid",
      "type": "PURCHASE",
      "amount": 10,
      "description": "Credit package purchase",
      "balanceAfter": 25,
      "createdAt": "2025-01-15T..."
    }
  ],
  "pagination": {
    "hasMore": false,
    "cursor": null
  }
}
```

---

### 7. Billing UI Visual Check

**Verify Vocaid Design:**
- [ ] Background: white with zinc accents
- [ ] Primary color: purple-600
- [ ] Header gradient: purple-600 to purple-700
- [ ] Cards: white with zinc-200 borders
- [ ] No external icon libraries (uses Unicode characters)
- [ ] Provider selector shows both options
- [ ] Packages load dynamically (not hardcoded)
- [ ] Transaction history shows real data

---

### 8. Webhook Verification

**MercadoPago Webhook:**
```bash
# Test with MercadoPago sandbox IPN
POST /webhook/mercadopago
Content-Type: application/json

{
  "type": "payment",
  "data": { "id": "12345678" }
}
```

**PayPal Webhook:**
```bash
# Test with PayPal sandbox IPN
POST /webhook/paypal
Content-Type: application/json

{
  "event_type": "PAYMENT.CAPTURE.COMPLETED",
  "resource": {
    "id": "capture_id",
    "custom_id": "user_id|package_id"
  }
}
```

---

## Environment Variables Required

### Backend (.env)

```env
# Free Trial Credits
FREE_TRIAL_CREDITS=15

# MercadoPago
MERCADOPAGO_ACCESS_TOKEN=<sandbox_token>
MERCADOPAGO_PUBLIC_KEY=<public_key>

# PayPal
PAYPAL_CLIENT_ID=<sandbox_client_id>
PAYPAL_CLIENT_SECRET=<sandbox_secret>
PAYPAL_MODE=sandbox

# URLs
FRONTEND_URL=http://localhost:3000
BACKEND_URL=http://localhost:3001
```

### Frontend (.env)

```env
REACT_APP_FREE_TRIAL_CREDITS=15
REACT_APP_API_URL=http://localhost:3001
```

---

## Known Issues & Notes

1. **PayPal webhook signature verification**: Currently logging only, may need full verification in production
2. **Provider preference persistence**: User's manual provider choice is session-only (not persisted to DB yet)
3. **Currency conversion**: Prices are served in local currency but actual payment uses provider's currency handling

---

## Files Modified

### Backend
- `src/services/creditsWalletService.ts`
- `src/services/clerkService.ts`
- `src/services/enhancedAbuseService.ts`
- `src/server.ts` (PayPal endpoints added)

### Frontend
- `src/config/credits.ts`
- `src/pages/app/billing/index.tsx` (complete rewrite)

---

*Last Updated: January 2025*
