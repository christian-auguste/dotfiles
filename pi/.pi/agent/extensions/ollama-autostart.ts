/**
 * ollama-autostart — ensure the local Ollama server is running on session start
 *
 * pi-knowledge-search / pi-session-search embed notes and sessions via a local
 * Ollama server. If Ollama isn't running, embedding calls fail (and, before the
 * flood fix, spammed the TUI). This extension health-checks Ollama when a
 * session starts and, if it's down, launches `ollama serve` as a detached
 * background process so it survives beyond this pi session — no manual restart,
 * no system-wide brew service required.
 *
 * The Ollama URL is read from ~/.pi/knowledge-search.json (same source of truth
 * the indexer uses), falling back to http://localhost:11434.
 *
 * Idempotent: if Ollama is already up, it does nothing and stays silent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "http://localhost:11434";
const CONFIG_PATH = join(homedir(), ".pi", "knowledge-search.json");
const HEALTH_TIMEOUT_MS = 1500;
// After spawning, poll for readiness this many times (server takes ~1-2s to bind).
const READY_ATTEMPTS = 15;
const READY_INTERVAL_MS = 500;

function ollamaUrl(): string {
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      const url = cfg?.provider?.url;
      if (typeof url === "string" && url.trim()) return url.replace(/\/$/, "");
    }
  } catch {
    // fall through to default on any parse/read error
  }
  return DEFAULT_URL;
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Only bother when Ollama would actually be talked to locally.
    const url = ollamaUrl();

    // Remote endpoints aren't ours to start.
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url)) return;

    if (await isUp(url)) return; // already running — stay silent

    // Launch detached so the server outlives this pi session. stdio to a log
    // file (not inherited) so its output never lands on pi's TUI.
    const logPath = join(homedir(), ".pi", "ollama-autostart.log");
    let out: number;
    try {
      out = openSync(logPath, "a");
    } catch {
      out = openSync("/dev/null", "a");
    }

    try {
      const child = spawn("ollama", ["serve"], {
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.on("error", () => {
        // ollama not on PATH, etc. — reported below after the readiness check.
      });
      child.unref();
    } catch {
      ctx.ui.notify(
        "ollama-autostart: failed to launch `ollama serve` (is ollama installed?)",
        "error",
      );
      return;
    }

    // Wait for it to bind before declaring success.
    for (let i = 0; i < READY_ATTEMPTS; i++) {
      await sleep(READY_INTERVAL_MS);
      if (await isUp(url)) {
        ctx.ui.notify(`ollama-autostart: started Ollama (${url})`, "info");
        return;
      }
    }

    ctx.ui.notify(
      `ollama-autostart: launched Ollama but it didn't become ready at ${url} — check ~/.pi/ollama-autostart.log`,
      "warning",
    );
  });
}
