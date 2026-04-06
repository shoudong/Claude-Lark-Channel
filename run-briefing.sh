#!/bin/bash
set -euo pipefail

MODE="${1:?Usage: run-briefing.sh daily|eod|weekly}"

ENV_FILE="$HOME/.config/claude-lark-channel/config.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export ANTHROPIC_API_KEY
# Load ANTHROPIC_API_KEY from your secrets manager, e.g.:
# ANTHROPIC_API_KEY=$(op item get <item-id> --vault <vault> --field credential --reveal)

cd "$(dirname "$0")"
exec bun briefing.ts --mode "$MODE"
