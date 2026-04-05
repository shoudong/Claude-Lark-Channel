#!/usr/bin/env bun
/**
 * Reliability test harness for Lark Channel server.
 *
 * Sends simulated Lark webhook payloads to the running server and
 * checks events.jsonl for correct routing / extraction / handling.
 *
 * Usage:
 *   bun test-reliability.ts              # run all tests
 *   bun test-reliability.ts --quick      # skip Sonnet round-trips, only test routing/extraction
 *
 * Requires the server to be running on localhost:8765.
 */

import { readFileSync } from "node:fs";

const SERVER = process.env.TEST_SERVER ?? "http://localhost:8765";
const STATE_DIR = process.env.STATE_DIR ?? "/Users/dong-ai/Claude/scripts/lark-channel/.state";
const EVENTS_FILE = `${STATE_DIR}/events.jsonl`;
const QUICK = process.argv.includes("--quick");

// --- Config matching server ---
const CHAT_ID = "oc_cebe1616ba27d536286b15f59f63e5f0";
const OWNER_OPEN_ID = "ou_aa8bb5691e59fce13b80cefab30df7ab";
const VERIFICATION_TOKEN = "PxYMPKRiKPy0Q35ZKxF1DcB4MzczZXVY";

let testsPassed = 0;
let testsFailed = 0;
let testsSkipped = 0;
const failures: string[] = [];

// ─── Helpers ───────────────────────────────────────────────────────

function makeMessageId(): string {
  return `om_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildWebhookPayload(
  messageId: string,
  messageType: "text" | "post" | "interactive",
  content: Record<string, unknown>,
): Record<string, unknown> {
  return {
    header: {
      event_type: "im.message.receive_v1",
      token: VERIFICATION_TOKEN,
    },
    event: {
      sender: { sender_id: { open_id: OWNER_OPEN_ID } },
      message: {
        chat_id: CHAT_ID,
        message_id: messageId,
        message_type: messageType,
        content: JSON.stringify(content),
      },
    },
  };
}

async function sendWebhook(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
  const resp = await fetch(`${SERVER}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await resp.json() as any;
  return { ok: body.ok === true || resp.ok, status: resp.status };
}

function readEventsAfter(afterTs: string): any[] {
  try {
    const lines = readFileSync(EVENTS_FILE, "utf8").trim().split("\n");
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.ts > afterTs);
  } catch {
    return [];
  }
}

function findEvent(events: any[], type: string, messageId: string): any | null {
  return events.find((e) => e.type === type && e.messageId === messageId) ?? null;
}

async function waitForEvent(
  type: string,
  messageId: string,
  afterTs: string,
  timeoutMs = 30_000,
  pollMs = 500,
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readEventsAfter(afterTs);
    const found = findEvent(events, type, messageId);
    if (found) return found;
    await Bun.sleep(pollMs);
  }
  return null;
}

function assert(condition: boolean, label: string, detail = ""): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    testsFailed++;
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  }
}

// ─── Test cases ────────────────────────────────────────────────────

async function testHealth() {
  console.log("\n🔹 Test: Health endpoint");
  const resp = await fetch(`${SERVER}/health`);
  const data = await resp.json() as any;
  assert(resp.ok, "GET /health returns 200");
  assert(data.status === "ok", "status is ok");
  assert(data.defaultModel === "sonnet", "default model is sonnet");
}

async function testUrlVerification() {
  console.log("\n🔹 Test: URL verification challenge");
  const resp = await fetch(`${SERVER}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "url_verification",
      token: VERIFICATION_TOKEN,
      challenge: "test_challenge_123",
    }),
  });
  const data = await resp.json() as any;
  assert(resp.ok, "returns 200");
  assert(data.challenge === "test_challenge_123", "echoes challenge back");
}

async function testInvalidToken() {
  console.log("\n🔹 Test: Invalid verification token rejected");
  const resp = await fetch(`${SERVER}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      header: { event_type: "im.message.receive_v1", token: "wrong_token" },
      event: {
        sender: { sender_id: { open_id: OWNER_OPEN_ID } },
        message: { chat_id: CHAT_ID, message_id: makeMessageId(), message_type: "text", content: JSON.stringify({ text: "hello" }) },
      },
    }),
  });
  assert(resp.status === 403, "returns 403 for invalid token");
}

async function testWrongSenderIgnored() {
  console.log("\n🔹 Test: Messages from non-owner ignored");
  const msgId = makeMessageId();
  const payload = buildWebhookPayload(msgId, "text", { text: "hello" });
  (payload.event as any).sender.sender_id.open_id = "ou_someone_else";
  const { ok } = await sendWebhook(payload);
  assert(ok, "returns ok");
  await Bun.sleep(1000);
  const events = readEventsAfter(new Date(Date.now() - 2000).toISOString());
  const found = findEvent(events, "inbound", msgId);
  assert(found === null, "no inbound event logged for wrong sender");
}

