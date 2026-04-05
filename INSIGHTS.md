# Lark Channel — Insights & Lessons Learned

Captured from development sessions on 2026-04-04 and 2026-04-05.

## Architecture Decisions

### Two-Tier Model (Haiku + Sonnet/Opus)
- **Haiku** (direct Anthropic API, ~300-800ms): dispatch routing, content extraction/compression
- **Sonnet/Opus** (`claude -p` CLI): reasoning with tool access, session resume, file system
- Core principle: *"The cheapest token is the one you never send to the expensive model."*
- Haiku costs < 1% of total spend (48 calls = $0.03 vs Sonnet 32 calls = $4.67)

### Why reasoning stays on `claude -p`
- Needs tool access (lark-cli for calendar/email/tasks, file system for PDFs/docs)
- Session resume preserves context across turns
- `--add-dir` for Obsidian memory
- `--permission-mode dontAsk` for autonomous operation

### Why Haiku uses direct API (not `claude -p`)
- CLI spawn adds ~2-3s overhead per call
- Direct fetch to api.anthropic.com: ~300-800ms
- No tool access needed for classification/extraction

## Token Efficiency Analysis

### Cost Breakdown (Apr 5, 32 Sonnet calls)
- **Cache creation: 83% of cost** ($4.01 / $4.84)
- Cache read: 12% ($0.59)
- Output: 5% ($0.24)
- Input (non-cached): 0% ($0.00)

### What creates the cache overhead (~28-54K tokens/call)
1. Claude Code system prompt + tool definitions (~15-20K tokens)
2. `--add-dir` Obsidian root (~10-20K tokens depending on vault size)
3. Bucket memory from Obsidian files (~1-4K tokens)
4. JSON schema for structured output (~0.5K tokens)
5. User instruction + extracted content (variable)

### Top Optimizations (by impact)
1. **Increase session turn limit** (8 → 16-20): halves cache creation frequency
2. **Narrow --add-dir scope**: point to bucket memory dir only, not entire Obsidian vault
3. **Direct Sonnet API for tool-free tasks**: skip `claude -p` overhead (~25K baseline) for summarize/translate/draft tasks that don't need tools
4. **Haiku pre-compression**: already implemented — strips 30-50% noise from long content before Sonnet sees it

### Pricing Reference (Sonnet)
- Input: $3/M tokens
- Cache write: $3.75/M tokens (most expensive!)
- Cache read: $0.30/M tokens (12.5x cheaper than write)
- Output: $15/M tokens

## Bugs Found & Fixed

### Forwarded emails silently dropped
- **Cause**: `message_type: "interactive"` was rejected by `messageType !== "text"` check
- **Fix**: Added `interactive` and `post` type parsing

### Forwarded email triggering calendar handler
- **Cause**: Email mentioning "meeting" matched `handleSimpleCalendar` keyword check
- **Fix**: Skip simple handlers for all forwarded content (`isForward` flag)

### Follow-up "summarize this email" not finding the email
- **Cause**: Cascading failure — email was intercepted by simple calendar handler, never reached Sonnet session. Follow-up resumes session with no email context.
- **Fix**: Same as above (skip simple handlers for forwards)

### Forward without instruction drafts a response instead of summarizing
- **Cause**: Haiku's `DEFAULT_ACTION` was too action-oriented (e.g., "File for records and share with board")
- **Fix**: Always wrap with "Summarize first, suggest action at the end"

### Bucket mismatch on follow-ups
- **Cause**: "can you draft a response?" routed to `general` instead of `email` because keyword matching found no email-related words
- **Fix**: Replaced all keyword routing with Haiku universal dispatcher + recent message ring buffer (last 5 messages)

### Race condition: URL + instruction arriving 157ms apart
- **Cause**: Both dispatched before either completed, recentMessages empty for second call
- **Fix**: URL-only text messages treated as bufferable content (same 5s merge window)

### HTML tags leaking from post messages
- **Cause**: `<p>help me summarize</p>` came through with tags intact from rich text
- **Fix**: `text.replace(/<[^>]+>/g, "")` strip after parsing

### Language not matching
- **Cause**: User asked in Chinese, got English response
- **Fix**: Added "Respond in the same language the user writes in" to system prompt

### PDF/file messages silently ignored
- **Cause**: Only `text`, `post`, `interactive` types handled; `file` and `image` rejected
- **Fix**: Added file/image download via `lark-cli im +messages-resources-download`, buffer with 5s merge window

### Double-compression on merged content
- **Cause**: User instruction merged with already-extracted forward could exceed 500 chars, triggering `extractLongContent` on already-compressed content
- **Fix**: Pass `isForward=true` for merged content to skip re-extraction

## Design Principles

1. **Haiku for all dispatch** — never hardcode keyword routing. Haiku sees recent message context and makes semantic decisions. Keyword fallback only if API fails.
2. **Haiku for content extraction** — strip noise before it reaches expensive models. Emails, docs, meeting notes, chat threads — all get compressed.
3. **Buffer before dispatch** — forwarded content, files, images, URLs all get a 5s merge window. User can add instruction; if not, auto-action fires.
4. **Simple handlers before complex** — calendar/task lookups are zero-token (lark-cli only). Try these before spawning Sonnet.
5. **Per-bucket sessions** — calendar, email, lark_docs, chat_history, general. Independent queues, independent context.
6. **Forward content skips simple handlers** — forwarded body text can contain any keywords; always route to reasoning model.
7. **Original instruction for context, compressed for reasoning** — `addRecentMessage` uses raw text for follow-up detection; `handleComplex` gets the compressed version.

## Testing

### Reliability test suite (`bun test-reliability.ts`)
18 tests, 46+ assertions covering:
- Security: token validation, sender filtering, dedup
- Routing: Haiku dispatch to correct buckets, follow-up context
- Content processing: extraction, compression, HTML stripping
- Merge window: forward+instruction merge, URL buffering
- Message types: text, post, interactive, file, image

### Cost of full test run
~$3-4 (mostly Sonnet). Haiku portion is ~$0.03.
