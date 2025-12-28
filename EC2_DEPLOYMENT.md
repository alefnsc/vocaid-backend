# EC2 Deployment Commands for Multilingual Platform

## Prerequisites
- SSH access to your EC2 instance
- Node.js 18+ installed on EC2
- PM2 or systemd for process management
- Environment variables configured

## 1. Connect to EC2 Instance

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@your-ec2-ip
```

## 2. Navigate to Backend Directory

```bash
cd /path/to/Vocaid-backend
```

## 3. Pull Latest Changes

```bash
git pull origin main
```

## 4. Install Dependencies

```bash
npm install
```

## 5. Configure Environment Variables

Add the following to your `.env` file (or EC2 environment):

```bash
# ========================================
# RETELL AI - SIMPLIFIED MULTILINGUAL CONFIGURATION
# ========================================
# The platform uses just TWO agents:
# 1. RETELL_AGENT_ID - Main multilingual agent (PT, EN, ES, FR, RU, HI)
# 2. RETELL_AGENT_ID_ZH - Chinese Mandarin only (zh-CN)
#
# Language differentiation happens via Custom LLM prompt injection,
# not through separate agents per language.

# Main Multilingual Agent (REQUIRED)
# Handles: pt-BR, en-US, en-GB, es-ES, es-MX, es-AR, fr-FR, ru-RU, hi-IN
RETELL_AGENT_ID=agent_e8f326778af49aaa788cbda7d0

# Chinese Mandarin Agent (OPTIONAL - only if Chinese support needed)
# Handles: zh-CN only (Cantonese/zh-TW is NOT supported)
RETELL_AGENT_ID_ZH=agent_ab2721588d6050d8705093636a

# Optional: Language-specific voice IDs for better accents
# RETELL_VOICE_ID_PT_BR=voice_xxx
# RETELL_VOICE_ID_ES_ES=voice_xxx
# ... (add for other languages as needed)

# ========================================
# PAYMENT PROVIDERS
# ========================================

# PayPal Configuration (Global payments)
PAYPAL_CLIENT_ID=your_paypal_client_id
PAYPAL_CLIENT_SECRET=your_paypal_client_secret
PAYPAL_SANDBOX_CLIENT_ID=your_sandbox_client_id  # For testing
PAYPAL_SANDBOX_CLIENT_SECRET=your_sandbox_secret

# MercadoPago (existing - already configured)
MERCADOPAGO_ACCESS_TOKEN=your_production_token
MERCADOPAGO_TEST_ACCESS_TOKEN=your_test_token

# ========================================
# AI SERVICES
# ========================================

# Anthropic Claude (for performance chat)
ANTHROPIC_API_KEY=sk-ant-xxx
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# ========================================
# ABUSE PREVENTION (optional tuning)
# ========================================
MAX_ACCOUNTS_PER_IP=2
MAX_ACCOUNTS_PER_FINGERPRINT=1
MAX_SIGNUPS_PER_SUBNET_HOUR=3

# ========================================
# EXISTING VARIABLES (keep as-is)
# ========================================
CLERK_SECRET_KEY=xxx
DATABASE_URL=xxx
RETELL_API_KEY=xxx
WEBHOOK_BASE_URL=https://your-backend.com
FRONTEND_URL=https://your-frontend.com
```

## 6. Run Database Migrations

```bash
# Generate Prisma client with new tables
npx prisma generate

# Run migrations for new tables
npx prisma migrate deploy
```

**New tables added:**
- `InterviewScoreHistory` - Score tracking by role/company
- `UsageLog` - User activity logging
- `ChatSession` - Performance chat sessions
- `ChatMessage` - Chat message history
- `SignupRecord` - Enhanced abuse prevention
- `DisposableEmailDomain` - Email domain blocklist
- `SubnetTracker` - IP velocity tracking

## 7. Seed Disposable Email Domains (Optional)

```bash
# Run this once to populate common disposable email domains
node -e "require('./dist/services/enhancedAbuseService').seedDisposableEmailDomains()"
```

## 8. Build TypeScript

```bash
npm run build
```

## 9. Restart the Server

### Using PM2 (recommended):

```bash
# If first time
pm2 start dist/server.js --name Vocaid-backend

