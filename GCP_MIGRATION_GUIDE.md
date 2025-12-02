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

---

## Phase 1: Google Authentication (Replace Clerk)

### Step 1.1: Enable Google Identity Platform

```bash
# Enable required APIs
gcloud services enable identitytoolkit.googleapis.com
gcloud services enable iamcredentials.googleapis.com
```

### Step 1.2: Configure Firebase Auth (Recommended)

Firebase Authentication provides a drop-in replacement for Clerk with similar features.

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Add your GCP project to Firebase
3. Navigate to **Authentication** > **Sign-in method**
4. Enable desired providers:
   - Email/Password
   - Google
   - GitHub (optional)

### Step 1.3: Install Firebase SDK

**Frontend (React):**

```bash
cd voxly-frontend
npm uninstall @clerk/clerk-react
npm install firebase
```

**Create `src/lib/firebase.ts`:**

```typescript
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Auth helper functions
export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);
export const signInEmail = (email: string, password: string) => 
  signInWithEmailAndPassword(auth, email, password);
export const signUpEmail = (email: string, password: string) => 
  createUserWithEmailAndPassword(auth, email, password);
export const logout = () => signOut(auth);
export { onAuthStateChanged, type User };
```

### Step 1.4: Create Auth Context (Replace ClerkProvider)

**Create `src/contexts/AuthContext.tsx`:**

```typescript
import React, { createContext, useContext, useEffect, useState } from 'react';
import { auth, onAuthStateChanged, User } from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  isSignedIn: boolean;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isSignedIn: false,
  isLoading: true
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsLoading(false);
    });
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, isSignedIn: !!user, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
```

### Step 1.5: Update App.tsx

```typescript
// Replace ClerkProvider with AuthProvider
import { AuthProvider } from './contexts/AuthContext';

function App() {
  return (
    <AuthProvider>
      {/* ... rest of your app */}
    </AuthProvider>
  );
}
```

### Step 1.6: Backend Token Verification

**Install Firebase Admin SDK:**

```bash
cd voxly-backend
npm uninstall @clerk/clerk-sdk-node
npm install firebase-admin
```

**Create `src/lib/firebaseAdmin.ts`:**

```typescript
import admin from 'firebase-admin';

// Initialize with service account
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  })
});

export const verifyToken = async (idToken: string) => {
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken;
  } catch (error) {
    throw new Error('Invalid token');
  }
};

export default admin;
```

---

## Phase 2: Gemini API (Replace OpenAI)

### Step 2.1: Enable Gemini API

```bash
gcloud services enable generativelanguage.googleapis.com
```

### Step 2.2: Get API Key

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Click "Get API Key"
3. Create a new API key for your project

### Step 2.3: Install Gemini SDK

```bash
cd voxly-backend
npm uninstall openai
npm install @google/generative-ai
```

### Step 2.4: Create Gemini Service

**Create `src/services/geminiService.ts`:**

```typescript
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Model mapping from OpenAI to Gemini
// GPT-4 → gemini-1.5-pro
// GPT-3.5 → gemini-1.5-flash

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class GeminiService {
  private model: GenerativeModel;

  constructor(modelName: string = 'gemini-1.5-pro') {
    this.model = genAI.getGenerativeModel({ model: modelName });
  }

  async generateResponse(
    messages: ChatMessage[],
    systemPrompt?: string
  ): Promise<string> {
    // Convert OpenAI message format to Gemini format
    const history = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    // Get the last user message
    const lastMessage = messages[messages.length - 1];
    
    // Create chat with system instruction
    const chat = this.model.startChat({
      history: history.slice(0, -1),
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.7,
        topP: 0.9,
      },
      systemInstruction: systemPrompt || messages.find(m => m.role === 'system')?.content
    });

    const result = await chat.sendMessage(lastMessage.content);
    return result.response.text();
  }

  async generateStreamingResponse(
    messages: ChatMessage[],
    systemPrompt?: string,
    onChunk: (text: string) => void
  ): Promise<string> {
    const history = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const lastMessage = messages[messages.length - 1];

    const chat = this.model.startChat({
      history: history.slice(0, -1),
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.7,
        topP: 0.9,
      },
      systemInstruction: systemPrompt || messages.find(m => m.role === 'system')?.content
    });

    const result = await chat.sendMessageStream(lastMessage.content);
    let fullResponse = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      fullResponse += text;
      onChunk(text);
    }

    return fullResponse;
  }
}

export const geminiService = new GeminiService();
```

### Step 2.5: Update LLM WebSocket Service

Replace OpenAI calls in `src/services/customLLMWebSocket.ts`:

```typescript
// Replace OpenAI imports
// import OpenAI from 'openai';
import { geminiService } from './geminiService';

// Replace OpenAI API calls with Gemini
const response = await geminiService.generateResponse(messages, systemPrompt);
```

---

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

---

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
