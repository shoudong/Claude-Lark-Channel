# Claude-Lark-Channel

Message Claude directly from Lark. Get summaries of chats, emails, calendars, documents, and more — with persistent memory in Obsidian.

---

## Table of Contents

- [What Is This?](#what-is-this)
- [What Can It Do?](#what-can-it-do)
- [What It Can't Do (Yet)](#what-it-cant-do-yet)
- [Why This Over OpenClaw?](#why-this-over-openclaw)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Channel](#running-the-channel)
- [Verifying It Works](#verifying-it-works)
- [Daily Usage Examples](#daily-usage-examples)
- [How the Routing Works](#how-the-routing-works)
- [Token Efficiency](#token-efficiency)
- [Troubleshooting](#troubleshooting)

---

## What Is This?

Claude-Lark-Channel is a bridge between **Lark (Feishu)** and **Claude Code**. It creates a dedicated Lark group chat where you message Claude directly — and Claude replies in seconds.

Think of it as a **Chief of Staff + memory layer** inside Lark:

- **Before meetings**: ask Claude to prepare a briefing from your calendar, emails, and past notes
- **After meetings**: forward meeting minutes and Claude summarizes decisions, action items, and follow-ups
- **During the day**: forward emails, documents, or Lark messages and Claude analyzes them
- **End of day**: Claude synthesizes what happened and saves insights to your Obsidian vault
- **Weekly**: Claude generates a structured weekly summary across all your activity

The core idea: **AI should compress noise, preserve signal, and increase follow-through.**

---

## What Can It Do?

**Real-time from Lark (via webhook)**

| Action | Example Message | What Happens |
|--------|----------------|--------------|
| Calendar lookup | "What meetings do I have today?" | Fetches your Lark calendar via lark-cli (zero tokens) |
| Email summary | "Check my latest emails" | Reads inbox via lark-cli (zero tokens) |
| Contact search | "Who is Agnes?" / "Find Peter" | Searches Lark contacts via lark-cli (zero tokens) |
| Meeting history | "What meetings did I have yesterday?" | Searches past meetings via lark-cli (zero tokens) |
| Pending items | "/pending" / "Who's waiting on me?" | Shows unanswered @mentions, overdue tasks, unread emails (zero tokens) |
| Forward an email | Forward any email card | Claude extracts key info, strips boilerplate, summarizes |
| Forward a document | Forward a Lark doc / wiki page | Pre-fetches via `docs +fetch`, then Claude analyzes |
| Forward meeting minutes | Forward a minutes URL | Pre-fetches notes via `vc +notes` → `docs +fetch`, then Claude summarizes |
| Draft a reply | Forward email + "draft a reply declining politely" | Claude merges forward content with your instruction |
| Deep analysis | "Analyze this quarterly report and note key takeaways" | Full Claude reasoning with Sonnet/Opus |
| Save to memory | "Summarize this and save" | Claude writes structured notes to Obsidian vault |
| Task management | "Show my tasks" / "What's overdue?" | Reads Lark Tasks (zero tokens) |
| Follow-ups | "Draft a reply to that" (after forwarding something) | Routes to same context bucket as the prior forward |

**Scheduled batch jobs (cron-based, separate from webhook)**

| Job | When | Purpose |
|-----|------|---------|
| Morning briefing | 8am daily | Calendar + email + Lark threads compressed into one briefing |
| End-of-day synthesis | 6pm daily | Consolidate decisions, action items, insights into Obsidian |
| Weekly summary | Friday evening | Close the loop across the entire week |

---

## What It Can't Do (Yet)

- **No multi-user support** — currently one owner per channel server instance
- **No image/video processing** — unsupported message types are silently ignored
- **No write actions by default** — Claude reads your Lark data but won't send messages, create events, or modify docs unless you explicitly enable it
- **No mobile app** — it works through Lark's mobile app, but there's no standalone Claude mobile client
- **No real-time streaming** — Claude processes your message and replies once (no token-by-token streaming in Lark)

---

## Why This Over OpenClaw?

| Dimension | OpenClaw (legacy) | Claude-Lark-Channel |
|-----------|-------------------|---------------------|
| **Reliability** | Frequent crashes, missed messages | Webhook-based, restarts cleanly, dedup built in |
| **Security** | API keys in config files | 3-layer filtering: Lark verification token, sender open_id, chat_id. API keys via 1Password or env vars |
| **Token efficiency** | AI tokens on every poll + every simple task | Zero tokens for simple tasks (lark-cli direct). Haiku (~$0.001) for routing. Sonnet/Opus only for real work |
| **Latency** | 15s polling delay + cold start | Webhook-driven (instant). Simple tasks ~1.5s. Complex tasks 5-30s |
| **Architecture** | Monolithic, hard to debug | Modular: Haiku dispatch + extraction, bucketed sessions, Obsidian memory |
| **Idle cost** | Tokens consumed even when idle | Zero. No polling, no background token spend |
| **Memory** | Ephemeral chat history | Obsidian vault — structured, searchable, syncs across machines |

---

## Architecture

```
┌──────────┐     webhook     ┌────────────────────────────────────────────────┐
│          │ ───────────────▶ │            Channel Server (Bun + TS)          │
│   Lark   │                 │                                                │
│  (User)  │                 │  ┌─────────────────────────────────────────┐   │
│          │                 │  │  Haiku Dispatcher (direct Anthropic API) │   │
│          │                 │  │  • classifies bucket + model             │   │
│          │                 │  │  • extracts/compresses forwarded content │   │
│          │                 │  │  • decides simple vs tools vs direct     │   │
│          │                 │  └──────────┬──────────────────────────────┘   │
│          │                 │             │                                   │
│          │                 │    ┌────────┼────────────┐                     │
│          │                 │    ▼        ▼            ▼                     │
│          │                 │  Zero-   Sonnet      Sonnet/Opus              │
│          │                 │  token   Direct      (claude -p)              │
│          │                 │  lark-   API         Full tool                │
│          │  ◀───────────── │  cli     (no tools)  access                   │
│          │   bot reply     │                                                │
└──────────┘                 └──────────┬─────────────────┬──────────────────┘
                                        │                 │
                                        ▼                 ▼
                                 ┌──────────────┐  ┌──────────────────┐
                                 │  Lark APIs   │  │  Obsidian Vault   │
                                 │  calendar,   │  │  persistent       │
                                 │  email, docs,│  │  memory layer     │
                                 │  contacts,   │  │                   │
                                 │  meetings    │  │                   │
                                 └──────────────┘  └──────────────────┘
```

### Three layers

1. **Lark** — your daily work happens here. Messages, emails, calendar, documents, meetings, contacts. The channel server receives webhook events from Lark whenever you send a message in the Claude Channel group.

2. **Channel Server (this repo)** — a Bun/TypeScript HTTP server that:
   - Receives Lark webhook events
   - Validates sender identity (3-layer security)
   - Uses **Haiku** (fast, cheap) to classify the message and extract/compress forwarded content
   - Routes simple tasks directly to lark-cli (zero AI tokens): calendar, tasks, email, contacts, meetings, pending @mentions
   - Routes text-only tasks to Sonnet direct API (no tool overhead)
   - Routes complex tasks to Claude Code sessions (Sonnet/Opus) with full tool access
   - Manages per-bucket session queues with automatic rotation

3. **Obsidian** — local markdown vault that serves as Claude's long-term memory. Structured folders for strategy, customers, decisions, meeting notes, etc. Syncs across machines via iCloud or Obsidian Sync. Claude reads relevant notes at session start and writes new insights when you say "save."

### Three-tier model usage

| Tier | Model | Role | Latency | Cost |
|------|-------|------|---------|------|
| 0 | **None** (lark-cli only) | Simple lookups: calendar, tasks, email, contacts, meetings, `/pending` | ~1-3s | **Free** |
| 1 | **Haiku** (direct Anthropic API) | Routing + content extraction/compression | ~300-800ms | ~$0.001 per call |
| 2 | **Sonnet** (direct Anthropic API) | Text-only tasks — summarize, translate, draft (no tool access needed) | 2-5s | ~$0.003-0.01 per task |
| 3 | **Sonnet** (`claude -p` CLI) | Reasoning with full tool access — research, multi-step actions | 5-15s | ~$0.01-0.05 per task |
| 4 | **Opus** (`claude -p` CLI) | Deep reasoning (only when explicitly requested) | 10-30s | ~$0.05-0.15 per task |

### Bucketed sessions

Messages are routed into topic buckets (`calendar`, `email`, `lark_docs`, `chat_history`, `general`). Each bucket maintains its own Claude Code session. This means:

- Calendar questions share context with other calendar questions
- Email analysis shares context with other email analysis
- Sessions auto-rotate after 8 turns to keep context fresh
- Each bucket has its own Obsidian memory file for cross-session continuity

### Forward + merge window

When you forward content (email, doc, message, minutes URL), the server:
1. Immediately starts extraction — Haiku for text, `docs +fetch` for Lark docs, `vc +notes` for meeting minutes
2. Opens a 5-second merge window
3. If you send a follow-up instruction within 5s, it merges your instruction with the clean extract
4. If no instruction arrives, Claude auto-summarizes with a default action

---

## Prerequisites

You need the following installed on your machine before starting.

### 1. macOS with Homebrew

```bash
# If Homebrew isn't installed:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Git

```bash
brew install git
git --version
```

### 3. Node.js (for lark-cli)

```bash
brew install node
node --version   # v18+ recommended
npm --version
```

### 4. Bun (JavaScript runtime — runs the server)

```bash
brew install oven-sh/bun/bun
bun --version
```

### 5. Claude Code (CLI)

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

You'll need an Anthropic API key or Claude Pro/Max subscription for Claude Code to work.

### 6. ngrok (exposes local server to the internet for Lark webhooks)

```bash
brew install ngrok
ngrok --version
```

Sign up at [ngrok.com](https://ngrok.com) and run `ngrok config add-authtoken <your-token>`.

### 7. Obsidian (persistent memory layer)

Download from [obsidian.md](https://obsidian.md/) and install. Create or open a vault — this is where Claude will store summaries, decisions, and insights.

Recommended vault folder structure:

```
YourVault/
├── 00_Profile/          # Your identity, priorities, operating rules
├── 01_Strategy/         # Strategy docs and positioning
├── 02_Product/          # Product direction and roadmap
├── 03_Customers/        # Customer notes and account intelligence
├── 04_Sales/            # GTM, pipeline, partnerships
├── 05_Hiring_Org/       # Org design and people notes
├── 06_Investors/        # Board and investor notes
├── 07_Market_Intel/     # Competitors, market signals
├── 08_Decision_Log/     # Key decisions with rationale
├── 09_Writing/          # Memos, speeches, talking points
├── 10_Inbox/            # Capture area — Lark summaries go here
│   └── Lark-Channel-Memory/  # Auto-created by the channel server
└── Shared/              # Cross-vault shared context files
```

---

## Installation

### Step 1: Clone this repo

```bash
git clone https://github.com/shoudong/Claude-Lark-Channel.git
cd Claude-Lark-Channel
```

### Step 2: Install dependencies

```bash
bun install
```

### Step 3: Install Lark CLI

```bash
npm install -g @larksuite/cli
lark-cli --version
lark-cli doctor
```

### Step 4: Install Lark CLI skills for Claude Code

These skills give Claude the ability to understand and use lark-cli commands:

```bash
npx skills add larksuite/cli --all -y
```

This installs ~20 skills covering: calendar, messages, contacts, docs, wiki, drive, sheets, base, tasks, mail, meetings, approvals, and more.

### Step 5: Create a Lark Bot App

1. Go to [Lark Open Platform](https://open.larksuite.com/) (or [Feishu Open Platform](https://open.feishu.cn/) for China)
2. Create a new app (Custom App)
3. Note your **App ID** and **App Secret**
4. Under **Event Subscriptions**:
   - Set the Request URL to your ngrok URL + `/webhook` (you'll get this in Step 8)
   - Add event: `im.message.receive_v1` (Message received)
5. Under **Permissions & Scopes**, add the scopes you need (see Step 6)
6. Publish the app (or use test mode)

### Step 6: Authenticate Lark CLI

Run this with the scopes you need (read-only recommended to start):

```bash
lark-cli auth login --scope "calendar:calendar:readonly calendar:calendar.event:read im:chat:readonly im:chat:read im:message:readonly im:message:basic drive:drive:readonly drive:drive.metadata:readonly mail:user_mailbox.message:readonly minutes:minutes:readonly minutes:minutes.basic:read wiki:wiki:readonly wiki:node:read sheets:spreadsheet:readonly sheets:spreadsheet.meta:read task:task:read vc:meeting:readonly vc:meeting.meetingevent:read"
```

This opens a browser for you to authorize. Verify it worked:

```bash
lark-cli auth status
lark-cli calendar +agenda   # Should show today's events
```

> **Note**: Auth tokens expire after ~7 days. Re-run this step when they expire.

### Step 7: Create the Claude Channel group in Lark

1. Create a new group chat in Lark
2. Add your Lark bot to the group
3. Add yourself to the group
4. Note the **Chat ID** — you can find it via:
   ```bash
   lark-cli im chats list
   ```
5. Note your **Open ID**:
   ```bash
   lark-cli contact +search-user --query "Your Name"
   ```
6. Note the **Verification Token** from your Lark app's Event Subscription settings

---

## Configuration

Create a config file at `~/.config/claude-lark-channel/config.env`:

```bash
mkdir -p ~/.config/claude-lark-channel

cat > ~/.config/claude-lark-channel/config.env << 'EOF'
# Required — from your Lark app setup
LARK_CHAT_ID=oc_your_chat_id_here
LARK_OWNER_OPEN_ID=ou_your_open_id_here
LARK_VERIFICATION_TOKEN=YourVerificationTokenHere

# Required — Anthropic API key (for Haiku dispatch)
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Optional — customize paths
CLAUDE_WORKDIR=/path/to/your/working/directory
OBSIDIAN_ROOT=/path/to/your/obsidian/vault
LARK_CHANNEL_STATE_DIR=/path/to/Claude-Lark-Channel/.state

# Optional — customize models
CLAUDE_MODEL_DEFAULT=sonnet
CLAUDE_MODEL_REASONING=opus
CLAUDE_MODEL_HAIKU=claude-haiku-4-5-20251001

# Optional — tune behavior
LARK_MAX_SESSION_TURNS=8
LARK_BUCKET_MEMORY_TAIL_CHARS=4000
PORT=8765
EOF
```

### Environment variables reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LARK_CHAT_ID` | Yes | — | Chat ID of the Claude Channel group |
| `LARK_OWNER_OPEN_ID` | Yes | — | Your Lark Open ID (only messages from this ID are processed) |
| `LARK_VERIFICATION_TOKEN` | Yes | — | From Lark app Event Subscription settings |
| `ANTHROPIC_API_KEY` | Yes | — | For Haiku API calls (routing + extraction) |
| `CLAUDE_WORKDIR` | No | `.` | Working directory for Claude Code sessions |
| `OBSIDIAN_ROOT` | No | `./obsidian-vault` | Path to your Obsidian vault |
| `LARK_CHANNEL_STATE_DIR` | No | `./.state` | Where session state and logs are stored |
| `CLAUDE_MODEL_DEFAULT` | No | `sonnet` | Default model for reasoning tasks |
| `CLAUDE_MODEL_REASONING` | No | `opus` | Model for deep reasoning (when requested) |
| `CLAUDE_MODEL_HAIKU` | No | `claude-haiku-4-5-20251001` | Model for routing and extraction |
| `LARK_MAX_SESSION_TURNS` | No | `8` | Turns before session auto-rotation |
| `LARK_BUCKET_MEMORY_TAIL_CHARS` | No | `4000` | How much bucket memory to load per session |
| `PORT` | No | `8765` | HTTP server port |

---

## Running the Channel

### Terminal 1: Start ngrok

```bash
ngrok http 8765
```

Copy the public URL (e.g., `https://abc123.ngrok-free.dev`) and update your Lark app's Event Subscription Request URL to:

```
https://abc123.ngrok-free.dev/webhook
```

> **Note**: The ngrok URL changes every time you restart ngrok. Update the Lark developer console each time.

### Terminal 2: Start the channel server

```bash
# Load your config and start the server
set -a && source ~/.config/claude-lark-channel/config.env && set +a
bun server.ts
```

Or use the provided script:

```bash
./run-channel.sh
```

You should see:

```
[lark-channel] Server listening on port 8765
```

### Keeping it running

For persistent operation, you can use a process manager or macOS launchd. The `claude-channel-daemon.sh` script provides an example of a polling-based approach for environments where webhooks aren't available.

---

## Verifying It Works

### 1. Check server health

```bash
curl http://localhost:8765/health
```

Should return:

```json
{"status":"ok","defaultModel":"sonnet","queueDepth":0}
```

### 2. Check ngrok tunnel

```bash
curl http://localhost:4040/api/tunnels
```

### 3. Send a test message

Open the Claude Channel group in Lark and type:

```
What meetings do I have today?
```

Claude should reply within a few seconds with your calendar.

### 4. Run the reliability tests (optional)

```bash
# With the server running:
bun test-reliability.ts
```

---

## Daily Usage Examples

**Morning routine:**
> "Give me a briefing for today — calendar, key emails, any follow-ups due"

**Before a meeting:**
> "Prepare me for my 2pm product review — what context do I need?"

**Forward an email, then instruct:**
> [Forward email card]
> "Draft a polite reply declining but suggesting next quarter"

**Forward meeting minutes:**
> [Forward meeting notes]
> "Extract decisions and action items, then save to Obsidian"

**End of day:**
> "Summarize what I worked on today and save the key decisions"

**Quick lookups:**
> "Show my tasks" / "Check inbox" / "What's on my calendar tomorrow?"

---

## How the Routing Works

```
Message arrives
     │
     ▼
┌─ Fast-path command? (/pending, contacts, meetings) ──────────┐
│                                                               │
│  YES → lark-cli directly → reply (zero tokens, ~1-3s)        │
│                                                               │
│  NO                                                           │
│   │                                                           │
│   ▼                                                           │
│  Is it forwarded content / URL / file?                        │
│   │                                                           │
│   ├── YES                                      NO             │
│   │    │                                        │             │
│   │    ▼                                        ▼             │
│   │  Extract content:                        Is text > 500   │
│   │  • Lark doc → docs +fetch                chars?           │
│   │  • Minutes URL → vc +notes               YES: Haiku      │
│   │  • Text → Haiku compress                      compress   │
│   │  Open 5s merge window                    NO: Pass through │
│   │   │                                        │             │
│   │   ├── Instruction within 5s → Merge        │             │
│   │   └── No instruction → Auto-summarize      │             │
│   │                                             │             │
│   └─────────────────────┬───────────────────────┘             │
│                         │                                     │
│                         ▼                                     │
│                 Haiku dispatches:                              │
│                 → bucket, model, simple, tools                │
│                         │                                     │
│            ┌────────────┼────────────┐                        │
│            ▼            ▼            ▼                        │
│         Simple       Sonnet       Sonnet/Opus                │
│         handler      Direct       (claude -p)                │
│         (lark-cli)   API          + tools                    │
│         0 tokens     ~$0.003      ~$0.01-0.15                │
│                                                               │
└───────────────────────┬───────────────────────────────────────┘
                        │
                        ▼
                  Reply sent to Lark
                  Memory saved to Obsidian (if applicable)
```

---

## Token Efficiency

| Action | Haiku Tokens | Sonnet/Opus Tokens | Cost |
|--------|-------------|-------------------|------|
| Simple lookup (calendar, tasks, email, contacts, meetings) | 0 | 0 | **Free** — lark-cli directly |
| `/pending` (unanswered @mentions + overdue tasks + unread email) | 0 | 0 | **Free** — lark-cli directly |
| Lark doc / minutes URL pre-fetch | 0 | 0 | **Free** — `docs +fetch` / `vc +notes` directly |
| Message routing | ~500 input + ~100 output | 0 | ~$0.001 |
| Forward extraction | ~1000 input + ~300 output | 0 | ~$0.002 |
| Text-only task (Sonnet direct API) | ~500 (routing) | ~1-3K | ~$0.003-0.01 |
| Complex task (analysis, drafting) | ~500 (routing) | ~5-10K | ~$0.01-0.05 |
| Deep reasoning (Opus) | ~500 (routing) | ~10-20K | ~$0.05-0.15 |
| Idle | 0 | 0 | **Free** |

Key design decision: **Haiku handles all classification and extraction work** (~300-800ms, fractions of a cent). Sonnet/Opus is only invoked when genuine reasoning is needed. Simple tasks and data lookups bypass AI entirely — the server calls lark-cli directly and formats the response.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Server won't start | Check all required env vars are set. Run `env \| grep LARK` to verify |
| `lark-cli: command not found` | `npm install -g @larksuite/cli` |
| Lark auth expired | `lark-cli auth login --scope "..."` (re-run Step 6) |
| ngrok URL changed | Update Request URL in Lark developer console Event Subscriptions |
| Messages not arriving | Check ngrok dashboard at `http://localhost:4040` for incoming requests |
| 403 from webhook | Verification token mismatch — check `LARK_VERIFICATION_TOKEN` |
| Claude not replying | Check server logs. Verify `claude --version` works. Check `ANTHROPIC_API_KEY` |
| Wrong sender ignored | Only messages from `LARK_OWNER_OPEN_ID` are processed. Verify your Open ID |
| Session feels stale | Sessions auto-rotate after 8 turns. Or restart the server for a clean state |
| Obsidian notes not appearing | Check `OBSIDIAN_ROOT` path is correct and writable |

### Checking logs

Server logs go to stderr. Event history is stored in `.state/events.jsonl`:

```bash
# Recent events
tail -20 .state/events.jsonl | jq .

# Daily token usage
cat .state/usage-daily.json | jq .
```

---

## License

See [LICENSE](LICENSE) for details.
