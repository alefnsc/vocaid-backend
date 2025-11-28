# ⚠️ CONFIGURATION REQUIRED

Your backend is running but needs API keys to function properly.

## 🔑 Required API Keys

Edit `/Users/ale.fonseca/Documents/Projects/Voxly/voxly-back/.env` and add these keys:

### 1. OpenAI API Key
**Where to get**: https://platform.openai.com/api-keys
- Sign in to OpenAI
- Click "Create new secret key"
- Copy and paste into `.env`:
  ```
  OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxx
  ```

### 2. Retell AI API Key & Agent ID
**Where to get**: https://beta.retellai.com/
- Sign up/Login to Retell
- Go to "API Keys" → Copy your API key
- Go to "Agents" → Create or select agent → Copy Agent ID
- Paste into `.env`:
  ```
  RETELL_API_KEY=key_xxxxxxxxxxxxx
  RETELL_AGENT_ID=agent_xxxxxxxxxxxxx
  ```

**Important**: Configure your Retell agent:
- Set LLM Provider to "Custom LLM"
- Set Custom LLM URL to: `ws://localhost:3001/llm-websocket/{call_id}`

### 3. Mercado Pago Access Token
**Where to get**: https://www.mercadopago.com.br/developers/panel/credentials
- Login to Mercado Pago
- Select "Test" or "Production" credentials
- Copy "Access Token"
- Paste into `.env`:
  ```
  MERCADOPAGO_ACCESS_TOKEN=TEST-xxxxxxxxxxxxx
  ```

### 4. Clerk Secret Key
**Where to get**: https://dashboard.clerk.com/
- Login to Clerk
- Select your application
- Go to "API Keys"
- Copy "Secret Key"
- Paste into `.env`:
  ```
  CLERK_SECRET_KEY=sk_test_xxxxxxxxxxxxx
  CLERK_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxxx
  ```

## 🔄 After Adding Keys

1. Save the `.env` file
2. The backend will automatically reload (using tsx watch)
3. Refresh your frontend and try again

## 💰 Cost Information

- **OpenAI**: Charges per token usage (GPT-4 is ~$0.03 per 1K tokens)
- **Retell**: Check their pricing at https://retellai.com/pricing
- **Mercado Pago**: Transaction fees apply
- **Clerk**: Free tier available, check https://clerk.com/pricing

## 🧪 Test Mode

For development:
- Use OpenAI API with low usage
- Use Retell test environment
- Use Mercado Pago **TEST** credentials
- Use Clerk test keys

## ❓ Need Help?

Check the documentation:
- `/voxly-back/QUICKSTART.md` - Quick setup guide
- `/voxly-back/SETUP_GUIDE.md` - Detailed instructions
- `/voxly-back/README.md` - Project overview

---

**Current Status**: ❌ Backend running but API keys not configured  
**Action Required**: Add API keys to `.env` file