async function testDuplicateRejected() {
  console.log("\n🔹 Test: Duplicate message ID rejected");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  const payload = buildWebhookPayload(msgId, "text", { text: "test dedup" });
  await sendWebhook(payload);
  await Bun.sleep(500);
  // Send same message ID again
  const { ok } = await sendWebhook(payload);
  assert(ok, "second send returns ok (silently ignored)");
  await Bun.sleep(2000);
  const events = readEventsAfter(ts);
  const inbounds = events.filter((e) => e.type === "inbound" && e.messageId === msgId);
  assert(inbounds.length <= 1, `only 0-1 inbound events for duplicate (got ${inbounds.length})`);
}

async function testPlainTextRouting() {
  console.log("\n🔹 Test: Plain text routes to correct bucket via Haiku dispatch");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  await sendWebhook(buildWebhookPayload(msgId, "text", { text: "What meetings do I have today?" }));
  const event = await waitForEvent("inbound", msgId, ts, 15_000);
  assert(event !== null, "inbound event logged");
  if (event) {
    assert(event.bucket === "calendar", `bucket is calendar (got ${event.bucket})`);
    assert(event.isForward === false, "not marked as forward");
  }
}

async function testEmailTextRouting() {
  console.log("\n🔹 Test: Email-related text routes to email bucket");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  await sendWebhook(buildWebhookPayload(msgId, "text", { text: "Check my latest emails from the legal team" }));
  const event = await waitForEvent("inbound", msgId, ts, 15_000);
  assert(event !== null, "inbound event logged");
  if (event) {
    assert(event.bucket === "email", `bucket is email (got ${event.bucket})`);
  }
}

async function testForwardedEmailNotCalendar() {
  console.log("\n🔹 Test: Forwarded email mentioning 'meeting' does NOT trigger simple calendar");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  // Simulate an interactive (forwarded email) card that mentions meetings
  const payload = buildWebhookPayload(msgId, "interactive", {
    title: "Fwd: Team meeting reschedule",
    elements: [
      { text: "<p>Hi team, the weekly meeting has been moved to Thursday 3pm. Please update your calendars. Best regards, Alice</p>" },
    ],
  });
  await sendWebhook(payload);
  // Wait for the merge window (5s) + Haiku extraction + dispatch + possible queue
  const event = await waitForEvent("inbound", msgId, ts, 45_000);
  assert(event !== null, "inbound event logged after merge window");
  if (event) {
    assert(event.isForward === true, "marked as forward");
    // The critical check: it should NOT have been handled by simple calendar
    await Bun.sleep(3000); // wait for possible simple_complete
    const simpleEvent = findEvent(readEventsAfter(ts), "simple_complete", msgId);
    assert(simpleEvent === null, "NOT handled by simple calendar handler");
  }
}

async function testForwardedEmailExtraction() {
  console.log("\n🔹 Test: Forwarded email gets Haiku extraction (check instruction is compressed)");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  const longEmail = `Dear Mr. Shou,

I hope this email finds you well. I am writing to follow up on our previous discussion regarding the Q2 partnership agreement between ADVANCE.AI and TechCorp Solutions.

As discussed during our meeting on March 15th, the key terms are:
1. Revenue share: 70/30 split favoring ADVANCE.AI
2. Integration timeline: 6 weeks starting April 15
3. Minimum guarantee: USD 500,000 per quarter
4. Termination clause: 90-day notice required

Please review the attached draft agreement and let us know if you have any questions or proposed modifications by April 10th.

Best regards,
Sarah Chen
VP of Partnerships
TechCorp Solutions
Level 35, Marina Bay Financial Centre
1 Raffles Quay, Singapore 048583
Tel: +65 6123 4567 | Fax: +65 6123 4568
CONFIDENTIALITY NOTICE: This email and any attachments are for the exclusive and confidential use of the intended recipient.
If you are not the intended recipient, please do not read, distribute, or take action based on this message.`;

  const payload = buildWebhookPayload(msgId, "interactive", {
    title: "Fwd: Q2 Partnership Agreement - TechCorp",
    elements: [{ text: longEmail }],
  });
  await sendWebhook(payload);
  const event = await waitForEvent("inbound", msgId, ts, 45_000);
  assert(event !== null, "inbound event logged");
  if (event) {
    assert(event.isForward === true, "marked as forward");
    // The instruction should contain "Summarize" (our default action wrapper)
    assert(
      event.instruction.includes("Summarize"),
      "default action wraps with summarize instruction",
    );
    // Should NOT contain the full boilerplate
    assert(
      !event.instruction.includes("CONFIDENTIALITY NOTICE"),
      "boilerplate stripped by Haiku extraction",
    );
  }
}

