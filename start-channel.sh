#!/bin/bash
set -euo pipefail

cd ~/Claude/scripts/lark-channel
exec /opt/homebrew/bin/bun server.ts
