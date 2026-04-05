#!/usr/bin/env bun

import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

type SessionInfo = {
  sessionId: string;
  updatedAt: string;
  turns: number;
  bucket: string;
  model: string;
};

type SessionState = Record<string, SessionInfo>;

type ClaudeStructuredResult = {
  reply_markdown: string;
  save_note_markdown: string | null;
};

type BucketConfig = {
  key: string;
  label: string;
};

type ClaudeUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const CONFIG = {
  chatId: requireEnv("LARK_CHAT_ID"),
  ownerOpenId: requireEnv("LARK_OWNER_OPEN_ID"),
  verificationToken: requireEnv("LARK_VERIFICATION_TOKEN"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  larkCli: process.env.LARK_CLI ?? "/opt/homebrew/bin/lark-cli",
  claudeCli: process.env.CLAUDE_CLI ?? "/opt/homebrew/bin/claude",
  port: Number(process.env.PORT ?? "8765"),
  claudeWorkdir: process.env.CLAUDE_WORKDIR ?? "/Users/dong-ai/Claude",
  obsidianRoot: process.env.OBSIDIAN_ROOT ?? "/Users/dong-ai/Documents/ADVANCE-AI-OS",
  dailyBriefDir:
    process.env.DAILY_BRIEF_DIR ?? "/Users/dong-ai/Documents/ADVANCE-AI-OS/10_Inbox",
  stateDir:
    process.env.LARK_CHANNEL_STATE_DIR ?? "/Users/dong-ai/Claude/scripts/lark-channel/.state",
  routeMode: process.env.LARK_ROUTE_MODE ?? "claude_direct",
  defaultModel: process.env.CLAUDE_MODEL_DEFAULT ?? process.env.CLAUDE_MODEL ?? "sonnet",
  reasoningModel: process.env.CLAUDE_MODEL_REASONING ?? "opus",
  haikuModel: process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001",
  claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE ?? "dontAsk",
  bucketMemoryTailChars: Number(process.env.LARK_BUCKET_MEMORY_TAIL_CHARS ?? "4000"),
  maxSessionTurns: Number(process.env.LARK_MAX_SESSION_TURNS ?? "8"),
};

const SESSION_FILE = join(CONFIG.stateDir, "sessions.json");
const EVENTS_FILE = join(CONFIG.stateDir, "events.jsonl");
const OUTBOX_FILE = join(CONFIG.stateDir, "outbox.jsonl");
const CLAUDE_RAW_FILE = join(CONFIG.stateDir, "claude-raw.jsonl");
const USAGE_DAILY_FILE = join(CONFIG.stateDir, "usage-daily.json");
const BUCKET_MEMORY_DIR = join(CONFIG.obsidianRoot, "10_Inbox", "Lark-Channel-Memory");
const JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    reply_markdown: { type: "string" },
    save_note_markdown: { type: ["string", "null"] },
  },
  required: ["reply_markdown", "save_note_markdown"],
  additionalProperties: false,
});

const processedMessages = new Set<string>();
const bucketQueues = new Map<string, Promise<unknown>>();
const bucketQueueDepths = new Map<string, number>();

// Buffer for forwarded content — Haiku extraction starts immediately, merge window waits for user instruction
let pendingForward: {
  messageId: string;
  extraction: Promise<ForwardExtract>;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
const FORWARD_MERGE_WINDOW_MS = 5_000;


mkdirSync(CONFIG.stateDir, { recursive: true });
mkdirSync(BUCKET_MEMORY_DIR, { recursive: true });

const log = (msg: string) =>
  process.stderr.write(`[lark-channel] ${new Date().toISOString().slice(0, 19)} ${msg}\n`);

function logJson(file: string, payload: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`);
}

function getBucketQueueDepth(bucketKey: string): number {
  return bucketQueueDepths.get(bucketKey) ?? 0;
}

function getTotalQueueDepth(): number {
  let total = 0;
  for (const depth of bucketQueueDepths.values()) total += depth;
  return total;
}

function isDuplicate(messageId: string): boolean {
  if (processedMessages.has(messageId)) return true;
  processedMessages.add(messageId);
  if (processedMessages.size > 500) processedMessages.clear();
  return false;
}

function loadSessionState(): SessionState {
  try {
    if (!existsSync(SESSION_FILE)) return {};
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionState;
  } catch (error) {
    log(`failed to load sessions: ${error}`);
    return {};
  }
}

function saveSessionState(state: SessionState): void {
  writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

function sessionStateKey(bucket: string): string {
  return `${CONFIG.chatId}:${bucket}`;
}

function bucketMemoryFile(bucket: string): string {
  return join(BUCKET_MEMORY_DIR, `${bucket}.md`);
}

function trimLargeFile(path: string, keepChars: number): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  if (content.length <= keepChars) return;
  writeFileSync(path, `# Memory Snapshot\n\n${content.slice(-keepChars)}`);
}

function readBucketMemory(bucket: string): string {
  const file = bucketMemoryFile(bucket);
  if (!existsSync(file)) return "";
  const content = readFileSync(file, "utf8");
  return content.slice(-CONFIG.bucketMemoryTailChars);
}

function appendBucketMemory(bucket: string, instruction: string, result: ClaudeStructuredResult): string {
  const file = bucketMemoryFile(bucket);
  if (!existsSync(file)) {
    writeFileSync(file, `# ${bucket} memory\n\n`);
  }
  const snapshot = (result.save_note_markdown || result.reply_markdown)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000);
  const entry = [
    `## ${new Date().toISOString().slice(0, 16)} ${bucket}`,
    "",
    `**User**: ${instruction}`,
    "",
    snapshot,
    "",
  ].join("\n");
  appendFileSync(file, entry);
  trimLargeFile(file, 24000);
  return file;
}

