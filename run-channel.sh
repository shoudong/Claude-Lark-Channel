#!/bin/bash
set -euo pipefail

ENV_FILE="$HOME/.config/claude-lark-channel/config.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

cd "$(dirname "$0")"
exec bun server.ts
