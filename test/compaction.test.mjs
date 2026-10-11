// Compaction must never paraphrase the goal: across three long runs, em dash
// violations were 0/81 before the first compaction and 44/264 after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist, FAKE_CLAUDE, runScripted, call } from "./helpers/harness.mjs";
const { chooseCompactionCut, compactMessages } = await import(dist("task/runner.js"));
const { getModel } = await import(dist("ai/interpreter.js"));

const goal = { role: "user", content: "GOAL: never use an em dash. Reply to 10 tweets per cycle." };
const exchange = (i) => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "remember", args: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "remember", result: "{}" }] },
];
const history = (n) => [goal, ...Array.from({ length: n }, (_, i) => exchange(i)).flat()];

test("the cut never lands on the goal", () => {
  assert.ok(chooseCompactionCut(history(2), 100) >= 1);
  assert.ok(chooseCompactionCut(history(30), 20) >= 1);
});

test("the kept tail never starts with an orphaned tool result", () => {
  const h = history(30);
  for (let keep = 1; keep < 25; keep++) {
    const cut = chooseCompactionCut(h, keep);
    assert.notEqual(h[cut].role, "tool", `keep=${keep} orphaned a tool result`);
  }
});

function model(summary) {
  const d = mkdtempSync(path.join(tmpdir(), "slapify-cmp-"));
  writeFileSync(path.join(d, "s.json"), JSON.stringify([summary]));
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: path.join(d, "s.json"), FAKE_CLAUDE_STATE: path.join(d, "n") });
  return getModel({ provider: "claude-cli", model: "t", cli_path: FAKE_CLAUDE, timeout_seconds: 5 });
}

test("after compaction the goal is still message 0, word for word", async () => {
  const out = await compactMessages(history(30), model("did stuff"), "test-session", 6);
  assert.deepEqual(out[0], goal);
  assert.ok(out.length < history(30).length);
});

test("if summarizing fails, the goal still survives (it used to be dropped)", async () => {
  const d = mkdtempSync(path.join(tmpdir(), "slapify-cmp-"));
  writeFileSync(path.join(d, "s.json"), JSON.stringify(["x"]));
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: path.join(d, "s.json"), FAKE_CLAUDE_STATE: path.join(d, "n"), FAKE_CLAUDE_HANG_MS: "8000" });
  const slow = getModel({ provider: "claude-cli", model: "t", cli_path: FAKE_CLAUDE, timeout_seconds: 1 });
  const out = await compactMessages(history(30), slow, "test-session", 6);
  delete process.env.FAKE_CLAUDE_HANG_MS;
  assert.deepEqual(out[0], goal);
});

test("a persistent task compacts at the end of each cycle and keeps going", async () => {
  const r = await runScripted(
    [
      call(["remember", { key: "a", value: "1" }]),
      call(["sleep_until", { until: "1s" }]),
      "summary of cycle one", // consumed by the compaction call
      call(["remember", { key: "b", value: "2" }]),
    ],
    { persistent: true, maxIterations: 4 }
  );
  assert.ok(r.messages.some((m) => /Cycle complete/.test(m)), r.messages.join(" | "));
  assert.equal(r.session.memory.b, "2", "carried on into the next cycle");
});
