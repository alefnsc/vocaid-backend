# ⚠️ IMPORTANT: Retell Agent Configuration

## Current Issue
Your Retell agent Custom LLM URL is **incorrect**.

### ❌ Wrong Configuration
```
ws://localhost:3001/llm-websocket
```

### ✅ Correct Configuration
```
ws://localhost:3001/llm-websocket/{call_id}
```

**The `{call_id}` placeholder is REQUIRED!** Retell replaces it with the actual call ID.

---

## How to Fix

1. Go to **https://beta.retellai.com/**
2. Navigate to **Agents** section
3. Select your agent: `agent_e8f326778af49aaa788cbda7d0`
4. Find **LLM Configuration** section
5. Set **LLM Provider** to: `Custom LLM`
6. Set **Custom LLM WebSocket URL** to:
   ```
   ws://localhost:3001/llm-websocket/{call_id}
   ```
7. Click **Save**

---

## Testing

After updating:
1. Refresh your frontend
2. Start a new interview
3. Check backend logs - you should see:
   ```
   WebSocket connection established for call: call_xxxxx
   ```

---

## For Production/ngrok

If using ngrok for testing:
1. Start ngrok: `ngrok http 3001`
2. Copy the URL (e.g., `https://abc123.ngrok.io`)
3. Update Retell agent Custom LLM URL to:
   ```
   wss://abc123.ngrok.io/llm-websocket/{call_id}
   ```
   (Note: Use `wss://` for HTTPS, not `ws://`)

---

**Remember**: The `{call_id}` part is a **placeholder** that Retell automatically replaces with each call's unique ID. Don't remove it!