// --- Haiku fast path: direct API calls for classification and extraction ---

async function callHaiku(prompt: string, maxTokens = 300, purpose = "haiku"): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CONFIG.haikuModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Haiku API ${resp.status}: ${err}`);
  }
  const data = (await resp.json()) as any;
  const usage: ClaudeUsage = {
    input_tokens: data.usage?.input_tokens || 0,
    output_tokens: data.usage?.output_tokens || 0,
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
  };
  // Haiku pricing: $0.80/M input, $4/M output
  const costUsd = (usage.input_tokens! * 0.8 + usage.output_tokens! * 4) / 1_000_000;
  updateDailyUsage(purpose, "haiku", usage, costUsd);
  return (data.content?.[0]?.text || "").trim();
}

// Recent message history for dispatch context (ring buffer, last 5)
const recentMessages: Array<{ ts: number; instruction: string; bucket: string; isForward: boolean }> = [];
const MAX_RECENT = 5;

function addRecentMessage(instruction: string, bucket: string, isForward: boolean): void {
  recentMessages.push({ ts: Date.now(), instruction: instruction.slice(0, 120), bucket, isForward });
  if (recentMessages.length > MAX_RECENT) recentMessages.shift();
}

function recentContext(): string {
  if (!recentMessages.length) return "No recent messages.";
  return recentMessages
    .map((m, i) => `${i + 1}. [${m.bucket}${m.isForward ? " (forwarded)" : ""}] ${m.instruction}`)
    .join("\n");
}

type DispatchDecision = {
  bucket: string;
  model: "sonnet" | "opus";
  reasoning: string;
};

async function dispatchWithHaiku(instruction: string, isForward: boolean): Promise<DispatchDecision> {
  const prompt = `You are a message router for a CEO's AI assistant. Route each message to the correct processing bucket and choose the right model.

Available buckets:
- calendar: meetings, agenda, schedule, invites, RSVPs
- email: emails, inbox, mail-related requests
- lark_docs: Lark documents, wikis, knowledge base
- chat_history: Lark IM messages, conversation threads
- general: anything that doesn't fit the above

Model selection:
- sonnet: default for everything — fast, cheap, good enough for most tasks
- opus: ONLY when the user explicitly asks for deep reasoning ("use opus", "think deeply")

IMPORTANT: If the message references a recent forwarded item (e.g., "draft a reply", "translate this", "summarize it"), route to the SAME bucket as that forwarded item.

Recent message history:
${recentContext()}

Current message${isForward ? " (forwarded content)" : ""}:
${instruction.slice(0, 500)}

Respond in exactly this format (3 lines, no extra text):
BUCKET: <bucket name>
MODEL: <sonnet or opus>
REASON: <one short sentence>`;

  try {
    const output = await callHaiku(prompt, 100, "_dispatch");
    const bucketMatch = output.match(/BUCKET:\s*(\S+)/i);
    const modelMatch = output.match(/MODEL:\s*(\S+)/i);
    const reasonMatch = output.match(/REASON:\s*(.+)/i);

    const bucket = bucketMatch?.[1] || "general";
    const validBuckets = ["calendar", "email", "lark_docs", "chat_history", "general"];
    const model = (modelMatch?.[1]?.toLowerCase() === "opus" ? "opus" : "sonnet") as "sonnet" | "opus";

    log(`haiku dispatch: ${bucket} / ${model} — ${reasonMatch?.[1]?.slice(0, 60) || "no reason"}`);
    return {
      bucket: validBuckets.includes(bucket) ? bucket : "general",
      model,
      reasoning: reasonMatch?.[1] || "",
    };
  } catch (err) {
    log(`haiku dispatch failed, using keyword fallback: ${err}`);
    return fallbackDetect(instruction);
  }
}

function fallbackDetect(instruction: string): DispatchDecision {
  const lower = instruction.toLowerCase();
  let bucket = "general";
  if (["calendar", "agenda", "meeting", "schedule", "invite", "rsvp"].some((kw) => lower.includes(kw))) {
    bucket = "calendar";
  } else if (["email", "mail", "inbox", "reply to email", "gmail"].some((kw) => lower.includes(kw))) {
    bucket = "email";
  } else if (["doc", "docs", "document", "wiki", "knowledge base"].some((kw) => lower.includes(kw))) {
    bucket = "lark_docs";
  } else if (["chat history", "im messages", "conversation", "thread", "messages", "chat log"].some((kw) => lower.includes(kw))) {
    bucket = "chat_history";
  }
  const model = ["use opus", "think deeply", "deep reasoning"].some((kw) => lower.includes(kw)) ? "opus" as const : "sonnet" as const;
  return { bucket, model, reasoning: "keyword fallback" };
}

type ForwardExtract = {
  default_action: string;
  clean_extract: string;
};

async function extractForward(content: string): Promise<ForwardExtract> {
  const prompt = `You are a pre-processor for a CEO's AI assistant. You receive raw forwarded content (email, article, doc, chat thread, etc.) and your job is to strip noise and extract signal.

