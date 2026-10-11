// text_filters must hold on every reply, not most of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist } from "./helpers/harness.mjs";
const { applyTextFilters } = await import(dist("task/runner.js"));
const F = { " — ": ", ", "—": ", ", " – ": " - ", "–": "-" };

test("spaced em dash becomes a clean comma", () => {
  assert.equal(applyTextFilters("Great point — the caching part.", F).text, "Great point, the caching part.");
});
test("bare em dash is replaced", () => {
  assert.equal(applyTextFilters("runners—a lifesaver", F).text, "runners, a lifesaver");
});
test("en dash ranges keep their meaning", () => {
  assert.equal(applyTextFilters("3–5 seconds", F).text, "3-5 seconds");
});
test("clean text is untouched and reports nothing replaced", () => {
  const r = applyTextFilters("no dashes here", F);
  assert.equal(r.text, "no dashes here");
  assert.equal(r.replaced.length, 0);
});
test("it reports which patterns fired, so the model can be told", () => {
  assert.ok(applyTextFilters("a — b", F).replaced.length > 0);
});
test("no filters configured is a no-op", () => {
  assert.equal(applyTextFilters("a — b", {}).text, "a — b");
});
