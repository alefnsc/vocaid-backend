# Supabase Migration Rollback Plan

This document outlines the rollback procedures for each component of the Clerk → Supabase migration. Use these procedures if issues arise during or after the migration.

---

## Table of Contents

1. [Pre-Rollback Checklist](#pre-rollback-checklist)
2. [Auth Rollback (Supabase → Clerk)](#auth-rollback-supabase--clerk)
3. [Database Rollback (Supabase Postgres → EC2 Postgres)](#database-rollback-supabase-postgres--ec2-postgres)
4. [Storage Rollback (Supabase Storage → Base64/S3)](#storage-rollback-supabase-storage--base64s3)
5. [Frontend Rollback](#frontend-rollback)
6. [Backend Rollback](#backend-rollback)
7. [CodeDeploy Rollback](#codedeploy-rollback)
8. [Emergency Contacts](#emergency-contacts)

---

## Pre-Rollback Checklist

Before initiating any rollback:

- [ ] **Notify stakeholders** of the rollback decision
- [ ] **Document the issue** that triggered the rollback
- [ ] **Take database backup** of current Supabase state
- [ ] **Export any new user data** created post-migration
- [ ] **Verify Clerk account is still active** and has API keys
- [ ] **Confirm EC2 Postgres container** is still running or can be started

---

## Auth Rollback (Supabase → Clerk)

### Severity: HIGH
### Estimated Time: 30-60 minutes

### Step 1: Restore Clerk Environment Variables

```bash
# In vocaid-backend/.env
CLERK_SECRET_KEY=sk_live_xxxxx  # Restore from secrets manager
CLERK_PUBLISHABLE_KEY=pk_live_xxxxx

# In vocaid-frontend/.env
REACT_APP_CLERK_PUBLISHABLE_KEY=pk_live_xxxxx
```

### Step 2: Revert Backend Middleware

```bash
# In src/middleware/authMiddleware.ts
# Revert to Clerk verification (use git to restore)
git checkout HEAD~X -- src/middleware/authMiddleware.ts
```

Or manually restore:
```typescript
// src/middleware/authMiddleware.ts
import { clerkClient } from '@clerk/clerk-sdk-node';

export const authMiddleware = async (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const user = await clerkClient.users.getUser(userId);
    req.user = { id: userId, email: user.emailAddresses[0]?.emailAddress };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid user' });
  }
};
```

### Step 3: Revert Frontend Auth Context

```bash
# Restore ClerkProvider in App.tsx
git checkout HEAD~X -- src/App.tsx
git checkout HEAD~X -- src/contexts/AuthContext.tsx
```

### Step 4: Update Frontend API Service

```typescript
// src/services/APIService.ts
// Revert to x-user-id header
private async getHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  const user = window.Clerk?.user;
  if (user?.id) {
    headers['x-user-id'] = user.id;
  }
  
  return headers;
}
```

### Step 5: User Data Migration (if needed)

If users were created in Supabase during the migration window:

```sql
-- Export new Supabase users
SELECT id, email, phone, created_at 
FROM auth.users 
WHERE created_at > 'MIGRATION_START_DATE';

-- These users will need to re-register in Clerk
-- Or manually create them via Clerk Dashboard/API
```

---

## Database Rollback (Supabase Postgres → EC2 Postgres)

### Severity: CRITICAL
### Estimated Time: 1-2 hours

### Step 1: Verify EC2 Postgres Container

```bash
# SSH into EC2
ssh -i ~/.ssh/your-key.pem ec2-user@your-ec2-ip

# Check if Postgres container is running
docker ps | grep postgres

# If not running, start it
docker-compose up -d postgres
```

### Step 2: Export Data from Supabase

```bash
# Use pg_dump to export Supabase data
pg_dump "postgresql://postgres:[password]@db.vnbauggmguyyyqpndwgn.supabase.co:5432/postgres" \
  --data-only \
  --exclude-table-data='auth.*' \
  --exclude-table-data='storage.*' \
  > supabase_data_backup.sql
```

### Step 3: Restore Original Prisma Migrations

```bash
# Move legacy migrations back
cd /path/to/vocaid-backend/prisma
rm -rf migrations
mv migrations_legacy migrations

# Reset database and apply migrations
npx prisma migrate reset --force
npx prisma migrate deploy
```

### Step 4: Import Data to EC2 Postgres

```bash
# Copy backup to EC2
scp supabase_data_backup.sql ec2-user@your-ec2-ip:/tmp/

# Import into EC2 Postgres
docker exec -i postgres_container psql -U postgres -d vocaid < /tmp/supabase_data_backup.sql
```

### Step 5: Update Backend Database URL

```bash
# In vocaid-backend/.env
DATABASE_URL="postgresql://postgres:password@localhost:5432/vocaid"
# Remove or comment out:
# SUPABASE_URL=...
# SUPABASE_ANON_KEY=...
# SUPABASE_SERVICE_ROLE_KEY=...
```

### Step 6: Restart Services

```bash
pm2 restart vocaid-backend
```

---

## Storage Rollback (Supabase Storage → Base64/S3)

### Severity: MEDIUM
### Estimated Time: 1-2 hours

### Step 1: Export Files from Supabase Storage

```typescript
// scripts/export-storage.ts
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const buckets = ['resumes', 'feedback-pdfs', 'docs', 'images'];

async function exportBucket(bucketName: string) {
  const { data: files } = await supabase.storage.from(bucketName).list();
  
  for (const file of files || []) {
    const { data } = await supabase.storage
      .from(bucketName)
      .download(file.name);
    
    if (data) {
      const buffer = Buffer.from(await data.arrayBuffer());
      const outputPath = path.join('./storage-backup', bucketName, file.name);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buffer);
    }
  }
}

async function main() {
  for (const bucket of buckets) {
    await exportBucket(bucket);
  }
}

main();
```

### Step 2: Convert Files Back to Base64 (if applicable)

```typescript
// scripts/convert-to-base64.ts
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/providers/prismaProvider';

async function convertResumesToBase64() {
  const resumeDir = './storage-backup/resumes';
  const files = fs.readdirSync(resumeDir);
  
  for (const file of files) {
    const userId = file.split('/')[0]; // Assuming userId/filename structure
    const filePath = path.join(resumeDir, file);
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    
    // Update database with base64 data
    await prisma.resumeDocument.updateMany({
      where: { userId },
      data: { pdfBase64: base64 }
    });
  }
}

convertResumesToBase64();
```

### Step 3: Revert Storage Service

```bash
# Restore original storage service
git checkout HEAD~X -- src/services/storageService.ts
```

---

## Frontend Rollback

### Severity: MEDIUM
### Estimated Time: 15-30 minutes

### Step 1: Revert Package.json

```bash
cd vocaid-frontend

# Remove Supabase package
npm uninstall @supabase/supabase-js

# Ensure Clerk is installed
npm install @clerk/clerk-react
```

### Step 2: Revert Source Files

```bash
# Restore all modified files
git checkout HEAD~X -- src/lib/supabase.ts  # Delete this file
git checkout HEAD~X -- src/App.tsx
git checkout HEAD~X -- src/services/APIService.ts
git checkout HEAD~X -- src/contexts/

# Remove new Supabase files
rm -f src/lib/supabase.ts
rm -f src/services/SupabaseAuthService.ts
rm -f src/contexts/SupabaseAuthContext.tsx
```

### Step 3: Rebuild and Deploy

```bash
npm run build
# Deploy to Vercel or your hosting platform
vercel --prod
```

---

## Backend Rollback

### Severity: MEDIUM
### Estimated Time: 15-30 minutes

### Step 1: Revert Package.json

```bash
cd vocaid-backend

# Remove Supabase package
npm uninstall @supabase/supabase-js

# Ensure Clerk is installed
npm install @clerk/clerk-sdk-node
```

### Step 2: Revert Source Files

```bash
# Remove new Supabase files
rm -f src/providers/supabaseProvider.ts
rm -f src/middleware/supabaseAuthMiddleware.ts
rm -f src/routes/supabaseUserRoutes.ts

# Restore original files
git checkout HEAD~X -- src/config/env.ts
git checkout HEAD~X -- src/middleware/authMiddleware.ts
git checkout HEAD~X -- src/routes/index.ts
```

### Step 3: Restore server.ts

```bash
git checkout HEAD~X -- src/server.ts
```

### Step 4: Restart Services

```bash
pm2 restart vocaid-backend
```

---

## CodeDeploy Rollback

### Severity: LOW
### Estimated Time: 5-10 minutes

### Option 1: Manual Rollback via AWS Console

1. Go to AWS CodeDeploy Console
2. Navigate to Deployments
3. Find the previous successful deployment
4. Click "Rollback"

### Option 2: CLI Rollback

```bash
# Get deployment history
aws deploy list-deployments \
  --application-name vocaid-backend \
  --deployment-group-name staging \
  --include-only-statuses Succeeded

# Get the previous deployment ID and create rollback
aws deploy create-deployment \
  --application-name vocaid-backend \
  --deployment-group-name staging \
  --revision revisionType=GitHub,repository=your-org/vocaid-backend,commitId=PREVIOUS_COMMIT_SHA
```

### Option 3: Remove CodeDeploy Configuration

```bash
# Simply remove the CodeDeploy files if not needed
rm -f appspec.yml
rm -rf scripts/codedeploy/
```

---

## Quick Reference Commands

### Full System Rollback (Emergency)

```bash
#!/bin/bash
# emergency-rollback.sh

echo "🚨 EMERGENCY ROLLBACK INITIATED"

# 1. Stop all services
pm2 stop all

# 2. Restore from last known good state
cd /path/to/vocaid-backend
git checkout LAST_GOOD_COMMIT

# 3. Restore environment
cp .env.backup .env

# 4. Install dependencies
npm ci

# 5. Restart services
pm2 start ecosystem.config.js

echo "✅ Rollback complete. Verify services."
```

### Verify System Health Post-Rollback

```bash
#!/bin/bash
# verify-rollback.sh

echo "Checking health..."

# Check backend
curl -s http://localhost:3001/health | jq .

# Check database connection
npx prisma db pull --print

# Check PM2 processes
pm2 status

# Check logs for errors
pm2 logs --lines 50 | grep -i error
```

---

## Emergency Contacts

| Role | Contact | Responsibility |
|------|---------|----------------|
| Backend Lead | TBD | Database/API rollback |
| Frontend Lead | TBD | UI/Auth rollback |
| DevOps | TBD | Infrastructure/CodeDeploy |
| Supabase Support | support@supabase.io | Supabase-specific issues |
| Clerk Support | support@clerk.dev | Clerk-specific issues |

---

## Rollback Decision Matrix

| Issue | Severity | Rollback Scope |
|-------|----------|----------------|
| Auth failures (all users) | CRITICAL | Full auth rollback |
| Auth failures (some users) | HIGH | Investigate before rollback |
| Database connection issues | CRITICAL | Full database rollback |
| Storage access issues | MEDIUM | Storage rollback only |
| Performance degradation | LOW | Monitor, rollback if persists |
| Single API endpoint failure | LOW | Fix forward preferred |

---

## Post-Rollback Actions

1. **Document the failure** in incident report
2. **Identify root cause** before re-attempting migration
3. **Update migration plan** with lessons learned
4. **Test thoroughly** in staging before next attempt
5. **Schedule re-migration** with proper change window

---

*Last Updated: Auto-generated during migration*
*Version: 1.0*
