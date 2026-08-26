/**
 * @fileoverview Adapter hook mapping, session-grant flow, policy-activity
 * recording, and the /sandbox customization page with a fake host.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { defaultConfig } from "../src/config";
import { SessionGrants } from "../src/session-grants";
import { createSandboxHandler, loadSandboxConfig } from "../extensions/omp";
import { AuditJournal } from "../src/audit-journal";
import { ruleRegistry } from "../src/customization";

/** Minimal ExtensionAPI stand-in that captures registered handlers/commands. */
interface FakePi {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: { name: string; handler: (args: unknown, ctx: unknown) => unknown }[];
  shortcuts: { id: string; options: unknown }[];
  logger: { warn: () => void; error: () => void };
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerCommand(
    name: string,
    options: { handler: (args: unknown, ctx: unknown) => unknown },
  ): void;
  registerShortcut(id: string, options: unknown): void;
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands: { name: string; handler: (args: unknown, ctx: unknown) => unknown }[] = [];
  const shortcuts: { id: string; options: unknown }[] = [];
  return {
    handlers,
    commands,
    shortcuts,
    logger: { warn: () => {}, error: () => {} },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name, options) => {
      commands.push({ name, handler: options.handler });
    },
    registerShortcut: (id, options) => {
      shortcuts.push({ id, options });
    },
  };
}

/** Fake ExtensionContext; approve controls the confirm dialog result. */
function makeCtx(cwd: string, hasUI: boolean, approve = true): ExtensionContext {
  return {
    cwd,
    hasUI,
    ui: { confirm: async () => approve, notify: () => {} },
  } as unknown as ExtensionContext;
}

/** Drive the registered tool_call handler exactly as the host would. */
async function runToolCall(
  fake: FakePi,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | void> {
  const handler = fake.handlers.get("tool_call") as
    | ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void>)
    | undefined;
  expect(handler).toBeDefined();
  return handler!(event, ctx);
}

/** Small delay to allow async confirm toggles to settle. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function bashEvent(command: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc-1", toolName: "bash", input: { command } };
}

/** Minimal TUI stand-in the customization page repaints against. */
function makeTui(): unknown {
  return {
    requestRender: () => {},
    terminal: { columns: 100, rows: 30 },
  };
}

/** Fake theme that keeps row text plain so tests can read it. */
function makeTheme(): unknown {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

/** Fake key bindings mirroring the host defaults the page navigates with. */
function makeKeybindings(): unknown {
  const defaults: Record<string, string[]> = {
    "tui.select.cancel": ["\x1b", "\x03"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.up": ["\x1b[A"],
    "tui.select.down": ["\x1b[B"],
    "tui.select.pageUp": ["\x1b[5~"],
    "tui.select.pageDown": ["\x1b[6~"],
  };
  return {
    matches: (data: string, id: string) => (defaults[id] ?? []).includes(data),
  };
}

/**
 * Opens the /sandbox page via the fake host and returns its live component.
 *
 * @param confirmResult whether safety-floor confirm should approve.
 */
async function openPage(
  command: { handler: (args: unknown, ctx: unknown) => unknown },
  opts: { mode?: string; confirmResult?: boolean } = {},
): Promise<{
  component: { handleInput(data: string): void; render(width: number): readonly string[] };
  closed: boolean;
  notified: string[];
}> {
  let component: { handleInput(data: string): void; render(width: number): readonly string[] } | undefined;
  let closed = false;
  const notified: string[] = [];
  const ui = {
    notify: (message: string) => { notified.push(message); },
    confirm: async () => opts.confirmResult ?? true,
    custom: async (factory: (...args: unknown[]) => unknown) => {
      component = (await factory(makeTui(), makeTheme(), makeKeybindings(), () => {
        closed = true;
      })) as { handleInput(data: string): void; render(width: number): readonly string[] };
      return undefined;
    },
  };
  await command.handler({}, { mode: opts.mode ?? "tui", ui, hasUI: true, cwd: "/repo" } as unknown as ExtensionContext);
  expect(component).toBeDefined();
  return {
    component: component!,
    get closed() {
      return closed;
    },
    notified,
  };
}

/** Creates a sandbox handler wired to a throwaway config file. */
function handlerWithConfigFile(
  file: string,
): { fake: FakePi; handle: { activity: { entries(): { kind: string; rule: string; tool: string; reason: string; at: number }[] } } } {
  const fake = makeFakePi();
  const handle = createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig(), file);
  return { fake, handle };
}

describe("SessionGrants", () => {
  test("grant/has match on the exact cwd+command pair", () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf node_modules", "/repo");
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(true);
  });

  test("no match on a different cwd or command", () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf node_modules", "/repo");
    expect(grants.has("rm -rf node_modules", "/other")).toBe(false);
    expect(grants.has("rm -rf dist", "/repo")).toBe(false);
  });

  test("clear empties the store", () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf node_modules", "/repo");
    grants.clear();
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(false);
  });
});