# If already running
pm2 restart Vocaid-backend

# Check status
pm2 status
pm2 logs Vocaid-backend --lines 100
```

### Using systemd:

```bash
sudo systemctl restart Vocaid-backend
sudo systemctl status Vocaid-backend
journalctl -u Vocaid-backend -f
```

## 10. Verify Deployment

### Check Health Endpoint:

```bash
curl https://your-backend.com/health
```

### Test Multilingual Routes:

```bash
# Check supported languages
curl https://your-backend.com/api/multilingual/languages

# Test payment provider detection (with auth header)
curl -H "x-user-id: user_xxx" \
  https://your-backend.com/api/multilingual/payment/provider
```

### Check Logs for Errors:

```bash
pm2 logs Vocaid-backend --err --lines 50
```

## 11. Verify New Features

### A. Multilingual Interviews
1. Create interview with language preference
2. Check that correct Retell agent is used
3. Verify language in transcript

### B. Payment Strategy
1. Test user from Brazil → should get MercadoPago
2. Test user from US → should get PayPal
3. Check fallback logic if provider unavailable

### C. Analytics & Chat
1. Complete an interview
2. Check score recorded in history
3. Test performance chat endpoint

### D. Enhanced Abuse Prevention
1. Try signup with disposable email → should be blocked/throttled
2. Check subnet velocity tracking
3. Verify credit throttling

## 12. Monitoring Commands

```bash
# Watch PM2 logs in real-time
pm2 logs Vocaid-backend

# Monitor CPU/Memory usage
pm2 monit

# Check process info
pm2 info Vocaid-backend

# Restart if needed
pm2 restart Vocaid-backend --update-env
```

## 13. Rollback (if needed)

```bash
# Go back to previous commit
git reset --hard HEAD~1

# Reinstall dependencies
npm install

# Rebuild
npm run build

# Restart
pm2 restart Vocaid-backend
```

## Troubleshooting

### Issue: "Cannot find module" errors
**Solution:**
```bash
rm -rf node_modules package-lock.json
npm install
npm run build
pm2 restart Vocaid-backend
```

### Issue: Database connection errors
**Solution:**
```bash
# Check Prisma client is generated
npx prisma generate

# Verify DATABASE_URL
echo $DATABASE_URL

# Test database connection
npx prisma db push --preview-feature
```

### Issue: TypeScript errors
**Solution:**
```bash
# Check TypeScript version
npx tsc --version

# Rebuild with verbose output
npm run build -- --verbose
```

### Issue: Payment provider not available
**Solution:**
```bash
# Verify environment variables are set
env | grep PAYPAL
env | grep MERCADOPAGO

# Check provider availability in logs
pm2 logs Vocaid-backend | grep "payment provider"
```

## Post-Deployment Checklist

- [ ] Backend server restarted successfully
- [ ] Database migrations applied
- [ ] Environment variables configured
- [ ] Health check endpoint responding
- [ ] Multilingual routes accessible
- [ ] Payment providers configured
- [ ] Logs show no critical errors
- [ ] Clerk metadata sync working
- [ ] Retell agents responding in correct languages
- [ ] Analytics tracking score history
- [ ] Chat service responding (if enabled)

## Performance Optimization

### Enable connection pooling in Prisma:

```env
DATABASE_URL="postgresql://...?connection_limit=10&pool_timeout=20"
```

### Set up PM2 cluster mode for multiple cores:

```bash
pm2 start dist/server.js -i max --name Vocaid-backend
```

### Configure log rotation:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
```

## Security Notes

1. **Never commit `.env` file** - use AWS Secrets Manager or EC2 Parameter Store
2. **Rotate PayPal/MercadoPago credentials** regularly
3. **Enable HTTPS** for all endpoints
4. **Set up CloudFlare** for DDoS protection and geo-detection
5. **Monitor for suspicious signup patterns** using abuse prevention logs

## Support

For issues, check:
- `MULTILINGUAL_ARCHITECTURE.md` for architecture details
- PM2 logs: `pm2 logs Vocaid-backend`
- Database logs: Check RDS/PostgreSQL logs
- Retell dashboard: Check agent call history
