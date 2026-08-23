import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { normalizeMessage, normalizeToolCall, normalizeToolResult, type MdLogEvent } from "../lib/event-model";
import { appendLogBlock, ensureMarkdownFile, fileExists, findFrontMatterTarget, MARKER_KEY, readMarker, readText, upsertFrontMatter, writeArtifact } from "../lib/log-file";
import { renderCallout } from "../lib/log-renderer";
import { canonicalize, discoverVaultRoot, resolveBoundPath } from "../lib/path-guard";
import { emptyState, MD_LOG_STATE_TYPE, pushSeen, reconstructState, serializeState, type MdLogState } from "../lib/session-state";

type Entry = { type: string; id: string; message?: unknown; customType?: string; data?: unknown };

export default function registerMdLog(pi: ExtensionAPI): void {
  let state: MdLogState | null = null;
  let vaultRoot: string | null = null;
  let appendErrorNotified = false;
  let queue: Promise<void> = Promise.resolve();
  const permissionMessage = (target: string) =>
    `md-log: permission denied accessing ${target}; grant the terminal Files & Folders access in System Settings > Privacy & Security`;
  const isPermissionError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  };
  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const branch = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as unknown as Entry[];
  const persist = () => { if (state) pi.appendEntry(MD_LOG_STATE_TYPE, serializeState(state)); };
  const enqueue = (work: () => Promise<void>) => { queue = queue.then(work).catch((error) => pi.logger.error(`[md-log] ${String(error)}`)); };

  async function restore(ctx: ExtensionContext): Promise<void> {
    state = reconstructState(branch(ctx)) ?? emptyState(sessionId(ctx));
    state.sessionId = sessionId(ctx);
    const discovery = discoverVaultRoot(ctx.cwd);
    vaultRoot = discovery.ok ? discovery.root : state.vaultRoot ?? null;
    if (!state.boundPath) return;
    const marker = await readMarker(state.boundPath);
    if (state.logId && marker !== state.logId) {
      const matches = vaultRoot ? await findFrontMatterTarget(vaultRoot, state.logId) : [];
      if (matches.length === 1) {
        state.boundPath = canonicalize(matches[0]);
        ctx.ui.notify(`md-log: followed moved note to ${state.boundPath}`, "info");
        persist();
      } else if (matches.length === 0) {
        ctx.ui.notify("md-log: bound note was not found; binding cleared.", "warning");
        state.boundPath = null;
        persist();
      } else ctx.ui.notify("md-log: duplicate marker found; keeping the current binding.", "warning");
    } else if (!state.logId && marker === null && await fileExists(state.boundPath)) {
      state.logId = randomUUID();
      await upsertFrontMatter(state.boundPath, { [MARKER_KEY]: state.logId });
      persist();
    }
  }

  async function append(ctx: ExtensionContext, event: MdLogEvent): Promise<void> {
    if (!state?.boundPath || state.seenIds.includes(event.id)) return;
    // Real containment check: the old assertExactBoundPath(boundPath, boundPath)
    // compared a path with itself and never failed. Reuse the bind-time bouncer.
    if (vaultRoot && resolveBoundPath(vaultRoot, state.boundPath).error) return;
    try {
      if (event.kind === "artifact") {
        if (!vaultRoot) return;
        const embedPath = await writeArtifact(vaultRoot, sessionId(ctx), event.name, event.content);
        if (!embedPath) return;
        event = { ...event, embedPath };
      }
      await appendLogBlock(state.boundPath, renderCallout(event));
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      if (!appendErrorNotified) {
        appendErrorNotified = true;
        ctx.ui.notify(permissionMessage(state.boundPath), "error");
      }
      return; // entry stays unseen; next backfill retries once access is granted
    }
    appendErrorNotified = false;
    state.seenIds = pushSeen(state.seenIds, event.id);
    state.cursor++;
    persist();
  }

  async function backfill(ctx: ExtensionContext): Promise<number> {
    if (!state?.boundPath) return 0;
    const existing = await readText(state.boundPath);
    if (state.cursor === 0 && existing?.includes("> [!")) return 0;
    let count = 0;
    for (const entry of branch(ctx)) {
      if (entry.type !== "message" || !entry.message) continue;
      for (const event of normalizeMessage("entry:" + entry.id, entry.message as never)) {
        if (!state.seenIds.includes(event.id)) { await append(ctx, event); count++; }
      }
    }
    return count;
  }

  pi.on("session_start", async (_event, ctx) => { await restore(ctx); await backfill(ctx); });
  pi.on("session_switch", async (_event, ctx) => { await restore(ctx); await backfill(ctx); });
  pi.on("session_branch", async (_event, ctx) => { await restore(ctx); await backfill(ctx); });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role === "user" || message.role === "assistant") {
      const id = branch(ctx).filter((entry) => entry.type === "message").at(-1)?.id ?? "live:" + Date.now();
      for (const item of normalizeMessage(id, message as never)) enqueue(() => append(ctx, item));
    }
  });
  pi.on("tool_call", async (event, ctx) => { for (const item of normalizeToolCall(event)) enqueue(() => append(ctx, item)); });
  pi.on("tool_result", async (event, ctx) => { for (const item of normalizeToolResult(event)) enqueue(() => append(ctx, item)); });
  pi.on("session_shutdown", async () => { await queue; });

  pi.registerCommand("md-log", {
    description: "Bind this session to an Obsidian Markdown note",
    handler: async (args, ctx) => {
      let requested = args.trim();
      if ((requested.startsWith('"') && requested.endsWith('"')) || (requested.startsWith("'") && requested.endsWith("'"))) requested = requested.slice(1, -1);
      if (!requested || requested.startsWith("~") || !path.isAbsolute(requested)) { ctx.ui.notify("md-log requires an absolute path.", "error"); return; }
      // The absolute note path names the vault, so binding works from any cwd
      // (e.g. a session in ~/.omp/agent for LSP work).
      const discovery = discoverVaultRoot(path.dirname(requested));
      if (!discovery.ok) {
        if (discovery.error === "denied") ctx.ui.notify(permissionMessage(discovery.at), "error");
        else ctx.ui.notify("md-log could not find an Obsidian vault.", "error");
        return;
      }
      vaultRoot = discovery.root;
      const resolved = resolveBoundPath(vaultRoot, requested);
      if (resolved.error) { ctx.ui.notify(resolved.error, "error"); return; }
      let marker: string;
      let same: boolean;
      try {
        await ensureMarkdownFile(resolved.path);
        marker = (await readMarker(resolved.path)) ?? randomUUID();
        same = state?.boundPath ? canonicalize(state.boundPath) === canonicalize(resolved.path) : false;
        await upsertFrontMatter(resolved.path, { Date: new Date().toISOString().slice(0, 10), Time: new Date().toTimeString().slice(0, 5), [MARKER_KEY]: marker });
      } catch (error) {
        if (!isPermissionError(error)) throw error;
        ctx.ui.notify(permissionMessage(resolved.path), "error");
        return;
      }
      appendErrorNotified = false;
      state = { version: 1, boundPath: resolved.path, cursor: same ? state?.cursor ?? 0 : 0, seenIds: same ? state?.seenIds ?? [] : [], sessionId: sessionId(ctx), logId: marker, vaultRoot };
      persist();
      const count = await backfill(ctx);
      ctx.ui.notify(`md-log: bound to ${resolved.path} (${count} events backfilled)`, "info");
    },
  });

  pi.registerTool({
    name: "md_log_status",
    label: "md-log status",
    description: "Report the current md-log binding and recorded event count.",
    parameters: pi.zod.object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      await restore(ctx);
      if (!state?.boundPath) return { content: [{ type: "text", text: "md-log: not bound" }], details: { bound: false, vaultRoot } };
      return { content: [{ type: "text", text: `md-log: ${state.boundPath}\nevents: ${state.cursor}\nvault: ${vaultRoot ?? "unknown"}` }], details: { bound: true, ...state, vaultRoot } };
    },
  });
}
