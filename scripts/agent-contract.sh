#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_ready
cd "$RUNTIME_DIR"

TARGET="${1:-web}"
DRIVER="${2:-computer-use}"

run_runtime_command npm run cli -- agent contract --target "$TARGET" --driver "$DRIVER" --pretty
