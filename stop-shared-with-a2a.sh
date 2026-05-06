#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A2A_DIR="/Users/apx103/work/A2A-center"

echo "🛑 Stopping MCP Conversation Engine..."
cd "$SCRIPT_DIR"
docker compose down

echo "🛑 Stopping A2A-center..."
cd "$A2A_DIR"
docker compose down

echo "✅ Both projects stopped."
