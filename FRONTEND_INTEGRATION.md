# Frontend Integration Guide

This guide explains how the Voxly frontend integrates with the new backend.

## Overview

The backend provides:
1. **Retell Custom LLM** for interview conversations
2. **Mercado Pago** payment processing
3. **AI Feedback** generation from interview transcripts

## Updated Files

### 1. MercadoPagoService.ts

**Location**: `voxly-front/src/services/MercadoPagoService.ts`

**Changes**:
- `createPreference()` now calls backend endpoint
- Payment processing handled via backend webhooks
- Credits automatically added after successful payment

**Usage Example**:
```typescript
import mercadoPagoService from '@/services/MercadoPagoService';

// Create payment preference
const initPoint = await mercadoPagoService.createPreference(
  'professional',  // packageId
  userId,          // from Clerk
  userEmail        // from Clerk
);

// Redirect user to payment
window.location.href = initPoint;
```

### 2. APIService.ts

**Location**: `voxly-front/src/services/APIService.ts`

**No changes needed** - Already configured to use `REACT_APP_BACKEND_URL`.

**Existing Methods**:
- `registerCall()` - Registers interview with Retell
- `getCall()` - Gets call details
- `getFeedback()` - Generates AI feedback

## Environment Configuration

### Frontend (.env)

```env
# Backend URL
REACT_APP_BACKEND_URL=http://localhost:3001

# Mercado Pago Public Key (for SDK initialization)
REACT_APP_MERCADOPAGO_PUBLIC_KEY=APP_USR-your-public-key

# Clerk Keys (unchanged)
REACT_APP_CLERK_PUBLISHABLE_KEY=pk_test_your-key
```

## Payment Flow

### Complete Payment Integration

```typescript
import { useUser } from '@clerk/clerk-react';
import mercadoPagoService from '@/services/MercadoPagoService';

function BuyCreditsComponent() {
  const { user } = useUser();

  const handleBuyCredits = async (packageId: string) => {
    try {
      // 1. Create payment preference via backend
      const initPoint = await mercadoPagoService.createPreference(
        packageId,
        user.id,
        user.primaryEmailAddress?.emailAddress || ''
      );

      // 2. Redirect to Mercado Pago checkout
      window.location.href = initPoint;

      // 3. After payment:
      // - Mercado Pago redirects back to your success URL
      // - Mercado Pago sends webhook to backend
      // - Backend verifies payment and adds credits
      // - Credits appear in user's Clerk metadata
    } catch (error) {
      console.error('Error creating payment:', error);
    }
  };

  return (
    <button onClick={() => handleBuyCredits('professional')}>
      Buy 15 Credits - R$ 40.00
    </button>
  );
}
```

### Handling Payment Success

Create success page at `voxly-front/src/pages/Payment/Success.tsx`:

```typescript
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';

function PaymentSuccess() {
  const navigate = useNavigate();
  const { user, reload } = useUser();

  useEffect(() => {
    // Reload user data to get updated credits
    const checkCredits = async () => {
      await reload();
      // Credits should now be updated
      setTimeout(() => {
        navigate('/');
      }, 3000);
    };

    checkCredits();
  }, [reload, navigate]);

  return (
    <div>
      <h1>Payment Successful! ✅</h1>
      <p>Your credits have been added.</p>
      <p>Redirecting...</p>
    </div>
  );
}
```

## Interview Flow

### Starting an Interview

The existing interview flow works with the backend:

```typescript
import apiService from '@/services/APIService';

// 1. Register call (already implemented in useCallManager hook)
const response = await apiService.registerCall({
  metadata: {
    first_name: candidateName,
    job_title: jobTitle,
    company_name: companyName,
    job_description: jobDescription,
    interviewee_cv: resumeText
  }
});

// 2. Start call with access token
await apiService.startCall(response.access_token);

// 3. Interview runs via WebSocket to backend Custom LLM
// - Backend handles: field-specific prompts, congruency check, 15-min timer

// 4. After interview, get feedback
const feedbackResponse = await apiService.getFeedback(callId);
```

## Credits Management

### Checking Credits

```typescript
import { useUser } from '@clerk/clerk-react';

function CreditsDisplay() {
  const { user } = useUser();
  const credits = user?.publicMetadata?.credits || 0;

  return <div>Credits: {credits}</div>;
}
```

### Deducting Credits (Frontend)

When starting interview, deduct credit via Clerk:

