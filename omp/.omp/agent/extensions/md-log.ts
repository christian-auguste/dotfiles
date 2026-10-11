import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { normalizeCustomMessage, normalizeMessage, normalizeToolCall, normalizeToolExecutionUpdate, normalizeToolResult, type MdLogEvent } from "../lib/event-model";
import { ensureMarkdownFile, fileExists, findFrontMatterTarget, MARKER_KEY, readMarker, readText, reconcileLogBlocks, upsertFrontMatter, writeArtifact, type ReconcileLogResult } from "../lib/log-file";
import { readConfig, writeConfig } from "../lib/md-log-config";
import { renderCallout } from "../lib/log-renderer";
import { canonicalize, discoverVaultRoot, resolveBoundPath } from "../lib/path-guard";
import { emptyState, MD_LOG_STATE_TYPE, pushSeen, reconstructState, SEEN_IDS_CAP, serializeState, type MdLogState } from "../lib/session-state";

type Entry = { type: string; id: string; message?: unknown; customType?: string; attribution?: string; details?: unknown; data?: unknown };

export default function registerMdLog(pi: ExtensionAPI): void {
  let state: MdLogState | null = null;
  let vaultRoot: string | null = null;
  let appendErrorNotified = false;
  let queue: Promise<void> = Promise.resolve();
  let bindingGeneration = 0;
  const permissionMessage = (target: string) =>
    `md-log: permission denied accessing ${target}; grant the terminal Files & Folders access in System Settings > Privacy & Security`;
  const isPermissionError = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  };
  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const branch = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as unknown as Entry[];
  const persist = () => { if (state) pi.appendEntry(MD_LOG_STATE_TYPE, serializeState(state)); };
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work).catch((error) => pi.logger.error(`[md-log] ${String(error)}`));
    return queue;
  };

  async function restore(ctx: ExtensionContext): Promise<void> {
    state = reconstructState(branch(ctx)) ?? emptyState(sessionId(ctx));
    state.sessionId = sessionId(ctx);
    const discovery = discoverVaultRoot(ctx.cwd);
    // cwd discovery wins; then the session's own root (bound when the vault
    // was resolved from the note path); then the user-configured default.
    vaultRoot = discovery.ok ? discovery.root : state.vaultRoot ?? (await readConfig()).vaultRoot ?? null;
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

  async function append(ctx: ExtensionContext, event: MdLogEvent, generation = bindingGeneration): Promise<void> {
    const boundPath = state?.boundPath;
    if (!boundPath || generation !== bindingGeneration) return;
    // Real containment check: the old assertExactBoundPath(boundPath, boundPath)
    // compared a path with itself and never failed. Reuse the bind-time bouncer.
    if (vaultRoot && resolveBoundPath(vaultRoot, boundPath).error) return;
    try {
      if (event.kind === "artifact") {
        if (!vaultRoot) return;
        const embedPath = await writeArtifact(vaultRoot, sessionId(ctx), event.name, event.content);
        if (!embedPath) return;
        event = { ...event, embedPath };
      }
      const wasSeen = state?.seenIds.includes(event.id) ?? false;
      const result = await reconcileLogBlocks(boundPath, [{ id: event.id, content: renderCallout(event) }], new Set([event.id]));
      if (!result.presentIds.includes(event.id)) return;
      if (generation !== bindingGeneration || state?.boundPath !== boundPath) return;
      state.seenIds = pushSeen(state.seenIds, event.id);
      if (!wasSeen) {
        appendErrorNotified = false;
        state.cursor++;
        persist();
      }
    } catch (error) {
      if (generation !== bindingGeneration || state?.boundPath !== boundPath) return;
      if (!isPermissionError(error)) throw error;
      if (!appendErrorNotified) {
        appendErrorNotified = true;
        ctx.ui.notify(permissionMessage(boundPath), "error");
      }
      return; // entry stays unseen; next backfill retries once access is granted
    }
    if (generation !== bindingGeneration || state?.boundPath !== boundPath) return;
    appendErrorNotified = false;
  }

  const schedule = (ctx: ExtensionContext, event: MdLogEvent): Promise<void> => {
    const generation = bindingGeneration;
    return enqueue(() => append(ctx, event, generation));
  };

  async function backfill(ctx: ExtensionContext): Promise<number> {
    const currentState = state;
    if (!currentState?.boundPath) return 0;
    const boundPath = currentState.boundPath;
    if (vaultRoot && resolveBoundPath(vaultRoot, boundPath).error) return 0;
    const generation = bindingGeneration;
    const existing = await readText(boundPath);
    const branchHistory = branch(ctx);
    let resetBoundary = -1;
    for (let index = 0; index < branchHistory.length; index++) {
      if (branchHistory[index]!.type === "reset_boundary") resetBoundary = index;
    }
    const history = branchHistory.slice(resetBoundary + 1);
    // /clear keeps durable history; only the suffix after its last boundary is live.
    const skipHistory = resetBoundary < 0 && currentState.cursor === 0 && existing?.includes("> [!");
    const allEvents: MdLogEvent[] = [];
    for (const entry of history) {
      if (entry.type === "message" && entry.message) {
        allEvents.push(...normalizeMessage("entry:" + entry.id, entry.message as never));
      } else if (entry.type === "custom_message") {
        allEvents.push(...normalizeCustomMessage("entry:" + entry.id, entry as never));
      }
    }
    const latestSkillPrompt = history
      .filter((entry) => entry.type === "custom_message" && entry.customType === "skill-prompt" && entry.attribution === "user")
      .at(-1);
    const skillEventIds = new Set(
      latestSkillPrompt
        ? normalizeCustomMessage("entry:" + latestSkillPrompt.id, latestSkillPrompt as never).map((event) => event.id)
        : [],
    );
    const eligibleIds = new Set(allEvents
      .filter((event) => !skipHistory || skillEventIds.has(event.id))
      .map((event) => event.id));
    let result: ReconcileLogResult;
    try {
      result = await reconcileLogBlocks(
        boundPath,
        allEvents.map((event) => ({ id: event.id, content: renderCallout(event) })),
        eligibleIds,
      );
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      if (!appendErrorNotified) {
        appendErrorNotified = true;
        ctx.ui.notify(permissionMessage(boundPath), "error");
      }
      return 0;
    }
    if (generation !== bindingGeneration || state !== currentState) return 0;
    appendErrorNotified = false;
    const seen = new Set(currentState.seenIds);
    for (const id of result.presentIds) seen.add(id);
    for (const id of result.addedIds) {
      if (!currentState.seenIds.includes(id)) currentState.cursor++;
    }
    currentState.seenIds = [...seen].slice(-SEEN_IDS_CAP);
    persist();
    return result.addedIds.length;
  }

  async function showStatus(ctx: ExtensionContext): Promise<void> {
    await restore(ctx);
    const config = await readConfig();
    ctx.ui.notify(
      [
        state?.boundPath ? `bound: ${state.boundPath}` : "bound: none",
        `events: ${state?.cursor ?? 0}`,
        `vault: ${vaultRoot ?? "unknown"}`,
        `configured vault: ${config.vaultRoot ?? "none"}`,
      ].join("\n"),
      "info",
    );
  }

  async function showVaultConfig(ctx: ExtensionContext): Promise<void> {
    const config = await readConfig();
    if (!config.vaultRoot) { ctx.ui.notify("md-log: no default vault configured. Run: /md-log vault set \"/abs/path\".", "info"); return; }
    const discovery = discoverVaultRoot(config.vaultRoot);
    if (discovery.ok) ctx.ui.notify(`md-log: default vault ${discovery.root}`, "info");
    else if (discovery.error === "denied") ctx.ui.notify(permissionMessage(discovery.at), "error");
    else ctx.ui.notify(`md-log: configured vault ${config.vaultRoot} no longer exists; run /md-log vault set <path>.`, "warning");
  }

  async function setVaultConfig(target: string, ctx: ExtensionContext): Promise<void> {
    let requested = target.trim();
    if ((requested.startsWith('"') && requested.endsWith('"')) || (requested.startsWith("'") && requested.endsWith("'"))) requested = requested.slice(1, -1);
    if (!requested || requested.startsWith("~") || !path.isAbsolute(requested)) { ctx.ui.notify("md-log vault set requires an absolute path.", "error"); return; }
    const discovery = discoverVaultRoot(requested);
    if (!discovery.ok) {
      if (discovery.error === "denied") ctx.ui.notify(permissionMessage(discovery.at), "error");
      else ctx.ui.notify(`md-log: ${requested} is not inside an Obsidian vault.`, "error");
      return;
    }
    try {
      await writeConfig({ version: 1, vaultRoot: discovery.root });
    } catch (error) {
      ctx.ui.notify(`md-log: could not save config: ${String(error)}`, "error");
      return;
    }
    ctx.ui.notify(`md-log: default vault set to ${discovery.root}`, "info");
  }

  pi.on("session_start", async (_event, ctx) => { await restore(ctx); await backfill(ctx); });
  pi.on("session_switch", async (event, ctx) => {
    await restore(ctx);
    if (event.reason !== "new") await backfill(ctx);
  });
  pi.on("session_branch", async (_event, ctx) => { await restore(ctx); await backfill(ctx); });
  pi.on("agent_start", async (_event, ctx) => {
    const entry = branch(ctx).at(-1);
    if (entry?.type !== "custom_message") return;
    for (const item of normalizeCustomMessage("entry:" + entry.id, entry as never)) await schedule(ctx, item);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role === "user" || message.role === "assistant") {
      const id = branch(ctx).filter((entry) => entry.type === "message").at(-1)?.id ?? "live:" + Date.now();
      for (const item of normalizeMessage(id, message as never)) schedule(ctx, item);
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    for (const item of normalizeToolCall(event)) await schedule(ctx, item);
  });
  pi.on("tool_execution_update", async (event, ctx) => {
    for (const item of normalizeToolExecutionUpdate(event)) await schedule(ctx, item);
  });
  pi.on("tool_result", async (event, ctx) => {
    for (const item of normalizeToolResult(event)) await schedule(ctx, item);
  });
  pi.on("session_shutdown", async () => { await queue; });

  pi.registerCommand("md-log", {
    description: "Bind to an Obsidian note; configure the vault (vault set/clear, status)",
    getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
      const trimmed = argumentPrefix.trim();
      const tokens = trimmed ? trimmed.split(/\s+/) : [];
      const afterVault = tokens[0] === "vault" && (tokens.length === 2 || (tokens.length === 1 && argumentPrefix.endsWith(" ")));
      if (afterVault) {
        const subs = [
          { label: "set", value: "set ", description: "Set the default vault to an absolute path" },
          { label: "clear", value: "clear", description: "Remove the configured default vault" },
        ];
        const filtered = subs.filter((item) => item.label.startsWith(tokens[1] ?? ""));
        return filtered.length ? filtered : null;
      }
      if (tokens.length <= 1) {
        const top = [
          { label: "vault", value: "vault", description: "Show or change the default Obsidian vault" },
          { label: "status", value: "status", description: "Show the binding, event count, and vault config" },
        ];
        const filtered = top.filter((item) => item.label.startsWith(trimmed));
        return filtered.length ? filtered : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const sub = input ? input.split(/\s+/)[0] : "";
      if (!input || sub === "status") { await showStatus(ctx); return; }
      if (sub === "vault") {
        const rest = input.slice(sub.length).trim();
        const verb = rest.split(/\s+/)[0] ?? "";
        if (!verb) { await showVaultConfig(ctx); return; }
        if (verb === "clear") {
          try { await writeConfig({ version: 1 }); } catch (error) { ctx.ui.notify(`md-log: could not save config: ${String(error)}`, "error"); return; }
          ctx.ui.notify("md-log: default vault cleared.", "info");
          return;
        }
        if (verb === "set") { await setVaultConfig(rest.slice(verb.length).trim(), ctx); return; }
        ctx.ui.notify(`md-log: unknown vault command "${verb}". Try: vault set <path> | vault clear.`, "error");
        return;
      }
      let requested = input;
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
      bindingGeneration++;
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
