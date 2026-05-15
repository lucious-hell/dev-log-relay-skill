#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_ready
cd "$RUNTIME_DIR"

run_runtime_command npm run cli -- harness evidence --pretty "$@"
