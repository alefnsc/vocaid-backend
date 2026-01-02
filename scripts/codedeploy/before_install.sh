#!/bin/bash
# ========================================
# AWS CodeDeploy - Before Install Hook
# ========================================
# Runs before the new version is copied to the deployment directory
# Cleans up old deployment artifacts

set -e

echo "=== Before Install: Starting cleanup ==="

APP_DIR="/home/ec2-user/vocaid-backend"

# Backup current .env if it exists (we don't want to lose env vars)
if [ -f "$APP_DIR/.env" ]; then
    echo "Backing up .env file..."
    cp "$APP_DIR/.env" /tmp/vocaid-backend-env-backup
fi

# Remove old node_modules to ensure clean install
if [ -d "$APP_DIR/node_modules" ]; then
    echo "Removing old node_modules..."
    rm -rf "$APP_DIR/node_modules"
fi

# Clean up Prisma generated files
if [ -d "$APP_DIR/node_modules/.prisma" ]; then
    rm -rf "$APP_DIR/node_modules/.prisma"
fi

# Clean up build artifacts
if [ -d "$APP_DIR/dist" ]; then
    echo "Removing old dist folder..."
    rm -rf "$APP_DIR/dist"
fi

echo "=== Before Install: Cleanup complete ==="
