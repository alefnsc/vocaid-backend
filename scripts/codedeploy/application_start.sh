#!/bin/bash
# ========================================
# AWS CodeDeploy - Application Start Hook
# ========================================
# Starts or restarts the application using PM2

set -e

echo "=== Application Start: Starting server ==="

APP_DIR="/home/ec2-user/vocaid-backend"
APP_NAME="vocaid-backend"
cd "$APP_DIR"

# Load environment variables
set -a
source "$APP_DIR/.env"
set +a

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2 globally..."
    npm install -g pm2
fi

# Stop existing process if running
echo "Stopping existing process (if any)..."
pm2 stop "$APP_NAME" 2>/dev/null || true
pm2 delete "$APP_NAME" 2>/dev/null || true

# Start the application with PM2
echo "Starting application with PM2..."
pm2 start npm --name "$APP_NAME" -- start

# Save PM2 process list for auto-restart on reboot
pm2 save

# Set PM2 to start on boot (if not already set)
pm2 startup 2>/dev/null || true

# Wait a moment for the app to start
sleep 5

# Check if process is running
if pm2 list | grep -q "$APP_NAME"; then
    echo "Application started successfully!"
    pm2 show "$APP_NAME"
else
    echo "ERROR: Application failed to start"
    pm2 logs "$APP_NAME" --lines 50
    exit 1
fi

echo "=== Application Start: Complete ==="
