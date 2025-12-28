# Vocaid - Backend

<p align="center">
  <strong>Backend Server for Vocaid Interview Platform</strong><br>
  Retell Custom LLM, OpenAI Integration, and MercadoPago Payment Processing
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#api-endpoints">API Endpoints</a> •
  <a href="#interview-system">Interview System</a> •
  <a href="#deployment">Deployment</a>
</p>

---

## Features

### 🎙️ Retell Custom LLM Integration
- WebSocket-based custom LLM for real-time interview conversations
- Handles all Retell interaction types: `call_details`, `response_required`, `reminder_required`, `update_only`
- Streaming responses for natural conversation flow
- Graceful call termination with proper messaging

### 🧠 AI-Powered Interviews
- **Field-specific prompts** for Engineering, Marketing, AI/ML, Agriculture, Physics
- **Auto-detection** of job field from keywords in job description
- **Resume congruency analysis** - detects mismatch between resume and job requirements
- **15-minute timer** with 2-minute warning before automatic termination
- **Silence handling** with reminders and graceful end after prolonged inactivity

### 💳 MercadoPago Payment Integration
- Payment preference creation for credit packages
- Webhook handling for payment notifications
- Automatic credit addition via Clerk Admin API
- Support for Starter, Intermediate, and Professional packages

### 📊 AI Feedback Generation
- **OpenAI GPT-4** primary provider with **Google Gemini** fallback
- Structured feedback: Overall rating, Strengths, Areas for Improvement, Recommendations
- Technical skills, Communication, and Problem-solving ratings
- Transcript analysis and performance summary

### 👥 User Management (Clerk)
- Credit management via Clerk Admin API
- User metadata storage for credits
- Secure authentication verification

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- OpenAI API key
- Retell AI account
- MercadoPago account
- Clerk account

### Installation

```bash
# Clone repository
git clone https://github.com/alefnsc/Vocaid-backend.git
cd Vocaid-backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your keys (see below)

# Start development server
npm run dev
```

Server runs at http://localhost:3001

### Verify Installation

```bash
curl http://localhost:3001/health
# Returns: {"status":"ok","message":"Vocaid Backend is running","timestamp":"..."}
```

### Environment Variables

Create a `.env` file in the project root:

```env
# Server Configuration
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
WEBHOOK_BASE_URL=http://localhost:3001

# OpenAI (Required)
# Get key at: https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-your-openai-key

# Google Gemini (Optional - fallback for feedback)
# Get key at: https://makersuite.google.com/app/apikey
GEMINI_API_KEY=your-gemini-key

# Retell AI (Required for interviews)
# Get keys at: https://beta.retellai.com/
RETELL_API_KEY=key_your-retell-key
RETELL_AGENT_ID=agent_your-agent-id

# MercadoPago (Required for payments)
# Get keys at: https://www.mercadopago.com.br/developers/panel/credentials
MERCADOPAGO_ACCESS_TOKEN=TEST-your-access-token
MERCADOPAGO_PUBLIC_KEY=APP_USR-your-public-key

# Clerk (Required for user management)
# Get keys at: https://dashboard.clerk.com/
CLERK_PUBLISHABLE_KEY=pk_test_your-key
CLERK_SECRET_KEY=sk_test_your-key

# Interview Settings (Optional)
MAX_INTERVIEW_DURATION_MINUTES=15
```

---

## Architecture

### System Overview

```
┌──────────────────────┐         ┌──────────────────────┐
│   Frontend (React)   │◄───────►│  Backend (Node.js)   │
│   Port: 3000         │  HTTP   │  Port: 3001          │
└──────────────────────┘         └──────────────────────┘
         │                               │
         ▼                               ▼
┌──────────────────────┐         ┌──────────────────────┐
│   Clerk              │         │  Retell AI           │
│   (Auth & Credits)   │         │  (Voice Calls)       │
└──────────────────────┘         └──────────────────────┘
                                         │
                                         ▼
                                 ┌──────────────────────┐
                                 │  Custom LLM          │
                                 │  (WebSocket)         │
                                 └──────────────────────┘
                                         │
                                         ▼
                                 ┌──────────────────────┐
                                 │  OpenAI GPT-4        │
                                 │  (AI Responses)      │
                                 └──────────────────────┘

┌──────────────────────┐
│  MercadoPago         │◄─── Webhooks
│  (Payments)          │
└──────────────────────┘
```

### Project Structure

