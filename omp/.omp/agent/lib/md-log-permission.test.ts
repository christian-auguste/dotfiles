// Behavioral checks for md-log binding, ordered replay, and lifecycle filtering.
// Run: bun lib/md-log-permission.test.ts
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { discoverVaultRoot } from "./path-guard";
import registerMdLog from "../extensions/md-log";

const tmp = mkdtempSync(path.join(tmpdir(), "mdlog-perm-"));
const agentDir = path.join(tmp, "agent");
mkdirSync(agentDir, { recursive: true });
// Route md-log.json writes to the temp agent dir, never the real ~/.omp/agent.
process.env.PI_CODING_AGENT_DIR = agentDir;
const vault = path.join(tmp, "Vault");
const vault2 = path.join(tmp, "Vault2");
mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
mkdirSync(path.join(vault2, ".obsidian"), { recursive: true });
mkdirSync(path.join(vault, "notes"), { recursive: true });
const denied = path.join(vault, "denied");
mkdirSync(path.join(denied, "inner"), { recursive: true });
const note = path.join(vault, "notes", "chat.md");
const noVault = path.join(tmp, "no-vault");
mkdirSync(noVault, { recursive: true });

type Handler = (event?: unknown, ctx?: unknown) => Promise<void> | void;

type CommandDef = {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ label: string; value: string; description?: string }> | null;
};

let harnessSerial = 0;

function harness() {
  const runId = ++harnessSerial;
  const handlers: Record<string, Handler> = {};
  const notifies: string[] = [];
  let stored: string | null = null;
  let serial = 0;
  const fired: Array<Record<string, unknown> & { type: string; id: string }> = [];
  let commandDef: CommandDef | null = null;
  let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
  // Test mock: the harness types are far broader than the registration
  // surface this test exercises, so cast past ExtensionAPI.
  const pi = {
    on: (event: string, cb: Handler) => { handlers[event] = cb; },
    registerCommand: (_name: string, def: CommandDef) => { commandDef = def; handler = def.handler; },
    registerTool: () => {},
    appendEntry: (_type: string, data: string) => { stored = data; },
    logger: { error: () => {} },
    zod: { object: () => ({}) },
  } as unknown as ExtensionAPI;
  registerMdLog(pi);
  const ctx = (cwd: string) => ({
    cwd,
    ui: { notify: (message: string, level: string) => notifies.push(`${level}: ${message}`) },
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [
        ...(stored ? [{ type: "custom", customType: "mdlog.state", data: stored }] : []),
        ...fired,
      ],
    },
  });
  const userMessage = (text: string) => {
    const entry = { type: "message", id: `m${runId}-${++serial}`, message: { role: "user", content: [{ type: "text", text }] } };
    fired.push(entry);
    return { message: entry.message };
  };
  const skillPrompt = (args: string) => {
    const entry = {
      type: "custom_message",
      id: `c${runId}-${++serial}`,
      customType: "skill-prompt",
      attribution: "user",
      details: { name: "learn", args },
      content: `Injected skill instructions\nUser: ${args}`,
    };
    fired.push(entry);
    return entry;
  };

  const quizResult = (question: string) => {
    const entry = {
      type: "message",
      id: `m${runId}-${++serial}`,
      message: {
        role: "toolResult",
        toolName: "quiz",
        toolCallId: `q${runId}-${serial}`,
        input: { question },
        details: {
          status: "answered",
          options: [{ label: "A" }],
          answers: [{ label: "A" }],
          correctIndices: [1],
          correct: true,
        },
        content: [],
        isError: false,
      },
    };
    fired.push(entry);
    return entry;
  };
  const cancelledQuiz = (question: string) => {
    const toolCallId = `q${runId}-${++serial}`;
    const args = {
      question,
      options: [{ label: "Yes" }, { label: "No" }],
      correctAnswer: "Yes",
      explanation: "Test explanation.",
    };
    fired.push({
      type: "message",
      id: `m${runId}-${serial}`,
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "write",
          toolCallId,
          arguments: { path: "xd://quiz", content: JSON.stringify(args) },
        }],
      },
    });
    fired.push({
      type: "message",
      id: `m${runId}-${++serial}`,
      message: {
        role: "toolResult",
        toolName: "write",
        toolCallId,
        details: { xdev: { tool: "quiz", inner: { status: "cancelled" } } },
        content: [{ type: "text", text: "User cancelled the quiz" }],
        isError: false,
      },
    });
  };
  const completedBridgeQuiz = (question: string, note: string) => {
    const toolCallId = `q${runId}-${++serial}`;
    fired.push({
      type: "message",
      id: `m${runId}-${serial}`,
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "write",
          toolCallId,
          arguments: {
            path: "xd://quiz",
            content: JSON.stringify({
              question,
              options: [{ label: "10 committees" }, { label: "20 committees" }],
            }),
          },
        }],
      },
    });
    fired.push({
      type: "message",
      id: `m${runId}-${++serial}`,
      message: {
        role: "toolResult",
        toolName: "write",
        toolCallId,
        details: {
          xdev: {
            tool: "quiz",
            args: { question, options: [{ label: "10 committees" }, { label: "20 committees" }] },
            inner: {
              status: "answered",
              question,
              options: [{ index: 1, label: "10 committees" }, { index: 2, label: "20 committees" }],
              answers: [],
              correctIndices: [1],
              correct: false,
              dontKnow: true,
              note,
              explanation: "A committee is unordered.",
            },
          },
        },
        content: [{ type: "text", text: `Question: ${question}\n\nUser selected I don't know\n\nUser's note: ${note}\n\nExplanation: A committee is unordered.` }],
        isError: false,
      },
    });
  };

  const resetBoundary = () => {
    fired.push({ type: "reset_boundary", id: `r${runId}-${++serial}` });
  };
  // The extension exposes session_shutdown as "await the write queue"; use it
  // to drain enqueued appends deterministically instead of guessing a delay.
  const drain = async () => { await handlers["session_shutdown"]!(); };
  const setStored = (data: string | null) => { stored = data; };
  return { handlers, notifies, handler, commandDef, ctx, userMessage, skillPrompt, quizResult, cancelledQuiz, completedBridgeQuiz, resetBoundary, drain, setStored };
}

