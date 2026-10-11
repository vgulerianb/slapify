// Ultrafast mode: Jev picks each operation and target, the LLM only writes
// text. A scripted fake Jev drives a real browser on a local fixture.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dist, FAKE_CLAUDE } from "./helpers/harness.mjs";

if (!process.env.AGENT_BROWSER_SESSION) process.env.AGENT_BROWSER_SESSION = "slapify-test";
const { runFast } = await import(dist("fast/agent.js"));
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = `file://${path.join(here, "fixtures", "capabilities.html")}`;
let hasBrowser = true;
try { execSync("agent-browser --version", { stdio: "ignore" }); } catch { hasBrowser = false; }

// Each script step: { op, target?: RegExp matched against the offered elements }
// or { verify: p } for the DONE check. Requests are recorded for assertions.
let script = [];
const requests = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    requests.push(body);
    const answers = {};
    if (body.questions.holds) {
      const s = script.shift();
      answers.holds = { type: "noul", noul: s?.verify ?? 0.9 };
    } else {
      const s = script.shift() || { op: "BLOCKED" };
      answers.operation = { type: "choice", choice: s.op, confidence: 0.9, probabilities: {} };
      for (const [key, q] of Object.entries(body.questions)) {
        if (key === "operation") continue;
        const refs = Object.keys(q.criteria);
        const want = s.target && key.startsWith(s.op.toLowerCase().replace("type_text", "type"));
        const pick = (want && refs.find((r) => s.target.test(JSON.stringify(q.criteria[r])))) || s.bad || refs[0];
        answers[key] = { type: "choice", choice: pick, confidence: 0.95, probabilities: {} };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers, usage: { input_tokens: 100 } }));
  });
});
await new Promise((r) => server.listen(0, r));
after(() => server.close());
const config = {
  llm: { provider: "claude-cli", model: "t", cli_path: FAKE_CLAUDE, timeout_seconds: 10 },
  browser: { headless: true, timeout: 15000 },
  jev: { enabled: true, base_url: `http://127.0.0.1:${server.address().port}`, api_key: "k" },
};
const inTmp = async (fn) => {
  const prev = process.cwd();
  process.chdir(mkdtempSync(path.join(tmpdir(), "slapify-fast-")));
  try { return await fn(); } finally { process.chdir(prev); }
};
const skip = !hasBrowser && "agent-browser not installed";

test("one Jev request per step picks operation and target; no LLM needed without typing", { skip, timeout: 90_000 }, async () => {
  script = [
    { op: "SELECT", target: /"option \\"Large\\""/ },
    { op: "CLICK", target: /checkbox \\"I agree\\"/ },
    { op: "DONE" },
    { verify: 0.9 },
  ];
  requests.length = 0;
  const r = await inTmp(() => runFast({ goal: "Pick Large and agree", url: FIXTURE, config, keepOpen: true }));
  try {
    assert.equal(r.status, "done", r.reason);
    assert.deepEqual(r.steps.map((s) => s.operation), ["SELECT", "CLICK", "DONE"]);
    assert.equal(r.textCalls, 0);
    const first = requests[0].questions;
    assert.ok(first.operation && first.click_target && first.select_target, "operation and targets asked together");
    // Compatible pools only: nothing editable in the click head, only options in select.
    assert.ok(Object.values(first.select_target.criteria).every((c) => /^option /.test(c.element)));
    assert.ok(!Object.values(first.click_target.criteria).some((c) => /^textbox /.test(c.element)));
    const log = execSync("agent-browser get text body", { encoding: "utf8" });
    assert.match(log, /size=l/);
    assert.match(log, /agree=true/);
  } finally {
    execSync("agent-browser close", { stdio: "ignore" });
  }
});

test("an answer outside the offered set never becomes an action", { skip, timeout: 60_000 }, async () => {
  script = [{ op: "CLICK", target: /nothing/, bad: "e999" }];
  const r = await inTmp(() => runFast({ goal: "x", url: FIXTURE, config }));
  assert.equal(r.status, "error");
  assert.match(r.reason, /invalid click_target/);
  assert.equal(r.steps.length, 0);
});

test("DONE must be verified: rejected claims go back into the loop, then stop", { skip, timeout: 60_000 }, async () => {
  script = [{ op: "DONE" }, { verify: 0.1 }, { op: "DONE" }, { verify: 0.1 }, { op: "DONE" }, { verify: 0.1 }];
  const r = await inTmp(() => runFast({ goal: "x", url: FIXTURE, config }));
  assert.equal(r.status, "blocked", r.reason);
  assert.match(r.reason, /three times/);
});

test("three actions that change nothing stop the run as stuck", { skip, timeout: 60_000 }, async () => {
  // A single click on a double-click-only button does nothing to the page.
  script = [1, 2, 3].map(() => ({ op: "CLICK", target: /Double target/ }));
  const r = await inTmp(() => runFast({ goal: "x", url: FIXTURE, config }));
  assert.equal(r.status, "blocked", r.reason);
  assert.match(r.reason, /changed nothing/);
  assert.equal(r.steps.length, 3);
});

test("a budget ends the run", { skip, timeout: 60_000 }, async () => {
  script = [{ op: "SCROLL_DOWN" }, { op: "SCROLL_DOWN" }];
  const r = await inTmp(() => runFast({ goal: "x", url: FIXTURE, config, maxActions: 1 }));
  assert.equal(r.status, "limit");
});
