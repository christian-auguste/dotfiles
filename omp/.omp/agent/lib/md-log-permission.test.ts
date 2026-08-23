// Behavioral check for the md-log TCC/permission fixes.
// Run: bun lib/md-log-permission.test.ts
// Covers: discovery denied-vs-not-found, /md-log error rendering, bind,
// append notify-once + recovery, and the append-time vault containment check.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { discoverVaultRoot } from "./path-guard";
import registerMdLog from "../extensions/md-log";

const tmp = mkdtempSync(path.join(tmpdir(), "mdlog-perm-"));
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

function harness() {
  const handlers: Record<string, Handler> = {};
  const notifies: string[] = [];
  let stored: string | null = null;
  let serial = 0;
  const fired: Array<{ id: string; message: unknown }> = [];
  let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
  // Test mock: the harness types are far broader than the registration
  // surface this test exercises, so cast past ExtensionAPI.
  const pi = {
    on: (event: string, cb: Handler) => { handlers[event] = cb; },
    registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { handler = def.handler; },
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
  return { handlers, notifies, handler, ctx, userMessage, drain };
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

// 4. /md-log from a denied cwd -> permission message, not the vault-not-found one
{
  const h = harness();
  chmodSync(denied, 0o000);
  try {
    await h.handler(JSON.stringify(note), h.ctx(path.join(denied, "inner")));
  } finally { chmodSync(denied, 0o755); }
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0], /permission denied accessing/);
  assert.doesNotMatch(h.notifies[0], /could not find an Obsidian vault/);
}

// 5. /md-log from a no-vault cwd -> existing not-found message
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(noVault));
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0], /could not find an Obsidian vault/);
}

// 6. Normal bind from inside the vault -> success, note created with marker
{
  const h = harness();
  await h.handler(JSON.stringify(note), h.ctx(vault));
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

rmSync(tmp, { recursive: true, force: true });
console.log("md-log permission checks: all passed");
