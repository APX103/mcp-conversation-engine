#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT_DIR/.pids"

# Stop any existing instances
if [ -f "$PID_FILE" ]; then
  echo "Stopping existing services..."
  "$ROOT_DIR/stop.sh" > /dev/null 2>&1 || true
fi

# Check config.json exists
if [ ! -f "$ROOT_DIR/config.json" ]; then
  echo "Error: config.json not found."
  echo "Please copy config.example.json to config.json and fill in your API keys:"
  echo "  cp config.example.json config.json"
  exit 1
fi

echo "Starting MCP Conversation Engine..."

# Start backend (port 3000) — run from project root so relative paths in config resolve correctly
cd "$ROOT_DIR"
npx tsx backend/src/index.ts &
BACKEND_PID=$!
echo "  Backend  (PID $BACKEND_PID) -> http://localhost:3000"

# Start frontend (port 5173)
cd "$ROOT_DIR/frontend"
npx vite --host &
FRONTEND_PID=$!
echo "  Frontend (PID $FRONTEND_PID) -> http://localhost:5173"

# Start example MCP server
cd "$ROOT_DIR/example-mcp-server"
node index.js &
MCP_PID=$!
echo "  MCP Server (PID $MCP_PID) -> calculator example"

# Save PIDs
echo "$BACKEND_PID $FRONTEND_PID $MCP_PID" > "$PID_FILE"

echo ""
echo "All services started. Open http://localhost:5173 to begin."
echo "Run ./stop.sh to stop all services."
