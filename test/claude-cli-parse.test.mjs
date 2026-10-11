// The claude-cli provider turns text into tool calls. Every case here is a
// response shape that has actually ended a long-running task in the past.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist } from "./helpers/harness.mjs";
const { extractToolCalls } = await import(dist("ai/claude-cli.js"));

const names = (r) => r.toolCalls.map((c) => c.toolName);

test("intact tool-call JSON parses", () => {
  const r = extractToolCalls('{"tool_calls": [{"name": "navigate", "arguments": {"url": "https://x.com"}}]}');
  assert.deepEqual(names(r), ["navigate"]);
  assert.deepEqual(JSON.parse(r.toolCalls[0].input), { url: "https://x.com" });
});

test("fenced JSON parses", () => {
  const r = extractToolCalls('```json\n{"tool_calls": [{"name": "wait", "arguments": {"seconds": 2}}]}\n```');
  assert.deepEqual(names(r), ["wait"]);
});

test("text before the JSON is kept as text", () => {
  const r = extractToolCalls('Going there now.\n{"tool_calls": [{"name": "navigate", "arguments": {"url": "u"}}]}');
  assert.deepEqual(names(r), ["navigate"]);
  assert.equal(r.text, "Going there now.");
});

test("response cut off between brackets is repaired", () => {
  const r = extractToolCalls('{"tool_calls": [{"name": "remember", "arguments": {"key": "k", "value": "v"}}, {"name": "navigate", "arguments": {"url": "u"}}]');
  assert.deepEqual(names(r), ["remember", "navigate"]);
});

test("response cut off INSIDE a string value is repaired", () => {
  // The exact shape that ended a 2-hour run: truncated mid-sentence in a memory value.
  const r = extractToolCalls('{"tool_calls": [{"name": "remember", "arguments": {"key": "cycle_count", "value": "5"}}, {"name": "remember", "arguments": {"key": "summary", "value": "Cycle 4 complete. Notifications checked - no new ment');
  assert.deepEqual(names(r), ["remember", "remember"]);
});

test("trailing comma after the last call is repaired", () => {
  const r = extractToolCalls('{"tool_calls": [{"name": "remember", "arguments": {"key": "k", "value": "v"}},');
  assert.deepEqual(names(r), ["remember"]);
});

test("genuine prose is never turned into a tool call", () => {
  const r = extractToolCalls("All done for this cycle, nothing further to add.");
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.text, "All done for this cycle, nothing further to add.");
});

test("escaped quotes inside strings do not confuse the repair", () => {
  const r = extractToolCalls('{"tool_calls": [{"name": "type", "arguments": {"ref": "e1", "text": "he said \\"hi\\" and');
  assert.deepEqual(names(r), ["type"]);
});

test("a call cut off before its name keeps the raw text, so it is not read as a finish", () => {
  const r = extractToolCalls('{"tool_calls": [{"name": ');
  assert.equal(r.toolCalls.length, 0);
  assert.match(r.text, /tool_calls/);
});
