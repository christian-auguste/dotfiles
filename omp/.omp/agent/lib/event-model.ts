import type { ToolCallEvent, ToolExecutionUpdateEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { eventId } from "./session-state";

type Message = { role: string; content: unknown } & Record<string, unknown>;
type RecordValue = Record<string, unknown>;
type Option = string | { label?: string; value?: string };

export type MdLogEvent =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "skill"; name: string; text: string }
  | { id: string; kind: "assistant"; text: string; sources: boolean }
  | { id: string; kind: "question"; question: string; options: string[] }
  | { id: string; kind: "answer"; text: string; verdict?: "success" | "warning" | "abstract" }
  | { id: string; kind: "artifact"; name: string; embedPath: string; content: string };

const ASK: Record<string, true> = { ask: true, ask_user_question: true, quiz: true };
const QUIZ_BRIDGE_PATH = "xd://quiz";

function quizBridgeInput(input: unknown): RecordValue | null {
  if (typeof input !== "object" || input === null || !("path" in input) || input.path !== QUIZ_BRIDGE_PATH) return null;
  if (!("content" in input) || typeof input.content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(input.content);
    return typeof parsed === "object" && parsed !== null ? parsed as RecordValue : null;
  } catch {
    return null;
  }
}

export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function injected(message: Message): boolean {
  return message.synthetic === true || message.attribution === "agent";
}

export function normalizeMessage(source: string, message: Message): MdLogEvent[] {
  if (message.role === "user") {
    if (injected(message)) return [];
    const text = textOf(message).trim();
    if (!text || (text.startsWith("/") && !text.startsWith("/skill:"))) return [];
    if (text.startsWith("/skill:")) {
      return [{ id: eventId("skill", source, 0), kind: "skill", name: text.slice(7).trim(), text }];
    }
    return [{ id: eventId("user", source, 0), kind: "user", text }];
  }
  if (message.role === "assistant") {
    const text = textOf(message).trim();
    const result: MdLogEvent[] = text
      ? [{ id: eventId("assistant", source, 0), kind: "assistant", text, sources: /https?:\/\/|^#{1,6}\s+sources\s*$/im.test(text) }]
      : [];
    const parts = Array.isArray(message.content)
      ? message.content.filter((part): part is RecordValue => typeof part === "object" && part !== null)
      : [];
    for (const part of parts) {
      if (part.type !== "toolCall") continue;
      const name = typeof part.name === "string" ? part.name : undefined;
      const args = typeof part.arguments === "object" && part.arguments !== null ? part.arguments as RecordValue : {};
      const toolCallId = typeof part.toolCallId === "string"
        ? part.toolCallId
        : typeof part.id === "string"
          ? part.id
          : source;
      const bridgeQuiz = name === "write" ? quizBridgeInput(args) : null;
      if (bridgeQuiz) result.push(...questions("quiz", bridgeQuiz, toolCallId));
      else if (name && ASK[name] && name !== "quiz") result.push(...questions(name, args, toolCallId));
    }
    return result;
  }
  if (message.role === "toolResult") {
    return normalizeToolResult(message as unknown as ToolResultEvent);
  }
  return [];
}

function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((option: Option) => typeof option === "string" ? option : option.label ?? "")
    .filter(Boolean);
}

function questions(name: string, args: RecordValue, source: string): MdLogEvent[] {
  if (name === "ask") {
    return ((args.questions ?? []) as Array<{ question?: string; options?: Option[] }>).flatMap((q, index) =>
      q.question
        ? [{ id: eventId("question", source, index), kind: "question", question: q.question, options: optionLabels(q.options) }]
        : [],
    );
  }
  const question = name === "quiz" ? args.question ?? args.prompt : args.question;
  if (typeof question !== "string") return [];
  return [{ id: eventId("question", source, 0), kind: "question", question, options: optionLabels(args.options) }];
}

function quizQuestion(event: { toolCallId: string; args: unknown; partialResult?: unknown; result?: unknown }): MdLogEvent[] {
  const args = typeof event.args === "object" && event.args !== null ? event.args as RecordValue : {};
  const partial = typeof event.partialResult === "object" && event.partialResult !== null ? event.partialResult as RecordValue : {};
  const result = typeof event.result === "object" && event.result !== null ? event.result as RecordValue : {};
  const details = (partial.details ?? result.details) as RecordValue | undefined;
  const question = typeof args.question === "string" ? args.question : typeof args.prompt === "string" ? args.prompt : typeof details?.question === "string" ? details.question : undefined;
  if (!question || !details?.options) return [];
  return [{
    id: eventId("question", event.toolCallId, 0),
    kind: "question",
    question,
    options: optionLabels(details.options),
  }];
}

export function normalizeToolCall(event: ToolCallEvent): MdLogEvent[] {
  const bridgeQuiz = event.toolName === "write" ? quizBridgeInput(event.input) : null;
  if (bridgeQuiz) return questions("quiz", bridgeQuiz, event.toolCallId);
  if (!ASK[event.toolName] || event.toolName === "quiz") return [];
  return questions(event.toolName, event.input as unknown as RecordValue, event.toolCallId);
}

export function normalizeToolExecutionUpdate(event: ToolExecutionUpdateEvent): MdLogEvent[] {
  if (event.toolName !== "quiz") return [];
  return quizQuestion(event);
}

function answerLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((answer: unknown) => {
      if (typeof answer === "string") return answer;
      if (typeof answer === "object" && answer !== null && "label" in answer && typeof answer.label === "string") return answer.label;
      return "";
    })
    .filter(Boolean);
}

