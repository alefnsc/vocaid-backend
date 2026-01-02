#!/bin/bash
# ========================================
# AWS CodeDeploy - Validate Service Hook
# ========================================
# Validates that the application is running and healthy

set -e

echo "=== Validate Service: Checking health ==="

APP_NAME="vocaid-backend"
PORT="${PORT:-3001}"
MAX_RETRIES=6
RETRY_INTERVAL=5

# Wait for the application to be ready
echo "Waiting for application to be ready on port $PORT..."

for i in $(seq 1 $MAX_RETRIES); do
    echo "Health check attempt $i of $MAX_RETRIES..."
    
    # Try to hit the health endpoint
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null || echo "000")
    
    if [ "$RESPONSE" = "200" ]; then
        echo "Health check passed! (HTTP $RESPONSE)"
        
        # Show PM2 status
        pm2 show "$APP_NAME"
        
        echo "=== Validate Service: Success ==="
        exit 0
    fi
    
    echo "Health check failed (HTTP $RESPONSE), waiting $RETRY_INTERVAL seconds..."
    sleep $RETRY_INTERVAL
done

# If we get here, health checks failed
echo "ERROR: Health checks failed after $MAX_RETRIES attempts"

# Show logs for debugging
echo "=== Recent logs ==="
pm2 logs "$APP_NAME" --lines 100 --nostream

exit 1
