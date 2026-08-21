import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { inspectToolCall } from "../lib/destructive-guard";

function readString(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object" || !(key in input)) return null;
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

function preview(toolName: string, input: unknown): string {
  const command = toolName === "bash" ? readString(input, "command") : null;
  if (command !== null) return `Command:\n${command}`;

  const code = toolName === "eval" ? readString(input, "code") : null;
  if (code !== null) return `Eval code:\n${code.length > 1200 ? `${code.slice(0, 1200)}\n…` : code}`;
  return `Tool: ${toolName}`;
}

export default function registerDestructiveGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const decision = inspectToolCall(event.toolName, event.input, ctx.cwd);
    if (!decision) return;
    if (decision.action === "block") return { block: true, reason: decision.reason };
    if (!ctx.hasUI) return { block: true, reason: `${decision.reason} No interactive approval is available.` };

    const approved = await ctx.ui.confirm("Approve risky operation?", `${decision.reason}\n\n${preview(event.toolName, event.input)}`);
    if (!approved) return { block: true, reason: "Blocked: exact approval was not granted." };
  });
}