Step 1: Identify content type (email, article, document, chat thread, meeting notes, report, video link, etc.)
Step 2: Extract ONLY the essential information. Remove:
- email signatures, legal disclaimers, boilerplate
- "Dear X" / "Best regards" / greetings
- automated footer text, unsubscribe links
- redundant reply-chain repetition
- formatting artifacts
Step 3: Output in this exact format:

DEFAULT_ACTION: <one-line instruction for what to do with this content — be specific to what you see>
---
Type: <content type>
From: <sender if available>
Date: <date if available>
Subject: <subject or topic>
Key points:
- <point 1>
- <point 2>
Action required: <specific action or "None">
Deadline: <deadline or "None">
Additional context: <anything else important, or omit>

Be ruthless about compression. The CEO's time and token budget are both limited.

Raw content:
${content.slice(0, 4000)}`;

  try {
    const output = await callHaiku(prompt, 400, "_extract_forward");
    const dashIdx = output.indexOf("---");
    let defaultAction = "Summarize this forwarded content concisely.";
    let cleanExtract = output;
    if (dashIdx > 0) {
      const actionLine = output.slice(0, dashIdx).trim();
      const match = actionLine.match(/^DEFAULT_ACTION:\s*(.+)/i);
      if (match) defaultAction = match[1].trim();
      cleanExtract = output.slice(dashIdx + 3).trim();
    }
    log(`haiku extracted (${cleanExtract.length} chars): ${defaultAction.slice(0, 80)}`);
    return { default_action: defaultAction, clean_extract: cleanExtract };
  } catch (err) {
    log(`haiku extraction failed: ${err}`);
    return {
      default_action: "Summarize this forwarded content. Include: key points, action required, and deadlines. Be concise.",
      clean_extract: content.slice(0, 3000),
    };
  }
}

const LONG_CONTENT_THRESHOLD = 500;

async function extractLongContent(content: string): Promise<string> {
  const prompt = `You are a pre-processor for a CEO's AI assistant. You receive a long message and your job is to compress it into the essential information only.

Rules:
- Keep ALL factual content: names, dates, numbers, decisions, action items, deadlines
- Remove noise: greetings, filler phrases, repetition, boilerplate, signatures, disclaimers
- Preserve the user's intent/question if there is one — put it first
- Output structured bullet points when appropriate
- Keep the same language as the input
- Be ruthless: aim for 30-50% compression on most content

If the content is already concise and information-dense, return it as-is.