// Backfill reconstructs an answer and its note from persisted xdev details.
{
  const h = harness();
  const backfillNote = path.join(vault, "notes", "quiz-note-backfill.md");
  const question = "How many distinct committees can be formed?";
  const noteText = "I think this is n choose r, but I am unsure.";
  h.completedBridgeQuiz(question, noteText);
  writeFileSync(backfillNote, [
    "---",
    "Date: 2026-10-11",
    `omp-md-log: test-log-id`,
    "---",
    "",
    "> [!question] Question",
    `> ${question}`,
    ">",
    "> 1. 10 committees",
    "> 2. 20 committees",
  ].join("\n"));
  h.setStored(JSON.stringify({
    version: 1,
    boundPath: backfillNote,
    cursor: 25,
    seenIds: [],
    sessionId: "test-session",
    logId: "test-log-id",
    vaultRoot: realpathSync(vault),
  }));
  await h.handlers["session_switch"]!({ reason: "new" }, h.ctx(vault));
  await h.handler(JSON.stringify(backfillNote), h.ctx(vault));
  let content = readFileSync(backfillNote, "utf8");
  assert.equal(content.split(question).length - 1, 1);
  assert.match(content, /> \[!question\] Quiz — I don't know\n> Your answer: I don't know\n> Correct answer: 1\. 10 committees\n> \n> Note: I think this is n choose r, but I am unsure\.\n> \n> Explanation:\n> A committee is unordered\./);
  await h.handler(JSON.stringify(backfillNote), h.ctx(vault));
  content = readFileSync(backfillNote, "utf8");
  assert.equal(content.split(question).length - 1, 1);
  assert.equal(content.split("Note: I think this is n choose r").length - 1, 1);

}

// A bind after /learn recovers the complete user prompt, not injected skill text.
{
  const h = harness();
  const args = "Explain the full assignment.\n\n<attachment>\nAssignment text\n</attachment>";
  h.skillPrompt(args);
  await h.handler(JSON.stringify(note), h.ctx(vault));
  const content = readFileSync(note, "utf8");
  assert.match(content, /Explain the full assignment/);
  assert.match(content, /Assignment text/);
  assert.doesNotMatch(content, /Injected skill instructions/);
}

