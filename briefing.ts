#!/usr/bin/env bun
/**
 * CEO Briefing Automation — Daily / EoD / Weekly
 * Gathers data via lark-cli, reasons with Opus 4.6, saves to Obsidian, pushes to Lark channel.
 * Usage: bun briefing.ts --mode daily|eod|weekly
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join } from "path";

// ─── Configuration ───────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

const CONFIG = {
  chatId: requireEnv("LARK_CHAT_ID"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  larkCli: process.env.LARK_CLI ?? "lark-cli",
  inboxDir:
    process.env.DAILY_BRIEF_DIR ??
    "./obsidian-vault/Inbox",
  stateDir:
    process.env.LARK_CHANNEL_STATE_DIR ??
    "./.state",
  channelMemoryDir:
    process.env.CHANNEL_MEMORY_DIR ??
    "./obsidian-vault/Inbox/Lark-Channel-Memory",
};

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[briefing] ${new Date().toISOString().slice(0, 19)} ${msg}`);
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Returns [Mon, Tue, Wed, Thu, Fri] date strings for the week containing `d`. */
function getWeekDates(d: Date): string[] {
  const dow = d.getDay(); // 0=Sun … 6=Sat
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mon = addDays(d, -daysToMon);
  return Array.from({ length: 5 }, (_, i) => dateStr(addDays(mon, i)));
}

/** Most recent past Friday relative to `d`. */
function lastFriday(d: Date): Date {
  const dow = d.getDay();
  const back = dow === 0 ? 2 : dow === 6 ? 1 : dow + 2;
  return addDays(d, -back);
}

/** Previous workday (skips weekends). */
function previousWorkday(d: Date): Date {
  const prev = addDays(d, -1);
  const dow = prev.getDay();
  if (dow === 0) return addDays(prev, -2);
  if (dow === 6) return addDays(prev, -1);
  return prev;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// ─── Process runner ──────────────────────────────────────────────────────────

async function runProcess(
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeout = opts.timeoutMs ?? 30_000;
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY; // don't leak to subprocesses
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

async function runLarkCli(args: string[]): Promise<string> {
  const { stdout, stderr, code } = await runProcess(
    [CONFIG.larkCli, ...args],
    { timeoutMs: 30_000 },
  );
  if (code !== 0) log(`lark-cli exited ${code}: ${stderr.trim()}`);
  return stdout.trim();
}

// ─── Haiku direct API (data preprocessing) ──────────────────────────────────

async function callHaikuDirect(
  systemPrompt: string,
  userContent: string,
  maxTokens = 1024,
): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Haiku API ${resp.status}: ${err}`);
  }
  const data = (await resp.json()) as any;
  return (data.content?.[0]?.text || "").trim();
}

/** Use Haiku to convert raw JSON data into compact readable markdown. */
async function compressWithHaiku(
  label: string,
  raw: string,
  instruction: string,
): Promise<string> {
  if (!raw || raw.length < 100) return raw;
  try {
    const result = await callHaikuDirect(
      "You are a data formatter. Convert raw JSON into clean, compact markdown. Be terse — no filler, no explanations. Strip HTML tags. Output only the formatted result.",
      `${instruction}\n\n${raw.slice(0, 12000)}`,
      800,
    );
    log(`[haiku-compress] ${label}: ${raw.length} chars → ${result.length} chars`);
    return result;
  } catch (err) {
    log(`[haiku-compress] ${label} failed, using raw: ${err}`);
    return stripHtml(raw);
  }
}

// ─── Opus 4.6 direct API ────────────────────────────────────────────────────

type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

async function callOpusDirect(
  systemPrompt: string,
  userContent: string,
  maxTokens = 8192,
): Promise<{ text: string; usage: ClaudeUsage; costUsd: number }> {
  const API_TIMEOUT_MS = 600_000; // 10 minutes — Opus can be slow under load
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": CONFIG.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError" || controller.signal.aborted)
      throw new Error(`Opus API timed out after ${API_TIMEOUT_MS / 1000}s`);
    throw err;
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Opus API ${resp.status}: ${errBody}`);
  }
  const data = (await resp.json()) as any;
  const text = (data.content?.[0]?.text || "").trim();
  const usage: ClaudeUsage = {
    input_tokens: data.usage?.input_tokens || 0,
    output_tokens: data.usage?.output_tokens || 0,
    cache_creation_input_tokens:
      data.usage?.cache_creation_input_tokens || 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
  };
  // Opus pricing: $15/M input, $75/M output
  const costUsd =
    (usage.input_tokens * 15 + usage.output_tokens * 75) / 1_000_000;
  return { text, usage, costUsd };
}

