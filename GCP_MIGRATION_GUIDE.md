# Voxly GCP Migration Guide

This guide provides comprehensive steps for migrating the Voxly application stack from the current infrastructure (Clerk, OpenAI, AWS EC2) to a Google Cloud Platform (GCP) stack using Google Auth, Gemini API, and GCP services with PostgreSQL.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Phase 1: Google Authentication (Replace Clerk)](#phase-1-google-authentication-replace-clerk)
4. [Phase 2: Gemini API (Replace OpenAI)](#phase-2-gemini-api-replace-openai)
5. [Phase 3: GCP Backend Services (Replace AWS EC2)](#phase-3-gcp-backend-services-replace-aws-ec2)
6. [Phase 4: PostgreSQL Cloud SQL (Replace Current DB)](#phase-4-postgresql-cloud-sql-replace-current-db)
7. [Environment Variables](#environment-variables)
8. [Testing & Validation](#testing--validation)
9. [Rollback Plan](#rollback-plan)

---

## Overview

### Current Stack
| Component | Current Service | New Service |
|-----------|----------------|-------------|
| Authentication | Clerk | Google Identity Platform / Firebase Auth |
| LLM API | OpenAI GPT-4 | Google Gemini API |
| Backend Hosting | AWS EC2 | Google Cloud Run / Compute Engine |
| Database | PostgreSQL (Neon) | Google Cloud SQL for PostgreSQL |
| Voice AI | Retell AI | Retell AI (unchanged) |
| Payments | MercadoPago | MercadoPago (unchanged) |

---

## Prerequisites

1. **GCP Account** with billing enabled
2. **GCP Project** created (e.g., `voxly-production`)
3. **gcloud CLI** installed and authenticated
4. **Google Cloud Console** access
5. **Service Account** with appropriate permissions

```bash
# Install gcloud CLI (macOS)
brew install google-cloud-sdk

# Authenticate
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

## Phase 3: GCP Backend Services (Replace AWS EC2)

### Option A: Google Cloud Run (Recommended - Serverless)

#### Step 3A.1: Create Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY .env.production ./.env

EXPOSE 8080

CMD ["node", "dist/server.js"]
```

#### Step 3A.2: Build and Deploy

```bash
# Build the application
npm run build

# Build container
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/voxly-backend

# Deploy to Cloud Run
gcloud run deploy voxly-backend \
  --image gcr.io/YOUR_PROJECT_ID/voxly-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 10 \
  --set-env-vars "NODE_ENV=production"
```

### Option B: Google Compute Engine (VM-based)

#### Step 3B.1: Create VM Instance

```bash
gcloud compute instances create voxly-backend \
  --machine-type e2-medium \
  --zone us-central1-a \
  --image-family ubuntu-2204-lts \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 20GB \
  --tags http-server,https-server
```

#### Step 3B.2: Configure Firewall

```bash
gcloud compute firewall-rules create allow-http \
  --allow tcp:80,tcp:443,tcp:3001 \
  --target-tags http-server,https-server
```

#### Step 3B.3: SSH and Setup

```bash
gcloud compute ssh voxly-backend --zone us-central1-a

# On the VM:
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx

# Clone and setup application
git clone https://github.com/your-repo/voxly-backend.git
cd voxly-backend
npm install
npm run build

# Setup PM2 for process management
sudo npm install -g pm2
pm2 start dist/server.js --name voxly-backend
pm2 startup
pm2 save
```

## Phase 4: PostgreSQL Cloud SQL (Replace Current DB)

### Step 4.1: Create Cloud SQL Instance

```bash
# Enable Cloud SQL API
gcloud services enable sqladmin.googleapis.com

# Create PostgreSQL instance
gcloud sql instances create voxly-postgres \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1 \
  --storage-type=SSD \
  --storage-size=10GB \
  --availability-type=ZONAL

# Set root password
gcloud sql users set-password postgres \
  --instance=voxly-postgres \
  --password=YOUR_SECURE_PASSWORD
```

### Step 4.2: Create Database and User

```bash
# Create database
gcloud sql databases create voxly --instance=voxly-postgres

# Create application user
gcloud sql users create voxly_app \
  --instance=voxly-postgres \
  --password=YOUR_APP_PASSWORD
```

### Step 4.3: Configure Connection

**For Cloud Run (recommended):**

```bash
# Add Cloud SQL connection
gcloud run services update voxly-backend \
  --add-cloudsql-instances YOUR_PROJECT_ID:us-central1:voxly-postgres
```

**Connection String:**

```
# Using Cloud SQL Proxy (local development)
postgresql://voxly_app:PASSWORD@localhost:5432/voxly

# Using private IP (Cloud Run/Compute Engine)
postgresql://voxly_app:PASSWORD@/voxly?host=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME
```

### Step 4.4: Migrate Data

```bash
# Export from current database (Neon)
pg_dump -h your-neon-host -U user -d database > backup.sql

# Import to Cloud SQL
gcloud sql connect voxly-postgres --user=postgres
\i backup.sql
```

### Step 4.5: Update Prisma Schema

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

---

## Environment Variables

### Frontend (.env.production)

```env
# Firebase (replaces Clerk)
REACT_APP_FIREBASE_API_KEY=your-firebase-api-key
REACT_APP_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=your-project-id
REACT_APP_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=123456789
REACT_APP_FIREBASE_APP_ID=1:123456789:web:abc123

# API
REACT_APP_API_URL=https://your-cloud-run-url.run.app
```

### Backend (.env.production)

```env
# Firebase Admin
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Gemini (replaces OpenAI)
GEMINI_API_KEY=your-gemini-api-key

# Database (Cloud SQL)
DATABASE_URL=postgresql://voxly_app:PASSWORD@/voxly?host=/cloudsql/PROJECT:REGION:INSTANCE

# Retell AI (unchanged)
RETELL_API_KEY=your-retell-api-key

# MercadoPago (unchanged)
MERCADOPAGO_ACCESS_TOKEN=your-mercadopago-token

# Server
PORT=8080
NODE_ENV=production
```

---

## Testing & Validation

### Checklist

- [ ] Firebase Auth login/signup works
- [ ] Google OAuth login works
- [ ] Token verification on backend succeeds
- [ ] Gemini API generates interview questions
- [ ] WebSocket connection to Retell AI works
- [ ] Database CRUD operations work
- [ ] Payment flow with MercadoPago works
- [ ] Cloud Run/Compute Engine accessible
- [ ] SSL/HTTPS configured
- [ ] Environment variables set correctly

### Test Commands

```bash
# Test Firebase Auth
curl -X POST https://your-api-url/api/auth/verify \
  -H "Authorization: Bearer YOUR_FIREBASE_ID_TOKEN"

# Test Gemini API
curl -X POST https://your-api-url/api/interview/generate-questions \
  -H "Content-Type: application/json" \
  -d '{"position": "Software Engineer", "company": "Google"}'

# Test Database
curl https://your-api-url/api/health
```

---

## Rollback Plan

If migration fails, revert to original stack:

1. **DNS**: Point domain back to AWS EC2
2. **Frontend**: Redeploy with Clerk environment variables
3. **Backend**: Restart EC2 instance with original `.env`
4. **Database**: No changes needed (keep Neon active during migration)

### Rollback Commands

```bash
# Revert frontend deployment
cd voxly-frontend
git checkout main
npm install @clerk/clerk-react
vercel --prod

# Restart AWS EC2 backend
ssh ec2-user@your-ec2-ip
pm2 restart voxly-backend
```

---

## Cost Comparison

| Service | Current (AWS/Clerk/OpenAI) | GCP Stack |
|---------|---------------------------|-----------|
| Auth | Clerk Free/Pro ($25+) | Firebase Free (10k users) |
| LLM | OpenAI ($0.03/1k tokens) | Gemini ($0.0025-0.0075/1k) |
| Compute | EC2 t3.medium (~$30/mo) | Cloud Run (~$10-50/mo) |
| Database | Neon Free/Pro | Cloud SQL ($7-50/mo) |

---

## Support

For issues during migration:

1. Check GCP Cloud Logging: `console.cloud.google.com/logs`
2. Review Firebase Console for auth issues
3. Test Gemini API in AI Studio
4. Contact: support@voxly.ai