// Binding to a note with prior callouts still captures the current /learn prompt.
{
  const h = harness();
  const existingNote = path.join(vault, "notes", "existing.md");
  writeFileSync(existingNote, "---\nDate: 2026-10-09\n---\n\n> [!info] Earlier\nEarlier conversation\n");
  h.skillPrompt("Capture this complete request.\n\n<attachment>\nCurrent assignment\n</attachment>");
  await h.handler(JSON.stringify(existingNote), h.ctx(vault));
  const content = readFileSync(existingNote, "utf8");
  assert.match(content, /Capture this complete request/);
  assert.match(content, /Current assignment/);
  assert.match(content, /Earlier conversation/);
}

// Existing event comments are removed, and restarts keep the note marker-free.
{
  const h = harness();
  const existingNote = path.join(vault, "notes", "ordered.md");
  writeFileSync(existingNote, [
    "---",
    "Date: 2026-10-09",
    "---",
    "",
    "My note text stays here.",
    "",
    "> [!info] My callout",
    "> Keep this exactly.",
    "",
    "<!-- md-log:event:deadbeef:start -->",
    "> [!question] Question",
    "> Which event happened later?",
    ">",
    "> 1. A",
    "<!-- md-log:event:deadbeef:end -->",
    "",
    "Handwritten note between events.",
    "",
    "> [!success] Quiz — correct ✓",
    "> Your answer: A",
    "> Correct answer: 1. A",
  ].join("\n"));
  h.skillPrompt("Explain the assignment.");
  h.quizResult("Which event happened later?");
  await h.handler(JSON.stringify(existingNote), h.ctx(vault));
  const content = readFileSync(existingNote, "utf8");
  assert.ok(content.indexOf("Explain the assignment.") < content.indexOf("Which event happened later?"));
  assert.equal(content.split("Which event happened later?").length - 1, 1);
  assert.doesNotMatch(content, /<!-- md-log:event:/);
  assert.ok(content.includes("> [!info] My callout\n> Keep this exactly."));
  assert.ok(content.includes("Handwritten note between events."));
  assert.ok(content.includes("My note text stays here."));
  const skillStart = content.indexOf("> [!quote] You\n\nExplain the assignment.");
  const questionStart = content.indexOf("> [!question] Question", skillStart);
  assert.notEqual(skillStart, -1);
  assert.notEqual(questionStart, -1);
  writeFileSync(existingNote, content.slice(0, skillStart) + content.slice(questionStart));
  await h.handlers["session_start"]!({}, h.ctx(vault));
  const repaired = readFileSync(existingNote, "utf8");
  assert.ok(repaired.indexOf("Explain the assignment.") < repaired.indexOf("Which event happened later?"));
  assert.doesNotMatch(repaired, /<!-- md-log:event:/);
  await h.handlers["session_start"]!({}, h.ctx(vault));
  const replayed = readFileSync(existingNote, "utf8");
  assert.doesNotMatch(replayed, /<!-- md-log:event:/);
  assert.equal(replayed.split("Explain the assignment.").length - 1, 1);
  assert.equal(replayed.split("Which event happened later?").length - 1, 1);
}

// A new session must not backfill old, unlogged messages into the bound note.
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(vault));
  h.skillPrompt("old prompt");
  await h.handlers["session_switch"]!({ reason: "new" }, h.ctx(vault));
  await h.drain();
  assert.doesNotMatch(readFileSync(note, "utf8"), /old prompt/);
  h.handlers["message_end"]!(h.userMessage("new prompt"), h.ctx(vault));
  await h.drain();
  assert.match(readFileSync(note, "utf8"), /new prompt/);
}

