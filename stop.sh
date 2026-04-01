#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT_DIR/.pids"

if [ ! -f "$PID_FILE" ]; then
  echo "No running services found (.pids file missing)."
  exit 0
fi

PIDS=$(cat "$PID_FILE")

for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    echo "Stopped PID $PID"
  fi
done

rm -f "$PID_FILE"
echo "All services stopped."
