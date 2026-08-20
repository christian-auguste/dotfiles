import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type ResourceKind = "extensions" | "skills" | "agents" | "commands" | "plugins" | "settings";
type FileStamp = { path: string; mtimeMs: number; size: number };
type Snapshot = Map<ResourceKind, Map<string, FileStamp>>;

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
const EXTENSION_SUFFIXES = new Set([".ts", ".js", ".mjs", ".cjs"]);
const RESOURCE_DIRS: Array<[ResourceKind, string]> = [
  ["extensions", "extensions"],
  ["skills", "skills"],
  ["agents", "agents"],
  ["commands", "commands"],
  ["plugins", "plugins"],
];

async function collectFiles(root: string, kind: ResourceKind): Promise<Map<string, FileStamp>> {
  const files = new Map<string, FileStamp>();
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (kind === "extensions" && !EXTENSION_SUFFIXES.has(path.extname(entry.name))) continue;
      try {
        const metadata = await stat(target);
        files.set(target, { path: target, mtimeMs: metadata.mtimeMs, size: metadata.size });
      } catch {
        // Files can disappear while a reload snapshot is being collected.
      }
    }
  }
  await visit(root);
  return files;
}

async function snapshot(cwd: string): Promise<Snapshot> {
  const result: Snapshot = new Map();
  for (const [kind, directory] of RESOURCE_DIRS) {
    const files = new Map<string, FileStamp>();
    for (const root of [path.join(AGENT_DIR, directory), path.join(cwd, ".omp", directory)]) {
      for (const [file, stamp] of await collectFiles(root, kind)) files.set(file, stamp);
    }
    result.set(kind, files);
  }
  const settings = new Map<string, FileStamp>();
  for (const file of [
    path.join(AGENT_DIR, "config.yml"),
    path.join(AGENT_DIR, "keybindings.yaml"),
    path.join(cwd, ".omp", "config.yml"),
    path.join(cwd, ".omp", "settings.json"),
  ]) {
    try {
      const metadata = await stat(file);
      settings.set(file, { path: file, mtimeMs: metadata.mtimeMs, size: metadata.size });
    } catch {
      // These files are optional.
    }
  }
  result.set("settings", settings);
  return result;
}

function changedKinds(before: Snapshot, after: Snapshot): ResourceKind[] {
  const changed: ResourceKind[] = [];
  for (const [kind, previous] of before) {
    const current = after.get(kind) ?? new Map<string, FileStamp>();
    const paths = new Set([...previous.keys(), ...current.keys()]);
    for (const file of paths) {
      const oldStamp = previous.get(file);
      const newStamp = current.get(file);
      if (!oldStamp || !newStamp || oldStamp.mtimeMs !== newStamp.mtimeMs || oldStamp.size !== newStamp.size) {
        changed.push(kind);
        break;
      }
    }
  }
  return changed;
}

function refreshAction(kind: ResourceKind): string {
  if (kind === "plugins" || kind === "skills" || kind === "agents" || kind === "commands") return "run /reload-plugins";
  return "restart omp";
}

export default function registerReload(pi: ExtensionAPI): void {
  let loaded: Snapshot | null = null;

  pi.on("session_start", async (_event, ctx) => {
    loaded = await snapshot(ctx.cwd);
  });
  pi.on("session_switch", async (_event, ctx) => {
    loaded = await snapshot(ctx.cwd);
  });

  pi.registerCommand("reload", {
    description: "Check changed resources and report the required refresh action",
    handler: async (_args, ctx: ExtensionContext) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("/reload refused while omp is busy. Wait for the current turn or compaction to finish.", "warning");
        return;
      }
      const current = await snapshot(ctx.cwd);
      if (!loaded) loaded = current;
      const changed = changedKinds(loaded, current);
      loaded = current;
      const lines = ["/reload checked the current resource state."];
      if (changed.length === 0) {
        lines.push("No resource files changed since this session started.");
      } else {
        for (const kind of changed) lines.push(`${kind}: changed — ${refreshAction(kind)}.`);
      }
      lines.push("Extension code, settings, keybindings, and environment changes require a restart; /reload cannot hot-swap running modules.");
      ctx.ui.notify(lines.join("\n"), changed.includes("extensions") || changed.includes("settings") ? "warning" : "info");
    },
  });
}
