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

/** Minimal ExtensionAPI stand-in that captures registered handlers/commands. */
interface FakePi {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: { name: string; handler: (args: unknown, ctx: unknown) => unknown }[];
  logger: { warn: () => void; error: () => void };
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerCommand(
    name: string,
    options: { handler: (args: unknown, ctx: unknown) => unknown },
  ): void;
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands: { name: string; handler: (args: unknown, ctx: unknown) => unknown }[] = [];
  return {
    handlers,
    commands,
    logger: { warn: () => {}, error: () => {} },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name, options) => {
      commands.push({ name, handler: options.handler });
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

/** Opens the /sandbox page via the fake host and returns its live component. */
async function openPage(command: {
  handler: (args: unknown, ctx: unknown) => unknown;
}): Promise<{ component: { handleInput(data: string): void }; closed: boolean }> {
  let component: { handleInput(data: string): void } | undefined;
  let closed = false;
  const ui = {
    notify: () => {},
    custom: async (factory: (...args: unknown[]) => unknown) => {
      component = (await factory(makeTui(), makeTheme(), makeKeybindings(), () => {
        closed = true;
      })) as { handleInput(data: string): void };
      return undefined;
    },
  };
  await command.handler({}, { mode: "tui", ui, hasUI: true, cwd: "/repo" } as unknown as ExtensionContext);
  expect(component).toBeDefined();
  return {
    component: component!,
    get closed() {
      return closed;
    },
  };
}

/** Creates a sandbox handler wired to a throwaway config file. */
function handlerWithConfigFile(
  file: string,
): { fake: FakePi; handle: { activity: { entries(): { kind: string; rule: string; tool: string; reason: string }[] } } } {
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

  test("search filters by next step text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake, handle } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);

      for (const char of "shutdown") component.handleInput(char);
      component.handleInput("\r");

      const saved = JSON.parse(readFileSync(file, "utf8"))["disabledRules"] as string[];
      expect(saved).toEqual(["destroy-system"]);
      expect(handle.activity.entries()[0]).toMatchObject({ kind: "toggle", rule: "destroy-system" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tab switching moves to the next tab's rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
    try {
      const file = join(dir, "pi-os-sandbox.json");
      writeFileSync(file, "{}");
      const { fake } = handlerWithConfigFile(file);
      const command = fake.commands.find((entry) => entry.name === "sandbox");
      const { component } = await openPage(command!);

      component.handleInput("\t");
      component.handleInput("\r");

      const saved = JSON.parse(readFileSync(file, "utf8"))["disabledRules"] as string[];
      expect(saved).toEqual(["run-recursive-cleanup"]);
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
