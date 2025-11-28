# Voxly Backend

Backend server for Voxly AI Interview Platform with Retell Custom LLM and Mercado Pago integration.

## Features

- **Retell Custom LLM Integration**: WebSocket-based custom LLM for interview conversations
- **Field-Specific Interviews**: Specialized prompts for Engineering, Marketing, AI, Agriculture, and Physics
- **Resume Congruency Detection**: Automatic detection of resume/role/job description mismatch
- **15-Minute Interview Timer**: Automatic interview termination after maximum duration
- **Mercado Pago Integration**: Payment processing and webhook handling
- **Clerk Integration**: User management and credit system

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your API keys
```

3. Run in development mode:
```bash
npm run dev
```

4. Build for production:
```bash
npm run build
npm start
```

## API Endpoints

### Interview Endpoints
- `POST /register-call` - Register a new Retell interview call
- `GET /get-call/:callId` - Get call details
- `GET /get-feedback-for-interview/:callId` - Generate AI feedback for completed interview

### Payment Endpoints
- `POST /create-payment-preference` - Create Mercado Pago payment preference
- `POST /webhook/mercadopago` - Handle Mercado Pago payment notifications
- `POST /add-credits` - Add credits to user account after successful payment

### WebSocket Endpoints
- `WS /llm-websocket/:callId` - Custom LLM WebSocket for Retell

## Local Development URLs

For Retell Custom LLM configuration:
- **Custom LLM URL (localhost)**: `ws://localhost:3001/llm-websocket/{call_id}`
- **Custom LLM URL (ngrok)**: `wss://your-ngrok-url.ngrok.io/llm-websocket/{call_id}`

For Mercado Pago webhooks:
- **Webhook URL (ngrok required)**: `https://your-ngrok-url.ngrok.io/webhook/mercadopago`

### Using ngrok for local testing

```bash
# Install ngrok
brew install ngrok  # macOS

# Start ngrok tunnel
ngrok http 3001

# Copy the https URL and update .env:
# WEBHOOK_BASE_URL=https://your-ngrok-url.ngrok.io
```

## Interview Flow

1. User starts interview from frontend
2. Backend registers call with Retell API
3. Retell connects to Custom LLM WebSocket
4. Custom LLM processes conversation with OpenAI
5. Resume/role congruency is monitored
6. Interview ends at 15 minutes or on early termination
7. Feedback is generated from transcript

## Payment Flow

1. User selects credit package
2. Frontend requests payment preference
3. Backend creates Mercado Pago preference
4. User completes payment on Mercado Pago
5. Mercado Pago sends webhook notification
6. Backend verifies payment and adds credits via Clerk
