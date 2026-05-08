#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_ready
cd "$RUNTIME_DIR"

TARGET="${1:-auto}"
shift || true

run_runtime_command npm run cli -- project verify --target "$TARGET" --pretty "$@"
