---
name: configure
description: Set up the Lark channel — check ngrok, verify webhook, test connectivity
user_invocable: true
allowed_tools:
  - Read
  - Write
  - Bash
---

# /lark-channel:configure — Lark Channel Setup & Health Check

Verify and configure the Lark channel for Claude Code. This skill checks all components of the pipeline: ngrok tunnel, HTTP webhook, Lark event subscription, and MCP channel connection.

Arguments passed: `$ARGUMENTS`

## No args — full health check

Run all checks and report status:

### 1. ngrok tunnel
```bash
curl -s http://127.0.0.1:4040/api/tunnels
```
- Extract the public URL
- Report: running/not running, current URL

### 2. HTTP webhook server
```bash
curl -s http://localhost:8765/health
```
- Report: healthy/unreachable

### 3. Webhook reachability (ngrok → server)
```bash
curl -s <ngrok-url>/health
```
- Report: reachable/unreachable through tunnel

### 4. Lark event subscription
- Remind user to verify the Request URL in Lark developer console matches: `<ngrok-url>/webhook`
- Show the current ngrok URL clearly for copy-paste

### 5. Recent webhook traffic
```bash
curl -s 'http://127.0.0.1:4040/api/requests/http?limit=5'
```
- Show recent requests (time, method, path, status)
- Flag any 502s or 4xxs

### 6. Reply test
```bash
/opt/homebrew/bin/lark-cli im +messages-send --as bot --chat-id "oc_cebe1616ba27d536286b15f59f63e5f0" --markdown "Health check: Claude channel is connected."
```
- Confirm reply was sent

### 7. Summary
Print a status table:
```
ngrok:     OK (https://xxx.ngrok-free.dev)
webhook:   OK (port 8765)
tunnel:    OK (end-to-end)
lark URL:  check manually — should be <url>/webhook
last event: 2 min ago (200)
reply:     OK (message sent)
```

## `ngrok` — start ngrok

If ngrok isn't running:
```bash
ngrok http 8765
```
Remind user this runs in foreground — suggest running in a separate terminal or with `&`.

## `test` — send a test message

Send a test reply to the Claude Channel:
```bash
/opt/homebrew/bin/lark-cli im +messages-send --as bot --chat-id "oc_cebe1616ba27d536286b15f59f63e5f0" --markdown "Test from Claude: channel is working."
```

## Implementation Notes

- The Lark channel uses webhooks (push model), unlike Telegram which uses polling
- ngrok URL changes on every restart — Lark developer console must be updated each time
- The server runs as both HTTP webhook receiver AND MCP channel server in one process
- Config is hardcoded in server.ts (chat_id, sender filter, verification token)