```
Vocaid-backend/
├── src/
│   ├── server.ts                 # Main Express server + WebSocket
│   ├── prompts/
│   │   └── fieldPrompts.ts       # Field-specific interview prompts
│   ├── services/
│   │   ├── customLLMWebSocket.ts # Retell Custom LLM handler
│   │   ├── retellService.ts      # Retell API integration
│   │   ├── mercadoPagoService.ts # Payment processing
│   │   └── feedbackService.ts    # AI feedback generation
│   └── utils/
│       ├── congruencyAnalyzer.ts # Resume/job matching analysis
│       ├── interviewTimer.ts     # Interview time management
│       └── logger.ts             # Logging utility
├── .env.example                  # Environment template
├── package.json                  # Dependencies
└── tsconfig.json                 # TypeScript config
```

---

## API Endpoints

### Health Check

```
GET /health
```

Returns server status.

### Interview Endpoints

#### Register Call

```
POST /register-call
Content-Type: application/json

{
  "metadata": {
    "first_name": "John",
    "job_title": "Senior Software Engineer",
    "company_name": "Tech Corp",
    "job_description": "Looking for experienced engineer...",
    "interviewee_cv": "Resume text here..."
  }
}

Response:
{
  "call_id": "call_abc123",
  "access_token": "token_xyz789",
  "sample_rate": 24000
}
```

#### Get Call Details

```
GET /get-call/:callId

Response:
{
  "call_id": "call_abc123",
  "call_status": "ended",
  "transcript": [...],
  "metadata": {...}
}
```

#### Get Interview Feedback

```
GET /get-feedback-for-interview/:callId

Response:
{
  "feedback": {
    "overall_rating": 4,
    "strengths": ["Strong technical knowledge", "Clear communication"],
    "areas_for_improvement": ["Could elaborate more on examples"],
    "recommendations": ["Practice STAR method"],
    "detailed_feedback": "...",
    "technical_skills_rating": 4,
    "communication_skills_rating": 4,
    "problem_solving_rating": 3
  },
  "summary": "Strong candidate with good technical background..."
}
```

### Payment Endpoints

#### Create Payment Preference

```
POST /create-payment-preference
Content-Type: application/json

{
  "packageId": "professional",
  "userId": "user_123",
  "userEmail": "user@example.com"
}

Response:
{
  "preferenceId": "pref_abc123",
  "initPoint": "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=...",
  "sandboxInitPoint": "https://sandbox.mercadopago.com.br/checkout/v1/redirect?..."
}
```

#### Payment Webhook

```
POST /webhook/mercadopago
```

Handles MercadoPago payment notifications. Automatically adds credits to user account.

#### Add Credits (Manual)

```
POST /add-credits
Content-Type: application/json

{
  "userId": "user_123",
  "credits": 10
}
```

### WebSocket Endpoint

```
WS /llm-websocket/{call_id}
```

Retell Custom LLM WebSocket connection. Handles real-time interview conversation.

---

## Interview System

### Interview Flow

1. **User Initiates**: Frontend submits interview form
2. **Register Call**: Backend registers call with Retell, returns `call_id` + `access_token`
3. **Start Voice Call**: Frontend connects to Retell using access token
4. **WebSocket Connection**: Retell connects to backend `/llm-websocket/{call_id}`
5. **Conversation Loop**:
   - User speaks → Retell → Backend receives transcript
   - Backend processes with OpenAI (field detection, prompts, congruency)
   - Response streams back → Retell → User hears
6. **Interview Ends**: Timer expires, user quits, or congruency mismatch
7. **Generate Feedback**: Backend analyzes full transcript, returns structured feedback

### Field-Specific Prompts

The system auto-detects job field based on keywords:

| Field | Keywords |
|-------|----------|
| Engineering | programming, code, software, algorithm, backend, frontend |
| Marketing | campaign, brand, social media, analytics, growth |
| AI/ML | machine learning, neural network, nlp, tensorflow, pytorch |
| Agriculture | crop, farming, sustainable, harvest, soil |
| Physics | mechanics, quantum, research, laboratory, particles |

Each field has specialized:
- **System prompt** defining interviewer behavior
- **Initial message** customized with candidate name and job info
- **Evaluation focus areas** for that domain

### Resume Congruency Detection

```
Checks after 2-3 minutes (~4 user responses):
├── Skills alignment with job description
├── Experience level match
├── Domain knowledge relevance
└── If match < 40%: Graceful interview termination
```

### 15-Minute Timer

```
0-13 min:  Normal interview
13 min:    Warning issued ("We have about 2 minutes remaining...")
15 min:    Automatic termination with thank you message
```

### Silence Handling

```
User silent → Reminder 1: "Are you still there?"
Still silent → Reminder 2: "I haven't heard from you..."
Still silent → Graceful ending: "Thank you for your time..."
```

---

## Payment Flow

### Credit Packages

