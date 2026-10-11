// The model must see the CURRENT page snapshot in full. Trimming it before the
// model read it was the root cause of the agent never clicking anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist } from "./helpers/harness.mjs";
const { pruneToolResultHistory, pruneVisionHistory, takeVisionImage, closeDanglingToolCalls, historyForProvider } = await import(dist("task/runner.js"));
const { rebuildMessages } = await import(dist("task/session.js"));

const text = (value) => ({ type: "text", value });
const snap = (n) => ({ role: "tool", content: [{ type: "tool-result", toolName: "get_page_state", output: text(JSON.stringify({ snapshot: `- textbox "Post text" [ref=e${n}]` + "x".repeat(20000) })) }] });

test("newest snapshot survives in full", () => {
  const m = [snap(1), snap(2)];
  pruneToolResultHistory(m);
  assert.ok(m[1].content[0].output.value.includes("[ref=e2]"));
  assert.ok(m[1].content[0].output.value.length > 20000);
});
test("older snapshots collapse to a short placeholder", () => {
  const m = [snap(1), snap(2)];
  pruneToolResultHistory(m);
  assert.ok(m[0].content[0].output.value.length < 400);
  assert.match(m[0].content[0].output.value, /does NOT mean the page was empty/);
});
test("small results are never touched", () => {
  const m = [snap(1), { role: "tool", content: [{ type: "tool-result", toolName: "remember", output: text('{"ok":true}') }] }];
  pruneToolResultHistory(m);
  assert.equal(m[1].content[0].output.value, '{"ok":true}');
});
test("only the newest screenshot keeps its image", () => {
  const img = (t) => ({ role: "tool", content: [{ type: "tool-result", toolName: "screenshot", output: { type: "content", value: [{ type: "text", text: t }, { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } }] } }] });
  const m = [img("1"), img("2"), img("3")];
  pruneVisionHistory(m);
  const kept = m.map((x) => x.content[0].output.value.some((c) => c.type === "file"));
  assert.deepEqual(kept, [false, false, true]);
});
test("screenshot bytes never leak into the text channel", () => {
  const r = { ok: true, note: "x", __visionImage: { data: "QUFB", mimeType: "image/png" } };
  const img = takeVisionImage(r);
  assert.equal(img.data, "QUFB");
  assert.ok(!("__visionImage" in r));
});

// The AI SDK refuses to send a tool call that has no result.
const calls = (...ids) => ({ role: "assistant", content: ids.map((id) => ({ type: "tool-call", toolCallId: id, toolName: "click", input: {} })) });
test("a tool call left without a result gets one saying it may not have happened", () => {
  const m = [{ role: "user", content: "goal" }, calls("a", "b"), { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "click", output: text("{}") }] }, calls("c"), { role: "user", content: "next" }];
  closeDanglingToolCalls(m);
  assert.deepEqual(m[2].content.map((p) => p.toolCallId), ["a", "b"]);
  assert.equal(m[4].role, "tool", "inserted right after the call, before the next user message");
  assert.match(m[4].content[0].output.value, /may or may not have happened/);
  assert.equal(m.length, 6);
});
test("screenshots stay out of tool results for providers that can't take them there", () => {
  const shot = { role: "tool", content: [{ type: "tool-result", toolCallId: "s", toolName: "screenshot", output: { type: "content", value: [{ type: "text", text: "shot" }, { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } }] } }] };
  assert.deepEqual(historyForProvider([shot], "openai")[0].content[0].output, text("shot"));
  assert.equal(historyForProvider([shot], "anthropic")[0], shot);
  assert.equal(shot.content[0].output.type, "content", "the history itself is untouched");
});
test("a resumed session pairs each logged result with its tool call", () => {
  const ts = "t";
  const m = rebuildMessages([
    { type: "session_start", goal: "g", ts },
    { type: "llm_response", text: "", toolCalls: [{ toolCallId: "c1", toolName: "navigate", args: { url: "u" } }, { toolCallId: "c2", toolName: "click", args: { ref: "e1" } }], ts },
    { type: "tool_call", toolName: "navigate", args: { url: "u" }, result: { ok: true }, ts },
    { type: "tool_error", toolName: "click", args: { ref: "e1" }, error: "boom", ts },
  ]);
  assert.deepEqual(m[1].content.map((p) => p.input), [{ url: "u" }, { ref: "e1" }]);
  assert.deepEqual(m[2].content.map((p) => [p.toolCallId, p.output.value]), [["c1", '{"ok":true}'], ["c2", "ERROR: boom"]]);
});
