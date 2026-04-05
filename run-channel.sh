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

cd "$HOME/Claude/scripts/lark-channel"
exec /opt/homebrew/bin/bun server.ts