// ─── Lark messaging ─────────────────────────────────────────────────────────

async function sendToLark(markdown: string): Promise<void> {
  const args = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--chat-id",
    CONFIG.chatId,
    "--markdown",
    markdown,
  ];
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { code, stderr, stdout } = await runProcess(
      [CONFIG.larkCli, ...args],
      { timeoutMs: 30_000 },
    );
    if (code === 0) return;
    lastError = stderr.trim() || stdout.trim() || `exit ${code}`;
    log(`sendToLark attempt ${attempt} failed: ${lastError}`);
    await Bun.sleep(attempt * 750);
  }
  throw new Error(`sendToLark failed after 3 attempts: ${lastError}`);
}

function formatForLark(text: string): string {
  let out = text
    .replace(/^\|.*\|$/gm, (row) => {
      const cols = row
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      return cols.length ? `- ${cols.join(" · ")}` : row;
    })
    .replace(/^\|[-| ]+\|?$/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (out.length <= 4500) return out;
  const cut = out.slice(0, 4000);
  const nl = cut.lastIndexOf("\n");
  return (
    cut.slice(0, nl) +
    "\n\n_Full briefing saved to Obsidian. Showing top items only._"
  );
}

// ─── Usage tracking (shared with server.ts) ──────────────────────────────────

const USAGE_FILE = join(CONFIG.stateDir, "usage-daily.json");

function updateDailyUsage(
  bucket: string,
  model: string,
  usage: ClaudeUsage,
  totalCostUsd: number,
): void {
  const date = today();
  let root: any = {};
  try {
    if (existsSync(USAGE_FILE))
      root = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
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
  agg.input_tokens += usage.input_tokens;
  agg.cache_creation_input_tokens += usage.cache_creation_input_tokens;
  agg.cache_read_input_tokens += usage.cache_read_input_tokens;
  agg.output_tokens += usage.output_tokens;
  agg.total_cost_usd += totalCostUsd;

  const t = root[date].totals;
  t.calls = (t.calls || 0) + 1;
  t.input_tokens = (t.input_tokens || 0) + usage.input_tokens;
  t.cache_creation_input_tokens =
    (t.cache_creation_input_tokens || 0) + usage.cache_creation_input_tokens;
  t.cache_read_input_tokens =
    (t.cache_read_input_tokens || 0) + usage.cache_read_input_tokens;
  t.output_tokens = (t.output_tokens || 0) + usage.output_tokens;
  t.total_cost_usd = (t.total_cost_usd || 0) + totalCostUsd;

  writeFileSync(USAGE_FILE, JSON.stringify(root, null, 2));
}

// ─── Data gathering ──────────────────────────────────────────────────────────

async function gatherSafe<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ data: T; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[${label}] failed: ${msg}`);
    return { data: fallback, error: msg };
  }
}

async function gatherCalendar(dateOpt?: string): Promise<string> {
  const args = ["calendar", "+agenda", "--format", "json"];
  if (dateOpt) args.push("--start", dateOpt, "--end", dateOpt);
  return runLarkCli(args);
}

async function gatherTasks(): Promise<string> {
  return runLarkCli(["task", "+get-my-tasks", "--format", "json"]);
}

/** Strip HTML tags from task data — Lark stores descriptions as HTML. */
function stripHtml(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")   // <br> → newline
    .replace(/<[^>]+>/g, "")         // all other tags → nothing
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/** Filter out tasks overdue by more than `days` days, and strip HTML. */
function preprocessTasks(raw: string, maxOverdueDays = 14): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxOverdueDays);
  const cutoffMs = cutoff.getTime();

  try {
    const parsed = JSON.parse(raw);
    const items: any[] =
      parsed?.data?.items ?? parsed?.items ?? parsed?.data ?? [];

    const filtered = items.filter((t: any) => {
      const due = t.due?.timestamp
        ? Number(t.due.timestamp) * 1000
        : t.due?.date
          ? new Date(t.due.date).getTime()
          : null;
      if (due === null) return true; // no due date → keep
      const isOverdue = due < Date.now();
      if (!isOverdue) return true;
      return due >= cutoffMs; // only keep if overdue within cutoff window
    });

    // Strip HTML from summary and notes
    const cleaned = filtered.map((t: any) => ({
      ...t,
      summary: t.summary ? stripHtml(t.summary) : t.summary,
      notes: t.notes ? stripHtml(t.notes) : t.notes,
      content: t.content ? stripHtml(t.content) : t.content,
    }));

    return JSON.stringify({ ...parsed, data: { ...parsed?.data, items: cleaned } });
  } catch {
    // Not valid JSON — just strip HTML from raw string
    return stripHtml(raw);
  }
}

function readFileOr(path: string, fallback: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf8");
  } catch {}
  return fallback;
}

/** Extract today's entries from Lark-Channel-Memory files. */
function readChannelMemoryForDate(date: string): string {
  const files = [
    "calendar.md",
    "email.md",
    "general.md",
    "lark_docs.md",
    "chat_history.md",
  ];
  const sections: string[] = [];
  for (const file of files) {
    const content = readFileOr(join(CONFIG.channelMemoryDir, file), "");
    if (!content) continue;
    const re = new RegExp(`## ${date}T[\\s\\S]*?(?=## \\d{4}-|$)`, "g");
    const matches = content.match(re) || [];
    if (matches.length > 0) {
      sections.push(
        `### Channel: ${file.replace(".md", "")}`,
        ...matches,
      );
    }
  }
  return sections.join("\n\n") || "[No channel activity recorded today]";
}

