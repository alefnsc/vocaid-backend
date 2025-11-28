# AWS Bedrock + EC2 Server Setup Guide for Voxly

This guide explains how to set up AWS Bedrock (Claude) and deploy the Voxly backend on an EC2 instance.

## Table of Contents
1. [AWS Account Setup](#aws-account-setup)
2. [Enable AWS Bedrock](#enable-aws-bedrock)
3. [Create EC2 Instance](#create-ec2-instance)
4. [Configure Security Groups](#configure-security-groups)
5. [Deploy Backend](#deploy-backend)
6. [Configure Retell Agent](#configure-retell-agent)

---

## 1. AWS Account Setup

If you don't have an AWS account:
1. Go to [aws.amazon.com](https://aws.amazon.com)
2. Click "Create an AWS Account"
3. Complete the registration process (requires credit card)

### Create IAM User with Programmatic Access

1. Go to **IAM** service in AWS Console
2. Click **Users** → **Create user**
3. Name: `voxly-backend`
4. Check **Provide user access to the AWS Management Console** (optional)
5. Click **Next**
6. Select **Attach policies directly**
7. Add these policies:
   - `AmazonBedrockFullAccess`
   - `AmazonEC2FullAccess` (if managing EC2 via CLI)
8. Create user
    Console sign-in URL: https://411127385672.signin.aws.amazon.com/console
    User name: voxly
    Console password: #vIL7)22
9. Go to the user → **Security credentials** → **Create access key**
10. Select **Application running outside AWS**
11. Save the **Access Key ID** and **Secret Access Key**

---

## 2. Enable AWS Bedrock

### Request Model Access

1. Go to **Amazon Bedrock** in AWS Console
2. Select your region (e.g., `us-east-1` or `us-west-2`)
3. Go to **Model access** in the left sidebar
4. Click **Manage model access**
5. Select these models:
   - **Anthropic** → **Claude 3 Sonnet** (recommended for balance of cost/quality)
   - **Anthropic** → **Claude 3 Haiku** (faster, cheaper)
   - **Anthropic** → **Claude 3 Opus** (highest quality, most expensive)
6. Click **Request model access**
7. Wait for approval (usually instant for Claude models)

### Verify Model Access

```bash
# Install AWS CLI if not installed
brew install awscli  # macOS

# Configure AWS CLI
aws configure
# Enter your Access Key ID
# Enter your Secret Access Key
# Default region: us-east-1 (or your preferred region)
# Default output format: json

# Test Bedrock access
aws bedrock list-foundation-models --region us-east-1 | grep "modelId"
```

---

## 3. Create EC2 Instance

### Launch Instance

1. Go to **EC2** in AWS Console
2. Click **Launch instance**
3. Configure:
   - **Name**: `voxly-backend`
   - **OS**: Ubuntu Server 24.04 LTS
   - **Instance type**: `t3.small` (2 vCPU, 2 GB RAM) - minimum recommended
   - **Key pair**: Create new or select existing
   - **Network settings**: 
     - Allow SSH (port 22)
     - Allow HTTPS (port 443)
     - Allow Custom TCP (port 3001) - for backend
   - **Storage**: 20 GB gp3

4. Click **Launch instance**

### Connect to Instance

```bash
# Make key file secure
chmod 400 your-key.pem

# Connect via SSH
ssh -i your-key.pem ubuntu@<your-ec2-public-ip>
```

### Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version  # Should be v20.x
npm --version

# Install PM2 for process management
sudo npm install -g pm2

# Install nginx for reverse proxy
sudo apt install -y nginx
```

---

## 4. Configure Security Groups

### Inbound Rules

| Type | Protocol | Port | Source |
|------|----------|------|--------|
| SSH | TCP | 22 | Your IP |
| HTTPS | TCP | 443 | 0.0.0.0/0 |
| Custom TCP | TCP | 3001 | 0.0.0.0/0 |

### Setup Nginx Reverse Proxy with SSL

```bash
# Install certbot for SSL
sudo apt install -y certbot python3-certbot-nginx

# Create nginx config
sudo nano /etc/nginx/sites-available/voxly

# Add this configuration:
```

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

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
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    location /llm-websocket {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/voxly /etc/nginx/sites-enabled/

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Test nginx config
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx
```

---

## 5. Deploy Backend

### Configure SSH for GitHub (Private Repositories)

If your repository is private, you need to set up SSH authentication on the EC2 instance:

#### Step 1: Generate SSH Key on EC2

```bash
# Connect to your EC2 instance first
ssh -i your-key.pem ubuntu@<your-ec2-public-ip>

# Generate a new SSH key pair
ssh-keygen -t ed25519 -C "your-email@example.com"

# When prompted:
# - Press Enter to accept default location (~/.ssh/id_ed25519)
# - Enter a passphrase (optional, press Enter for none)
```

#### Step 2: Add SSH Key to GitHub

```bash
# Display your public key
cat ~/.ssh/id_ed25519.pub
```

Copy the entire output, then:

1. Go to [GitHub.com](https://github.com) → **Settings** (click your profile picture)
2. Navigate to **SSH and GPG keys** in the left sidebar
3. Click **New SSH key**
4. Configure:
   - **Title**: `Voxly EC2 Server` (or any descriptive name)
   - **Key type**: Authentication Key
   - **Key**: Paste the public key you copied
5. Click **Add SSH key**
6. Confirm with your GitHub password if prompted

#### Step 3: Configure SSH on EC2

```bash
# Start the SSH agent
eval "$(ssh-agent -s)"

# Add your SSH key to the agent
ssh-add ~/.ssh/id_ed25519

# Test the GitHub connection
ssh -T git@github.com
```

You should see:
```
Hi alefnsc! You've successfully authenticated, but GitHub does not provide shell access.
```

#### Step 4: Configure Git (Optional but Recommended)

```bash
# Set your Git identity
git config --global user.name "Your Name"
git config --global user.email "your-email@example.com"
```

### Clone and Setup

```bash
# Clone your repository using SSH (for private repos)
cd ~
git clone git@github.com:alefnsc/voxly.git voxly
cd voxly/voxly-back

# OR use HTTPS (for public repos - no SSH setup needed)
# git clone https://github.com/alefnsc/voxly.git voxly

# Install dependencies
npm install

# Create .env file
nano .env
```

### Configure Environment Variables

```env
# Server
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://your-frontend-domain.com
WEBHOOK_BASE_URL=https://your-domain.com

# OpenAI (for feedback generation)
OPENAI_API_KEY=sk-your-openai-key

# AWS Bedrock (for interview AI) - Optional if using OpenAI
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_REGION=us-east-1

# Retell
RETELL_API_KEY=your-retell-api-key
RETELL_AGENT_ID=your-agent-id

# Mercado Pago
MERCADOPAGO_ACCESS_TOKEN=your-mp-token

# Clerk
CLERK_SECRET_KEY=your-clerk-secret
```

### Build and Start

```bash
# Build TypeScript
npm run build

# Start with PM2
pm2 start dist/server.js --name voxly-backend

# Save PM2 config
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Run the command it outputs
```

### Useful PM2 Commands

```bash
pm2 status              # Check status
pm2 logs voxly-backend  # View logs
pm2 restart voxly-backend
pm2 stop voxly-backend
```

---

## 6. Configure Retell Agent

### Update Agent WebSocket URL

1. Go to [Retell Dashboard](https://beta.retellai.com/)
2. Select your agent
3. Under **LLM Configuration**:
   - Type: **Custom LLM**
   - LLM WebSocket URL: `wss://your-domain.com/llm-websocket/{call_id}`

### Test the Setup

1. Make a test call from your frontend
2. Check backend logs: `pm2 logs voxly-backend`
3. Verify WebSocket connection is established
4. Confirm agent responds with audio

---

## Switching from OpenAI to AWS Bedrock

If you want to use AWS Bedrock (Claude) instead of OpenAI for the interview AI, you'll need to update the `customLLMWebSocket.ts` file:

### Install AWS SDK

```bash
npm install @aws-sdk/client-bedrock-runtime @langchain/aws @langchain/core
```

### Update customLLMWebSocket.ts

Replace the OpenAI initialization with:

```typescript
import { BedrockChat } from '@langchain/aws';

const model = new BedrockChat({
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  },
  streaming: true
});
```

The Python backend uses this approach - refer to `ai-mock-interview-back/api/ai_mock_interviewer/ai_mock_interviewer.py` for the complete implementation.

---

## Troubleshooting

### WebSocket Connection Issues

1. Check nginx WebSocket configuration
2. Verify SSL certificate is valid
3. Ensure Retell agent has correct WebSocket URL

### Bedrock Access Denied

1. Verify IAM user has `AmazonBedrockFullAccess`
2. Check model access is approved in Bedrock console
3. Verify region matches in all configurations

### EC2 Instance Unreachable

1. Check security group inbound rules
2. Verify instance is running
3. Check public IP hasn't changed (consider Elastic IP)

---

## Cost Estimates (Monthly)

| Service | Cost |
|---------|------|
| EC2 t3.small | ~$15 |
| Bedrock Claude 3 Sonnet | ~$3 per 1M input tokens, ~$15 per 1M output tokens |
| Data Transfer | ~$0.09/GB (first 10TB) |
| SSL Certificate | Free (Let's Encrypt) |

For a typical interview (1000 tokens input, 500 tokens output per turn, 10 turns):
- ~$0.003 per interview

---

## Quick Start Commands Reference

```bash
# SSH into server
ssh -i key.pem ubuntu@<ip>

# View logs
pm2 logs voxly-backend --lines 100

# Restart backend
pm2 restart voxly-backend

# Check nginx status
sudo systemctl status nginx

# Renew SSL (auto-renews, but manual if needed)
sudo certbot renew
```
