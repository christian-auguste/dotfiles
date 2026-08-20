export const MD_LOG_STATE_TYPE = "mdlog.state";
export const SEEN_IDS_CAP = 1000;

export interface MdLogState {
  version: 1;
  boundPath: string | null;
  cursor: number;
  seenIds: string[];
  sessionId: string;
  logId?: string;
}

export function emptyState(sessionId: string): MdLogState {
  return { version: 1, boundPath: null, cursor: 0, seenIds: [], sessionId };
}

export function serializeState(state: MdLogState): string { return JSON.stringify(state); }

export function parseState(raw: unknown): MdLogState | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 || typeof value.sessionId !== "string") return null;
    return {
      version: 1,
      boundPath: typeof value.boundPath === "string" ? value.boundPath : null,
      cursor: typeof value.cursor === "number" ? value.cursor : 0,
      seenIds: Array.isArray(value.seenIds) ? value.seenIds.filter((x): x is string => typeof x === "string") : [],
      sessionId: value.sessionId,
      logId: typeof value.logId === "string" ? value.logId : undefined,
    };
  } catch { return null; }
}

export function reconstructState(branch: readonly { type: string; customType?: string; data?: unknown }[]): MdLogState | null {
  let latest: MdLogState | null = null;
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === MD_LOG_STATE_TYPE) {
      const state = parseState(entry.data);
      if (state) latest = state;
    }
  }
  return latest;
}

export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function eventId(kind: string, source: string, ordinal: number): string {
  return fnv1a(`${kind}:${source}:${ordinal}`);
}

export function pushSeen(seen: string[], id: string): string[] {
  const next = [...seen.filter((item) => item !== id), id];
  return next.slice(-SEEN_IDS_CAP);
}
