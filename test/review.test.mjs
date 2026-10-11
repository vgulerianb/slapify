// Action review: a policy check before anything irreversible happens.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist, runScripted, call, FAKE_CLAUDE } from "./helpers/harness.mjs";
const { ActionReviewer, shouldHold, heldByReview } = await import(dist("task/review.js"));
const { JevClient } = await import(dist("jev/client.js"));
const { getModel } = await import(dist("ai/interpreter.js"));

// Fake Jev: answers "clear" or "caution" per the queued plan, or fails.
let plan = [];
let lastBody = null;
const jevServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastBody = JSON.parse(body);
    const next = plan.shift() || "clear";
    if (next === "down") { res.writeHead(503); return res.end("{}"); }
    // "clear" / "caution" are confident; { choice, confidence } sets the margin.
    const [choice, confidence] = typeof next === "object" ? [next.choice, next.confidence] : [next, 0.9];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers: { decision: { type: "choice", choice, confidence, probabilities: {} } }, usage: { input_tokens: 300 } }));
  });
});
await new Promise((r) => jevServer.listen(0, r));
const JEV = `http://127.0.0.1:${jevServer.address().port}`;
after(() => jevServer.close());
const jev = () => new JevClient({ base_url: JEV, api_key: "k" });
const action = { description: 'press Meta+Enter', pageUrl: "https://x.com/a/status/1", pendingText: "Great point on caching.", goal: "reply to dev tweets" };

test("a clear verdict lets the action through", async () => {
  plan = ["clear"];
  const v = await new ActionReviewer({ enabled: true, policy: "tech only" }, jev(), null).review(action);
  assert.equal(v.outcome, "clear");
  assert.equal(v.by, "jev");
  assert.equal(shouldHold(v, {}), false);
});

test("a caution verdict holds the action", async () => {
  plan = ["caution"];
  const v = await new ActionReviewer({ enabled: true, policy: "tech only" }, jev(), null).review(action);
  assert.equal(v.outcome, "caution");
  assert.equal(shouldHold(v, {}), true);
});

test("the reviewer sees the policy, the page, the text and the exact action", async () => {
  plan = ["clear"];
  await new ActionReviewer({ enabled: true, policy: "No political content." }, jev(), null).review(action);
  for (const needle of ["No political content.", "x.com/a/status/1", "Great point on caching.", "press Meta+Enter"]) {
    assert.ok(lastBody.state.includes(needle), `missing: ${needle}`);
  }
});

test("when no reviewer can answer, the action is HELD by default (fail closed)", async () => {
  plan = ["down", "down", "down"];
  const v = await new ActionReviewer({ enabled: true, fallback: "none" }, jev(), null).review(action);
  assert.equal(v.outcome, "unavailable");
  assert.equal(shouldHold(v, {}), true);
});

test("on_unavailable: allow opts out of failing closed", () => {
  assert.equal(shouldHold({ outcome: "unavailable", reason: "x" }, { on_unavailable: "allow" }), false);
});

test("the LLM reviews when Jev is down", async () => {
  plan = ["down", "down", "down"];
  const d = mkdtempSync(path.join(tmpdir(), "slapify-rev-"));
  writeFileSync(path.join(d, "s.json"), JSON.stringify(["CAUTION: states a benchmark it cannot back up"]));
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: path.join(d, "s.json"), FAKE_CLAUDE_STATE: path.join(d, "n") });
  const llm = getModel({ provider: "claude-cli", model: "t", cli_path: FAKE_CLAUDE, timeout_seconds: 5 });
  const v = await new ActionReviewer({ enabled: true }, jev(), llm).review(action);
  assert.equal(v.outcome, "caution");
  assert.equal(v.by, "llm");
  assert.match(v.reason, /benchmark/);
});

test("a held result tells the model what to do instead", () => {
  const h = heldByReview({ outcome: "caution", by: "jev", ms: 1, reason: "off topic" }, "press Meta+Enter");
  assert.equal(h.held, true);
  assert.match(h.do_next, /Revise|skip/);
});

test("end to end: a caution verdict stops a submit before it runs", async () => {
  plan = ["caution"];
  const r = await runScripted(
    [call(["press", { key: "Meta+Enter" }]), call(["done", { summary: "ok" }])],
    {},
    `jev:\n  enabled: true\n  base_url: ${JEV}\n  api_key: k\nreview:\n  enabled: true\n  policy: tech only\n  fallback: none\n`
  );
  assert.ok(r.messages.some((m) => /Review held/.test(m)), r.messages.join(" | "));
});

// ── Unsure Jev verdicts get a second opinion ────────────────────
function llmSaying(...replies) {
  const d = mkdtempSync(path.join(tmpdir(), "slapify-rev-"));
  writeFileSync(path.join(d, "s.json"), JSON.stringify(replies));
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: path.join(d, "s.json"), FAKE_CLAUDE_STATE: path.join(d, "n") });
  return getModel({ provider: "claude-cli", model: "t", cli_path: FAKE_CLAUDE, timeout_seconds: 5 });
}
const brokenLlm = () => getModel({ provider: "claude-cli", model: "t", cli_path: "/nonexistent/claude", timeout_seconds: 5 });

test("an unsure Jev clear is overruled by the LLM's second opinion", async () => {
  plan = [{ choice: "clear", confidence: 0.1 }];
  const v = await new ActionReviewer({ enabled: true }, jev(), llmSaying("CAUTION: unverifiable claim")).review(action);
  assert.equal(v.outcome, "caution");
  assert.equal(v.by, "llm");
  assert.deepEqual(v.jev, { choice: "clear", confidence: 0.1 });
});

test("an unsure Jev caution can be cleared by the LLM", async () => {
  plan = [{ choice: "caution", confidence: 0.18 }];
  const v = await new ActionReviewer({ enabled: true }, jev(), llmSaying("CLEAR")).review(action);
  assert.equal(v.outcome, "clear");
  assert.equal(v.by, "llm");
});

test("a confident Jev verdict is final: the LLM is not asked", async () => {
  plan = [{ choice: "clear", confidence: 0.5 }];
  const v = await new ActionReviewer({ enabled: true }, jev(), brokenLlm()).review(action);
  assert.equal(v.outcome, "clear");
  assert.equal(v.by, "jev");
});

test("min_confidence is configurable", async () => {
  plan = [{ choice: "clear", confidence: 0.5 }];
  const v = await new ActionReviewer({ enabled: true, min_confidence: 0.6 }, jev(), llmSaying("CAUTION: no")).review(action);
  assert.equal(v.by, "llm");
});

test("unsure and no second opinion: a clear is held, a caution stays a caution", async () => {
  plan = [{ choice: "clear", confidence: 0.1 }];
  const a = await new ActionReviewer({ enabled: true }, jev(), brokenLlm()).review(action);
  assert.equal(a.outcome, "unavailable");
  assert.equal(shouldHold(a, {}), true);
  plan = [{ choice: "caution", confidence: 0.1 }];
  const b = await new ActionReviewer({ enabled: true }, jev(), brokenLlm()).review(action);
  assert.equal(b.outcome, "caution");
});

test("with fallback: none, Jev's answer stands however unsure", async () => {
  plan = [{ choice: "clear", confidence: 0.1 }];
  const v = await new ActionReviewer({ enabled: true, fallback: "none" }, jev(), null).review(action);
  assert.equal(v.outcome, "clear");
  assert.equal(v.by, "jev");
});