describe("tool_call hook (fake ExtensionAPI)", () => {
  test("headless catastrophic bash is blocked", async () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const result = await runToolCall(fake, bashEvent("rm -rf /"), makeCtx("/repo", false));
    expect(result?.block).toBe(true);
  });

  test("headless recursive rm is blocked while nothing is granted", async () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const result = await runToolCall(fake, bashEvent("rm -rf node_modules"), makeCtx("/repo", false));
    expect(result?.block).toBe(true);
  });

  test("interactive approval grants the exact command for later headless runs", async () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const cwd = "/repo";

    const first = await runToolCall(fake, bashEvent("rm -rf node_modules"), makeCtx(cwd, true, true));
    expect(first).toBeUndefined();

    const second = await runToolCall(fake, bashEvent("rm -rf node_modules"), makeCtx(cwd, false));
    expect(second).toBeUndefined();

    const third = await runToolCall(fake, bashEvent("rm -rf dist"), makeCtx(cwd, false));
    expect(third?.block).toBe(true);

    const fourth = await runToolCall(fake, bashEvent("rm -rf node_modules"), makeCtx("/other", false));
    expect(fourth?.block).toBe(true);
  });

  test("declined interactive approval blocks the tool", async () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const result = await runToolCall(
      fake,
      bashEvent("rm -rf node_modules"),
      makeCtx("/repo", true, false),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toBe("Blocked: exact approval was not granted.");
  });

  test("registers the sandbox-status command", () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    expect(fake.commands.map((command) => command.name)).toContain("sandbox-status");
  });

  test("registers /sandbox and /sandbox-session commands and Option+S shortcut", () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const names = fake.commands.map((c) => c.name);
    expect(names).toContain("sandbox");
    expect(names).toContain("sandbox-session");
    expect(fake.shortcuts.map((s) => s.id)).toContain("alt+s");
  });
});

