import type { MdLogEvent } from "./event-model";

function escapeHtmlLike(text: string): string {
  let result = "";
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "`") code = !code;
    if (char === "<" && !code && /[A-Za-z/!]/.test(text[i + 1] ?? "")) result += "\\<";
    else result += char;
  }
  return result;
}

export function renderCallout(event: MdLogEvent): string {
  if (event.kind === "user") return `> [!quote] You\n\n${escapeHtmlLike(event.text)}`;
  if (event.kind === "skill") return `> [!quote] You\n\n${escapeHtmlLike(event.text)}\n\n> [!info] SKILL loaded: ${event.name}`;
  if (event.kind === "assistant") return `> [!${event.sources ? "quote" : "info"}] ${event.sources ? "Sources" : "PI"}\n\n${escapeHtmlLike(event.text)}`;
  if (event.kind === "question") return [`> [!question] Question`, `> ${event.question}`, ...event.options.map((option) => `> - ${option}`)].join("\n");
  if (event.kind === "answer") {
    const label = event.verdict === "success" ? "Correct" : event.verdict === "warning" ? "Incorrect" : event.verdict === "abstract" ? "Not sure" : "Answer";
    const type = event.verdict === "success" ? "success" : event.verdict === "warning" ? "warning" : "abstract";
    return `> [!${type}] ${label}\n${event.text.split("\n").map((line) => `> ${line}`).join("\n")}`;
  }
  return `![[${event.embedPath}]]`;
}
