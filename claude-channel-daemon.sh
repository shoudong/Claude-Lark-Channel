#!/bin/bash
# Claude Channel Daemon
# Polls Lark every 15s for new messages from Dong.
# Writes to /tmp/claude_channel_inbox.json ONLY when new messages arrive.
# Designed to run as a launchd service. Zero token cost.

CHAT_ID="oc_cebe1616ba27d536286b15f59f63e5f0"
DONG_ID="ou_aa8bb5691e59fce13b80cefab30df7ab"
STATE_FILE="/tmp/claude_channel_last_processed.txt"
INBOX_FILE="/tmp/claude_channel_inbox.json"
LOG_FILE="/tmp/claude_channel_daemon.log"
POLL_INTERVAL=15

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

# Ensure state file exists
if [ ! -f "$STATE_FILE" ]; then
    echo "" > "$STATE_FILE"
fi

log "Daemon started (poll every ${POLL_INTERVAL}s)"

while true; do
    # Skip if inbox file already exists (Claude hasn't processed previous message yet)
    if [ -f "$INBOX_FILE" ]; then
        sleep "$POLL_INTERVAL"
        continue
    fi

    LAST_ID=$(cat "$STATE_FILE" 2>/dev/null | tr -d '[:space:]')

    # Fetch messages (suppress errors)
    MESSAGES=$(lark-cli im +chat-messages-list --chat-id "$CHAT_ID" --format json 2>/dev/null)

    if [ $? -ne 0 ]; then
        sleep "$POLL_INTERVAL"
        continue
    fi

    # Extract new messages from Dong
    NEW_MSG=$(echo "$MESSAGES" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    msgs = data.get('data', {}).get('messages', [])
    last = '$LAST_ID'
    found_last = False if last else True
    new_msgs = []
    for msg in reversed(msgs):
        if msg['message_id'] == last:
            found_last = True
            continue
        if found_last and msg.get('sender', {}).get('id') == '$DONG_ID' and msg.get('msg_type') != 'system':
            new_msgs.append({
                'id': msg['message_id'],
                'content': msg.get('content', ''),
                'time': msg.get('create_time', '')
            })
    if new_msgs:
        print(json.dumps(new_msgs))
except:
    pass
" 2>/dev/null)

    # Write to inbox if new messages found
    if [ -n "$NEW_MSG" ]; then
        echo "$NEW_MSG" > "$INBOX_FILE"
        log "New message(s) written to inbox"
    fi

    sleep "$POLL_INTERVAL"
done