/** Find prior context for the daily briefing (weekly summary on Mon, EoD on Tue-Fri). */
function findPriorContext(): string {
  const now = new Date();
  const dow = now.getDay();

  if (dow === 1) {
    // Monday — look for last Friday's weekly summary
    const fri = lastFriday(now);
    const ws = readFileOr(
      join(CONFIG.inboxDir, `Weekly-Summary-${dateStr(fri)}.md`),
      "",
    );
    if (ws)
      return `## Last Week's Summary (${dateStr(fri)})\n${ws}`;
    // Fallback: last Friday's EoD
    const eod = readFileOr(
      join(CONFIG.inboxDir, `EoD-Summary-${dateStr(fri)}.md`),
      "",
    );
    if (eod)
      return `## Last Friday's EoD (${dateStr(fri)})\n${eod}`;
    return "[No prior weekly summary or EoD found for last week]";
  }

  // Tue–Fri — yesterday's EoD
  const yday = previousWorkday(now);
  const eod = readFileOr(
    join(CONFIG.inboxDir, `EoD-Summary-${dateStr(yday)}.md`),
    "",
  );
  if (eod)
    return `## Yesterday's Closing Notes (${dateStr(yday)})\n${eod}`;
  // Fallback: yesterday's daily brief
  const daily = readFileOr(
    join(CONFIG.inboxDir, `Daily-Brief-${dateStr(yday)}.md`),
    "",
  );
  if (daily)
    return `## Yesterday's Daily Brief (${dateStr(yday)})\n${daily}`;
  return "[No prior EoD or daily brief found for yesterday]";
}

// ─── Obsidian file writing ───────────────────────────────────────────────────

function writeObsidian(filename: string, content: string): string {
  if (!existsSync(CONFIG.inboxDir))
    mkdirSync(CONFIG.inboxDir, { recursive: true });
  const path = join(CONFIG.inboxDir, filename);
  writeFileSync(path, content);
  log(`Saved: ${path}`);
  return path;
}

// ─── System prompt (shared) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the user's executive briefing assistant. The user is a CEO of a company.

Rules:
- Write in English. Use Chinese only when quoting Chinese names, titles, or terms verbatim.
- Lead with the most important item. Prioritize: deadlines > decisions needed > FYI.
- Bold key info: **names**, **amounts**, **dates**, **deadlines**, **decisions**.
- Use bullet points and headers, not tables.
- Be direct and concise. No filler, no "here is your briefing" — just deliver the briefing.
- For action items: bold the **owner** and the **deadline**.
- Flag conflicts, overlaps, and urgent items with ⚠️.
- If data is marked [unavailable], skip that section gracefully — do not hallucinate or guess.
- Output clean Markdown. Do not wrap in code blocks.`;

// ─── Daily Briefing ──────────────────────────────────────────────────────────

async function generateDailyBriefing(): Promise<void> {
  const date = today();
  const dow = new Date().getDay();
  const dayName = DAY_NAMES[dow];
  log(`Generating daily briefing for ${date} (${dayName})`);

  // Gather data in parallel
  const [calendar, tasks] = await Promise.all([
    gatherSafe("calendar", () => gatherCalendar(), ""),
    gatherSafe("tasks", () => gatherTasks(), ""),
  ]);

  const priorContext = findPriorContext();
  const contextLabel = dow === 1 ? "Last Week" : "Yesterday";

  // Pre-process raw JSON with Haiku — reduces Opus input tokens significantly
  const [calendarFmt, tasksFmt] = await Promise.all([
    calendar.error
      ? Promise.resolve(`[Calendar unavailable: ${calendar.error}]`)
      : compressWithHaiku("calendar", calendar.data || "", "Format these calendar events as a clean bullet list: time, title, key attendees only. One line per event."),
    tasks.error
      ? Promise.resolve(`[Tasks unavailable: ${tasks.error}]`)
      : compressWithHaiku("tasks", preprocessTasks(tasks.data || ""), "Format these tasks as a bullet list: task name, due date, status. Mark overdue items with ⚠️. Skip tasks with no name."),
  ]);

  const userPrompt = `Generate the CEO's morning briefing for **${date} (${dayName})**.

