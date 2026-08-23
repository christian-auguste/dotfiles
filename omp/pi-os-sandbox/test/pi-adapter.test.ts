/**
 * @fileoverview Adapter hook mapping and session-grant flow with a fake host.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { DenialRing } from "../src/block-feedback";
import { defaultConfig, loadConfig } from "../src/config";
import { SessionGrants } from "../src/session-grants";
import { createSandboxHandler, loadSandboxConfig } from "../extensions/pi";

/** Minimal ExtensionAPI stand-in that captures registered handlers/commands. */
interface FakePi {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: { name: string; handler: (args: unknown, ctx: unknown) => unknown }[];
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

function readEvent(path: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc-2", toolName: "read", input: { path } };
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

  test("benign command passes headless without approval", async () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    const result = await runToolCall(fake, bashEvent("git status"), makeCtx("/repo", false));
    expect(result).toBeUndefined();
  });

  test("block reasons are redacted before returning", async () => {
    const fake = makeFakePi();
    const config = loadConfig({ credentialRoots: ["/tmp/token=abc123/creds"] });
    createSandboxHandler(fake as unknown as ExtensionAPI, config);
    const result = await runToolCall(
      fake,
      readEvent("/tmp/token=abc123/creds/key"),
      makeCtx("/repo", false),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("[redacted]");
    expect(result?.reason).not.toContain("abc123");
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

  test("ring records a block with its rule and redacted reason", async () => {
    const fake = makeFakePi();
    const ring = new DenialRing();
    const config = loadConfig({ credentialRoots: ["/tmp/token=abc123/creds"] });
    createSandboxHandler(fake as unknown as ExtensionAPI, config, ring);
    const result = await runToolCall(
      fake,
      readEvent("/tmp/token=abc123/creds/key"),
      makeCtx("/repo", false),
    );
    expect(result?.block).toBe(true);
    const entries = ring.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("block");
    expect(entries[0]?.rule).toBe("credential-read");
    expect(entries[0]?.tool).toBe("read");
    expect(entries[0]?.reason).toContain("[redacted]");
    expect(entries[0]?.reason).not.toContain("abc123");
  });

  test("policy errors fail closed with a generic block", async () => {
    const fake = makeFakePi();
    const config = defaultConfig();
    config.metadataHosts = [null as unknown as RegExp];
    createSandboxHandler(fake as unknown as ExtensionAPI, config);
    const result = await runToolCall(
      fake,
      bashEvent("curl http://169.254.169.254/latest/meta-data/"),
      makeCtx("/repo", false),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toBe("Blocked: sandbox policy error.");
  });

  test("registers the sandbox-status command", () => {
    const fake = makeFakePi();
    createSandboxHandler(fake as unknown as ExtensionAPI, defaultConfig());
    expect(fake.commands.map((command) => command.name)).toContain("sandbox-status");
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
