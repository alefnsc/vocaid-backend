#!/bin/bash
# ========================================
# AWS CodeDeploy - After Install Hook
# ========================================
# Runs after new files are copied
# Installs dependencies and runs database migrations

set -e

echo "=== After Install: Starting setup ==="

APP_DIR="/home/ec2-user/vocaid-backend"
cd "$APP_DIR"

# Restore .env file if backed up
if [ -f "/tmp/vocaid-backend-env-backup" ]; then
    echo "Restoring .env file..."
    cp /tmp/vocaid-backend-env-backup "$APP_DIR/.env"
    rm /tmp/vocaid-backend-env-backup
fi

# Check for required environment variables
if [ ! -f "$APP_DIR/.env" ]; then
    echo "ERROR: .env file not found! Please create it manually."
    echo "Required variables: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
    exit 1
fi

# Load environment variables for this script
set -a
source "$APP_DIR/.env"
set +a

# Verify critical env vars
if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL is not set in .env"
    exit 1
fi

# Install Node.js dependencies
echo "Installing dependencies..."
npm ci --production=false

# Generate Prisma client
echo "Generating Prisma client..."
npx prisma generate

# Run database migrations
echo "Running database migrations..."
npx prisma migrate deploy

# Build TypeScript (if needed)
if [ -f "tsconfig.json" ]; then
    echo "Building TypeScript..."
    npm run build 2>/dev/null || echo "No build script found, skipping..."
fi

# Set correct permissions
echo "Setting permissions..."
chmod -R 755 "$APP_DIR"

echo "=== After Install: Setup complete ==="
