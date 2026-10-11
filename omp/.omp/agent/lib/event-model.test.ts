import assert from "node:assert/strict";
import { normalizeCustomMessage, normalizeToolResult } from "./event-model";
import { renderCallout } from "./log-renderer";

const prompt = "Work through the whole assignment.\n\n<attachment>\nAll assignment text\n</attachment>";
const [skillEvent] = normalizeCustomMessage("skill-entry", {
  type: "custom_message",
  customType: "skill-prompt",
  attribution: "user",
  details: { name: "learn", args: prompt },
  content: "Injected skill instructions\nUser: " + prompt,
});
assert.equal(skillEvent?.kind, "skill");
assert.match(renderCallout(skillEvent!), /SKILL loaded: learn/);
assert.equal(skillEvent?.text, prompt);
assert.match(renderCallout(skillEvent!), /All assignment text/);
assert.doesNotMatch(renderCallout(skillEvent!), /Injected skill instructions/);

assert.deepEqual(normalizeCustomMessage("other-entry", {
  type: "custom_message",
  customType: "unrelated",
  attribution: "user",
  details: { name: "other", args: prompt },
  content: prompt,
}), []);

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

const [bridgeQuestion, bridgeAnswer] = normalizeToolResult({
  toolName: "write",
  toolCallId: "answered-quiz",
  input: { path: "xd://quiz", content: JSON.stringify({ question: "Q", options: [] }) },
  content: [{ type: "text", text: "I don't know\nNote: My note\nExplanation: The answer." }],
  isError: false,
} as never);
assert.equal(bridgeQuestion?.kind, "question");
assert.equal(bridgeAnswer?.kind, "answer");
assert.match(renderCallout(bridgeAnswer!), /> Note: My note\n> \n> Explanation: The answer\./);

console.log("canceled quiz rendering: passed");
