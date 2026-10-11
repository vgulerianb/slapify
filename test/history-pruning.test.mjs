// The model must see the CURRENT page snapshot in full. Trimming it before the
// model read it was the root cause of the agent never clicking anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist } from "./helpers/harness.mjs";
const { pruneToolResultHistory, pruneVisionHistory, takeVisionImage } = await import(dist("task/runner.js"));

const snap = (n) => ({ role: "tool", content: [{ type: "tool-result", toolName: "get_page_state", result: JSON.stringify({ snapshot: `- textbox "Post text" [ref=e${n}]` + "x".repeat(20000) }) }] });

test("newest snapshot survives in full", () => {
  const m = [snap(1), snap(2)];
  pruneToolResultHistory(m);
  assert.ok(m[1].content[0].result.includes("[ref=e2]"));
  assert.ok(m[1].content[0].result.length > 20000);
});
test("older snapshots collapse to a short placeholder", () => {
  const m = [snap(1), snap(2)];
  pruneToolResultHistory(m);
  assert.ok(m[0].content[0].result.length < 400);
  assert.match(m[0].content[0].result, /does NOT mean the page was empty/);
});
test("small results are never touched", () => {
  const m = [snap(1), { role: "tool", content: [{ type: "tool-result", toolName: "remember", result: '{"ok":true}' }] }];
  pruneToolResultHistory(m);
  assert.equal(m[1].content[0].result, '{"ok":true}');
});
test("only the newest screenshot keeps its image", () => {
  const img = (t) => ({ role: "tool", content: [{ type: "tool-result", toolName: "screenshot", result: t, experimental_content: [{ type: "text", text: t }, { type: "image", data: "AAAA", mimeType: "image/png" }] }] });
  const m = [img("1"), img("2"), img("3")];
  pruneVisionHistory(m);
  const kept = m.map((x) => x.content[0].experimental_content.some((c) => c.type === "image"));
  assert.deepEqual(kept, [false, false, true]);
});
test("screenshot bytes never leak into the text channel", () => {
  const r = { ok: true, note: "x", __visionImage: { data: "QUFB", mimeType: "image/png" } };
  const img = takeVisionImage(r);
  assert.equal(img.data, "QUFB");
  assert.ok(!("__visionImage" in r));
});
