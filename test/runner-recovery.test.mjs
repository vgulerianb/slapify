// End-to-end runner behaviour against a scripted model. Each case is a failure
// that previously killed or silently ended a long-running task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScripted, call } from "./helpers/harness.mjs";

const done = (summary = "finished") => call(["done", { summary }]);
const remember = (k = "k") => call(["remember", { key: k, value: "v" }]);

test("a tool call with missing arguments is corrected, not fatal", async () => {
  const r = await runScripted([call(["click", {}]), remember(), done("recovered")]);
  assert.equal(r.session.status, "completed");
  assert.equal(r.session.finalSummary, "recovered");
  assert.ok(r.messages.some((m) => /Malformed tool call/.test(m)));
});

test("a truncated response is repaired and the run continues", async () => {
  const truncated = '{"tool_calls": [{"name": "remember", "arguments": {"key": "a", "value": "cut off mid sente';
  const r = await runScripted([truncated, done("after truncation")]);
  assert.equal(r.session.finalSummary, "after truncation");
  assert.equal(r.session.memory.a !== undefined, true);
});

test("broken tool-call JSON is not mistaken for a final answer", async () => {
  // Unrepairable: the call has no usable name. Must not end the task.
  const broken = '{"tool_calls": [{"name": ';
  const r = await runScripted([broken, done("not ended early")]);
  assert.equal(r.session.finalSummary, "not ended early");
  assert.ok(r.messages.some((m) => /broken tool call/.test(m)));
});

test("an unexpected error in one turn is recovered, not fatal", async () => {
  const r = await runScripted([{ raw: "this is not json at all" }, done("survived")]);
  assert.equal(r.session.status, "completed");
  assert.equal(r.session.finalSummary, "survived");
});

test("a genuine final answer still ends a normal task", async () => {
  const r = await runScripted(["The gold price today is $2,400/oz."]);
  assert.equal(r.session.status, "completed");
  assert.match(r.session.finalSummary, /gold price/);
});

test("an empty response does not end the task", async () => {
  const r = await runScripted(["", done("kept going")]);
  assert.equal(r.session.finalSummary, "kept going");
});
