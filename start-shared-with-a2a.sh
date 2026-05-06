#!/usr/bin/env bash
set -e

# Start both MCP Conversation Engine and A2A-center on a shared Docker network
# so services can reach each other by container name.
#
# Usage: ./start-shared-with-a2a.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A2A_DIR="/Users/apx103/work/A2A-center"
NETWORK_NAME="shared-agent-net"

# 1. Ensure shared network exists
if ! docker network inspect "$NETWORK_NAME" &>/dev/null; then
  echo "🔧 Creating shared Docker network: $NETWORK_NAME"
  docker network create "$NETWORK_NAME"
else
  echo "✅ Shared network already exists: $NETWORK_NAME"
fi

# 2. Start A2A-center
echo "🚀 Starting A2A-center..."
cd "$A2A_DIR"
docker compose up -d --build

# 3. Start MCP Conversation Engine
echo "🚀 Starting MCP Conversation Engine..."
cd "$SCRIPT_DIR"
docker compose up -d --build

echo ""
echo "========================================"
echo "Both projects are up!"
echo "----------------------------------------"
echo "A2A-center:     http://localhost:8888"
echo "MCP Instance A: http://localhost:5174"
echo "MCP Instance B: http://localhost:5175"
echo "----------------------------------------"
echo "Shared network: $NETWORK_NAME"
echo ""
echo "From MCP backends, reach A2A-center at:"
echo "  a2a-center:8888"
echo ""
echo "From A2A-center, reach MCP backends at:"
echo "  backend-a:3000"
echo "  backend-b:3000"
echo "========================================"