Content to compress:
${content.slice(0, 6000)}`;

  try {
    const compressed = await callHaiku(prompt, 600, "_extract_long");
    const ratio = Math.round((1 - compressed.length / content.length) * 100);
    log(`haiku compressed long content: ${content.length} → ${compressed.length} chars (${ratio}% reduction)`);
    return compressed;
  } catch (err) {
    log(`haiku long content extraction failed: ${err}`);
    return content; // fallback: pass through raw
  }
}

const BUCKET_LABELS: Record<string, string> = {
  calendar: "Calendar read/create",
  email: "Email retrieval",
  lark_docs: "Lark document analysis",
  chat_history: "Chat history / IM messages",
  general: "General / future use case",
};

function bucketConfig(key: string): BucketConfig {
  return { key, label: BUCKET_LABELS[key] || "General / future use case" };
}


function shouldPersist(instruction: string): boolean {
  return ["save", "note", "remember"].some((kw) => instruction.toLowerCase().includes(kw));
}

async function runProcess(
  cmd: string[],
  opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    },
  });

  if (opts.stdin && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }

  const timeoutMs = opts.timeoutMs ?? 180_000;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.exited.finally(() => clearTimeout(timer));
  });

  const result = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));

  return Promise.race([result, timeoutPromise]);
}

async function runLarkCli(args: string[]): Promise<string> {
  const { stdout, stderr, code } = await runProcess([CONFIG.larkCli, ...args], {
    timeoutMs: 30_000,
  });
  if (code !== 0) log(`lark-cli exited ${code}: ${stderr.trim()}`);
  return stdout.trim();
}

async function sendReply(text: string, meta: Record<string, unknown> = {}): Promise<void> {
  const args = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--chat-id",
    CONFIG.chatId,
    "--markdown",
    text,
  ];

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { stdout, stderr, code } = await runProcess([CONFIG.larkCli, ...args], {
      timeoutMs: 30_000,
    });
    if (code === 0) {
      logJson(OUTBOX_FILE, {
        type: "send",
        ok: true,
        attempt,
        textPreview: text.slice(0, 120),
        ...meta,
      });
      return;
    }
    lastError = stderr.trim() || stdout.trim() || `exit ${code}`;
    await Bun.sleep(attempt * 750);
  }

  logJson(OUTBOX_FILE, {
    type: "send",
    ok: false,
    error: lastError,
    textPreview: text.slice(0, 120),
    ...meta,
  });
  throw new Error(`sendReply failed: ${lastError}`);
}

async function handleSimpleCalendar(instruction: string): Promise<string | null> {
  const lower = instruction.toLowerCase();
  if (!["calendar", "agenda", "meeting", "schedule"].some((kw) => lower.includes(kw))) {
    return null;
  }

  const raw = await runLarkCli(["calendar", "+agenda", "--format", "json"]);
  try {
    const data = JSON.parse(raw);
    const events = data.data || [];
    if (!events.length) return "No events on your calendar today.";

    const isWeek = ["week", "this week"].some((kw) => lower.includes(kw));
    const lines = [isWeek ? "**Your upcoming events:**\n" : "**Today's agenda:**\n"];
    for (const event of events) {
      const summary = event.summary || "(no title)";
      const start = event.start_time?.datetime || "";
      const end = event.end_time?.datetime || "";
      const st = isWeek ? start.slice(5, 16).replace("T", " ") : start.slice(11, 16);
      const et = end ? end.slice(11, 16) : "";
      lines.push(`- ${st}-${et}  ${summary}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function handleSimpleTasks(instruction: string): Promise<string | null> {
  const lower = instruction.toLowerCase();
  if (!["task", "todo", "to-do"].some((kw) => lower.includes(kw))) return null;

  const raw = await runLarkCli(["task", "+get-my-tasks", "--format", "json"]);
  try {
    const data = JSON.parse(raw);
    const items = data.data?.items || data.data || [];
    if (!items.length) return "No active tasks found.";

    const lines = ["**Your tasks:**\n"];
    for (const item of items.slice(0, 10)) {
      const summary = item.summary || "(no title)";
      const overdue =
        item.due_at && new Date(item.due_at).getTime() < Date.now() ? " [OVERDUE]" : "";
      lines.push(`- ${summary}${overdue}`);
    }
    if (items.length > 10) lines.push(`\n_...and ${items.length - 10} more_`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function handleSimpleEmail(_instruction: string): Promise<string | null> {
  return null;
}

function buildClaudePrompt(
  instruction: string,
  persist: boolean,
  bucket: BucketConfig,
  memoryText: string
): string {
  const memoryBlock = memoryText
    ? [`Recent ${bucket.label} memory from Obsidian:`, memoryText.trim(), ""].join("\n")
    : "";

  return [
    `You are Claude Channel, a CEO's AI assistant (bucket: ${bucket.label}).`,
    "",
    "Formatting rules (STRICT):",
    "- Respond in the same language the user writes in",
    "- Keep replies SHORT — max 10 lines for simple requests, max 20 for complex ones",
    "- Use bold for key info: names, dates, amounts, decisions",
    "- Use bullet points, NOT tables (Lark renders tables poorly)",
    "- No horizontal rules (---), no emoji headers, no decorative formatting",
    "- Lead with the answer or decision, then supporting details",
    "- For emails/docs: one-line subject, then 3-5 bullet points max",
    "- For action items: bold the owner and deadline",
    "- Never say 'here is the summary' — just give the summary",
    "",
    "Do not mention tools, internal reasoning, or session mechanics.",
    persist
      ? "Also produce a concise markdown note suitable for appending to the daily brief."
      : "Set save_note_markdown to null unless the user explicitly asked to save, note, or remember.",
    "If the request is ambiguous, make the best reasonable assumption and answer directly.",
    "",
    memoryBlock,
    "User message:",
    instruction,
  ].filter(Boolean).join("\n");
}

function normalizeClaudePayload(result: unknown): ClaudeStructuredResult {
  if (result && typeof result === "object") {
    const obj = result as Partial<ClaudeStructuredResult>;
    if (typeof obj.reply_markdown === "string") {
      return {
        reply_markdown: obj.reply_markdown.trim(),
        save_note_markdown: obj.save_note_markdown?.trim() || null,
      };
    }
  }

  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed) throw new Error("Claude result was empty");
    if (trimmed.startsWith("{")) {
      try {
        return normalizeClaudePayload(JSON.parse(trimmed));
      } catch {
      }
    }
    return {
      reply_markdown: trimmed,
      save_note_markdown: null,
    };
  }

  throw new Error("Claude result missing reply_markdown");
}

function extractFallbackText(outer: any): string {
  const candidates = [
    outer?.structured_output,
    outer?.result,
    outer?.message,
    outer?.content,
    outer?.output,
    outer?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            if (typeof item.text === "string") return item.text;
            if (typeof item.content === "string") return item.content;
          }
          return "";
        })
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }

  return "";
}