| Package | Credits | Price (BRL) | MercadoPago Product |
|---------|---------|-------------|---------------------|
| Starter | 5 | R$ 23.94 | Interview Credits - Starter |
| Intermediate | 10 | R$ 35.94 | Interview Credits - Intermediate |
| Professional | 15 | R$ 47.94 | Interview Credits - Professional |

### Payment Process

```
1. Frontend requests preference → POST /create-payment-preference
2. Backend creates MercadoPago preference
3. User redirected to MercadoPago checkout
4. User completes payment
5. MercadoPago sends webhook → POST /webhook/mercadopago
6. Backend verifies payment status
7. Backend adds credits via Clerk Admin API
8. User redirected back with updated credits
```

### Webhook Configuration

For local development, use ngrok:

```bash
# Start ngrok tunnel
ngrok http 3001

# Update .env
WEBHOOK_BASE_URL=https://abc123.ngrok.io

# Configure webhook in MercadoPago dashboard:
# URL: https://abc123.ngrok.io/webhook/mercadopago
# Events: payment
```

---

## Retell Configuration

### Configure Agent for Custom LLM

1. Go to https://beta.retellai.com/
2. Navigate to **Agents**
3. Select your agent
4. In **LLM Configuration**:
   - Set **LLM Provider**: `Custom LLM`
   - Set **Custom LLM WebSocket URL**:
     - Local: `ws://localhost:3001/llm-websocket/{call_id}`
     - Production: `wss://your-domain.com/llm-websocket/{call_id}`

⚠️ **Important**:
- Use `wss://` for HTTPS/production
- The `{call_id}` placeholder is **required** - Retell replaces it automatically
- No trailing slash after `{call_id}`

---

## Deployment

### AWS EC2 Deployment

#### 1. Launch EC2 Instance

- OS: Ubuntu Server 24.04 LTS
- Instance type: `t3.small` (minimum)
- Storage: 20 GB gp3
- Security Group: Allow SSH (22), HTTPS (443), Custom TCP (3001)

#### 2. Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 and nginx
sudo npm install -g pm2
sudo apt install -y nginx certbot python3-certbot-nginx
```

#### 3. Configure nginx with SSL

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }

    location /llm-websocket {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_read_timeout 86400;
    }
}
```

#### 4. Deploy Application

```bash
git clone https://github.com/alefnsc/Vocaid-backend.git
cd Vocaid-backend
npm install
npm run build
pm2 start dist/server.js --name Vocaid-backend
pm2 save
pm2 startup
```

#### 5. Update Retell Agent

Set Custom LLM URL to `wss://your-domain.com/llm-websocket/{call_id}`

### Using ngrok for Development

For webhook testing and Retell connection:

```bash
# Install ngrok
brew install ngrok  # macOS

# Start tunnel
ngrok http 3001

# Monitor at http://127.0.0.1:4040
```

---

## Troubleshooting

### Port Already in Use

```bash
lsof -ti:3001 | xargs kill -9
```

### WebSocket Connection Issues

1. Ensure firewall allows port 3001
2. For ngrok, use `wss://` not `ws://`
3. Check Retell agent Custom LLM URL includes `{call_id}`
4. Verify backend is running and accessible

### Payment Webhook Not Receiving

1. Verify ngrok is running
2. Check webhook URL in MercadoPago dashboard
3. Test: `curl https://YOUR-NGROK-URL.ngrok.io/health`
4. Check server logs for incoming requests

### OpenAI API Errors

1. Verify API key is valid
2. Check billing at https://platform.openai.com/
3. Ensure using correct model (`gpt-4-turbo-preview`)

### Credits Not Updating

1. Check backend logs for webhook calls
2. Verify Clerk secret key is correct
3. Ensure payment status is `approved`

### TypeScript Errors

```bash
npm install
npm run build
```

---

## Security Checklist

### Development

- [x] Use test credentials for all services
- [x] Never commit `.env` file
- [x] Use ngrok for webhook testing

### Production

- [ ] Use HTTPS for all endpoints
- [ ] Use production API keys
- [ ] Enable CORS restrictions
- [ ] Implement rate limiting
- [ ] Add authentication to sensitive endpoints
- [ ] Implement webhook signature verification
- [ ] Sanitize user inputs
- [ ] Set up error monitoring (Sentry)
- [ ] Rotate API keys regularly
- [ ] Add request logging

---

## External Resources

| Service | Documentation |
|---------|---------------|
| Retell AI | https://docs.retellai.com/ |
| OpenAI | https://platform.openai.com/docs |
| MercadoPago | https://www.mercadopago.com.br/developers/pt/docs |
| Clerk | https://clerk.com/docs |
| Google Gemini | https://ai.google.dev/docs |

---

## License

MIT

---

## Support

For issues or questions:
- Open a GitHub issue
- Contact the development team
