#!/bin/bash
# Lightweight pre-check for Claude Channel messages.
# Only outputs a prompt for Claude if there's a new message from the owner.
# Used as a cron pre-filter to avoid wasting tokens on empty polls.

CHAT_ID="${LARK_CHAT_ID:?Set LARK_CHAT_ID}"
OWNER_ID="${LARK_OWNER_OPEN_ID:?Set LARK_OWNER_OPEN_ID}"
STATE_FILE="/tmp/claude_channel_last_processed.txt"

# Get last processed message ID
LAST_ID=""
if [ -f "$STATE_FILE" ]; then
    LAST_ID=$(cat "$STATE_FILE" | tr -d '[:space:]')
fi

# Fetch recent messages
MESSAGES=$(lark-cli im +chat-messages-list --chat-id "$CHAT_ID" --format json 2>/dev/null)

if [ $? -ne 0 ]; then
    exit 0  # silently fail, don't waste tokens
fi

# Check for new messages from the owner after the last processed ID
NEW_MSG=$(echo "$MESSAGES" | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('data', {}).get('messages', [])
last = '$LAST_ID'
found_last = False if last else True
new_msgs = []
for msg in reversed(msgs):
    if msg['message_id'] == last:
        found_last = True
        continue
    if found_last and msg.get('sender', {}).get('id') == '$OWNER_ID' and msg.get('msg_type') != 'system':
        new_msgs.append({'id': msg['message_id'], 'content': msg.get('content', ''), 'time': msg.get('create_time', '')})
if new_msgs:
    print(json.dumps(new_msgs))
" 2>/dev/null)

# Only output if there are new messages (this becomes the Claude prompt trigger)
if [ -n "$NEW_MSG" ]; then
    echo "NEW_MESSAGES_FOUND"
    echo "$NEW_MSG"
fi