function parseClaudeUsage(raw: string): { durationMs: number | null; totalCostUsd: number | null; usage: ClaudeUsage } {
  const outer = JSON.parse(raw);
  return {
    durationMs: typeof outer.duration_ms === "number" ? outer.duration_ms : null,
    totalCostUsd: typeof outer.total_cost_usd === "number" ? outer.total_cost_usd : null,
    usage: (outer.usage || {}) as ClaudeUsage,
  };
}

function updateDailyUsage(bucket: string, model: string, usage: ClaudeUsage, totalCostUsd: number | null): void {
  const date = new Date().toISOString().slice(0, 10);
  let root: any = {};
  try {
    if (existsSync(USAGE_DAILY_FILE)) {
      root = JSON.parse(readFileSync(USAGE_DAILY_FILE, "utf8"));
    }
  } catch {
    root = {};
  }

  root[date] ||= { totals: {}, buckets: {} };
  root[date].buckets[bucket] ||= {};
  root[date].buckets[bucket][model] ||= {
    calls: 0,
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
  };

  const agg = root[date].buckets[bucket][model];
  agg.calls += 1;
  agg.input_tokens += usage.input_tokens || 0;
  agg.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  agg.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  agg.output_tokens += usage.output_tokens || 0;
  agg.total_cost_usd += totalCostUsd || 0;

  const totals = root[date].totals;
  totals.calls = (totals.calls || 0) + 1;
  totals.input_tokens = (totals.input_tokens || 0) + (usage.input_tokens || 0);
  totals.cache_creation_input_tokens =
    (totals.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  totals.cache_read_input_tokens =
    (totals.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  totals.output_tokens = (totals.output_tokens || 0) + (usage.output_tokens || 0);
  totals.total_cost_usd = (totals.total_cost_usd || 0) + (totalCostUsd || 0);

  writeFileSync(USAGE_DAILY_FILE, JSON.stringify(root, null, 2));
}

function parseClaudeResult(raw: string): { sessionId: string; payload: ClaudeStructuredResult } {
  const outer = JSON.parse(raw);
  const sessionId = String(outer.session_id || "");
  if (!sessionId) throw new Error("Claude result missing session_id");

  try {
    return {
      sessionId,
      payload: normalizeClaudePayload(outer.structured_output ?? outer.result),
    };
  } catch (error) {
    const fallbackText = extractFallbackText(outer);
    if (fallbackText) {
      return {
        sessionId,
        payload: {
          reply_markdown: fallbackText,
          save_note_markdown: null,
        },
      };
    }
    throw error;
  }
}

async function runClaude(
  instruction: string,
  bucket: BucketConfig,
  model: string
): Promise<ClaudeStructuredResult> {
  const state = loadSessionState();
  const key = sessionStateKey(bucket.key);
  const current = state[key];
  const existing = current && current.turns < CONFIG.maxSessionTurns ? current : undefined;
  const persist = shouldPersist(instruction);
  const memoryText = existing?.sessionId ? "" : readBucketMemory(bucket.key);

  if (current && !existing) {
    delete state[key];
    saveSessionState(state);
    logJson(EVENTS_FILE, {
      type: "session_rotated",
      bucket: bucket.key,
      reason: "max_turns",
      priorTurns: current.turns,
    });
  }

  const args = [
    CONFIG.claudeCli,
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    CONFIG.claudePermissionMode,
    "--json-schema",
    JSON_SCHEMA,
    "--model",
    model,
    "--add-dir",
    CONFIG.obsidianRoot,
  ];

  if (existing?.sessionId) {
    args.push("--resume", existing.sessionId);
  }
  args.push("--", buildClaudePrompt(instruction, persist, bucket, memoryText));

  const first = await runProcess(args, {
    cwd: CONFIG.claudeWorkdir,
    timeoutMs: 180_000,
  });

  logJson(CLAUDE_RAW_FILE, {
    type: "claude_run",
    phase: "first",
    bucket: bucket.key,
    model,
    resumed: Boolean(existing?.sessionId),
    code: first.code,
    stdout: first.stdout.slice(0, 6000),
    stderr: first.stderr.slice(0, 2000),
  });

  if (first.code !== 0) {
    const detail = first.stderr.trim() || first.stdout.trim();
    log(`claude failed${existing?.sessionId ? " on resume" : ""}: ${detail}`);
    if (!existing?.sessionId) {
      throw new Error(detail || "Claude request failed");
    }

    const retryArgs = args.filter((arg, idx) => !(arg === "--resume" || args[idx - 1] === "--resume"));
    const retry = await runProcess(retryArgs, {
      cwd: CONFIG.claudeWorkdir,
      timeoutMs: 180_000,
    });
    logJson(CLAUDE_RAW_FILE, {
      type: "claude_run",
      phase: "retry_without_resume",
      bucket: bucket.key,
      model,
      resumed: false,
      code: retry.code,
      stdout: retry.stdout.slice(0, 6000),
      stderr: retry.stderr.slice(0, 2000),
    });
    if (retry.code !== 0) {
      throw new Error(retry.stderr.trim() || retry.stdout.trim() || "Claude retry failed");
    }
    const retryUsage = parseClaudeUsage(retry.stdout.trim());
    const parsedRetry = parseClaudeResult(retry.stdout.trim());
    state[key] = {
      sessionId: parsedRetry.sessionId,
      updatedAt: new Date().toISOString(),
      turns: 1,
      bucket: bucket.key,
      model,
    };
    saveSessionState(state);
    updateDailyUsage(bucket.key, model, retryUsage.usage, retryUsage.totalCostUsd);
    logJson(EVENTS_FILE, {
      type: "usage",
      bucket: bucket.key,
      model,
      resumed: false,
      durationMs: retryUsage.durationMs,
      totalCostUsd: retryUsage.totalCostUsd,
      ...retryUsage.usage,
    });
    return parsedRetry.payload;
  }

  const firstUsage = parseClaudeUsage(first.stdout.trim());
  const parsed = parseClaudeResult(first.stdout.trim());
  state[key] = {
    sessionId: parsed.sessionId,
    updatedAt: new Date().toISOString(),
    turns: (existing?.turns ?? 0) + 1,
    bucket: bucket.key,
    model,
  };
  saveSessionState(state);
  updateDailyUsage(bucket.key, model, firstUsage.usage, firstUsage.totalCostUsd);
  logJson(EVENTS_FILE, {
    type: "usage",
    bucket: bucket.key,
    model,
    resumed: Boolean(existing?.sessionId),
    durationMs: firstUsage.durationMs,
    totalCostUsd: firstUsage.totalCostUsd,
    ...firstUsage.usage,
  });
  return parsed.payload;
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function appendDailyBrief(noteMarkdown: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const file = join(CONFIG.dailyBriefDir, `Daily-Brief-${date}.md`);
  ensureParentDir(file);
  if (!existsSync(file)) {
    writeFileSync(file, `# Daily Brief - ${date}\n\n`);
  }
  appendFileSync(file, `## ${now.toISOString().slice(11, 16)} Claude Channel\n\n${noteMarkdown}\n\n`);
  return file;
}

function formatReplyForLark(text: string): string {
  return text
    .replace(/^\|.*\|$/gm, (row) => {
      // Convert any stray table rows to bullet points
      const cols = row.split("|").map((s) => s.trim()).filter(Boolean);
      return cols.length ? `- ${cols.join(" · ")}` : row;
    })
    .replace(/^\|[-| ]+\|?$/gm, "") // Remove table separator lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function enqueue<T>(bucketKey: string, task: () => Promise<T>): Promise<T> {
  bucketQueueDepths.set(bucketKey, getBucketQueueDepth(bucketKey) + 1);

  const prior = bucketQueues.get(bucketKey) ?? Promise.resolve();
  const current = prior.then(task, task);

  bucketQueues.set(
    bucketKey,
    current.then(
      () => undefined,
      () => undefined
    )
  );

  current.finally(() => {
    const nextDepth = Math.max(0, getBucketQueueDepth(bucketKey) - 1);
    if (nextDepth === 0) {
      bucketQueueDepths.delete(bucketKey);
      bucketQueues.delete(bucketKey);
    } else {
      bucketQueueDepths.set(bucketKey, nextDepth);
    }
  });

  return current;
}

async function handleComplex(
  instruction: string,
  messageId: string,
  bucket: BucketConfig,
  model: string,
): Promise<void> {
  const start = Date.now();

  const result = await runClaude(instruction, bucket, model);
  const memoryFile = appendBucketMemory(bucket.key, instruction, result);
  let noteFile: string | null = null;
  if (result.save_note_markdown) {
    noteFile = appendDailyBrief(result.save_note_markdown);
  }

  const replyText = formatReplyForLark(result.reply_markdown);

  await sendReply(replyText, {
    type: "reply",
    messageId,
    noteFile,
    memoryFile,
    bucket: bucket.key,
    model,
  });
  logJson(EVENTS_FILE, {
    type: "complex_complete",
    messageId,
    durationMs: Date.now() - start,
    persisted: Boolean(noteFile),
    noteFile,
    memoryFile,
    bucket: bucket.key,
    model,
  });
}

function handleInbound(instruction: string, messageId: string, isForward = false): void {
  // Dispatch happens async — enqueue to a temporary holding queue, then re-enqueue to the right bucket
  (async () => {
    const start = Date.now();

    // For long non-forward text, run Haiku extraction to compress before reasoning
    // Forwards are already extracted upstream via extractForward()
    let processed = instruction;
    if (!isForward && instruction.length > LONG_CONTENT_THRESHOLD) {
      processed = await extractLongContent(instruction);
    }

    // Haiku decides bucket + model (~300-800ms via direct API)
    const dispatch = await dispatchWithHaiku(processed, isForward);
    const bucket = bucketConfig(dispatch.bucket);
    const model = dispatch.model === "opus" ? CONFIG.reasoningModel : CONFIG.defaultModel;

    // Track for follow-up context (use original instruction for context, not compressed)
    addRecentMessage(instruction, dispatch.bucket, isForward);

    const queueAhead = getBucketQueueDepth(bucket.key);

    enqueue(bucket.key, async () => {
      logJson(EVENTS_FILE, {
        type: "inbound",
        messageId,
        instruction: instruction.slice(0, 300),
        routeMode: CONFIG.routeMode,
        bucket: bucket.key,
        model,
        dispatchReason: dispatch.reasoning,
        isForward,
        compressed: processed !== instruction,
        queueAhead,
      });

      // Try simple handlers first (zero-token, instant) — but skip for forwards
      // Forwarded content often mentions "meeting"/"schedule" etc. in body text,
      // which would falsely trigger simple calendar/task handlers
      if (!isForward) {
        const simple =
          (await handleSimpleCalendar(instruction)) ??
          (await handleSimpleTasks(instruction)) ??
          (await handleSimpleEmail(instruction));

        if (simple !== null) {
          await sendReply(simple, { type: "simple", messageId, bucket: bucket.key });
          logJson(EVENTS_FILE, {
            type: "simple_complete",
            messageId,
            durationMs: Date.now() - start,
            bucket: bucket.key,
          });
          return;
        }
      }

      // Send compressed content to reasoning model (saves tokens + reduces noise)
      await handleComplex(processed, messageId, bucket, model);
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`handleInbound error: ${message}`);
      logJson(EVENTS_FILE, { type: "error", messageId, error: message });
      try {
        await sendReply(
          "I hit an internal error while working on that. Please retry once.",
          { type: "error", messageId },
        );
      } catch (replyError) {
        log(`failed to send error reply: ${replyError}`);
      }
    });
  })();
}

process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error}`));
process.on("uncaughtException", (error) => log(`uncaught exception: ${error}`));

Bun.serve({
  port: CONFIG.port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      const sessions = loadSessionState();
      return Response.json({
        status: "ok",
        service: "lark-channel",
        queueDepth: getTotalQueueDepth(),
        bucketQueueDepths: Object.fromEntries(bucketQueueDepths.entries()),
        hasSession: Boolean(Object.keys(sessions).length),
        routeMode: CONFIG.routeMode,
        defaultModel: CONFIG.defaultModel,
        reasoningModel: CONFIG.reasoningModel,
        maxSessionTurns: CONFIG.maxSessionTurns,
      });
    }

    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }

    let data: any;
    try {
      data = await req.json();
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    if (data.type === "url_verification") {
      if (data.token && data.token !== CONFIG.verificationToken) {
        log("URL verification rejected: invalid token");
        return Response.json({ error: "invalid token" }, { status: 403 });
      }
      return Response.json({ challenge: data.challenge || "" });
    }

    const header = data.header || {};
    if (header.token && header.token !== CONFIG.verificationToken) {
      log("Rejected event: invalid token");
      return Response.json({ error: "invalid token" }, { status: 403 });
    }

    if (header.event_type !== "im.message.receive_v1") {
      return Response.json({ ok: true });
    }

    const event = data.event || {};
    const message = event.message || {};
    const sender = event.sender || {};

    const senderId = sender.sender_id?.open_id || "";
    const chatId = message.chat_id || "";
    const messageId = message.message_id || "";
    const messageType = message.message_type || "";

    if (senderId !== CONFIG.ownerOpenId) return Response.json({ ok: true });
    if (chatId !== CONFIG.chatId) return Response.json({ ok: true });
    if (!messageId || isDuplicate(messageId)) return Response.json({ ok: true });

    let text = "";
    try {
      const content = JSON.parse(message.content || "{}");
      if (messageType === "text") {
        text = content.text || "";
      } else if (messageType === "post") {
        // Rich text — extract all text nodes
        const lang = content.zh_cn || content.en_us || content[Object.keys(content)[0]] || {};
        const title = lang.title || "";
        const body = (lang.content || [])
          .flat()
          .map((node: any) => node.text || node.content || "")
          .filter(Boolean)
          .join(" ");
        text = [title, body].filter(Boolean).join("\n\n");
      } else if (messageType === "interactive") {
        // Forwarded emails / cards — extract title + all text elements
        const title = content.title || "";
        const body = (content.elements || [])
          .flat()
          .map((node: any) => node.text || "")
          .filter(Boolean)
          .join("");
        text = [title, body].filter(Boolean).join("\n\n");
      } else if (messageType === "file") {
        // File attachment — download and pass file path to Claude
        const fileKey = content.file_key || "";
        const fileName = content.file_name || "unknown_file";
        if (!fileKey) {
          log(`file message missing file_key, messageId: ${messageId}`);
          return Response.json({ ok: true });
        }
        const downloadDir = join(CONFIG.stateDir, "downloads");
        mkdirSync(downloadDir, { recursive: true });
        const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const outputPath = join(downloadDir, safeName);
        try {
          await runProcess([
            CONFIG.larkCli, "im", "+messages-resources-download",
            "--as", "bot",
            "--message-id", messageId,
            "--file-key", fileKey,
            "--type", "file",
            "--output", safeName,
          ], { cwd: downloadDir, timeoutMs: 30_000 });
          text = `[File: ${fileName}]\nDownloaded to: ${outputPath}\nPlease read and analyze this file.`;
          log(`downloaded file: ${fileName} → ${outputPath}`);
        } catch (err) {
          log(`file download failed: ${err}`);
          text = `[File: ${fileName}] (download failed — file_key: ${fileKey})`;
        }
      } else if (messageType === "image") {
        // Image attachment — download and pass to Claude
        const imageKey = content.image_key || "";
        if (!imageKey) {
          log(`image message missing image_key, messageId: ${messageId}`);
          return Response.json({ ok: true });
        }
        const downloadDir = join(CONFIG.stateDir, "downloads");
        mkdirSync(downloadDir, { recursive: true });
        const safeName = `${Date.now()}_${imageKey}.png`;
        const outputPath = join(downloadDir, safeName);
        try {
          await runProcess([
            CONFIG.larkCli, "im", "+messages-resources-download",
            "--as", "bot",
            "--message-id", messageId,
            "--file-key", imageKey,
            "--type", "image",
            "--output", safeName,
          ], { cwd: downloadDir, timeoutMs: 30_000 });
          text = `[Image: ${imageKey}]\nDownloaded to: ${outputPath}\nPlease analyze this image.`;
          log(`downloaded image: ${imageKey} → ${outputPath}`);
        } catch (err) {
          log(`image download failed: ${err}`);
          text = `[Image] (download failed — image_key: ${imageKey})`;
        }
      } else {
        log(`unsupported message_type: ${messageType}, messageId: ${messageId}`);
        return Response.json({ ok: true });
      }
    } catch {
      text = "";
    }
    // Strip HTML tags from rich text content
    text = text.replace(/<[^>]+>/g, "").trim();
    if (!text) return Response.json({ ok: true });

    // Determine if this should be buffered (forwarded content, URL-only messages)
    const isUrlOnly = messageType === "text" && /^\s*https?:\/\/\S+\s*$/.test(text);
    const shouldBuffer = messageType === "interactive" || messageType === "post" || messageType === "file" || messageType === "image" || isUrlOnly;

    if (shouldBuffer) {
      // Forwarded content, file, image, or URL — buffer and wait for follow-up instruction
      if (pendingForward) clearTimeout(pendingForward.timer);
      const forwardText = text;
      const forwardId = messageId;
      const isFileOrImage = messageType === "file" || messageType === "image";
      // Haiku extraction starts NOW for text content — skip for files/images (Sonnet reads those directly)
      const extraction = isFileOrImage
        ? Promise.resolve({ default_action: `Read and summarize this ${messageType}.`, clean_extract: forwardText })
        : isUrlOnly
          ? Promise.resolve({ default_action: `Fetch and summarize this link: ${forwardText}`, clean_extract: forwardText })
          : extractForward(forwardText);
      pendingForward = {
        messageId: forwardId,
        extraction,
        timer: setTimeout(async () => {
          // No follow-up arrived — use default action + content
          if (pendingForward?.messageId === forwardId) {
            pendingForward = null;
            const { default_action, clean_extract } = await extraction;
            handleInbound(`Summarize the following forwarded content concisely. At the end, suggest a recommended next action.\n\nSuggested action: ${default_action}\n\n---\n\n${clean_extract}`, forwardId, true);
          }
        }, FORWARD_MERGE_WINDOW_MS),
      };
      return Response.json({ ok: true });
    }

    // Text message — check if there's a pending forward/URL to merge with
    if (pendingForward) {
      clearTimeout(pendingForward.timer);
      const pending = pendingForward;
      pendingForward = null;
      // Await Haiku extraction, then merge user instruction with clean extract
      // Mark as forward since content is already Haiku-extracted (skip re-compression)
      pending.extraction.then(({ clean_extract }) => {
        handleInbound(`${text}\n\n---\n\nForwarded content:\n${clean_extract}`, messageId, true);
      }).catch(() => {
        handleInbound(text, messageId);
      });
      return Response.json({ ok: true });
    }

    handleInbound(text, messageId);
    return Response.json({ ok: true });
  },
});

log(`HTTP webhook listening on http://0.0.0.0:${CONFIG.port}/webhook`);
