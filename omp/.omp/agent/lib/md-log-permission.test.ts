// Behavioral check for the md-log TCC/permission fixes and vault discovery.
// Run: bun lib/md-log-permission.test.ts
// Covers: discovery denied-vs-not-found, /md-log error rendering, bind from a
// no-vault cwd, append notify-once + recovery, cross-vault containment, and
// restore falling back to the stored vaultRoot for moved sessions.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

function harness() {
  const handlers: Record<string, Handler> = {};
  const notifies: string[] = [];
  let stored: string | null = null;
  let serial = 0;
  const fired: Array<{ id: string; message: unknown }> = [];
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
        ...fired.map((entry) => ({ type: "message", id: entry.id, message: entry.message })),
      ],
    },
  });
  const userMessage = (text: string) => {
    const entry = { id: `m${++serial}`, message: { role: "user", content: [{ type: "text", text }] } };
    fired.push(entry);
    return { message: entry.message };
  };
  // The extension exposes session_shutdown as "await the write queue"; use it
  // to drain enqueued appends deterministically instead of guessing a delay.
  const drain = async () => { await handlers["session_shutdown"]!(); };
  const setStored = (data: string | null) => { stored = data; };
  return { handlers, notifies, handler, commandDef, ctx, userMessage, drain, setStored };
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