## Prior Context
${priorContext}

## Today's Calendar
${calendarFmt}

## Open Tasks (overdue shown only if within past 14 days)
${tasksFmt}

---
Instructions:
1. Start with "# Daily Brief — ${date} (${dayName})"
2. If prior context has follow-ups or todos, list them first under "## Follow-ups from ${contextLabel}"
3. "## Calendar (N meetings)" — time, title, key attendees. Flag conflicts ⚠️. For meetings with description/agenda, provide 2-3 prep bullet points.
4. "## Meeting Prep" — for each meeting that has an agenda or description, digest it and provide prep guidance, key questions to address, and context the CEO should have going in.
5. "## Open Tasks" — list with any overdue flags
6. "## Action Items" — numbered list of concrete actions for today, ordered by priority`;

  log("Calling Opus 4.6…");
  const result = await callOpusDirect(SYSTEM_PROMPT, userPrompt);
  log(
    `Opus: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out — $${result.costUsd.toFixed(4)}`,
  );
  updateDailyUsage("_briefing_daily", "opus", result.usage, result.costUsd);

  // Save to Obsidian — prepend if the file already has channel-appended content
  const filename = `Daily-Brief-${date}.md`;
  const existing = readFileOr(join(CONFIG.inboxDir, filename), "");
  if (existing && !existing.includes("## Follow-ups") && !existing.includes("## Calendar")) {
    writeObsidian(filename, result.text + "\n\n---\n\n" + existing);
  } else if (!existing) {
    writeObsidian(filename, result.text);
  } else {
    // Already has a briefing section — overwrite entirely
    writeObsidian(filename, result.text);
  }

  await sendToLark(formatForLark(result.text));
  log("Daily briefing sent to Lark channel ✓");
}

// ─── EoD Summary ─────────────────────────────────────────────────────────────

async function generateEodSummary(): Promise<void> {
  const date = today();
  const dow = new Date().getDay();
  const dayName = DAY_NAMES[dow];
  log(`Generating EoD summary for ${date} (${dayName})`);

  const dailyBrief = readFileOr(
    join(CONFIG.inboxDir, `Daily-Brief-${date}.md`),
    "[No daily brief found for today]",
  );
  const channelActivity = readChannelMemoryForDate(date);

  const [calendar, tasks] = await Promise.all([
    gatherSafe("calendar", () => gatherCalendar(), ""),
    gatherSafe("tasks", () => gatherTasks(), ""),
  ]);

  // Pre-process raw JSON with Haiku before Opus
  const [calendarFmt, tasksFmt] = await Promise.all([
    calendar.error
      ? Promise.resolve(`[Calendar unavailable: ${calendar.error}]`)
      : compressWithHaiku("eod-calendar", calendar.data || "", "Format these calendar events as a bullet list: time, title, attendees. One line per event."),
    tasks.error
      ? Promise.resolve(`[Tasks unavailable: ${tasks.error}]`)
      : compressWithHaiku("eod-tasks", preprocessTasks(tasks.data || ""), "Format these tasks as a bullet list: task name, due date, status. Mark overdue with ⚠️."),
  ]);

  const userPrompt = `Generate the CEO's end-of-day summary for **${date} (${dayName})**.

## This Morning's Briefing
${dailyBrief.slice(0, 4000)}

## Today's Channel Activity (interactions through Lark AI channel)
${channelActivity.slice(0, 8000)}

## Today's Calendar (completed + remaining)
${calendarFmt}

## Current Tasks (overdue shown only if within past 14 days)
${tasksFmt}

