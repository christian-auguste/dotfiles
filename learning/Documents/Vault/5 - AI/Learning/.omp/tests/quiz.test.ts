import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import quiz from "../extensions/quiz";

type Theme = { fg: (_color: string, text: string) => string };
type QuizTool = {
  renderResult: (
    result: { content: Array<{ type: string; text?: string }>; details: unknown },
    options: unknown,
    theme: Theme,
  ) => { getText: () => string };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
};

test("quiz result keeps the question and separates note from explanation", () => {
  const schema = (..._args: unknown[]) => ({});
  let tool: QuizTool | undefined;
  quiz({
    typebox: { Type: { Object: schema, String: schema, Optional: schema, Array: schema, Boolean: schema, Union: schema } },
    registerTool: (definition: unknown) => { tool = definition as QuizTool; },
  } as unknown as ExtensionAPI);
  assert.ok(tool);

  const output = tool.renderResult({
    content: [{ type: "text", text: "" }],
    details: {
      status: "answered",
      question: "How many distinct committees can be formed?",
      answers: [],
      correctIndices: [1],
      options: [{ index: 1, label: "10 committees" }, { index: 2, label: "20 committees" }],
      correct: false,
      dontKnow: true,
      note: "I think this is n choose r, but I am unsure.",
      explanation: "A committee is unordered, so there are C(5, 2) choices.",
    },
  }, {}, { fg: (_color, text) => text }).getText();

  const questionIndex = output.indexOf("How many distinct committees can be formed?");
  assert.notEqual(questionIndex, -1);
  assert.ok(questionIndex < output.indexOf("I don't know"));
  assert.match(output, /I don't know\n\nNote: I think this is n choose r, but I am unsure\.\n\nA committee is unordered/);
});

test("quiz tool result preserves the question and note in stored text", async () => {
  const schema = (..._args: unknown[]) => ({});
  let tool: QuizTool | undefined;
  quiz({
    typebox: { Type: { Object: schema, String: schema, Optional: schema, Array: schema, Boolean: schema, Union: schema } },
    registerTool: (definition: unknown) => { tool = definition as QuizTool; },
  } as unknown as ExtensionAPI);
  assert.ok(tool);

  const note = "I am unsure about combinations.";
  const ctx = {
    hasUI: true,
    ui: {
      custom: () => Promise.resolve({ dontKnow: true, note, answers: [] }),
    },
  };
  const result = await tool.execute("quiz-test", {
    question: "How many distinct committees can be formed?",
    options: [{ label: "10 committees", value: "10" }, { label: "20 committees", value: "20" }],
    correctAnswer: "10",
    explanation: "A committee is unordered.",
    shuffle: false,
  }, undefined, undefined, ctx);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /^Question: How many distinct committees can be formed\?\n\n/);
  assert.match(text, /User's note: I am unsure about combinations\.\n\nExplanation: A committee is unordered\./);
});
