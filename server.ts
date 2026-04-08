#!/usr/bin/env bun

import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";


type ClaudeStructuredResult = {
  reply_markdown: string;
  save_note_markdown: string | null;
};

type BucketConfig = {
  key: string;
  label: string;
};

type ReplyLang = "zh" | "en" | "auto";

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
  larkCli: process.env.LARK_CLI ?? "lark-cli",
  claudeCli: process.env.CLAUDE_CLI ?? "claude",
  port: Number(process.env.PORT ?? "8765"),
  claudeWorkdir: process.env.CLAUDE_WORKDIR ?? ".",
  obsidianRoot: process.env.OBSIDIAN_ROOT ?? "./obsidian-vault",
  dailyBriefDir:
    process.env.DAILY_BRIEF_DIR ?? "./obsidian-vault/Inbox",
  stateDir:
    process.env.LARK_CHANNEL_STATE_DIR ?? "./.state",
  routeMode: process.env.LARK_ROUTE_MODE ?? "claude_direct",
  defaultModel: process.env.CLAUDE_MODEL_DEFAULT ?? process.env.CLAUDE_MODEL ?? "sonnet",
  reasoningModel: process.env.CLAUDE_MODEL_REASONING ?? "opus",
  haikuModel: process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001",
  claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE ?? "dontAsk",
};

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
  contentLang: ReplyLang;
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



function bucketMemoryFile(bucket: string): string {
  return join(BUCKET_MEMORY_DIR, `${bucket}.md`);
}

function trimLargeFile(path: string, keepChars: number): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  if (content.length <= keepChars) return;
  writeFileSync(path, `# Memory Snapshot\n\n${content.slice(-keepChars)}`);
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

// --- Direct Sonnet API for tool-free tasks ---

const DISTRESS_SIGNALS = [
  // English
  "i don't have access",
  "i can't see",
  "i cannot see",
  "could you share",
  "could you paste",
  "could you provide",
  "no content visible",
  "no email visible",
  "no email content",
  "no document visible",
  "i'm unable to",
  "i am unable to",
  "please share",
  "please paste",
  "please provide the",
  "not visible in this conversation",
  // Chinese
  "我无法访问",
  "我看不到",
  "我无法看到",
  "请提供",
  "请分享",
  "请粘贴",
  "没有看到内容",
  "没有邮件内容",
  "没有文档内容",
  "无法获取",
  "我没有权限",
  "内容不可见",
];

function isDistressResponse(text: string): boolean {
  const lower = text.toLowerCase();
  return text.length < 20 || DISTRESS_SIGNALS.some((sig) => lower.includes(sig));
}

type SonnetDirectResult = {
  reply: string;
  fallback: boolean;
  usage: ClaudeUsage;
  costUsd: number;
};

async function callSonnetDirect(prompt: string, maxTokens = 2000): Promise<SonnetDirectResult> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CONFIG.defaultModel === "sonnet" ? "claude-sonnet-4-6" : CONFIG.defaultModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Sonnet Direct API ${resp.status}: ${err}`);
  }
  const data = (await resp.json()) as any;
  const reply = (data.content?.[0]?.text || "").trim();
  const usage: ClaudeUsage = {
    input_tokens: data.usage?.input_tokens || 0,
    output_tokens: data.usage?.output_tokens || 0,
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
  };
  // Sonnet pricing: $3/M input, $15/M output
  const costUsd = (usage.input_tokens! * 3 + usage.output_tokens! * 15) / 1_000_000;
  updateDailyUsage("_sonnet_direct", "sonnet_direct", usage, costUsd);

  return { reply, fallback: isDistressResponse(reply), usage, costUsd };
}

// Last-exchange buffer per bucket for follow-up context on stateless calls
const lastDirectExchange = new Map<string, { instruction: string; reply: string; ts: number }>();

function saveDirectExchange(bucket: string, instruction: string, reply: string): void {
  lastDirectExchange.set(bucket, { instruction: instruction.slice(0, 2000), reply: reply.slice(0, 2000), ts: Date.now() });
}

function getDirectExchange(bucket: string): string {
  const ex = lastDirectExchange.get(bucket);
  if (!ex || Date.now() - ex.ts > 10 * 60 * 1000) return ""; // 10 min TTL
  return `Previous exchange in this topic:\nUser: ${ex.instruction}\nAssistant: ${ex.reply}\n\n`;
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
  simple: boolean; // true = zero-token deterministic handler, false = needs reasoning model
  tools: boolean;  // true = needs claude -p (tool access), false = direct API is sufficient
  dateStart?: string; // YYYY-MM-DD for date-based lookups
  dateEnd?: string;   // YYYY-MM-DD for date-based lookups
  reasoning: string;
};

async function dispatchWithHaiku(instruction: string, isForward: boolean): Promise<DispatchDecision> {
  const prompt = `You are a message router for a CEO's AI assistant. Route each message to the correct processing bucket, choose the right model, and decide what capabilities are needed.

Available buckets:
- calendar: meetings, agenda, schedule, invites, RSVPs
- email: emails, inbox, mail-related requests
- lark_docs: Lark documents, wikis, knowledge base
- chat_history: Lark IM messages, conversation threads
- general: anything that doesn't fit the above

Model selection:
- sonnet: default for everything — fast, cheap, good enough for most tasks
- opus: ONLY when the user explicitly asks for deep reasoning ("use opus", "think deeply")

Simple vs reasoning:
- SIMPLE=yes: Pure data lookups with no analysis needed — e.g. "show today's calendar", "show tomorrow's agenda", "what meetings do I have on Friday", "show my tasks", "what's on my schedule next week", "who is Peter?", "find Agnes", "what meetings yesterday?"
- SIMPLE=no: anything requiring reasoning, composition, multi-step actions, or analysis

Tools needed (DEFAULT IS YES — only say no when you are certain):
- TOOLS=yes: DEFAULT. Use for anything that might need external data, file access, or actions. This includes: checking calendar, reading emails, looking up tasks, searching chat, saving/writing files, reading documents, sending messages, opening links, any ambiguous request.
- TOOLS=no: ONLY when ALL three conditions are met: (1) ALL content needed is already present in the message text, (2) the task is purely text manipulation (summarize, translate, rewrite, draft, explain, analyze text), and (3) no file read/write/save/send/check/fetch/open/search is needed. When in doubt, say TOOLS=yes.

