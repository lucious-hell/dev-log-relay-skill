#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_ready
cd "$RUNTIME_DIR"

if [ "${1:-}" = "" ]; then
  echo "usage: scripts/handoff.sh <runId>" >&2
  exit 1
fi

RUN_ID="$1"
shift || true

run_runtime_command npm run cli -- ai handoff --runId "$RUN_ID" --pretty "$@"