// Binding after /clear must only backfill events after the latest boundary.
{
  const h = harness();
  const clearedNote = path.join(vault, "notes", "after-clear.md");
  writeFileSync(clearedNote, "> [!info] Existing note entry\n> Preserve this content.\n");
  h.skillPrompt("Pre-clear learning request.");
  h.cancelledQuiz("Question generated from recalled learning memory?");
  h.resetBoundary();
  h.userMessage("Message discarded by a later clear.");
  h.resetBoundary();
  h.skillPrompt("Post-clear learning request.");

  await h.handler(JSON.stringify(clearedNote), h.ctx(vault));
  let content = readFileSync(clearedNote, "utf8");
  assert.match(content, /Post-clear learning request/);
  assert.doesNotMatch(content, /Pre-clear learning request/);
  assert.doesNotMatch(content, /Question generated from recalled learning memory/);
  assert.doesNotMatch(content, /Message discarded by a later clear/);
  assert.match(content, /> \[!info\] Existing note entry\n> Preserve this content\./);
  assert.match(h.notifies.at(-1) ?? "", /\(1 events backfilled\)/);

  h.handlers["message_end"]!(h.userMessage("Fresh message after clear."), h.ctx(vault));
  await h.drain();
  content = readFileSync(clearedNote, "utf8");
  assert.match(content, /Fresh message after clear/);
  await h.handlers["session_start"]!({}, h.ctx(vault));
  const resumed = readFileSync(clearedNote, "utf8");
  assert.doesNotMatch(resumed, /Question generated from recalled learning memory/);
  assert.equal(resumed.split("Post-clear learning request.").length - 1, 1);
  assert.equal(resumed.split("Fresh message after clear.").length - 1, 1);
}

// A later /learn prompt is captured from its custom session entry.
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(vault));
  h.skillPrompt("Explain this next section.\n\n<attachment>\nNew material\n</attachment>");
  h.handlers["agent_start"]!({}, h.ctx(vault));
  await h.drain();
  const content = readFileSync(note, "utf8");
  assert.match(content, /Explain this next section/);
  assert.match(content, /New material/);
  assert.doesNotMatch(content, /Injected skill instructions/);
}

// 1. Normal discovery
{
  const found = discoverVaultRoot(vault);
  assert.equal(found.ok, true);
  if (found.ok) assert.equal(found.root, realpathSync(vault));
}

// 2. Denied discovery (chmod 000 parent) -> "denied", not "not-found"
chmodSync(denied, 0o000);
try {
  const found = discoverVaultRoot(path.join(denied, "inner"));
  assert.deepEqual(found, { ok: false, error: "denied", at: path.join(denied, "inner") });
} finally { chmodSync(denied, 0o755); }

// 3. No vault above -> "not-found"
{
  const found = discoverVaultRoot(noVault);
  assert.deepEqual(found, { ok: false, error: "not-found" });
}

// 4. /md-log with a note path inside a denied dir -> permission message,
//    not the vault-not-found one. cwd is irrelevant now.
{
  const h = harness();
  const deniedNote = path.join(denied, "inner", "note.md");
  chmodSync(denied, 0o000);
  try {
    await h.handler(JSON.stringify(deniedNote), h.ctx(noVault));
  } finally { chmodSync(denied, 0o755); }
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0], /permission denied accessing/);
  assert.doesNotMatch(h.notifies[0], /could not find an Obsidian vault/);
}

// 5. /md-log with a note path outside any vault -> existing not-found message
{
  const h = harness();
  await h.handler(JSON.stringify(path.join(noVault, "note.md")), h.ctx(vault));
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0], /could not find an Obsidian vault/);
}

// 6. Bind from a cwd with no vault above it -> still succeeds, because the
//    vault is discovered from the note path, not the cwd
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(noVault));
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0], /bound to .*chat\.md/);
  assert.match(readFileSync(note, "utf8"), /^omp-md-log: [0-9a-f-]{36}$/m);
}

// 7. Append notify-once: bind, then deny the note dir, fire two events
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(vault));
  h.notifies.length = 0;
  chmodSync(path.join(vault, "notes"), 0o000);
  try {
    h.handlers["message_end"]!(h.userMessage("first"), h.ctx(vault));
    h.handlers["message_end"]!(h.userMessage("second"), h.ctx(vault));
    await h.drain();
    const permissionNotifies = h.notifies.filter((n) => n.includes("permission denied accessing"));
    assert.equal(permissionNotifies.length, 1, `expected exactly one notify, got ${h.notifies}`);
  } finally { chmodSync(path.join(vault, "notes"), 0o755); }
  assert.doesNotMatch(readFileSync(note, "utf8"), /first|second/);
}

