#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_relay_running
echo "Relay backend is ready at $RELAY_URL"
