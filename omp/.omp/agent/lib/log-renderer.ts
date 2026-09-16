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

function quoteLines(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

export function renderCallout(event: MdLogEvent): string {
  if (event.kind === "user") return `> [!quote] You\n\n${escapeHtmlLike(event.text)}`;
  if (event.kind === "skill") return `> [!quote] You\n\n${escapeHtmlLike(event.text)}\n\n> [!info] SKILL loaded: ${event.name}`;
  if (event.kind === "assistant") return `> [!${event.sources ? "quote" : "info"}] ${event.sources ? "Sources" : "PI"}\n\n${escapeHtmlLike(event.text)}`;
  if (event.kind === "question") {
    return [
      "> [!question] Question",
      `> ${escapeHtmlLike(event.question)}`,
      ">",
      event.options.map((option, index) => `> ${index + 1}. ${escapeHtmlLike(option)}`).join("\n"),
    ].join("\n");
  }
  if (event.kind === "answer") {
    const label = event.verdict === "success"
      ? "Quiz — correct ✓"
      : event.verdict === "warning"
        ? "Quiz — incorrect ✗"
        : event.verdict === "abstract"
          ? "Quiz — I don't know"
          : "Answer";
    const type = event.verdict === "success"
      ? "success"
      : event.verdict === "warning"
        ? "failure"
        : event.verdict === "abstract"
          ? "question"
          : "example";
    return `> [!${type}] ${label}\n${quoteLines(event.text)}`;
  }
  return `![[${event.embedPath}]]`;
}