// 8. Recovery: perms restored -> entry lands, flag resets; re-deny -> notifies again
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(vault));
  h.notifies.length = 0;
  chmodSync(path.join(vault, "notes"), 0o000);
  try {
    h.handlers["message_end"]!(h.userMessage("blocked"), h.ctx(vault));
    await h.drain();
  } finally { chmodSync(path.join(vault, "notes"), 0o755); }
  h.handlers["message_end"]!(h.userMessage("recovered"), h.ctx(vault));
  await h.drain();
  assert.match(readFileSync(note, "utf8"), /recovered/);
  assert.doesNotMatch(readFileSync(note, "utf8"), /blocked/);
  h.notifies.length = 0;
  chmodSync(path.join(vault, "notes"), 0o000);
  try {
    h.handlers["message_end"]!(h.userMessage("blocked-again"), h.ctx(vault));
    await h.drain();
    assert.equal(h.notifies.filter((n) => n.includes("permission denied accessing")).length, 1);
  } finally { chmodSync(path.join(vault, "notes"), 0o755); }
}

// 9. Containment at append: bound note in vault1, session moved to vault2 -> no write
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(vault));
  const before = readFileSync(note, "utf8");
  await h.handlers["session_switch"]!({}, h.ctx(vault2));
  h.handlers["message_end"]!(h.userMessage("escaped"), h.ctx(vault2));
  await h.drain();
  assert.equal(readFileSync(note, "utf8"), before);
}

// 10. Restore fallback: session moved to a cwd with no vault above it still
//     appends, because restore falls back to the stored vaultRoot
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(vault));
  h.notifies.length = 0;
  await h.handlers["session_switch"]!({}, h.ctx(noVault));
  h.handlers["message_end"]!(h.userMessage("moved-session"), h.ctx(noVault));
  await h.drain();
  assert.match(readFileSync(note, "utf8"), /moved-session/);
}

// 11. vault set rejects a non-vault path and writes nothing
{
  const h = harness();
  await h.handler(`vault set "${noVault}"`, h.ctx(noVault));
  assert.match(h.notifies[0], /is not inside an Obsidian vault/);
  assert.equal(existsSync(path.join(agentDir, "md-log.json")), false);
}

// 12. vault set: real vault -> canonical root persisted
{
  const h = harness();
  await h.handler(`vault set "${vault}"`, h.ctx(noVault));
  assert.match(h.notifies[0], /default vault set to .*Vault$/);
  const saved = JSON.parse(readFileSync(path.join(agentDir, "md-log.json"), "utf8")) as Record<string, unknown>;
  assert.equal(saved.version, 1);
  assert.equal(saved.vaultRoot, realpathSync(vault));
}

// 13. vault (no verb) shows the configured vault
{
  const h = harness();
  await h.handler("vault", h.ctx(noVault));
  assert.match(h.notifies[0], /default vault .*Vault/);
}

// 14. vault clear removes the configured vault
{
  const h = harness();
  await h.handler("vault clear", h.ctx(noVault));
  assert.match(h.notifies[0], /default vault cleared/);
  const saved = JSON.parse(readFileSync(path.join(agentDir, "md-log.json"), "utf8")) as Record<string, unknown>;
  assert.equal(saved.vaultRoot, undefined);
}

// 15. status shows the binding
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(noVault));
  h.notifies.length = 0;
  await h.handler("status", h.ctx(noVault));
  assert.match(h.notifies[0], /bound: .*chat\.md/);
}

// 16. tab completions: top level, vault subcommands, and misses
{
  const h = harness();
  const completions = h.commandDef!.getArgumentCompletions!;
  assert.deepEqual(completions("").map((item) => item.label), ["vault", "status"]);
  assert.deepEqual(completions("vault ").map((item) => item.label), ["set", "clear"]);
  assert.deepEqual(completions("vault s").map((item) => item.label), ["set"]);
  assert.equal(completions("vault set /path"), null);
  assert.equal(completions("bogus"), null);
}

// 17. Restore falls back to the configured vault when the session state
//     predates vaultRoot (bound before the field existed)
{
  const h = harness();
  await h.handler(`vault set "${vault}"`, h.ctx(noVault));
  h.setStored(JSON.stringify({ version: 1, boundPath: note, cursor: 0, seenIds: [], sessionId: "test-session" }));
  await h.handlers["session_switch"]!({}, h.ctx(noVault));
  h.handlers["message_end"]!(h.userMessage("config-fallback"), h.ctx(noVault));
  await h.drain();
  assert.match(readFileSync(note, "utf8"), /config-fallback/);
}

delete process.env.PI_CODING_AGENT_DIR;
rmSync(tmp, { recursive: true, force: true });
console.log("md-log permission checks: all passed");