async function testPostMessageParsing() {
  console.log("\n🔹 Test: Post (rich text) message parsed correctly");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  const payload = buildWebhookPayload(msgId, "post", {
    zh_cn: {
      title: "会议纪要",
      content: [
        [{ text: "今天讨论了Q2的" }, { text: "预算分配方案" }],
        [{ text: "决定增加AI研发投入30%" }],
      ],
    },
  });
  await sendWebhook(payload);
  // Post messages are buffered (shouldBuffer=true)
  const event = await waitForEvent("inbound", msgId, ts, 45_000);
  assert(event !== null, "inbound event logged after merge window");
  if (event) {
    assert(event.isForward === true, "post treated as forward (buffered)");
  }
}

async function testHtmlTagsStripped() {
  console.log("\n🔹 Test: HTML tags stripped from post content");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  const payload = buildWebhookPayload(msgId, "post", {
    en_us: {
      title: "",
      content: [[{ text: "<p>help me <b>summarize</b> this document</p>" }]],
    },
  });
  await sendWebhook(payload);
  // This is a post so it gets buffered, then after 5s processed
  const event = await waitForEvent("inbound", msgId, ts, 45_000);
  assert(event !== null, "inbound event logged");
  if (event) {
    assert(!event.instruction.includes("<p>"), "no <p> tags in instruction");
    assert(!event.instruction.includes("<b>"), "no <b> tags in instruction");
  }
}

async function testMergeWindowForwardThenInstruction() {
  console.log("\n🔹 Test: Forward + follow-up instruction merged within 5s window");
  const forwardId = makeMessageId();
  const instructionId = makeMessageId();
  const ts = new Date().toISOString();

  // Send forwarded email
  await sendWebhook(buildWebhookPayload(forwardId, "interactive", {
    title: "Fwd: Invoice #12345",
    elements: [{ text: "Please find attached invoice for consulting services. Amount: USD 25,000. Due: April 30, 2026." }],
  }));

  // Wait 2s then send instruction (within 5s window)
  await Bun.sleep(2000);
  await sendWebhook(buildWebhookPayload(instructionId, "text", {
    text: "approve this invoice and forward to finance",
  }));

  // The instruction message should be the one processed (merged with forward)
  const event = await waitForEvent("inbound", instructionId, ts, 45_000);
  assert(event !== null, "merged inbound event logged under instruction messageId");
  if (event) {
    assert(
      event.instruction.includes("approve") || event.instruction.includes("invoice"),
      "instruction contains user's text",
    );
    assert(
      event.instruction.includes("Forwarded content"),
      "instruction contains merged forward extract",
    );
  }
  // The forward messageId should NOT have its own inbound event (it was consumed by merge)
  await Bun.sleep(8000); // wait past merge window
  const forwardInbound = findEvent(readEventsAfter(ts), "inbound", forwardId);
  assert(forwardInbound === null, "forward messageId consumed by merge (no separate inbound)");
}

async function testUrlOnlyBuffered() {
  console.log("\n🔹 Test: URL-only text message gets buffered");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  await sendWebhook(buildWebhookPayload(msgId, "text", {
    text: "https://docs.google.com/document/d/abc123/edit",
  }));
  // Should buffer for 5s, then process
  const event = await waitForEvent("inbound", msgId, ts, 45_000);
  assert(event !== null, "inbound event logged after merge window");
  if (event) {
    assert(event.isForward === true, "URL-only treated as forward");
    assert(event.instruction.includes("https://docs.google.com"), "URL preserved in instruction");
  }
}

async function testLongTextCompressed() {
  console.log("\n🔹 Test: Long text message (>500 chars) triggers Haiku compression");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  const longText = `I wanted to share some thoughts about our product strategy for Q3 and beyond. After reviewing the market analysis reports and competitive landscape assessment that the strategy team put together last week, I think we need to reconsider our approach to the Southeast Asian market expansion.

Here are the key points from my analysis:
1. Indonesia remains our strongest market with 45% year-over-year growth
2. Vietnam is showing promising traction but we need to invest more in local partnerships
3. Thailand market entry should be delayed to Q4 given the regulatory uncertainty
4. Philippines expansion is ahead of schedule — we should double down here

The main concern I have is around our burn rate. At the current pace, we have approximately 18 months of runway. If we pursue all four markets simultaneously, this drops to about 12 months. I propose we focus on Indonesia and Philippines for Q3, then reassess Vietnam and Thailand for Q4.

Please schedule a strategy review meeting for next Tuesday to discuss this further. I'd like the entire leadership team present, including the regional heads from Jakarta and Manila.`;

  await sendWebhook(buildWebhookPayload(msgId, "text", { text: longText }));
  const event = await waitForEvent("inbound", msgId, ts, 45_000);
  assert(event !== null, "inbound event logged");
  if (event) {
    assert(event.compressed === true, "marked as compressed");
    assert(event.isForward === false, "not marked as forward");
  }
}

