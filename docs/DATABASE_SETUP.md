# Database Setup Guide

This guide covers setting up the PostgreSQL database for Vocaid, including local development with Docker and production deployment on GCP.

## Table of Contents

1. [Local Development Setup (Docker)](#local-development-setup-docker)
2. [Database Schema Overview](#database-schema-overview)
3. [Running Migrations](#running-migrations)
4. [GCP PostgreSQL Setup](#gcp-postgresql-setup)
5. [Environment Configuration](#environment-configuration)
6. [API Endpoints](#api-endpoints)
7. [Troubleshooting](#troubleshooting)

---

## Local Development Setup (Docker)

### Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ installed
- npm or yarn

### Step 1: Start PostgreSQL with Docker

```bash
# Navigate to backend directory
cd Vocaid-backend

# Start PostgreSQL and pgAdmin containers
docker-compose up -d

# Verify containers are running
docker-compose ps
```

This starts:
- **PostgreSQL** on port `5432`
- **pgAdmin** on port `5050` (web UI for database management)

### Step 2: Install Dependencies

```bash
# Install Node.js dependencies including Prisma
npm install
```

### Step 3: Configure Environment

Create or update your `.env` file:

```env
# Database Configuration
DATABASE_URL="postgresql://Vocaid:Vocaid_password@localhost:5432/Vocaid?schema=public"

# Node Environment
NODE_ENV=development
```

### Step 4: Run Database Migrations

```bash
# Generate Prisma client
npx prisma generate

# Run migrations to create database tables
npx prisma migrate dev --name init

# (Optional) View database in Prisma Studio
npx prisma studio
```

### Step 5: Start Development Server

```bash
# Start with hot-reloading (nodemon)
npm run dev
```

### Accessing pgAdmin

1. Open http://localhost:5050 in your browser
2. Login with:
   - Email: `admin@Vocaid.ai`
   - Password: `admin_password`
3. Add a new server:
   - Host: `postgres` (Docker network name)
   - Port: `5432`
   - Database: `Vocaid`
   - Username: `Vocaid`
   - Password: `Vocaid_password`

---

## Database Schema Overview

### Models

#### User
Stores user information (internal `user.id` is the canonical identifier).

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Internal unique identifier |
| email | String | User email |
| firstName | String | First name |
| lastName | String | Last name |
| imageUrl | String | Profile image URL |
| credits | Int | Interview credits |
| createdAt | DateTime | Account creation |
| updatedAt | DateTime | Last update |

#### Interview
Stores interview session data and feedback.

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Internal unique identifier |
| retellCallId | String | Retell call ID |
| userId | UUID | Foreign key to User |
| jobTitle | String | Target position |
| companyName | String | Target company |
| jobDescription | Text | Full job description |
| resumeUrl | String | Resume file URL |
| status | Enum | PENDING, IN_PROGRESS, COMPLETED, CANCELLED |
| duration | Int | Interview duration in seconds |
| score | Int | Overall score (0-100) |
| transcript | Text | Full conversation transcript |
| feedback | JSON | Structured feedback object |
| createdAt | DateTime | Interview start time |
| completedAt | DateTime | Interview end time |

#### Payment
Stores payment transaction records.

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Internal unique identifier |
| userId | UUID | Foreign key to User |
| mpPreferenceId | String | MercadoPago preference ID |
| mpPaymentId | String | MercadoPago payment ID |
| amountLocal | Decimal | Amount in local currency |
| amountUSD | Decimal | Amount in USD |
| currency | String | Currency code |
| creditsAmount | Int | Credits purchased |
| status | Enum | PENDING, APPROVED, REJECTED, CANCELLED |
| paymentProvider | String | Payment provider name |
| createdAt | DateTime | Transaction creation |
| updatedAt | DateTime | Last status update |

---

## Running Migrations

### Development

```bash
# Create a new migration
npx prisma migrate dev --name <migration_name>

# Apply pending migrations
npx prisma migrate dev

# Reset database (WARNING: Deletes all data)
npx prisma migrate reset
```

### Production

```bash
# Apply migrations in production
npx prisma migrate deploy
```

---

## GCP PostgreSQL Setup

### Step 1: Create Cloud SQL Instance

```bash
# Create PostgreSQL instance
gcloud sql instances create Vocaid-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1 \
  --root-password=YOUR_SECURE_PASSWORD

# Create database
gcloud sql databases create Vocaid --instance=Vocaid-db

# Create user
gcloud sql users create Vocaid_user \
  --instance=Vocaid-db \
  --password=YOUR_USER_PASSWORD
```

### Step 2: Configure Connection

For **Cloud Run** or **App Engine**, use the Cloud SQL Proxy:

```env
# Production DATABASE_URL format for GCP
DATABASE_URL="postgresql://Vocaid_user:PASSWORD@/Vocaid?host=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME"
```

For **external connections** (not recommended for production):

1. Enable public IP on the instance
2. Add your IP to authorized networks
3. Use direct connection string:

```env
DATABASE_URL="postgresql://Vocaid_user:PASSWORD@INSTANCE_PUBLIC_IP:5432/Vocaid"
```

### Step 3: Deploy Migrations

```bash
# Set production DATABASE_URL
export DATABASE_URL="your_production_connection_string"

# Run migrations
npx prisma migrate deploy
```

---

## Environment Configuration

### Development (.env)

```env
# Database
DATABASE_URL="postgresql://Vocaid:Vocaid_password@localhost:5432/Vocaid?schema=public"

# Node Environment
NODE_ENV=development

# Server
PORT=3001
FRONTEND_URL=http://localhost:3000

# MercadoPago
MERCADOPAGO_ACCESS_TOKEN=TEST-xxxxx
MERCADOPAGO_PUBLIC_KEY=TEST-xxxxx

# AI APIs
OPENAI_API_KEY=sk-xxxxx
GOOGLE_GEMINI_API_KEY=xxxxx

# Retell
RETELL_API_KEY=xxxxx
```

### Production (.env)

```env
# Database
DATABASE_URL="postgresql://user:password@host/database"

# Node Environment
NODE_ENV=production

# Server
PORT=3001
FRONTEND_URL=https://Vocaid.ai
WEBHOOK_BASE_URL=https://api.Vocaid.ai

# Security
CORS_ORIGIN=https://Vocaid.ai

# (... other production keys ...)
```

---

## API Endpoints

### User Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users/me` | Get current user profile |
| GET | `/api/users/me/dashboard` | Get dashboard statistics |
| GET | `/api/users/:userId/stats` | Get user statistics |
| GET | `/api/users/:userId/interviews` | Get user's interviews |
| GET | `/api/users/:userId/payments` | Get payment history |
| GET | `/api/users/:userId/score-evolution` | Get score history |
| GET | `/api/users/:userId/spending` | Get spending history |

### Interview Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/interviews` | List all user's interviews |
| GET | `/api/interviews/:id` | Get interview details |
| POST | `/api/interviews` | Create new interview |
| PATCH | `/api/interviews/:id` | Update interview |
| GET | `/api/interviews/stats` | Get interview statistics |

### Payment Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/payments` | List all user's payments |
| GET | `/api/payments/stats` | Get payment statistics |

---

## npm Scripts

```bash
# Development
npm run dev          # Start with nodemon hot-reload
npm run build        # Compile TypeScript
npm start            # Start production server

# Database
npm run db:generate  # Generate Prisma client
npm run db:migrate   # Run migrations
npm run db:push      # Push schema (skip migrations)
npm run db:studio    # Open Prisma Studio

# Docker
npm run docker:up    # Start PostgreSQL
npm run docker:down  # Stop PostgreSQL
```

---

## Troubleshooting

### Connection Issues

**Error: Connection refused**
```bash
# Check if Docker containers are running
docker-compose ps

# Check PostgreSQL logs
docker-compose logs postgres
```

**Error: Authentication failed**
```bash
# Reset password
docker-compose down -v
docker-compose up -d
```

### Migration Issues

**Error: Migration failed**
```bash
# Reset database (development only)
npx prisma migrate reset

# Force regenerate client
npx prisma generate --force
```

### TypeScript Errors

After installing dependencies, if you see type errors:

```bash
# Ensure Prisma client is generated
npx prisma generate

# Restart TypeScript server in VS Code
# Cmd+Shift+P > "TypeScript: Restart TS Server"
```

---

## Security Considerations

1. **Never commit `.env` files** - Use `.env.example` as template
2. **Rotate database passwords** regularly
3. **Use IAM authentication** for GCP Cloud SQL when possible
4. **Enable SSL** for database connections in production
5. **Implement rate limiting** on API endpoints
6. **Audit log** sensitive database operations

---

## Next Steps

1. ✅ Set up local Docker environment
2. ✅ Run initial migrations
3. ⬜ Configure GCP Cloud SQL for production
4. ⬜ Set up CI/CD pipeline with migrations
5. ⬜ Implement database backups
6. ⬜ Add monitoring and alerting
