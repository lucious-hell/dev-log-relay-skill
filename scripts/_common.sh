#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/runtime"
WORKSPACE_ROOT="${DEV_LOG_RELAY_WORKSPACE_ROOT:-$PWD}"
RELAY_URL="${RELAY_URL:-http://127.0.0.1:5077}"
RELAY_PID_FILE="${RELAY_PID_FILE:-$ROOT/.relay.pid}"
RELAY_LOG_FILE="${RELAY_LOG_FILE:-$ROOT/.relay.log}"

export DEV_LOG_RELAY_WORKSPACE_ROOT="$WORKSPACE_ROOT"

ensure_runtime_ready() {
  cd "$RUNTIME_DIR"
  if [ ! -d node_modules ]; then
    npm install
  fi
}

relay_is_healthy() {
  curl -fsS "$RELAY_URL/healthz" >/dev/null 2>&1
}

wait_for_relay() {
  local attempt=0
  while [ "$attempt" -lt 40 ]; do
    if relay_is_healthy; then
      return 0
    fi
    sleep 0.5
    attempt=$((attempt + 1))
  done
  return 1
}

start_relay_background() {
  cd "$RUNTIME_DIR"
  nohup npm run dev >"$RELAY_LOG_FILE" 2>&1 &
  echo $! >"$RELAY_PID_FILE"
}

ensure_relay_running() {
  ensure_runtime_ready
  if relay_is_healthy; then
    return 0
  fi
  if [ -f "$RELAY_PID_FILE" ]; then
    local existing_pid
    existing_pid="$(cat "$RELAY_PID_FILE" 2>/dev/null || true)"
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      if wait_for_relay; then
        return 0
      fi
    fi
  fi
  start_relay_background
  if ! wait_for_relay; then
    echo "Relay backend failed to become healthy. Check $RELAY_LOG_FILE" >&2
    exit 1
  fi
}

run_runtime_command() {
  ensure_relay_running
  if ! "$@"; then
    echo "Relay command failed. Backend log: $RELAY_LOG_FILE" >&2
    exit 1
  fi
}
