import assert from "node:assert/strict";
import { normalizeToolResult } from "./event-model";
import { renderCallout } from "./log-renderer";

const [event] = normalizeToolResult({
  toolName: "quiz",
  toolCallId: "cancelled-check",
  input: { question: "Q", options: [{ label: "A" }] },
  details: { status: "cancelled" },
  content: [],
  isError: false,
} as never);

assert.equal(event?.kind, "answer");
assert.equal(event?.verdict, "cancelled");
assert.equal(event?.text, "Question cancelled");
assert.equal(renderCallout(event!), "> [!question] Quiz — cancelled\n> Question cancelled");

console.log("canceled quiz rendering: passed");
