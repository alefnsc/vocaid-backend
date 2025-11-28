# Voxly Backend - Quick Start

## 🚀 Quick Setup (5 minutes)

### Step 1: Install Dependencies

```bash
cd voxly-back
npm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your keys. **Minimum required**:

```env
OPENAI_API_KEY=sk-your-key
RETELL_API_KEY=key_your-key
RETELL_AGENT_ID=agent_your-id
MERCADOPAGO_ACCESS_TOKEN=TEST-your-token
CLERK_SECRET_KEY=sk_test_your-key
```

### Step 3: Run

```bash
npm run dev
```

Server starts on http://localhost:3001

---

## 📝 URLs for Configuration

### For Retell Dashboard (Agent Settings)

**Custom LLM WebSocket URL (localhost)**:
```
ws://localhost:3001/llm-websocket/{call_id}
```

**Custom LLM WebSocket URL (ngrok - for testing)**:
```
wss://YOUR-NGROK-URL.ngrok.io/llm-websocket/{call_id}
```

### For Mercado Pago Dashboard (Webhooks)

**Webhook URL (requires ngrok)**:
```
https://YOUR-NGROK-URL.ngrok.io/webhook/mercadopago
```

---

## 🔧 Setup ngrok (Required for Payments)

```bash
# Install
brew install ngrok

# Run (in a separate terminal)
ngrok http 3001

# Copy the https URL and update .env:
# WEBHOOK_BASE_URL=https://abc123.ngrok.io
```

---

## ✅ Verify Setup

```bash
# Check health
curl http://localhost:3001/health

# Should return:
# {"status":"ok","message":"Voxly Backend is running","timestamp":"..."}
```

---

## 🎯 Key Features Implemented

✅ **Retell Custom LLM** with WebSocket support  
✅ **Field-Specific Interviews**: Engineering, Marketing, AI, Agriculture, Physics  
✅ **Resume Congruency Detection**: Automatically detects mismatch  
✅ **15-Minute Timer**: Auto-terminates interviews  
✅ **Mercado Pago Integration**: Payment preferences & webhooks  
✅ **Clerk Integration**: User management & credit system  
✅ **AI Feedback Generation**: Using OpenAI GPT-4  

---

## 🔗 Important Links

- **Full Setup Guide**: See `SETUP_GUIDE.md`
- **Retell Docs**: https://docs.retellai.com/
- **Mercado Pago Docs**: https://www.mercadopago.com.br/developers/pt/docs
- **OpenAI API**: https://platform.openai.com/
- **Clerk Dashboard**: https://dashboard.clerk.com/

---

## 🆘 Common Issues

**Port in use?**
```bash
lsof -ti:3001 | xargs kill -9
```

**Webhook not working?**
- Make sure ngrok is running
- Update WEBHOOK_BASE_URL in .env
- Restart the server

**WebSocket connection failed?**
- Check Retell agent configuration
- Verify Custom LLM URL is correct
- Use `wss://` for ngrok, `ws://` for localhost

---

## 📚 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/register-call` | Start new interview |
| GET | `/get-call/:callId` | Get call details |
| GET | `/get-feedback-for-interview/:callId` | Get AI feedback |
| POST | `/create-payment-preference` | Create payment |
| POST | `/webhook/mercadopago` | Payment webhook |
| WS | `/llm-websocket/{call_id}` | Custom LLM |

---

**Need help?** Check `SETUP_GUIDE.md` for detailed instructions.
