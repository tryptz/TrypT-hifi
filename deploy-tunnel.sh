#!/bin/bash
# Cloudflare Tunnel Deployment Script
# Usage: ./deploy-tunnel.sh <TUNNEL_TOKEN> <APP_PORT=3000>

set -e

TUNNEL_TOKEN=${1:?Usage: $0 <TUNNEL_TOKEN> [APP_PORT]}
APP_PORT=${2:-3000}

echo "🚀 Setting up Cloudflare Tunnel..."

# Check if Docker is available
if command -v docker &> /dev/null; then
    echo "✓ Docker found, using Docker Compose..."
    
    # Ensure environment variables are set
    if [ -z "$DEEZER_ARL" ]; then
        echo "⚠️  DEEZER_ARL not set. Add to your environment or .env file."
    fi
    
    # Start with Docker Compose
    export CF_TUNNEL_TOKEN="$TUNNEL_TOKEN"
    docker-compose -f docker-compose.cloudflare.yml up -d
    
elif command -v cloudflared &> /dev/null; then
    echo "✓ Cloudflared found, running directly..."
    
    # Start the app (assuming Node.js app is built)
    npm run start &
    APP_PID=$!
    
    # Start Cloudflare Tunnel
    cloudflared tunnel run --token "$TUNNEL_TOKEN" &
    TUNNEL_PID=$!
    
    echo "✓ App running on port $APP_PORT"
    echo "✓ Cloudflare Tunnel running"
    echo "✓ Tunnels are accessible via HTTPS"
    
    # Cleanup on exit
    trap "kill $APP_PID $TUNNEL_PID 2>/dev/null" EXIT
    
    # Wait for processes
    wait
else
    echo "❌ Neither Docker nor Cloudflared found."
    echo ""
    echo "To deploy, install one of:"
    echo "  - Docker: https://docs.docker.com/get-docker/"
    echo "  - Cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
    echo ""
    echo "Then run:"
    echo "  docker-compose -f docker-compose.cloudflare.yml up -d"
    echo "  OR"
    echo "  ./deploy-tunnel.sh <TUNNEL_TOKEN>"
    exit 1
fi

echo ""
echo "✅ Deployment complete!"
echo "🌐 Access your app via the Cloudflare Tunnel URL"