describe("policy activity recording", () => {
  test("blocks, prompts, and grants each record an activity entry", async () => {
    const fake = makeFakePi();
    const handle = createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const cwd = "/repo";

    await runToolCall(fake, bashEvent("rm -rf /"), makeCtx(cwd, false));
    expect(handle.activity.entries()[0]).toMatchObject({ kind: "block", rule: "delete-filesystem-root", tool: "bash" });

    await runToolCall(fake, bashEvent("rm -rf node_modules"), makeCtx(cwd, true, true));
    const entries = handle.activity.entries();
    expect(entries[0]).toMatchObject({ kind: "grant", rule: "run-recursive-cleanup", tool: "bash" });
    expect(entries[1]).toMatchObject({ kind: "prompt", rule: "run-recursive-cleanup", tool: "bash" });
    expect(entries[2]).toMatchObject({ kind: "block", rule: "delete-filesystem-root", tool: "bash" });
  });

  test("a declined approval records a block entry", async () => {
    const fake = makeFakePi();
    const handle = createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    await runToolCall(fake, bashEvent("rm -rf node_modules"), makeCtx("/repo", true, false));
    const entries = handle.activity.entries();
    expect(entries[0]).toMatchObject({ kind: "block", rule: "run-recursive-cleanup", tool: "bash" });
    expect(entries[0]!.reason).toBe("Operator declined approval.");
    expect(entries[1]).toMatchObject({ kind: "prompt", rule: "run-recursive-cleanup", tool: "bash" });
  });

  test("recorded reasons are redacted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, JSON.stringify({ credentialRoots: [join(dir, `cred-${secret}`)] }));
      const config = loadSandboxConfig(file, () => {});
      const fake = makeFakePi();
      const handle = createSandboxHandler(fake as unknown as ExtensionAPI, config);
      const result = await runToolCall(
        fake,
        {
          type: "tool_call",
          toolCallId: "tc-1",
          toolName: "read",
          input: { path: join(dir, `cred-${secret}`, "id_rsa") },
        },
        makeCtx(dir, false),
      );
      expect(result?.block).toBe(true);
      const entry = handle.activity.entries()[0]!;
      expect(entry.kind).toBe("block");
      expect(entry.rule).toBe("read-credentials");
      expect(entry.reason).not.toContain(secret);
      expect(entry.reason).toContain("[redacted]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/sandbox customization page", () => {
  test("toggling a rule persists it, applies next call, and records a toggle entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      const config = defaultConfig();
      const handle = createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      expect(command).toBeDefined();
      const { component } = await openPage(command!);
      component.handleInput("\r");
      await tick();
      expect(JSON.parse(readFileSync(file, "utf8"))["disabledRules"]).toEqual(["delete-filesystem-root"]);
      expect(config.disabledRules).toEqual(["delete-filesystem-root"]);
      expect(handle.activity.entries()[0]).toMatchObject({
        kind: "toggle",
        rule: "delete-filesystem-root",
        tool: "sandbox",
        reason: "Operator disabled rule delete-filesystem-root",
      });
      const result = await runToolCall(fake, bashEvent("rm -rf /"), makeCtx("/repo", false));
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("safety-floor toggle requires confirm; cancel keeps rule enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      const config = defaultConfig();
      createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!, { confirmResult: false });
      component.handleInput("\r");
      await tick();
      const saved = JSON.parse(readFileSync(file, "utf8"))["disabledRules"];
      expect(saved).toBeUndefined();
      expect(config.disabledRules).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disabled safety-floor shows warning label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, JSON.stringify({ disabledRules: ["delete-filesystem-root"] }));
      const fake = makeFakePi();
      const config = defaultConfig();
      // Load disabled into config via handler startup
      const handle = createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      // Ensure config reflects saved disabled
      expect(config.disabledRules).toContain("delete-filesystem-root");
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      const lines = component.render(100).join("\n");
      expect(lines).toContain("warning");
      expect(lines).toContain("disabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("search filters by next step text and Enter toggles without leaving search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake, handle } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      for (const char of "shutdown") component.handleInput(char);
      // Should be in search mode: grouped results with heading
      const linesDuringSearch = component.render(100).join("\n");
      expect(linesDuringSearch).toContain("Safety floor");
      expect(linesDuringSearch).toContain("matches");
      // Toggle while searching: should not clear query
      component.handleInput("\r");
      await tick();
      const saved = JSON.parse(readFileSync(file, "utf8"))["disabledRules"] as string[];
      expect(saved).toEqual(["destroy-system"]);
      expect(handle.activity.entries()[0]).toMatchObject({ kind: "toggle", rule: "destroy-system" });
      // Still in search after toggle
      const stillSearching = component.render(100).join("\n");
      expect(stillSearching).toContain("shutdown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("global grouped search shows headings and match count and bottom explanation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      for (const char of "credential") component.handleInput(char);
      const lines = component.render(100).join("\n");
      // Should have headings for matching groups
      expect(lines).toContain("matches");
      // Bottom explanation: description of selected hit
      const registry = ruleRegistry().find((r) => r.id === "write-credentials" || r.id === "read-credentials");
      expect(lines).toContain(registry!.description.slice(0, 10));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Esc clears search, second Esc closes page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const page = await openPage(command!);
      for (const char of "shutdown") page.component.handleInput(char);
      expect(page.component.render(100).join("\n")).toContain("shutdown");
      page.component.handleInput("\x1b");
      expect(page.component.render(100).join("\n")).not.toContain("shutdown");
      expect(page.closed).toBe(false);
      page.component.handleInput("\x1b");
      expect(page.closed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tab switching moves to the next tab's rules and shows icons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      const initial = component.render(100).join("\n");
      expect(initial).toContain("Safety floor");
      expect(initial).toContain("⬢");
      expect(initial).toContain("⬣");
      expect(initial).toContain("⬔");
      expect(initial).toContain("◈");
      component.handleInput("\t");
      const after = component.render(100).join("\n");
      expect(after).toContain("Recursive cleanup");
      component.handleInput("\r");
      await tick();
      const saved = JSON.parse(readFileSync(file, "utf8"))["disabledRules"] as string[];
      expect(saved).toEqual(["run-recursive-cleanup"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("details panel order: state → description → nextStep → Rule id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      const lines = component.render(100);
      const text = lines.join("\n");
      // Should contain state, description, nextStep, Rule id in order
      const stateIdx = text.indexOf("State:");
      const descIdx = text.indexOf(ruleRegistry()[0]!.description.slice(0, 10));
      const nextIdx = text.indexOf(ruleRegistry()[0]!.nextStep.slice(0, 10));
      const idIdx = text.indexOf(`Rule id: ${ruleRegistry()[0]!.id}`);
      expect(stateIdx).toBeGreaterThan(-1);
      expect(descIdx).toBeGreaterThan(stateIdx);
      expect(nextIdx).toBeGreaterThan(descIdx);
      expect(idIdx).toBeGreaterThan(nextIdx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("path-policy details show protected paths with ~/ short form", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      // Switch to path-policy tab (2 tabs forward from safety-floor)
      component.handleInput("\t");
      component.handleInput("\t");
      const text = component.render(100).join("\n");
      expect(text).toContain("~/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("footer hints change contextually and summary shows two rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      let text = component.render(100).join("\n");
      expect(text).toContain("Saved rules:");
      expect(text).toContain("Active rules:");
      expect(text).toContain("Enter/Space change");
      // Typing search changes footer
      for (const c of "hi") component.handleInput(c);
      text = component.render(100).join("\n");
      expect(text).toContain("Esc clear search");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("esc closes the page without persisting anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const page = await openPage(command!);
      expect(page.closed).toBe(false);
      page.component.handleInput("\x1b");
      expect(page.closed).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))["disabledRules"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-TUI mode notifies instead of opening the page", async () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const command = fake.commands.find((entry) => entry.name === "sandbox");
    expect(command).toBeDefined();
    const notified: string[] = [];
    const ui = {
      notify: (message: string) => {
        notified.push(message);
      },
      custom: async () => {
        throw new Error("custom must not run outside TUI mode");
      },
    };
    await command!.handler({}, { mode: "rpc", ui, hasUI: false, cwd: "/repo" } as unknown as ExtensionContext);
    expect(notified[0]).toContain("terminal-only");
  });
});

describe("Session Sandbox", () => {
  test("session toggle does not persist to disk but updates effective config and banner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      const config = defaultConfig();
      createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      const cmd = fake.commands.find((entry) => entry.name === "sandbox-session");
      expect(cmd).toBeDefined();
      const { component } = await openPage(cmd!, { confirmResult: true });
      const before = component.render(100).join("\n");
      expect(before).toContain("Session Sandbox");
      expect(before).toContain("Session-only changes");
      component.handleInput("\r");
      await tick();
      // Saved file unchanged
      const saved = JSON.parse(readFileSync(file, "utf8"))["disabledRules"];
      expect(saved).toBeUndefined();
      // Config reflects effective
      expect(config.disabledRules).toContain("delete-filesystem-root");
      // Row shows saved → session
      const after = component.render(100).join("\n");
      expect(after).toContain("saved:");
      expect(after).toContain("session:");
      expect(after).toContain("Session overrides active");
      expect(after).toContain("Active rules:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session reset clears overrides and restores saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      const config = defaultConfig();
      createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      const cmd = fake.commands.find((entry) => entry.name === "sandbox-session");
      const { component } = await openPage(cmd!);
      component.handleInput("\r");
      await tick();
      expect(config.disabledRules.length).toBe(1);
      // Reset via 'r' key
      component.handleInput("r");
      expect(config.disabledRules.length).toBe(0);
      const text = component.render(100).join("\n");
      expect(text).not.toContain("Session overrides active");
      // Footer shows reset when overrides active, but after reset no banner
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("effective disabled overlays saved and session correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, JSON.stringify({ disabledRules: ["destroy-system"] }));
      const fake = makeFakePi();
      const config = defaultConfig();
      const handle = createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      // Initially effective includes saved disabled
      expect(config.disabledRules).toContain("destroy-system");
      // Open session and toggle a different rule
      const cmd = fake.commands.find((e) => e.name === "sandbox-session");
      const { component } = await openPage(cmd!);
      component.handleInput("\r"); // toggle delete-filesystem-root in session
      await tick();
      expect(config.disabledRules).toContain("delete-filesystem-root");
      expect(config.disabledRules).toContain("destroy-system");
      // Toggle same rule again in session to re-enable
      component.handleInput("\r");
      await tick();
      expect(config.disabledRules).not.toContain("delete-filesystem-root");
      expect(config.disabledRules).toContain("destroy-system");
      // Session overrides map reflects only session changes
      expect(handle.sessionOverrides.has("delete-filesystem-root")).toBe(true);
      expect(handle.sessionOverrides.get("delete-filesystem-root")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Activity tab merges current and saved newest first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      const config = defaultConfig();
      const handle = createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      const cwd = "/repo";
      await runToolCall(fake, bashEvent("rm -rf /"), makeCtx(cwd, false));
      // Add a persisted journal entry with older timestamp directly
      const journalPath = join(dir, "audit.jsonl");
      const journal = new AuditJournal(journalPath, () => {});
      journal.append({ at: Date.now() - 100_000, kind: "denial", rule: "write-credentials", tool: "bash", reason: "old persisted entry" });
      // Create a new handler that reads that journal? Instead inject via handle's journal
      // Use the handler's journal already; append an old entry
      (handle as unknown as { journal: AuditJournal }).journal.append({
        at: Date.now() - 100_000,
        kind: "denial",
        rule: "write-credentials",
        tool: "bash",
        reason: "old persisted entry",
      });
      const cmd = fake.commands.find((e) => e.name === "sandbox");
      const { component } = await openPage(cmd!);
      // Switch to Activity tab (3 tabs forward)
      component.handleInput("\t");
      component.handleInput("\t");
      component.handleInput("\t");
      const text = component.render(100).join("\n");
      expect(text).toContain("Activity");
      // Should show both current block and persisted entry; newest first => delete-filesystem-root first
      const idxNew = text.indexOf("delete-filesystem-root");
      const idxOld = text.indexOf("write-credentials");
      expect(idxNew).toBeGreaterThan(-1);
      expect(idxOld).toBeGreaterThan(-1);
      expect(idxNew).toBeLessThan(idxOld);
      // Empty message not shown when entries exist
      expect(text).not.toContain("No recent activity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Activity empty shows placeholder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig(), file);
      const cmd = fake.commands.find((e) => e.name === "sandbox");
      const { component } = await openPage(cmd!);
      component.handleInput("\t");
      component.handleInput("\t");
      component.handleInput("\t");
      const text = component.render(100).join("\n");
      expect(text).toContain("No recent activity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mouse handling", () => {
  test("row click selects and state click toggles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      const config = defaultConfig();
      createSandboxHandler(fake as unknown as ExtensionAPI, config, file);
      const cmd = fake.commands.find((e) => e.name === "sandbox");
      const { component } = await openPage(cmd!);
      // Render to populate hits; rows start at row index maybe 6+ depending on header
      component.render(100);
      // Access private hits via any
      const hits = (component as unknown as { rowHits: { row: number; index: number; stateStart: number; stateEnd: number }[] }).rowHits;
      expect(hits.length).toBeGreaterThan(0);
      const first = hits[0]!;
      // Click row (col 0) selects
      component.handleInput(`\x1b[<0;1;${first.row + 1}M`);
      // Toggle via state column click: col = stateStart+1
      const stateCol = first.stateStart + 1;
      component.handleInput(`\x1b[<0;${stateCol + 1};${first.row + 1}M`);
      await tick();
      expect(config.disabledRules).toContain(ruleRegistry()[0]!.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sandbox-status", () => {
  test("reports activity summary and disabled rule count", async () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const command = fake.commands.find((entry) => entry.name === "sandbox-status");
    expect(command).toBeDefined();
    const notified: string[] = [];
    const ctx = {
      cwd: "/repo",
      ui: {
        notify: (message: string) => {
          notified.push(message);
        },
      },
    } as unknown as ExtensionContext;
    await command!.handler({}, ctx);
    expect(notified[0]).toContain("0 disabled rules");
    expect(notified[0]).toContain("policy activity: 0 entries");
  });

  test("summary reflects recorded denials and toggles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const fake = makeFakePi();
      const handle = createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig(), file);
      const cwd = "/repo";

      await runToolCall(fake, bashEvent("rm -rf /"), makeCtx(cwd, false));
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);
      component.handleInput("\r");
      await tick();

      const notified: string[] = [];
      const status = fake.commands.find((entry) => entry.name === "sandbox-status");
      const ctx = {
        cwd,
        ui: {
          notify: (message: string) => {
            notified.push(message);
          },
        },
      } as unknown as ExtensionContext;
      await status!.handler({}, ctx);
      expect(notified[0]).toContain("1 disabled rule");
      expect(notified[0]).toContain("policy activity: 2 entries (block:1 toggle:1)");
      expect(handle.activity.entries()[0]).toMatchObject({ kind: "toggle", rule: "delete-filesystem-root" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadSandboxConfig", () => {
  test("loads a valid explicit config path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(
        file,
        JSON.stringify({
          safetyRoots: ["/tmp/safe"],
          credentialRoots: ["/tmp/creds"],
          metadataHosts: ["169\\.254\\.169\\.254"],
        }),
      );
      const config = loadSandboxConfig(file, () => {});
      expect(config.safetyRoots).toEqual(["/tmp/safe"]);
      expect(config.credentialRoots).toEqual(["/tmp/creds"]);
      expect(config.metadataHosts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid JSON falls back to the default strict floor", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{not json");
      expect(loadSandboxConfig(file, () => {})).toEqual(defaultConfig());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