function numberedAnswers(options: unknown, indices: unknown): string[] {
  if (!Array.isArray(indices)) return [];
  const labels = Array.isArray(options)
    ? options.map((option: unknown) => typeof option === "object" && option !== null && "label" in option && typeof option.label === "string" ? option.label : "")
    : [];
  return indices
    .map((index: unknown) => typeof index === "number" ? `${index}. ${labels[index - 1] ?? "(unknown)"}` : "")
    .filter(Boolean);
}

function quizAnswer(details: RecordValue): MdLogEvent {
  const dontKnow = details.dontKnow === true || details.unknown === true;
  const selected = dontKnow ? ["I don't know"] : answerLabels(details.answers).length ? answerLabels(details.answers) : [String(details.selectedOption ?? "(no answer)")];
  const correct = numberedAnswers(details.options, details.correctIndices);
  const lines = [`Your answer: ${selected.join(", ")}`];
  if (correct.length) lines.push(`Correct answer: ${correct.join(", ")}`);
  if (typeof details.note === "string" && details.note.trim()) lines.push(`Note: ${details.note.trim()}`);
  if (typeof details.explanation === "string" && details.explanation.trim()) lines.push("", `Explanation:`, details.explanation.trim());
  return {
    id: "",
    kind: "answer",
    text: lines.join("\n"),
    verdict: dontKnow ? "abstract" : details.correct === true ? "success" : "warning",
  };
}

function resultText(event: ToolResultEvent): string {
  if (!Array.isArray(event.content)) return "";
  return event.content
    .map((part: unknown) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function quizBridgeAnswer(event: ToolResultEvent): MdLogEvent[] {
  const text = resultText(event).trim();
  if (!text) return [];
  if (event.isError) {
    return [{ id: "", kind: "answer", text: `Quiz unavailable: ${text}`, verdict: "abstract" }];
  }
  const lower = text.toLowerCase();
  const verdict = lower.includes("i don't know") || lower.includes("did not know")
    ? "abstract"
    : lower.includes("answered correctly")
      ? "success"
      : lower.includes("answered incorrectly")
        ? "warning"
        : undefined;
  return [{ id: "", kind: "answer", text, verdict }];
}

function answers(event: ToolResultEvent, source: string): MdLogEvent[] {
  if (!ASK[event.toolName]) return [];
  const details = event.details as RecordValue | undefined;
  if (!details) return [];
  const result: MdLogEvent[] = event.toolName === "quiz"
    ? [quizAnswer(details)]
    : event.toolName === "ask_user_question"
      ? legacyAskAnswer(details)
      : askAnswer(details);
  return result.map((item, index) => ({ ...item, id: eventId("answer", source, index) }));
}

function legacyAskAnswer(details: RecordValue): MdLogEvent[] {
  if (details.status === "cancelled") return [{ id: "", kind: "answer", text: "Question cancelled", verdict: "abstract" }];
  if (details.status !== "answered") return [];
  const values = answerLabels(details.answers);
  return [{ id: "", kind: "answer", text: details.custom ? `User provided custom input: ${values.join(", ")}` : `Selected: ${values.join(", ")}` }];
}

function askAnswer(details: RecordValue): MdLogEvent[] {
  const results = Array.isArray(details.results) ? details.results as RecordValue[] : [];
  if (results.length) {
    const text = results.length === 1
      ? results[0].customInput
        ? `User provided custom input: ${results[0].customInput}`
        : `Selected: ${((results[0].selectedOptions as string[]) ?? []).join(", ")}`
      : `Selected: ${results.map((result) => `${result.id}: ${((result.selectedOptions as string[]) ?? []).join(", ")}`).join("; ")}`;
    return [{ id: "", kind: "answer", text }];
  }
  if (details.customInput) return [{ id: "", kind: "answer", text: `User provided custom input: ${details.customInput}` }];
  if (Array.isArray(details.selectedOptions)) return [{ id: "", kind: "answer", text: `Selected: ${details.selectedOptions.join(", ")}` }];
  return [];
}

export function normalizeToolResult(event: ToolResultEvent): MdLogEvent[] {
  const bridgeQuiz = event.toolName === "write" ? quizBridgeInput(event.input) : null;
  if (bridgeQuiz) {
    const question = questions("quiz", bridgeQuiz, event.toolCallId);
    return [...question, ...quizBridgeAnswer(event)];
  }
  const details = event.details as RecordValue | undefined;
  const question = event.toolName === "quiz" ? quizQuestion({ toolCallId: event.toolCallId, args: event.input, result: { details } }) : [];
  return [...question, ...answers(event, event.toolCallId)];
}
