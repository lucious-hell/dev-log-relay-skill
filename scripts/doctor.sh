#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_ready
cd "$RUNTIME_DIR"

if [ "${1:-}" = "" ]; then
  echo "usage: scripts/doctor.sh <target|trigger|readiness> [args...]" >&2
  exit 1
fi

run_runtime_command npm run cli -- doctor "$@"