IMPORTANT: If the message references a recent forwarded item (e.g., "draft a reply", "translate this", "summarize it"), route to the SAME bucket as that forwarded item.

Recent message history:
${recentContext()}

Current message${isForward ? " (forwarded content)" : ""}:
${instruction.slice(0, 500)}

Today is ${new Date().toISOString().slice(0, 10)} (${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()]}).

Respond in exactly this format (6 lines, no extra text):
BUCKET: <bucket name>
MODEL: <sonnet or opus>
SIMPLE: <yes or no>
TOOLS: <yes or no>
DATE_RANGE: <YYYY-MM-DD to YYYY-MM-DD, or "none" if not a date-based lookup. For "today" use today's date. For "this week" use Mon-Sun. For "tomorrow" use tomorrow's date for both start and end.>
REASON: <one short sentence>`;

  try {
    const output = await callHaiku(prompt, 160, "_dispatch");
    const bucketMatch = output.match(/BUCKET:\s*(\S+)/i);
    const modelMatch = output.match(/MODEL:\s*(\S+)/i);
    const simpleMatch = output.match(/SIMPLE:\s*(\S+)/i);
    const toolsMatch = output.match(/TOOLS:\s*(\S+)/i);
    const dateRangeMatch = output.match(/DATE_RANGE:\s*(.+)/i);
    const reasonMatch = output.match(/REASON:\s*(.+)/i);

    const bucket = bucketMatch?.[1] || "general";
    const validBuckets = ["calendar", "email", "lark_docs", "chat_history", "general"];
    const model = (modelMatch?.[1]?.toLowerCase() === "opus" ? "opus" : "sonnet") as "sonnet" | "opus";
    const simple = simpleMatch?.[1]?.toLowerCase() === "yes";
    const tools = toolsMatch?.[1]?.toLowerCase() !== "no"; // default to yes (conservative)

    // Parse date range from Haiku (e.g. "2026-04-08 to 2026-04-08")
    let dateStart: string | undefined;
    let dateEnd: string | undefined;
    const dateStr = dateRangeMatch?.[1]?.trim();
    if (dateStr && dateStr !== "none") {
      const dates = dateStr.match(/(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/);
      if (dates) {
        dateStart = dates[1];
        dateEnd = dates[2];
      }
    }

    log(`haiku dispatch: ${bucket} / ${model} / simple=${simple} / tools=${tools}${dateStart ? ` / ${dateStart}..${dateEnd}` : ""} — ${reasonMatch?.[1]?.slice(0, 60) || "no reason"}`);
    return {
      bucket: validBuckets.includes(bucket) ? bucket : "general",
      model,
      simple,
      tools,
      dateStart,
      dateEnd,
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
  if (["calendar", "agenda", "meeting", "schedule", "invite", "rsvp", "日历", "会议", "日程", "议程", "邀请", "排期"].some((kw) => lower.includes(kw))) {
    bucket = "calendar";
  } else if (["email", "mail", "inbox", "reply to email", "gmail", "邮件", "邮箱", "收件箱", "回复邮件"].some((kw) => lower.includes(kw))) {
    bucket = "email";
  } else if (["doc", "docs", "document", "wiki", "knowledge base", "文档", "知识库", "wiki", "飞书文档"].some((kw) => lower.includes(kw))) {
    bucket = "lark_docs";
  } else if (["chat history", "im messages", "conversation", "thread", "messages", "chat log", "聊天记录", "消息", "对话", "聊天", "消息记录"].some((kw) => lower.includes(kw))) {
    bucket = "chat_history";
  }
  const model = ["use opus", "think deeply", "deep reasoning", "深度思考", "仔细想", "用opus"].some((kw) => lower.includes(kw)) ? "opus" as const : "sonnet" as const;
  return { bucket, model, simple: false, tools: true, reasoning: "keyword fallback" };
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

const LONG_CONTENT_THRESHOLD = 800;

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


function listVaultBuckets(): string[] {
  try {
    return readdirSync(CONFIG.obsidianRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function shouldPersist(instruction: string): boolean {
  return ["save", "note", "remember", "保存", "记录", "记住", "存", "笔记"].some((kw) => instruction.toLowerCase().includes(kw));
}

const TOOL_KEYWORDS = [
  // file ops
  "save", "note", "remember", "read", "open", "write", "create", "delete",
  // data fetching
  "check", "fetch", "search", "find", "look up", "lookup", "show me", "get my",
  // actions
  "send", "reply", "forward", "schedule", "book", "cancel", "move", "reschedule",
  // data sources
  "calendar", "email", "inbox", "mail", "task", "chat history", "messages",
  // Chinese — file ops
  "保存", "记住", "记录", "笔记", "读", "打开", "写", "创建", "删除", "存",
  // Chinese — data fetching
  "查", "检查", "搜索", "找", "查看", "获取", "看看",
  // Chinese — actions
  "发送", "回复", "转发", "预约", "取消", "移动", "改期", "下载", "上传",
  // Chinese — data sources
  "日历", "邮件", "邮箱", "任务", "日程", "聊天记录", "消息", "文档",
  // Chinese — analysis/summary that may need data
  "总结", "汇总", "分析", "整理",
];

function needsTools(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  return TOOL_KEYWORDS.some((kw) => lower.includes(kw));
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
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      // Strip ANTHROPIC_API_KEY from subprocesses — the claude CLI has its own auth,
      // and inheriting this key causes "Invalid API key" errors.
      ANTHROPIC_API_KEY: undefined as unknown as string,
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

async function fetchLarkDoc(url: string): Promise<string | null> {
  try {
    const result = await runProcess(
      [CONFIG.larkCli, "docs", "+fetch", "--doc", url, "--format", "pretty"],
      { timeoutMs: 15_000 }
    );
    if (result.code !== 0) {
      log(`lark doc fetch failed (code ${result.code}): ${result.stderr.slice(0, 200)}`);
      return null;
    }
    const content = result.stdout.trim();
    return content || null;
  } catch (err) {
    log(`lark doc fetch error: ${err}`);
    return null;
  }
}

async function fetchMeetingNotes(minuteToken: string): Promise<string | null> {
  try {
    const result = await runProcess(
      [CONFIG.larkCli, "vc", "+notes", "--minute-tokens", minuteToken, "--format", "json"],
      { timeoutMs: 15_000 }
    );
    if (result.code !== 0) {
      log(`vc +notes failed (code ${result.code}): ${result.stderr.slice(0, 200)}`);
      return null;
    }
    const data = JSON.parse(result.stdout);
    const noteDocToken = data.data?.notes?.[0]?.note_doc_token;
    if (!noteDocToken) { log("vc +notes: no note_doc_token found"); return null; }
    return fetchLarkDoc(noteDocToken);
  } catch (err) {
    log(`meeting notes fetch error: ${err}`);
    return null;
  }
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

async function handleSimpleCalendar(dateStart?: string, dateEnd?: string): Promise<string | null> {
  const args = ["calendar", "+agenda", "--format", "json"];
  if (dateStart) args.push("--start", dateStart);
  if (dateEnd) args.push("--end", dateEnd);
  const raw = await runLarkCli(args);
  try {
    const data = JSON.parse(raw);
    const events = data.data || [];

    // Build a human-readable date label
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    let label: string;
    if (!dateStart || dateStart === today) {
      label = "Today's agenda";
    } else if (dateStart === dateEnd || !dateEnd) {
      label = dateStart === tomorrow ? "Tomorrow's agenda" : `Agenda for ${dateStart}`;
    } else {
      label = `Agenda ${dateStart} — ${dateEnd}`;
    }

    if (!events.length) return `**${label}:** No events.`;

    const lines = [`**${label}:**\n`];
    let currentDate = "";
    for (const event of events) {
      const summary = event.summary || "(no title)";
      const start = event.start_time?.datetime || "";
      const end = event.end_time?.datetime || "";
      const eventDate = start.slice(0, 10);
      // Add date header when spanning multiple days
      if (dateStart !== dateEnd && eventDate !== currentDate) {
        currentDate = eventDate;
        lines.push(`\n**${eventDate}**`);
      }
      const st = start.slice(11, 16);
      const et = end ? end.slice(11, 16) : "";
      lines.push(`- **${st}–${et}**  ${summary}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function handleSimpleTasks(dateStart?: string, dateEnd?: string): Promise<string | null> {
  const args = ["task", "+get-my-tasks", "--format", "json", "--page-all"];
  if (dateStart) args.push("--due-start", dateStart);
  if (dateEnd) args.push("--due-end", dateEnd);
  const raw = await runLarkCli(args);
  try {
    const data = JSON.parse(raw);
    const items = data.data?.items || data.data || [];
    if (!items.length) return dateStart ? `**No tasks due ${dateStart}${dateEnd && dateEnd !== dateStart ? ` — ${dateEnd}` : ""}.**` : "**No active tasks.**";

    const now = Date.now();
    // Sort: overdue first, then by due date, then no-due-date last
    items.sort((a: any, b: any) => {
      const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return aDue - bDue;
    });

    const overdue: string[] = [];
    const upcoming: string[] = [];
    const noDue: string[] = [];

    for (const item of items) {
      const summary = item.summary || "(no title)";
      const dueTime = item.due_at ? new Date(item.due_at).getTime() : null;
      const dueLabel = item.due_at ? item.due_at.slice(0, 10) : "";

      if (dueTime && dueTime < now) {
        overdue.push(`- **OVERDUE** ${summary} (due ${dueLabel})`);
      } else if (dueTime) {
        upcoming.push(`- ${summary} (due **${dueLabel}**)`);
      } else {
        noDue.push(`- ${summary}`);
      }
    }

    const lines = ["**Your tasks:**\n"];
    if (overdue.length) {
      lines.push(...overdue, "");
    }
    lines.push(...upcoming);
    if (noDue.length && !dateStart) {
      lines.push("", "_No due date:_", ...noDue);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function handleSimpleEmail(): Promise<string | null> {
  const raw = await runLarkCli(["mail", "+triage", "--max", "10", "--format", "json"]);
  try {
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages) || !messages.length) return "**No recent emails.**";

    const lines = ["**Recent emails:**\n"];
    for (const msg of messages) {
      const date = msg.date || "";
      const from = (msg.from || "").replace(/<[^>]+>/g, "").trim();
      const subject = msg.subject || "(no subject)";
      const labels = msg.labels || "";
      const unread = labels.includes("UNREAD") ? " **[NEW]**" : "";
      lines.push(`- ${date} — ${from}${unread}\n  ${subject}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function extractContactQuery(text: string): string {
  return text
    .replace(/^(who is|find|search for|look up|查一下|谁是|找)\s*/i, "")
    .replace(/[?.!？。！]+$/, "")
    .trim();
}

async function handleSimpleContactSearch(query: string): Promise<string | null> {
  if (!query) return null;
  const raw = await runLarkCli(["contact", "+search-user", "--query", query, "--format", "json"]);
  try {
    const data = JSON.parse(raw);
    const users = data.data?.users || [];
    if (!users.length) return `**No results for "${query}".**`;
    const lines = [`**People matching "${query}":**\n`];
    for (const u of users.slice(0, 8)) {
      const name = u.name || "(unknown)";
      const uid = u.user_id || "";
      lines.push(`- **${name}**${uid ? ` (${uid})` : ""}`);
    }
    return lines.join("\n");
  } catch { return null; }
}

async function handleSimpleMeetingSearch(dateStart?: string, dateEnd?: string): Promise<string | null> {
  const args = ["vc", "+search", "--format", "json"];
  if (dateStart) args.push("--start", dateStart);
  if (dateEnd) args.push("--end", dateEnd);
  const raw = await runLarkCli(args);
  try {
    const data = JSON.parse(raw);
    const items = data.data?.items || [];
    if (!items.length) return dateStart
      ? `**No meetings found ${dateStart}${dateEnd && dateEnd !== dateStart ? ` — ${dateEnd}` : ""}.**`
      : "**No recent meetings found.**";

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    let label: string;
    if (!dateStart) label = "Recent meetings";
    else if (dateStart === dateEnd || !dateEnd)
      label = dateStart === today ? "Today's meetings" : dateStart === yesterday ? "Yesterday's meetings" : `Meetings on ${dateStart}`;
    else label = `Meetings ${dateStart} — ${dateEnd}`;

    const lines = [`**${label}:**\n`];
    for (const m of items) {
      const topic = (m.display_info || "").split("\n")[0].trim() || "(no topic)";
      const desc = m.meta_data?.description || "";
      const orgMatch = desc.match(/组织者[：:]\s*([^\s|]+)/);
      const organizer = orgMatch?.[1] || "";
      lines.push(`- **${topic}**${organizer ? ` (${organizer})` : ""}`);
    }
    return lines.join("\n");
  } catch { return null; }
}

function detectLang(text: string): "zh" | "en" {
  // Strip XML/HTML tags, mention placeholders, and URLs before sampling
  const cleaned = text
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Sample more text (up to 2000 chars) to get past metadata-heavy headers
  const sample = cleaned.slice(0, 2000);
  const total = sample.replace(/\s/g, "").length || 1;
  const zhChars = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  return zhChars / total >= 0.10 ? "zh" : "en";
}

function langDirective(lang: ReplyLang): string {
  if (lang === "zh") return "⚠️ LANGUAGE RULE (MANDATORY): Your ENTIRE reply MUST be in Chinese (中文). No English unless it is a proper noun, brand name, or technical term.";
  if (lang === "en") return "⚠️ LANGUAGE RULE (MANDATORY): Your ENTIRE reply MUST be in English. No Chinese unless it is a proper noun or name.";
  return "⚠️ LANGUAGE RULE (MANDATORY): Reply in the same language as the primary content. Chinese content → reply in Chinese. English content → reply in English.";
}

function buildClaudePrompt(
  instruction: string,
  persist: boolean,
  bucket: BucketConfig,
  lang: ReplyLang
): string {
  return [
    langDirective(lang),
    "",
    `You are Claude Channel, a CEO's AI assistant (bucket: ${bucket.label}).`,
    "",
    "Formatting rules:",
    "- Be concise but COMPLETE — cover all important points. Short for simple questions, longer for rich documents. Never sacrifice key information for brevity.",
    "- Use bold for key info: names, dates, amounts, decisions",
    "- Use bullet points, NOT tables (Lark renders tables poorly)",
    "- No horizontal rules (---), no emoji headers, no decorative formatting",
    "- Lead with the answer or decision, then supporting details",
    "- For action items: bold the owner and deadline",
    "- Never say 'here is the summary' — just give the summary",
    "",
    "Tool guidance:",
    "- The user's workspace is Lark (Feishu). For calendar, email, docs, chat, tasks — ALWAYS use lark-cli. Never use Google Calendar, Gmail, or other non-Lark tools.",
    "- Calendar: `lark-cli calendar +agenda` for today, `lark-cli calendar +agenda --start YYYY-MM-DD --end YYYY-MM-DD` for other dates",
    "- Email: `lark-cli mail` commands",
    "- Docs: `lark-cli docs` commands",
    "- Tasks: `lark-cli task` commands",
    "- Contacts: `lark-cli contact +search-user --query \"name\"` to find people by name",
    "- Meetings: `lark-cli vc +search --start YYYY-MM-DD --end YYYY-MM-DD` to find past meetings, `lark-cli vc +notes --meeting-ids <id>` for meeting notes",
    "- Doc search: `lark-cli docs +search --query \"keyword\"` to search cloud documents",
    "",
    "Do not mention tools, internal reasoning, or session mechanics.",
    persist
      ? [
          "The user wants to SAVE content. Follow these rules:",
          `- Obsidian vault root: ${CONFIG.obsidianRoot}`,
          `- Existing vault folders (buckets): ${listVaultBuckets().join(", ")}`,
          "- When the user says 'save to bucket named X', find the matching folder by keyword:",
          "  e.g. 'Accident' → 11_Accidents, 'Strategy' → 01_Strategy, 'Product' → 02_Product, etc.",
          `  Save the file there: ${CONFIG.obsidianRoot}/<matching_folder>/<TopicName>.md`,
          "- If no folder matches, create a new numbered one (next available number) under the vault root",
          `- Do NOT save to ${BUCKET_MEMORY_DIR} — that is for channel session memory, not user-requested saves`,
          "- Save the FULL quoted/forwarded content — do NOT summarize or translate it. Preserve the original language.",
          "- Add a timestamp header (## YYYY-MM-DD HH:MM) before each entry",
          "- Derive filenames from the CURRENT content's topic — not from prior session history",
          "- After saving, confirm with the file path and a 1-line summary",
          "- Also set save_note_markdown to a concise summary for the daily brief",
        ].join("\n")
      : "Set save_note_markdown to null unless the user explicitly asked to save, note, or remember.",
    "If the request is ambiguous, make the best reasonable assumption and answer directly.",
    "",
    "User message:",
    instruction,
    "",
    langDirective(lang),
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

function parseClaudeResult(raw: string): ClaudeStructuredResult {
  const outer = JSON.parse(raw);

  try {
    return normalizeClaudePayload(outer.structured_output ?? outer.result);
  } catch (error) {
    const fallbackText = extractFallbackText(outer);
    if (fallbackText) {
      return {
        reply_markdown: fallbackText,
        save_note_markdown: null,
      };
    }
    throw error;
  }
}

async function runClaude(
  instruction: string,
  bucket: BucketConfig,
  model: string,
  lang: ReplyLang,
  isForward = false,
  userInstruction?: string,
): Promise<ClaudeStructuredResult> {
  // Check persist against user's instruction only — never match keywords inside forwarded doc content
  const persist = shouldPersist(userInstruction ?? instruction);

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
  ];

  if (persist) {
    args.push("--add-dir", BUCKET_MEMORY_DIR);
  }

  args.push("--", buildClaudePrompt(instruction, persist, bucket, lang));

  const first = await runProcess(args, {
    cwd: CONFIG.claudeWorkdir,
    timeoutMs: 180_000,
  });

  logJson(CLAUDE_RAW_FILE, {
    type: "claude_run",
    bucket: bucket.key,
    model,
    code: first.code,
    stdout: first.stdout.slice(0, 6000),
    stderr: first.stderr.slice(0, 2000),
  });

  if (first.code !== 0) {
    const detail = first.stderr.trim() || first.stdout.trim();
    log(`claude failed: ${detail}`);
    throw new Error(detail || "Claude request failed");
  }

  const firstUsage = parseClaudeUsage(first.stdout.trim());
  const parsed = parseClaudeResult(first.stdout.trim());
  updateDailyUsage(bucket.key, model, firstUsage.usage, firstUsage.totalCostUsd);
  logJson(EVENTS_FILE, {
    type: "usage",
    bucket: bucket.key,
    model,
    durationMs: firstUsage.durationMs,
    totalCostUsd: firstUsage.totalCostUsd,
    ...firstUsage.usage,
  });
  return parsed;
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

// --- /pending command: surface unanswered @mentions, overdue tasks, unread email ---

const PENDING_COMMAND_RE = /^\/pending\b|^pending(?:\s+@?mentions?)?\s*$|who.*waiting on me|unanswered.*@|pending.*@\s*me|mention.*(?:my name|me).*(?:pending|respond|reply|unanswered)|pending.*(?:my (?:response|reply))|谁.*@.*我|未回复|@.*我.*未回/i;

async function fetchUnreadMentions(): Promise<string | null> {
  try {
    // Search @me messages from the last 3 days
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    const tz = "+08:00";
    const startISO = threeDaysAgo.toISOString().slice(0, 19) + tz;
    const raw = await runLarkCli([
      "im", "+messages-search", "--is-at-me", "--page-size", "30",
      "--start", startISO, "--format", "json",
    ]);
    const data = JSON.parse(raw);
    const msgs: any[] = data.data?.messages || [];
    if (!msgs.length) return null;

    const ownerOpenId = CONFIG.ownerOpenId;

    // Filter: only messages from others that directly @me (not just @all)
    const directMentions = msgs.filter((m: any) => {
      if (m.sender?.id === ownerOpenId) return false;
      const mentions = m.mentions || [];
      const isAtMe = mentions.some((mt: any) => mt.id === ownerOpenId);
      const content = m.content || "";
      const isAtAll = /@all|@_all/.test(content);
      return isAtMe || !isAtAll;  // keep if directly @me, or not just @all
    });
    if (!directMentions.length) return null;

    // Group by chat, keep latest per chat
    const byChat = new Map<string, any>();
    for (const m of directMentions) {
      const cid = m.chat_id || "";
      if (!byChat.has(cid)) byChat.set(cid, { ...m, count: 1 });
      else byChat.get(cid)!.count++;
    }

    // Cross-check: for each chat, see if user has replied after the @mention
    const pending: { chat: string; sender: string; time: string; content: string; count: number }[] = [];
    for (const [chatId, m] of byChat) {
      try {
        const chatRaw = await runLarkCli([
          "im", "+chat-messages-list", "--chat-id", chatId,
          "--page-size", "5", "--sort", "desc", "--format", "json",
        ]);
        const chatData = JSON.parse(chatRaw);
        const chatMsgs: any[] = chatData.data?.items || [];
        const userReplied = chatMsgs.some((cm: any) => cm.sender?.id === ownerOpenId);
        if (userReplied) continue; // user already responded in this chat
      } catch {
        // JSON parse error — include it as pending to be safe
      }

      const chatName = m.chat_name || "P2P";
      const sender = m.sender?.name || "(unknown)";
      const content = (m.content || "").replace(/<[^>]+>/g, "").replace(/@[^\s]+\s*/g, "").trim().slice(0, 100);
      pending.push({ chat: chatName, sender, time: m.create_time || "", content, count: m.count });
    }

    if (!pending.length) return null;

    const lines = [`**${pending.length} chat${pending.length > 1 ? "s" : ""} with unanswered @mentions:**\n`];
    for (const p of pending) {
      const extra = p.count > 1 ? ` (${p.count} msgs)` : "";
      lines.push(`- **${p.sender}** [${p.chat}] ${p.time}${extra}\n  ${p.content}`);
    }
    return lines.join("\n");
  } catch (err) {
    log(`fetchUnreadMentions error: ${err}`);
    return null;
  }
}

async function handlePendingCommand(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  const [mentionsResult, tasksResult, emailResult] = await Promise.allSettled([
    fetchUnreadMentions(),
    runLarkCli(["task", "+get-my-tasks", "--format", "json", "--page-all"]),
    runLarkCli(["mail", "+triage", "--max", "5", "--format", "json"]),
  ]);

  const sections: string[] = [];

  // @mentions
  const mentionsText = mentionsResult.status === "fulfilled" ? mentionsResult.value : null;
  if (mentionsText) sections.push(mentionsText);

  // Due-today + recent overdue tasks (cap at 5, summarize the rest)
  if (tasksResult.status === "fulfilled") {
    try {
      const data = JSON.parse(tasksResult.value);
      const items: any[] = data.data?.items || data.data || [];
      const now = Date.now();
      const sevenDaysAgo = now - 7 * 86_400_000;
      const dueToday = items.filter(
        (t: any) => t.due_at && t.due_at.slice(0, 10) === today && new Date(t.due_at).getTime() >= now
      );
      const recentOverdue = items.filter(
        (t: any) => t.due_at && new Date(t.due_at).getTime() < now && new Date(t.due_at).getTime() >= sevenDaysAgo
      );
      const olderOverdue = items.filter(
        (t: any) => t.due_at && new Date(t.due_at).getTime() < sevenDaysAgo
      );
      if (dueToday.length || recentOverdue.length || olderOverdue.length) {
        const taskLines = ["**Pending tasks:**\n"];
        for (const t of dueToday) {
          taskLines.push(`- **Due today** ${t.summary || "(no title)"}`);
        }
        for (const t of recentOverdue.slice(0, 5)) {
          taskLines.push(`- **OVERDUE** ${t.summary || "(no title)"} (due ${t.due_at?.slice(0, 10)})`);
        }
        if (recentOverdue.length > 5) {
          taskLines.push(`- _...and ${recentOverdue.length - 5} more from this week_`);
        }
        if (olderOverdue.length) {
          taskLines.push(`- _${olderOverdue.length} older overdue task${olderOverdue.length > 1 ? "s" : ""} (>7 days)_`);
        }
        sections.push(taskLines.join("\n"));
      }
    } catch { /* ignore */ }
  }

  // Unread emails
  if (emailResult.status === "fulfilled") {
    try {
      const messages = JSON.parse(emailResult.value);
      if (Array.isArray(messages)) {
        const unread = messages.filter((m) => (m.labels || "").includes("UNREAD"));
        if (unread.length) {
          const emailLines = [
            `**${unread.length} unread email${unread.length > 1 ? "s" : ""}:**\n`,
          ];
          for (const m of unread.slice(0, 5)) {
            const from = (m.from || "").replace(/<[^>]+>/g, "").trim();
            emailLines.push(`- **${from}**: ${m.subject || "(no subject)"}`);
          }
          sections.push(emailLines.join("\n"));
        }
      }
    } catch { /* ignore */ }
  }

  if (!sections.length) {
    return "No pending @mentions, overdue tasks, or unread emails.";
  }

  return sections.join("\n\n");
}

async function handleComplex(
  instruction: string,
  messageId: string,
  bucket: BucketConfig,
  model: string,
  lang: ReplyLang,
  isForward = false,
  userInstruction?: string,
): Promise<void> {
  const start = Date.now();

  const result = await runClaude(instruction, bucket, model, lang, isForward, userInstruction);
  // Only persist to bucket memory when user explicitly asked to save (check user instruction, not doc content)
  const persist = shouldPersist(userInstruction ?? instruction);
  const memoryFile = persist ? appendBucketMemory(bucket.key, instruction, result) : null;
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

function handleInbound(instruction: string, messageId: string, isForward = false, lang: ReplyLang = "auto", userInstruction?: string): void {
  // Dispatch happens async — enqueue to a temporary holding queue, then re-enqueue to the right bucket
  (async () => {
    const start = Date.now();

    // Fast-path: /pending command — no Haiku dispatch, parallel lark-cli calls
    if (!isForward && PENDING_COMMAND_RE.test(instruction.trim())) {
      enqueue("chat_history", async () => {
        logJson(EVENTS_FILE, {
          type: "inbound",
          messageId,
          instruction: instruction.slice(0, 300),
          routeMode: "command",
          bucket: "chat_history",
          model: "none",
          dispatchReason: "pending_command",
          isForward: false,
          simple: true,
          tools: false,
          compressed: false,
          queueAhead: 0,
        });
        const reply = await handlePendingCommand();
        await sendReply(formatReplyForLark(reply), { type: "simple", messageId, bucket: "chat_history" });
        logJson(EVENTS_FILE, { type: "simple_complete", messageId, durationMs: Date.now() - start, bucket: "chat_history" });
      }).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`pending command error: ${message}`);
        try { await sendReply("Error fetching pending items. Please retry.", { type: "error", messageId }); } catch { /* ignore */ }
      });
      return;
    }

    // For long non-forward text, run Haiku extraction to compress before reasoning
    // Forwards are already extracted upstream via extractForward()
    let processed = instruction;
    if (!isForward && instruction.length > LONG_CONTENT_THRESHOLD) {
      processed = await extractLongContent(instruction);
    }

    // Haiku decides bucket + model (~300-800ms via direct API)
    const dispatch = await dispatchWithHaiku(processed, isForward);
    // Force tools=true when instruction clearly needs tool access
    // This overrides Haiku misclassifying tools=false for action-oriented requests
    if (needsTools(instruction)) {
      dispatch.tools = true;
    }
    // Force tools=false for forwards with embedded content that only need text processing
    // Haiku defaults to tools=true, but the content is already in the instruction — no fetch needed
    if (isForward && dispatch.tools) {
      const sepIdx = instruction.indexOf("---\n");
      const hasEmbeddedContent = sepIdx > 0 && instruction.length > 500;
      if (hasEmbeddedContent) {
        const embeddedContent = instruction.slice(sepIdx + 4).trim();
        // Never downgrade if the embedded "content" is just a URL — Claude needs web tools to fetch it
        // Handles both bare URL and "Forwarded content:\nhttps://..." from the merge path
        const embeddedCore = embeddedContent.replace(/^forwarded content:\s*/i, "").trim();
        const embeddedIsUrl = /^https?:\/\/\S+$/.test(embeddedCore);
        if (!embeddedIsUrl) {
          // Extract just the user's actual instruction, stripping the server-generated auto-summary prefix
          const userPart = (userInstruction || "").trim();
          // Auto-summary (no user instruction) — content is embedded, only needs text processing
          if (!userPart) {
            dispatch.tools = false;
          } else {
            // User gave an instruction — check if it's just text processing
            const isSummaryTask = /总结|summarize|summary|translate|翻译|rewrite|改写|extract|提取|analyze|分析/i.test(userPart);
            if (isSummaryTask && !needsTools(userPart)) {
              dispatch.tools = false;
            }
          }
        }
      }
    }
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
        simple: dispatch.simple,
        tools: dispatch.tools,
        compressed: processed !== instruction,
        queueAhead,
      });

      // Contact / meeting lookups — regex-gated, independent of Haiku simple flag
      if (!isForward) {
        const contactMatch = /who is|find\s+\w|search.*contact|谁是|查.*人|通讯录/i.test(instruction);
        const meetingMatch = /meeting|会议/i.test(instruction);
        if (contactMatch) {
          const result = await handleSimpleContactSearch(extractContactQuery(instruction));
          if (result !== null) {
            await sendReply(result, { type: "simple", messageId, bucket: bucket.key });
            logJson(EVENTS_FILE, { type: "simple_complete", messageId, durationMs: Date.now() - start, bucket: bucket.key });
            return;
          }
        }
        if (meetingMatch && dispatch.simple) {
          const result = await handleSimpleMeetingSearch(dispatch.dateStart, dispatch.dateEnd);
          if (result !== null) {
            await sendReply(result, { type: "simple", messageId, bucket: bucket.key });
            logJson(EVENTS_FILE, { type: "simple_complete", messageId, durationMs: Date.now() - start, bucket: bucket.key });
            return;
          }
        }
      }

      // Try simple handlers only when Haiku explicitly says it's a simple data lookup
      if (dispatch.simple && !isForward) {
        const simple =
          dispatch.bucket === "calendar" ? await handleSimpleCalendar(dispatch.dateStart, dispatch.dateEnd) :
          dispatch.bucket === "general" && /task|待办|任务/i.test(instruction) ? await handleSimpleTasks(dispatch.dateStart, dispatch.dateEnd) :
          dispatch.bucket === "email" ? await handleSimpleEmail() :
          null;

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

      // Direct Sonnet API for tool-free tasks (Phase 1)
      if (!dispatch.tools && dispatch.model !== "opus") {
        const priorExchange = getDirectExchange(bucket.key);
        const directPrompt = [
          langDirective(lang),
          "",
          `You are Claude Channel, a CEO's AI assistant (bucket: ${bucket.label}).`,
          "",
          "Formatting rules (STRICT):",
          "- Keep replies SHORT — max 10 lines for simple, max 20 for complex",
          "- Use bullet points, NOT tables",
          "- Bold key info: names, dates, amounts, decisions",
          "- Lead with the answer, then supporting details",
          "- Never say 'here is the summary' — just give the summary",
          "",
          priorExchange,
          "User message:",
          processed,
          "",
          langDirective(lang),
        ].filter(Boolean).join("\n");

        try {
          const result = await callSonnetDirect(directPrompt);
          if (result.fallback) {
            // Distress detected — fall back to claude -p
            log(`sonnet direct distress detected, falling back to claude -p: ${result.reply.slice(0, 80)}`);
            logJson(EVENTS_FILE, {
              type: "direct_fallback",
              messageId,
              bucket: bucket.key,
              distressReply: result.reply.slice(0, 200),
              directCostUsd: result.costUsd,
            });
            await handleComplex(processed, messageId, bucket, model, lang, isForward, userInstruction);
            return;
          }

          // Success — send reply, save exchange for follow-ups
          const replyText = formatReplyForLark(result.reply);
          saveDirectExchange(bucket.key, processed, result.reply);
          appendBucketMemory(bucket.key, processed, {
            reply_markdown: result.reply,
            save_note_markdown: null,
          });
          await sendReply(replyText, {
            type: "direct_sonnet",
            messageId,
            bucket: bucket.key,
          });
          logJson(EVENTS_FILE, {
            type: "direct_complete",
            messageId,
            durationMs: Date.now() - start,
            bucket: bucket.key,
            costUsd: result.costUsd,
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
          });
          return;
        } catch (err) {
          log(`sonnet direct API failed, falling back to claude -p: ${err}`);
          logJson(EVENTS_FILE, {
            type: "direct_error",
            messageId,
            bucket: bucket.key,
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through to handleComplex
        }
      }

      // Full claude -p path (tools, file access)
      await handleComplex(processed, messageId, bucket, model, lang, isForward, userInstruction);
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
      return Response.json({
        status: "ok",
        service: "lark-channel",
        queueDepth: getTotalQueueDepth(),
        bucketQueueDepths: Object.fromEntries(bucketQueueDepths.entries()),
        routeMode: CONFIG.routeMode,
        defaultModel: CONFIG.defaultModel,
        reasoningModel: CONFIG.reasoningModel,
      });
    }

    // Debug endpoint: exercise the distress detection → fallback chain
    if (req.method === "POST" && url.pathname === "/debug/test-distress") {
      const body = (await req.json()) as any;
      const messageId = body.messageId || `om_debug_${Date.now()}`;
      const distressText = body.distressText || "I don't have access to that information.";
      const bucket = bucketConfig(body.bucket || "general");

      // Simulate: isDistressResponse returns true → log direct_fallback → run handleComplex
      const detected = isDistressResponse(distressText);
      logJson(EVENTS_FILE, {
        type: "direct_fallback",
        messageId,
        bucket: bucket.key,
        distressReply: distressText.slice(0, 200),
        directCostUsd: 0,
        synthetic: true,
      });

      if (detected) {
        // Run the real claude -p fallback path
        enqueue(bucket.key, async () => {
          await handleComplex(
            body.instruction || "Summarize your current capabilities and available tools.",
            messageId,
            bucket,
            CONFIG.defaultModel,
            "auto",
          );
        }).catch((err) => {
          log(`debug test-distress handleComplex error: ${err}`);
          logJson(EVENTS_FILE, { type: "error", messageId, error: String(err) });
        });
      }

      return Response.json({ ok: true, detected, messageId });
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

    // Log all message fields for debugging quote issues
    const msgKeys = Object.keys(message).sort().join(",");
    if (message.parent_id || message.upper_message_id || message.root_id) {
      log(`msg fields with refs: ${msgKeys} | parent_id=${message.parent_id || ""} upper_message_id=${message.upper_message_id || ""} root_id=${message.root_id || ""}`);
    }

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

    // If this message quotes another message, fetch the quoted content and prepend it
    // Lark uses different fields: parent_id for thread replies, upper_message_id for "引用" (quote)
    const parentId = message.upper_message_id || message.parent_id || "";
    if (parentId) {
      log(`quote detected: upper_message_id=${message.upper_message_id || "(none)"} parent_id=${message.parent_id || "(none)"} → fetching ${parentId}`);
      try {
        const raw = await runLarkCli(["im", "+messages-mget", "--as", "bot", "--message-ids", parentId, "--format", "json"]);
        const parsed = JSON.parse(raw);
        const items = parsed.data?.messages || parsed.data?.items || parsed.items || [parsed.data].filter(Boolean);
        if (items.length > 0) {
          const quoted = items[0];
          const rawContent = quoted.body?.content || quoted.content || "";
          const qType = quoted.msg_type || quoted.message_type || "";
          log(`quoted msg type=${qType}, content preview=${String(rawContent).slice(0, 120)}`);
          let quotedText = "";

          // Try JSON parse first (webhook-style content), fall back to plain text (lark-cli style)
          let qContent: any = {};
          try {
            qContent = JSON.parse(rawContent);
          } catch {
            // lark-cli returns plain text content for bot messages — use directly
            quotedText = String(rawContent).trim();
          }

          if (!quotedText) {
            if (qType === "text") {
              quotedText = qContent.text || "";
            } else if (qType === "post") {
              const qLang = qContent.zh_cn || qContent.en_us || qContent[Object.keys(qContent)[0]] || {};
              if (typeof qLang === "string") {
                // lark-cli may flatten post content to a string
                quotedText = qLang;
              } else {
                quotedText = [
                  qLang.title || "",
                  ...(qLang.content || []).flat().map((n: any) => n.text || n.content || "").filter(Boolean),
                ].filter(Boolean).join(" ");
              }
            } else if (qType === "interactive") {
              const qTitle = qContent.title || "";
              const qBody = (qContent.elements || []).flat().map((n: any) => n.text || "").filter(Boolean).join("");
              quotedText = [qTitle, qBody].filter(Boolean).join("\n\n");
            }
          }

          quotedText = quotedText.replace(/<[^>]+>/g, "").trim();
          if (quotedText) {
            text = `IMPORTANT: The user is quoting a specific message. Their instruction "${text}" applies to the QUOTED CONTENT below, NOT to prior conversation history. If saving/noting, use a filename derived from the quoted content's topic.\n\n---\n\nQuoted content:\n${quotedText}\n\n---\n\nUser instruction: ${text}`;
            log(`fetched quoted message ${parentId}: ${quotedText.slice(0, 80)}...`);
          } else {
            log(`quoted message ${parentId} had empty content after extraction (type=${qType})`);
          }
        } else {
          log(`quoted message ${parentId} not found (0 items returned)`);
        }
      } catch (err) {
        log(`failed to fetch quoted message ${parentId}: ${err}`);
      }
    }

    // Determine if this should be buffered (forwarded content, URL-only messages)
    const isUrlOnly = messageType === "text" && /^\s*https?:\/\/\S+\s*$/.test(text);
    const larkDocMatch = isUrlOnly && /larksuite\.com\/(docx|wiki)\/([A-Za-z0-9]+)/.test(text.trim());
    const larkMinutesMatch = isUrlOnly && /larksuite\.com\/minutes\/([A-Za-z0-9]+)/.test(text.trim());
    const shouldBuffer = messageType === "interactive" || messageType === "post" || messageType === "file" || messageType === "image" || messageType === "merge_forward" || isUrlOnly;

    if (shouldBuffer) {
      // Forwarded content, file, image, or URL — buffer and wait for follow-up instruction
      if (pendingForward) clearTimeout(pendingForward.timer);
      const forwardText = text;
      const forwardId = messageId;
      const isFileOrImage = messageType === "file" || messageType === "image";
      const contentLang: ReplyLang = (isFileOrImage || isUrlOnly) ? "auto" : detectLang(forwardText);
      // Haiku extraction starts NOW for text content — skip for files/images (Sonnet reads those directly)
      const extraction = isFileOrImage
        ? Promise.resolve({ default_action: `Read and summarize this ${messageType}.`, clean_extract: forwardText })
        : (isUrlOnly && larkDocMatch)
          ? fetchLarkDoc(forwardText.trim()).then(content =>
              content
                ? { default_action: "Summarize this Lark document.", clean_extract: content }
                : { default_action: `Fetch and summarize this link: ${forwardText}`, clean_extract: forwardText }
            )
          : (isUrlOnly && larkMinutesMatch)
            ? fetchMeetingNotes(forwardText.trim().match(/\/minutes\/([A-Za-z0-9]+)/)?.[1] || "").then(content =>
                content
                  ? { default_action: "Summarize these meeting notes.", clean_extract: content }
                  : { default_action: `Fetch and summarize this link: ${forwardText}`, clean_extract: forwardText }
              )
          : isUrlOnly
            ? Promise.resolve({ default_action: `Fetch and summarize this link: ${forwardText}`, clean_extract: forwardText })
            : extractForward(forwardText);
      pendingForward = {
        messageId: forwardId,
        extraction,
        contentLang,
        timer: setTimeout(async () => {
          // No follow-up arrived — use default action + content
          if (pendingForward?.messageId === forwardId) {
            pendingForward = null;
            const { default_action, clean_extract } = await extraction;
            const langHint = clean_extract !== forwardText ? detectLang(clean_extract) : contentLang;
            const summarizeInstruction = langHint === "zh"
              ? `用中文简洁总结以下转发内容。最后给出建议的下一步行动。\n\n建议行动: ${default_action}\n\n---\n\n${clean_extract}`
              : `Summarize the following forwarded content concisely. At the end, suggest a recommended next action.\n\nSuggested action: ${default_action}\n\n---\n\n${clean_extract}`;
            handleInbound(summarizeInstruction, forwardId, true, langHint, "");
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
        // Compute lang: if user wrote text, use user's lang; if forward had fetched content, detect from it
        const langHint: ReplyLang = pending.contentLang === "auto"
          ? detectLang(text)
          : pending.contentLang;
        handleInbound(`${text}\n\n---\n\nForwarded content:\n${clean_extract}`, messageId, true, langHint, text);
      }).catch(() => {
        handleInbound(text, messageId, false, detectLang(text));
      });
      return Response.json({ ok: true });
    }

    handleInbound(text, messageId, false, detectLang(text));
    return Response.json({ ok: true });
  },
});

log(`HTTP webhook listening on http://0.0.0.0:${CONFIG.port}/webhook`);
