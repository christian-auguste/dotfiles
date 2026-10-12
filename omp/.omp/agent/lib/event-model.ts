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
  | { id: string; kind: "answer"; text: string; verdict?: "success" | "warning" | "abstract" | "cancelled" }
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

function bridgeQuizResult(details: unknown): { args?: RecordValue; result: RecordValue } | null {
  if (typeof details !== "object" || details === null || !("xdev" in details)) return null;
  const xdev = details.xdev;
  if (typeof xdev !== "object" || xdev === null || !("tool" in xdev) || xdev.tool !== "quiz") return null;
  if (!("inner" in xdev) || typeof xdev.inner !== "object" || xdev.inner === null) return null;
  const args = "args" in xdev && typeof xdev.args === "object" && xdev.args !== null
    ? xdev.args as RecordValue
    : undefined;
  return { args, result: xdev.inner as RecordValue };
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


export function normalizeCustomMessage(source: string, entry: RecordValue): MdLogEvent[] {
  if (entry.type !== "custom_message" || entry.customType !== "skill-prompt" || entry.attribution !== "user") return [];
  const details = typeof entry.details === "object" && entry.details !== null ? entry.details as RecordValue : {};
  if (typeof details.name !== "string" || typeof details.args !== "string") return [];
  return [{ id: eventId("skill", source, 0), kind: "skill", name: details.name, text: details.args }];
}

export function normalizeMessage(source: string, message: Message): MdLogEvent[] {
  if (message.role === "user") {
    if (message.synthetic === true || message.attribution === "agent") return [];
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
  if (details.status === "cancelled") {
    return { id: "", kind: "answer", text: "Question cancelled", verdict: "cancelled" };
  }
  const dontKnow = details.dontKnow === true || details.unknown === true;
  const selected = dontKnow ? ["I don't know"] : answerLabels(details.answers).length ? answerLabels(details.answers) : [String(details.selectedOption ?? "(no answer)")];
  const correct = numberedAnswers(details.options, details.correctIndices);
  const lines = [`Your answer: ${selected.join(", ")}`];
  if (correct.length) lines.push(`Correct answer: ${correct.join(", ")}`);
  if (typeof details.note === "string" && details.note.trim()) lines.push("", `Note: ${details.note.trim()}`);
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

function quizBridgeAnswer(event: ToolResultEvent, question?: string): MdLogEvent[] {
  let text = resultText(event).trim();
  const questionPrefix = question ? `Question: ${question}\n\n` : "";
  if (questionPrefix && text.startsWith(questionPrefix)) text = text.slice(questionPrefix.length);
  text = text
    .replace(/\r?\n(?=User's note:)/, "\n\n")
    .replace(/\r?\n(?=Explanation:)/, "\n\n")
    .replace(/(^|\n)User's note:/, "$1Note:");
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
  const bridge = event.toolName === "write" ? bridgeQuizResult(event.details) : null;
  const bridgeInput = event.toolName === "write" ? quizBridgeInput(event.input) : null;
  if (bridgeInput || bridge) {
    const questionArgs = bridgeInput ?? bridge?.args;
    const question = bridge && questionArgs
      ? { ...questionArgs, options: bridge.result.options ?? questionArgs.options }
      : questionArgs;
    const questionEvents = bridgeInput && question ? questions("quiz", question, event.toolCallId) : [];
    if (bridge && (bridge.result.status === "answered" || bridge.result.status === "cancelled")) {
      return [
        ...questionEvents,
        { ...quizAnswer(bridge.result), id: eventId("answer", event.toolCallId, 0) },
      ];
    }
    const questionText = typeof questionArgs?.question === "string" ? questionArgs.question : undefined;
    const bridgeAnswers = quizBridgeAnswer(event, questionText)
      .map((item, index) => ({ ...item, id: eventId("answer", event.toolCallId, index) }));
    return [...questionEvents, ...bridgeAnswers];
  }
  const details = event.details as RecordValue | undefined;
  const question = event.toolName === "quiz" ? quizQuestion({ toolCallId: event.toolCallId, args: event.input, result: { details } }) : [];
  return [...question, ...answers(event, event.toolCallId)];
}