async function testShortTextNotCompressed() {
  console.log("\n🔹 Test: Short text message (<500 chars) skips compression");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  await sendWebhook(buildWebhookPayload(msgId, "text", { text: "What's on my calendar tomorrow?" }));
  const event = await waitForEvent("inbound", msgId, ts, 15_000);
  assert(event !== null, "inbound event logged");
  if (event) {
    assert(event.compressed === false, "not compressed");
  }
}

async function testUnsupportedMessageTypeIgnored() {
  console.log("\n🔹 Test: Unsupported message type (image) silently ignored");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  const payload = buildWebhookPayload(msgId, "image" as any, { image_key: "img_abc123" });
  const { ok } = await sendWebhook(payload);
  assert(ok, "returns ok");
  await Bun.sleep(2000);
  const inbound = findEvent(readEventsAfter(ts), "inbound", msgId);
  assert(inbound === null, "no inbound event for unsupported type");
}

async function testEmptyTextIgnored() {
  console.log("\n🔹 Test: Empty text message ignored");
  const msgId = makeMessageId();
  const ts = new Date().toISOString();
  const { ok } = await sendWebhook(buildWebhookPayload(msgId, "text", { text: "   " }));
  assert(ok, "returns ok");
  await Bun.sleep(2000);
  const inbound = findEvent(readEventsAfter(ts), "inbound", msgId);
  assert(inbound === null, "no inbound event for empty text");
}

async function testFollowUpRoutedToSameBucket() {
  console.log("\n🔹 Test: Follow-up instruction routes to same bucket as prior forward");
  // First send a forwarded email
  const fwdId = makeMessageId();
  const ts = new Date().toISOString();
  await sendWebhook(buildWebhookPayload(fwdId, "interactive", {
    title: "Fwd: Board Meeting Minutes",
    elements: [{ text: "Board approved the FY2026 budget. Action items: CFO to finalize allocation by April 15." }],
  }));
  // Wait for it to process (past merge window)
  const fwdEvent = await waitForEvent("inbound", fwdId, ts, 45_000);
  assert(fwdEvent !== null, "forward processed");
  const fwdBucket = fwdEvent?.bucket;

  // Now send a follow-up
  await Bun.sleep(2000);
  const followId = makeMessageId();
  const ts2 = new Date().toISOString();
  await sendWebhook(buildWebhookPayload(followId, "text", { text: "Can you draft a reply to that?" }));
  const followEvent = await waitForEvent("inbound", followId, ts2, 15_000);
  assert(followEvent !== null, "follow-up processed");
  if (followEvent && fwdBucket) {
    assert(
      followEvent.bucket === fwdBucket,
      `follow-up routed to same bucket: ${fwdBucket} (got ${followEvent.bucket})`,
    );
  }
}

// ─── Runner ────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Lark Channel Reliability Tests");
  console.log(`  Server: ${SERVER}`);
  console.log(`  Mode: ${QUICK ? "quick (routing only)" : "full (includes Sonnet round-trips)"}`);
  console.log("═══════════════════════════════════════════════════");

  // Check server is up
  try {
    const resp = await fetch(`${SERVER}/health`);
    if (!resp.ok) throw new Error("unhealthy");
  } catch {
    console.error("\n❌ Server not reachable. Start it first:\n  bun server.ts\n");
    process.exit(1);
  }

  // Run tests
  await testHealth();
  await testUrlVerification();
  await testInvalidToken();
  await testWrongSenderIgnored();
  await testDuplicateRejected();
  await testUnsupportedMessageTypeIgnored();
  await testEmptyTextIgnored();
  await testPlainTextRouting();
  await testEmailTextRouting();
  await testShortTextNotCompressed();
  await testLongTextCompressed();
  await testForwardedEmailNotCalendar();
  await testForwardedEmailExtraction();
  await testPostMessageParsing();
  await testHtmlTagsStripped();
  await testUrlOnlyBuffered();
  await testMergeWindowForwardThenInstruction();
  await testFollowUpRoutedToSameBucket();

  // Summary
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsSkipped} skipped`);
  if (failures.length) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    • ${f}`);
  }
  console.log("═══════════════════════════════════════════════════\n");

  process.exit(testsFailed > 0 ? 1 : 0);
}

main();
