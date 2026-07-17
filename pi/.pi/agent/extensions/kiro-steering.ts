/**
 * Kiro Steering Extension
 *
 * Loads steering markdown files from ~/.kiro/steering/ and .kiro/steering/
 * and injects them as a one-time context message via before_agent_start,
 * matching kiro-cli's behavior where steering files are agent resources.
 *
 * Which files load is decided by steering-picker's `resolveActiveSteering`:
 *   - if you've saved a selection for this directory (via /steering), use it
 *   - otherwise default to every file whose inclusion is not manual/fileMatch
 *
 * Uses `session_start` (fires after extensions load) to register files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolveActiveSteering } from "./steering-picker.ts";

function loadActiveSteering(cwd: string): string[] {
    return resolveActiveSteering(cwd)
        .map((f) => {
            try {
                return readFileSync(f.path, "utf-8").trim();
            } catch {
                return "";
            }
        })
        .filter((content) => content.length > 0);
}

export default function (pi: ExtensionAPI) {
    let steeringContent = "";
    let injected = false;

    function reload(cwd: string) {
        // steering-picker decides which files are active for this directory
        // (saved selection, or default = all non-manual/fileMatch files).
        steeringContent = loadActiveSteering(cwd).join("\n\n");
        injected = false;
    }

    pi.on("session_start", async (_event, ctx) => {
        reload(ctx.cwd);
    });

    pi.on("before_agent_start", async () => {
        if (!steeringContent || injected) return;
        injected = true;
        return {
            message: {
                content: steeringContent,
                customType: "kiro-steering",
                display: false,
            },
        };
    });

    // Deduplicate steering messages on reload/reconnect (same pattern as aim-context)
    pi.on("context", async (event) => {
        const messages = (event as any).messages;
        if (!Array.isArray(messages)) return;

        let lastIdx = -1;
        messages.forEach((m: any, i: number) => {
            if (m.customType === "kiro-steering") lastIdx = i;
        });

        if (lastIdx < 0) return;

        // Keep only the last steering message
        const filtered = messages.filter((m: any, i: number) => {
            return m.customType !== "kiro-steering" || i === lastIdx;
        });

        if (!injected) injected = true;

        if (filtered.length !== messages.length) {
            return { messages: filtered };
        }
    });
}
