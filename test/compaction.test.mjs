// Compaction must never paraphrase the goal: across three long runs, em dash
// violations were 0/81 before the first compaction and 44/264 after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist, FAKE_CLAUDE, runScripted, call } from "./helpers/harness.mjs";
const { chooseCompactionCut, compactMessages } = await import(dist("task/runner.js"));
const { getModel } = await import(dist("ai/interpreter.js"));

const goal = { role: "user", content: "GOAL: never use an em dash. Reply to 10 tweets per cycle." };
const exchange = (i) => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "remember", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "remember", output: { type: "text", value: "{}" } }] },
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

// --memory-from and scheduled runs put a memory note ahead of the goal, so
// "keep message 0" kept the note and summarized the goal away.
const memNote = { role: "user", content: "[Memory from previous session]\n- thread_url: https://example.com/t/1" };
const withMemory = (n) => [memNote, goal, ...Array.from({ length: n }, (_, i) => exchange(i)).flat()];

test("the cut never lands inside the head (memory note + goal)", () => {
  const h = withMemory(30);
  for (let keep = 1; keep < h.length + 2; keep++) {
    const cut = chooseCompactionCut(h, keep, 2);
    assert.ok(cut >= 2, `keep=${keep} cut into the head`);
    if (cut < h.length) assert.notEqual(h[cut].role, "tool", `keep=${keep} orphaned a tool result`);
  }
});

test("with a memory note ahead of the goal, both survive compaction word for word", async () => {
  const out = await compactMessages(withMemory(30), model("did stuff"), "test-session", 6, 2);
  assert.deepEqual(out.slice(0, 2), [memNote, goal]);
  assert.match(String(out[2].content), /Context Summary/);
  assert.ok(out.length < withMemory(30).length);
});

test("a run started with inherited memory still shows the model its goal after compacting", async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "slapify-log-")), "prompts.txt");
  process.env.FAKE_CLAUDE_LOG = log;
  const GOAL = "GOAL-7f3a: never use an em dash, reply to three posts per cycle";
  try {
    await runScripted(
      [
        call(["remember", { key: "a", value: "1" }]),
        call(["sleep_until", { until: "1s" }]),
        "summary of cycle one", // consumed by the compaction call
        call(["remember", { key: "b", value: "2" }]),
      ],
      { goal: GOAL, persistent: true, maxIterations: 4, inheritedMemory: { thread_url: "https://example.com/t/1" } }
    );
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
  }
  const prompts = readFileSync(log, "utf8").split("\n\u0000\n").filter(Boolean);
  const last = prompts[prompts.length - 1];
  assert.match(last, /summary of cycle one/, "compaction happened");
  assert.ok(last.includes(GOAL), "the goal is still there, verbatim");
  assert.ok(last.includes("thread_url: https://example.com/t/1"), "so is the memory note");
});