---
Instructions:
1. Start with "# EoD Summary — ${date} (${dayName})"
2. "## Key Meetings" — which meetings happened today, key outcomes, decisions made, action items generated (cross-reference calendar with channel activity)
3. "## Decisions & Insights" — decisions made, documents reviewed, notable insights from channel activity
4. "## Open Loops" — items started but not finished, promises made, follow-ups needed
5. "## Closing Notes" — 5-7 bullet executive summary for tomorrow's morning briefing to pick up. This is the **most important section** — it feeds directly into tomorrow's daily brief. Be specific: include names, dates, and next actions.`;

  log("Calling Opus 4.6…");
  const result = await callOpusDirect(SYSTEM_PROMPT, userPrompt);
  log(
    `Opus: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out — $${result.costUsd.toFixed(4)}`,
  );
  updateDailyUsage("_briefing_eod", "opus", result.usage, result.costUsd);

  writeObsidian(`EoD-Summary-${date}.md`, result.text);
  await sendToLark(formatForLark(result.text));
  log("EoD summary sent to Lark channel ✓");
}

// ─── Weekly Summary ──────────────────────────────────────────────────────────

async function generateWeeklySummary(): Promise<void> {
  const now = new Date();
  const weekDates = getWeekDates(now);
  const monDate = weekDates[0];
  const friDate = weekDates[4];
  log(`Generating weekly summary for ${monDate} → ${friDate}`);

  const dailyBriefs: string[] = [];
  const eodSummaries: string[] = [];

  for (const d of weekDates) {
    const dn =
      DAY_NAMES[new Date(d + "T12:00:00").getDay()].slice(0, 3);

    const daily = readFileOr(
      join(CONFIG.inboxDir, `Daily-Brief-${d}.md`),
      "",
    );
    if (daily)
      dailyBriefs.push(`### ${dn} ${d}\n${daily.slice(0, 3000)}`);

    const eod = readFileOr(
      join(CONFIG.inboxDir, `EoD-Summary-${d}.md`),
      "",
    );
    if (eod)
      eodSummaries.push(`### ${dn} ${d}\n${eod.slice(0, 3000)}`);
  }

  const tasks = await gatherSafe("tasks", () => gatherTasks(), "");
  const tasksFmt = tasks.error
    ? `[Tasks unavailable: ${tasks.error}]`
    : await compressWithHaiku("weekly-tasks", preprocessTasks(tasks.data || ""), "Format these tasks as a bullet list: task name, due date, status. Mark overdue with ⚠️.");

  const userPrompt = `Generate the CEO's weekly summary for the week of **${monDate} to ${friDate}**.

## Daily Briefings This Week
${dailyBriefs.length ? dailyBriefs.join("\n\n") : "[No daily briefs found this week]"}

## EoD Summaries This Week
${eodSummaries.length ? eodSummaries.join("\n\n") : "[No EoD summaries found this week]"}

## Current Task Status (overdue shown only if within past 14 days)
${tasksFmt}

---
Instructions:
1. Start with "# Weekly Summary — ${monDate} to ${friDate}"
2. "## Week at a Glance" — 5-7 bullet narrative arc of the week
3. "## Key Decisions Made" — what was decided, by whom, with dates
4. "## Key Meetings & Outcomes" — most impactful meetings
5. "## Projects & Initiatives Update" — status of ongoing workstreams
6. "## Open Items & Carry-forwards" — unresolved items moving to next week
7. "## People & Relationships" — key interactions, external relationships
8. "## Priorities for Next Week" — recommended focus areas for Monday morning. Be specific: name the decisions, meetings, and follow-ups.`;

  log("Calling Opus 4.6…");
  const result = await callOpusDirect(SYSTEM_PROMPT, userPrompt, 12000);
  log(
    `Opus: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out — $${result.costUsd.toFixed(4)}`,
  );
  updateDailyUsage("_briefing_weekly", "opus", result.usage, result.costUsd);

  writeObsidian(`Weekly-Summary-${friDate}.md`, result.text);
  await sendToLark(formatForLark(result.text));
  log("Weekly summary sent to Lark channel ✓");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf("--mode");
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : args[0];

  if (!mode || !["daily", "eod", "weekly"].includes(mode)) {
    console.error("Usage: bun briefing.ts --mode daily|eod|weekly");
    process.exit(1);
  }

  log(`Starting ${mode} briefing…`);

  try {
    switch (mode) {
      case "daily":
        await generateDailyBriefing();
        break;
      case "eod":
        await generateEodSummary();
        break;
      case "weekly":
        await generateWeeklySummary();
        break;
    }
    log(`${mode} briefing complete.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FATAL: ${mode} briefing failed — ${msg}`);
    try {
      await sendToLark(
        `⚠️ **Briefing Failed**\n\nThe **${mode}** briefing could not be generated.\n\nError: \`${msg}\`\n\nCheck logs: \`/tmp/ceo-briefing-${mode}.err.log\``,
      );
    } catch {
      log("Could not send failure notification to Lark");
    }
    process.exit(1);
  }
}

main();
