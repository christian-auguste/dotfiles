import type { ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { eventId } from "./session-state";

type Message = { role: string; content: unknown } & Record<string, unknown>;
export type MdLogEvent =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "skill"; name: string; text: string }
  | { id: string; kind: "assistant"; text: string; sources: boolean }
  | { id: string; kind: "question"; question: string; options: string[] }
  | { id: string; kind: "answer"; text: string; verdict?: "success" | "warning" | "abstract" }
  | { id: string; kind: "artifact"; name: string; embedPath: string; content: string };

const ASK = new Set(["ask", "ask_user_question", "quiz"]);
export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("");
}
export function injected(message: Message): boolean { return message.synthetic === true || message.attribution === "agent"; }

export function normalizeMessage(source: string, message: Message): MdLogEvent[] {
  if (message.role === "user") {
    if (injected(message)) return [];
    const text = textOf(message).trim();
    if (!text || (text.startsWith("/") && !text.startsWith("/skill:"))) return [];
    if (text.startsWith("/skill:")) return [{ id: eventId("skill", source, 0), kind: "skill", name: text.slice(7).trim(), text }];
    return [{ id: eventId("user", source, 0), kind: "user", text }];
  }
  if (message.role === "assistant") {
    const text = textOf(message).trim();
    const result: MdLogEvent[] = text ? [{ id: eventId("assistant", source, 0), kind: "assistant", text, sources: /https?:\/\/|^#{1,6}\s+sources\s*$/im.test(text) }] : [];
    const parts = Array.isArray(message.content) ? message.content.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null) : [];
    for (const part of parts) {
      if (part.type !== "toolCall") continue;
      const name = typeof part.name === "string" ? part.name : undefined;
      const args = typeof part.arguments === "object" && part.arguments !== null ? part.arguments as Record<string, unknown> : {};
      const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : source;
      if (name && ASK.has(name)) result.push(...questions(name, args, toolCallId));
    }
    return result;
  }
  if (message.role === "toolResult") return answers(message as unknown as ToolResultEvent, typeof message.toolCallId === "string" ? message.toolCallId : source);
  return [];
}

function questions(name: string, args: Record<string, unknown>, source: string): MdLogEvent[] {
  if (name === "ask") return ((args.questions ?? []) as Array<{ question?: string; options?: Array<string | { label?: string }> }>).flatMap((q, index) => q.question ? [{ id: eventId("question", source, index), kind: "question", question: q.question, options: (q.options ?? []).map((x) => typeof x === "string" ? x : x.label ?? "").filter(Boolean) }] : []);
  const question = name === "quiz" ? args.prompt : args.question;
  if (typeof question !== "string") return [];
  const options = (args.options as Array<string | { label?: string }> | undefined)?.map((x) => typeof x === "string" ? x : x.label ?? "").filter(Boolean) ?? [];
  return [{ id: eventId("question", source, 0), kind: "question", question, options }];
}

export function normalizeToolCall(event: ToolCallEvent): MdLogEvent[] {
  if (!ASK.has(event.toolName)) return [];
  return questions(event.toolName, event.input as unknown as Record<string, unknown>, event.toolCallId);
}

function answers(event: ToolResultEvent, source: string): MdLogEvent[] {
  if (!ASK.has(event.toolName)) return [];
  const details = event.details as Record<string, unknown> | undefined;
  if (!details) return [];
  if (event.toolName === "quiz") {
    const answer = details.unknown ? "I don't know" : String(details.selectedOption ?? "(no answer)");
    return [{ id: eventId("answer", source, 0), kind: "answer", text: `${answer}\n${String(details.explanation ?? "")}`.trim(), verdict: details.correct ? "success" : details.unknown ? "abstract" : "warning" }];
  }
  if (event.toolName === "ask_user_question") {
    if (details.status === "cancelled") return [{ id: eventId("answer", source, 0), kind: "answer", text: "User cancelled the question" }];
    if (details.status !== "answered") return [];
    const values = Array.isArray(details.answers) ? details.answers.join(", ") : "";
    return [{ id: eventId("answer", source, 0), kind: "answer", text: details.custom ? `User provided custom input: ${values}` : `Selected: ${values}` }];
  }
  const results = Array.isArray(details.results) ? details.results as Array<Record<string, unknown>> : [];
  if (results.length) {
    const text = results.length === 1 ? (results[0].customInput ? `User provided custom input: ${results[0].customInput}` : `Selected: ${((results[0].selectedOptions as string[]) ?? []).join(", ")}`) : `Selected: ${results.map((r) => `${r.id}: ${((r.selectedOptions as string[]) ?? []).join(", ")}`).join("; ")}`;
    return [{ id: eventId("answer", source, 0), kind: "answer", text }];
  }
  if (details.customInput) return [{ id: eventId("answer", source, 0), kind: "answer", text: `User provided custom input: ${details.customInput}` }];
  if (Array.isArray(details.selectedOptions)) return [{ id: eventId("answer", source, 0), kind: "answer", text: `Selected: ${details.selectedOptions.join(", ")}` }];
  return [];
}

export function normalizeToolResult(event: ToolResultEvent): MdLogEvent[] { return answers(event, event.toolCallId); }
