#!/bin/bash

# Voxly Backend Setup Script

echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║   🎙️  Voxly Backend Setup                                 ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

echo "✅ Node.js version: $(node -v)"
echo "✅ npm version: $(npm -v)"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✅ Dependencies installed successfully"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "✅ .env file created"
    echo ""
    echo "⚠️  IMPORTANT: Please edit .env file and add your API keys:"
    echo "   - OPENAI_API_KEY"
    echo "   - RETELL_API_KEY"
    echo "   - RETELL_AGENT_ID"
    echo "   - MERCADOPAGO_ACCESS_TOKEN"
    echo "   - CLERK_SECRET_KEY"
    echo "   - CLERK_PUBLISHABLE_KEY"
    echo ""
else
    echo "✅ .env file already exists"
    echo ""
fi

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Build successful"
echo ""

echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║   ✅ Setup Complete!                                       ║"
echo "║                                                            ║"
echo "║   Next steps:                                              ║"
echo "║   1. Edit .env file with your API keys                     ║"
echo "║   2. Run 'npm run dev' to start development server         ║"
echo "║   3. For webhooks, run 'ngrok http 3001' in another tab    ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