```typescript
import { useUser } from '@clerk/clerk-react';

async function startInterview() {
  const { user } = useUser();
  const currentCredits = user?.publicMetadata?.credits || 0;

  if (currentCredits <= 0) {
    alert('No credits available');
    return;
  }

  // Deduct credit
  await user?.update({
    publicMetadata: {
      ...user.publicMetadata,
      credits: currentCredits - 1
    }
  });

  // Start interview
  // ...
}
```

**Note**: Credit deduction on frontend is temporary until user reload. For production, consider implementing credit deduction via backend endpoint for security.

## Backend API Reference

### POST /register-call

Registers new interview call with Retell.

**Request**:
```json
{
  "metadata": {
    "first_name": "John",
    "job_title": "Senior Software Engineer",
    "company_name": "Tech Corp",
    "job_description": "Looking for experienced engineer...",
    "interviewee_cv": "Resume text here..."
  }
}
```

**Response**:
```json
{
  "call_id": "call_abc123",
  "access_token": "token_xyz789",
  "status": "success",
  "message": "Call registered successfully"
}
```

### GET /get-call/:callId

Gets call details and transcript.

**Response**:
```json
{
  "call_id": "call_abc123",
  "status": "ended",
  "transcript": [...],
  "metadata": {...}
}
```

### GET /get-feedback-for-interview/:callId

Generates AI feedback for completed interview.

**Response**:
```json
{
  "status": "success",
  "call_id": "call_abc123",
  "feedback": {
    "overall_rating": 4,
    "strengths": ["Strong technical knowledge", ...],
    "areas_for_improvement": [...],
    "technical_skills_rating": 4,
    "communication_skills_rating": 5,
    "problem_solving_rating": 4,
    "detailed_feedback": "...",
    "recommendations": [...]
  }
}
```

### POST /create-payment-preference

Creates Mercado Pago payment preference.

**Request**:
```json
{
  "packageId": "professional",
  "userId": "user_123",
  "userEmail": "user@example.com"
}
```

**Response**:
```json
{
  "status": "success",
  "preference": {
    "preferenceId": "123456789-abc",
    "initPoint": "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=...",
    "sandboxInitPoint": "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=..."
  }
}
```

## Testing

### Test Payment Flow

1. Start backend: `cd voxly-back && npm run dev`
2. Start frontend: `cd voxly-front && npm start`
3. Navigate to credits/payment page
4. Select package
5. Complete payment on Mercado Pago (use test cards)
6. Verify credits added to Clerk metadata

### Test Interview Flow

1. Ensure backend is running
2. Start new interview from frontend
3. Verify WebSocket connection in backend logs
4. Complete interview
5. Check feedback generation

## Troubleshooting

### Payment not adding credits

- Check backend logs for webhook calls
- Verify ngrok is running and URL is in .env
- Check Mercado Pago webhook configuration
- Ensure webhook URL is public (https)

### Interview not connecting

- Verify backend is running on port 3001
- Check REACT_APP_BACKEND_URL in frontend .env
- Ensure Retell agent configured with correct Custom LLM URL
- Check browser console for errors

### Credits not updating

- Reload user data from Clerk: `await user.reload()`
- Check Clerk dashboard for user metadata
- Verify backend has correct Clerk secret key

## Security Considerations

### Production Checklist

- [ ] Use HTTPS for all endpoints
- [ ] Validate user authentication on all backend endpoints
- [ ] Implement rate limiting
- [ ] Add CORS restrictions
- [ ] Use production API keys (not test keys)
- [ ] Implement webhook signature verification
- [ ] Sanitize user inputs
- [ ] Add request logging
- [ ] Set up error monitoring (Sentry, etc.)
- [ ] Use environment variables (not .env files)

## Additional Features to Consider

### Credit Deduction via Backend

For better security, implement backend endpoint:

```typescript
// Backend: POST /deduct-credit
app.post('/deduct-credit', async (req, res) => {
  const { userId } = req.body;
  // Verify user authentication
  // Deduct credit via Clerk Admin API
  // Return new credit balance
});
```

### Credit Refund on Failed Interview

If interview fails or is cancelled, consider refunding credits:

```typescript
// Backend: POST /refund-credit
app.post('/refund-credit', async (req, res) => {
  const { userId, reason } = req.body;
  // Add credit back to user
});
```

### Payment History

Track payment history in database:

```typescript
// Store payment records
{
  userId: string;
  paymentId: string;
  packageId: string;
  amount: number;
  credits: number;
  status: 'pending' | 'approved' | 'failed';
  createdAt: Date;
}
```

## Support

For issues or questions:
- Check backend logs
- Verify API keys are correct
- Test endpoints with curl/Postman
- Check browser console for frontend errors
- Review backend SETUP_GUIDE.md
