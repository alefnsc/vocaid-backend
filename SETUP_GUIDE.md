# Voxly Backend - Detailed Setup Guide

## Prerequisites

- Node.js 18+ 
- npm or yarn
- OpenAI API key
- Retell AI account and API key
- Mercado Pago developer account
- Clerk account

## Installation

### 1. Install Dependencies

```bash
cd voxly-back
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```env
# OpenAI (for Custom LLM)
OPENAI_API_KEY=sk-your-openai-key

# Retell AI
RETELL_API_KEY=your-retell-api-key
RETELL_AGENT_ID=your-agent-id

# Mercado Pago
MERCADOPAGO_ACCESS_TOKEN=your-access-token
MERCADOPAGO_PUBLIC_KEY=your-public-key

# Clerk
CLERK_PUBLISHABLE_KEY=pk_test_your-key
CLERK_SECRET_KEY=sk_test_your-key

# URLs
FRONTEND_URL=http://localhost:3000
WEBHOOK_BASE_URL=http://localhost:3001
```

### 3. Get Your API Keys

#### OpenAI API Key
1. Go to https://platform.openai.com/api-keys
2. Create a new API key
3. Copy and paste into `.env`

#### Retell AI Configuration
1. Go to https://beta.retellai.com/
2. Sign up/Login
3. Go to API Keys section and copy your API key
4. Create an agent (or use existing one) and copy the Agent ID
5. **Important**: Configure your agent to use Custom LLM:
   - Go to Agent Settings
   - Select "Custom LLM" as the LLM provider
   - Set WebSocket URL to: `ws://localhost:3001/llm-websocket/{call_id}`
   - For production, use ngrok URL: `wss://your-ngrok-url.ngrok.io/llm-websocket/{call_id}`

#### Mercado Pago Credentials
1. Go to https://www.mercadopago.com.br/developers/panel/credentials
2. Select "Test" or "Production" credentials
3. Copy:
   - Public Key → `MERCADOPAGO_PUBLIC_KEY`
   - Access Token → `MERCADOPAGO_ACCESS_TOKEN`

#### Clerk Configuration
1. Go to https://dashboard.clerk.com/
2. Select your application
3. Go to API Keys
4. Copy:
   - Publishable Key → `CLERK_PUBLISHABLE_KEY`
   - Secret Key → `CLERK_SECRET_KEY`

### 4. Build and Run

#### Development Mode

```bash
npm run dev
```

This starts the server with hot reload on port 3001.

#### Production Mode

```bash
npm run build
npm start
```

## Webhook Setup (Required for Payments)

Mercado Pago webhooks require a public HTTPS URL. For local development, use ngrok:

### Install ngrok

```bash
# macOS
brew install ngrok

# Or download from https://ngrok.com/download
```

### Start ngrok tunnel

```bash
ngrok http 3001
```

You'll see output like:
```
Forwarding  https://abc123.ngrok.io -> http://localhost:3001
```

### Update Configuration

1. Copy the ngrok HTTPS URL
2. Update `.env`:
   ```env
   WEBHOOK_BASE_URL=https://abc123.ngrok.io
   ```
3. Restart your server

### Configure Mercado Pago Webhook

1. Go to https://www.mercadopago.com.br/developers/panel/webhooks
2. Click "Add Webhook"
3. Set URL to: `https://abc123.ngrok.io/webhook/mercadopago`
4. Select events: `payment`
5. Save

## Retell Custom LLM Configuration

### For Localhost Testing

In Retell dashboard, set Custom LLM URL to:
```
ws://localhost:3001/llm-websocket/{call_id}
```

### For Production/ngrok Testing

In Retell dashboard, set Custom LLM URL to:
```
wss://your-ngrok-url.ngrok.io/llm-websocket/{call_id}
```

**Note**: Replace `{call_id}` with the placeholder exactly as shown - Retell will replace it automatically.

## Testing the Setup

### 1. Health Check

```bash
curl http://localhost:3001/health
```

Should return:
```json
{
  "status": "ok",
  "message": "Voxly Backend is running",
  "timestamp": "..."
}
```

### 2. Test WebSocket

The WebSocket endpoint will be available at:
- Local: `ws://localhost:3001/llm-websocket/test-call-id`
- ngrok: `wss://your-ngrok-url.ngrok.io/llm-websocket/test-call-id`

### 3. Test Payment Creation

```bash
curl -X POST http://localhost:3001/create-payment-preference \
  -H "Content-Type: application/json" \
  -d '{
    "packageId": "starter",
    "userId": "user_123",
    "userEmail": "test@example.com"
  }'
```

## API Endpoints

### Interview Endpoints

- `POST /register-call` - Register new interview call
- `GET /get-call/:callId` - Get call details
- `GET /get-feedback-for-interview/:callId` - Generate feedback

### Payment Endpoints

- `POST /create-payment-preference` - Create payment preference
- `POST /webhook/mercadopago` - Handle payment notifications

### WebSocket Endpoint

- `WS /llm-websocket/{call_id}` - Custom LLM WebSocket

## Troubleshooting

### Port Already in Use

```bash
lsof -ti:3001 | xargs kill -9
```

### WebSocket Connection Issues

- Ensure firewall allows connections on port 3001
- For ngrok, use `wss://` (not `ws://`)
- Check Retell agent configuration

### Payment Webhook Not Receiving Events

- Verify ngrok is running
- Check webhook URL in Mercado Pago dashboard
- Test webhook with Mercado Pago testing tools
- Check server logs for incoming requests

### OpenAI API Errors

- Verify API key is valid
- Check you have credits/billing set up
- Ensure using correct model (`gpt-4-turbo-preview`)

## Development Tips

### Hot Reload

Changes to TypeScript files will automatically reload the server in dev mode.

### Viewing Logs

All logs are output to console. For production, consider using a logging service.

### Testing Webhooks Locally

Use ngrok's web interface at http://127.0.0.1:4040 to inspect webhook requests.

## Security Notes

⚠️ **Important Security Considerations:**

1. **Never commit `.env` file** - It contains sensitive API keys
2. **Use test credentials** for development
3. **Rotate API keys** regularly
4. **Validate webhook signatures** in production (implement HMAC validation)
5. **Use HTTPS** in production
6. **Implement rate limiting** for production endpoints
7. **Add authentication** to sensitive endpoints

## Production Deployment

For production deployment:

1. Use environment variables (don't use .env file)
2. Enable HTTPS/SSL
3. Use production API keys
4. Set up proper logging and monitoring
5. Implement request validation and sanitization
6. Add rate limiting
7. Use a process manager (PM2, systemd, etc.)
8. Set up load balancing if needed

## Support

For issues:
- Check logs in terminal
- Verify all API keys are correct
- Ensure all services (OpenAI, Retell, Mercado Pago, Clerk) are accessible
- Check network connectivity
