// A long-running task must never die from a transient failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist, runScripted, call } from "./helpers/harness.mjs";
const { classifyLlmError, patientBackoffMs } = await import(dist("task/recovery.js"));

test("errors are classified by what can be done about them", () => {
  assert.equal(classifyLlmError(new Error("Invalid arguments for tool click: Type validation failed")), "bad_tool_args");
  assert.equal(classifyLlmError(new Error("Invalid input for tool click: JSON parsing failed")), "bad_tool_args");
  assert.equal(classifyLlmError(new Error("claude CLI timed out after 600s")), "transient");
  assert.equal(classifyLlmError(new Error("fetch failed")), "transient");
  assert.equal(classifyLlmError(new Error("429 Too Many Requests")), "provider");
  assert.equal(classifyLlmError(new Error("something odd happened")), "unknown");
});

test("a usage limit is a wait, not a crash (the 273-restart night)", () => {
  const e = new Error('claude CLI exited with code 1: {"duration_api_ms":0,"stop_reason":"stop_sequence"}');
  assert.equal(classifyLlmError(e), "provider");
});

test("patient backoff grows, then caps at five minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(patientBackoffMs), [60000, 120000, 240000, 300000, 300000, 300000]);
});

test("persistent mode refuses done() so the task keeps going", async () => {
  const r = await runScripted(
    [call(["done", { summary: "trying to quit" }]), call(["remember", { key: "still", value: "here" }])],
    { persistent: true, maxIterations: 3 }
  );
  assert.equal(r.session.memory.still, "here", "kept working after done() was refused");
  assert.match(r.session.finalSummary || "", /maximum iteration/);
});

test("persistent mode treats a prose reply as a pause, not a finish", async () => {
  const r = await runScripted(
    ["I think I'm finished now.", call(["remember", { key: "after_prose", value: "yes" }])],
    { persistent: true, maxIterations: 3 }
  );
  assert.equal(r.session.memory.after_prose, "yes");
});

test("without persistent mode, done() still ends a normal task", async () => {
  const r = await runScripted([call(["done", { summary: "normal finish" }])]);
  assert.equal(r.session.status, "completed");
  assert.equal(r.session.finalSummary, "normal finish");
});
