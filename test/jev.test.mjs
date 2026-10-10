// Jev: candidate extraction, shortlisting, config, and the HTTP client's
// retry/fallback behaviour against a local fake server (no network).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dist } from "./helpers/harness.mjs";
const { JevClient } = await import(dist("jev/client.js"));
const { extractCandidates, shortlist, findElement, findElements, wantedRoles } = await import(dist("jev/decisions.js"));
const pages = JSON.parse(readFileSync(new URL("./fixtures/tweet-pages.json", import.meta.url)));

test("refs are found even when other attributes share the brackets", () => {
  const c = extractCandidates('- heading "Title" [level=2, ref=e2]\n- button "Like" [ref=e7]\n- textbox "Post text" [ref=e9]');
  assert.deepEqual(c.map((x) => x.ref), ["e7", "e9"]);
});

test("non-interactive lines are not offered as targets", () => {
  const c = extractCandidates('- heading "Hello" [level=2, ref=e2]\n- paragraph "text" [ref=e3]');
  assert.equal(c.length, 0);
});

test("shortlist never exceeds Jev's 255-option cap", () => {
  for (const p of pages) {
    assert.ok(shortlist(extractCandidates(p.snapshot), "the reply box").length <= 255, p.name);
  }
});

test("the true target survives shortlisting on every real page", () => {
  for (const p of pages) {
    const pool = shortlist(extractCandidates(p.snapshot), "the text box for writing a reply to the main tweet").map((c) => c.ref);
    assert.ok(pool.includes(p.truth.reply), `${p.name}: reply box dropped`);
    const likePool = shortlist(extractCandidates(p.snapshot), "the Like button for the main tweet").map((c) => c.ref);
    assert.ok(likePool.includes(p.truth.like), `${p.name}: like button dropped`);
  }
});

test("config: disabled, keyless and providerless all disable cleanly", () => {
  assert.equal(JevClient.fromConfig(undefined).client, null);
  assert.equal(JevClient.fromConfig({ enabled: false }).client, null);
  assert.match(JevClient.fromConfig({ enabled: true, provider: "vercel" }).reason, /api_key/);
  assert.match(JevClient.fromConfig({ enabled: true, api_key: "k" }).reason, /provider/);
});

test("config: every provider preset speaks the same /v1/systemone path", () => {
  const url = (provider) => new JevClient({ provider, api_key: "k" }).url;
  assert.equal(url("typesafe"), "https://api.typesafe.ai/v1/systemone");
  assert.equal(url("vercel"), "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
  assert.equal(url("openrouter"), "https://openrouter.ai/api/v1/systemone");
  assert.equal(new JevClient({ base_url: "http://proxy/", api_key: "k" }).url, "http://proxy/v1/systemone");
});

// ── HTTP behaviour against a local fake ────────────────────────────────────
let plan = [];
let hits = 0;
let lastBody = null;
// Answers every question it is asked with the step's choice (default e9).
const answerAll = (body, choice = "e9", confidence = 0.93) =>
  Object.fromEntries(Object.keys(body?.questions || {}).map((k) => [k, { type: "choice", choice, confidence, probabilities: { [choice]: confidence } }]));
const server = http.createServer((req, res) => {
  hits++;
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    lastBody = raw ? JSON.parse(raw) : null;
    const step = plan.shift() || { status: 200 };
    if (step.delay) return setTimeout(() => res.end(), step.delay);
    res.writeHead(step.status, { "content-type": "application/json", ...(step.headers || {}) });
    res.end(step.status === 200
      ? JSON.stringify({ answers: answerAll(lastBody, step.choice, step.confidence), usage: { input_tokens: 42 } })
      : JSON.stringify({ error: { message: "nope" } }));
  });
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const client = (extra = {}) => new JevClient({ base_url: base, api_key: "k", ...extra });
const snap = '- button "Like" [ref=e7]\n- textbox "Post text" [ref=e9]';

test("a successful answer is returned with confidence and token count", async () => {
  plan = [{ status: 200 }];
  const v = await findElement(client(), snap, "reply box");
  assert.equal(v.ref, "e9");
  assert.equal(v.confident, true);
  assert.equal(v.inputTokens, 42);
});

test("high demand (429) is retried, then succeeds", async () => {
  plan = [{ status: 429, headers: { "retry-after": "0" } }, { status: 200 }];
  hits = 0;
  const v = await findElement(client(), snap, "reply box");
  assert.equal(v.ref, "e9");
  assert.equal(hits, 2);
});

test("a bad key (401) is NOT retried and returns an error, never throws", async () => {
  plan = [{ status: 401 }];
  hits = 0;
  const v = await findElement(client(), snap, "reply box");
  assert.ok("error" in v);
  assert.match(v.error, /api_key/);
  assert.equal(hits, 1);
});

test("persistent overload gives up after a bounded number of attempts", async () => {
  plan = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
  hits = 0;
  const v = await findElement(client(), snap, "reply box");
  assert.ok("error" in v);
  assert.equal(hits, 3); // first try + 2 retries
});

test("x-should-retry: false is honoured", async () => {
  plan = [{ status: 503, headers: { "x-should-retry": "false" } }];
  hits = 0;
  await findElement(client(), snap, "reply box");
  assert.equal(hits, 1);
});

test("a hung server times out instead of stalling the agent", async () => {
  plan = [{ delay: 3000 }];
  const t = Date.now();
  const v = await findElement(client({ timeout_ms: 400 }), snap, "reply box");
  assert.ok("error" in v);
  assert.ok(Date.now() - t < 2000);
});

test("a low-confidence answer is flagged as not confident", async () => {
  plan = [{ status: 200, choice: "e9", confidence: 0.4 }];
  const v = await findElement(client(), snap, "the reply text box");
  assert.equal(v.confident, false);
});

// ── Ideas from browser-use/jev-ultrafast ───────────────────────────────────
test("candidates carry their container, position and state", () => {
  const tree = [
    '- article "Ann @ann: shipping v2 today" [ref=e1]',
    '  - button "12 Likes. Like" [ref=e2]',
    '  - article "Bob @bob: congrats" [ref=e3]',
    '    - button "2 Likes. Like" [ref=e4]',
    '- checkbox "Remember me" [checked=false, ref=e5]',
    '- combobox "Size" [expanded=false, ref=e6]: Small',
    '- button "Follow" [ref=e7]',
    '- button "Follow" [ref=e8]',
  ].join("\n");
  const c = Object.fromEntries(extractCandidates(tree).map((x) => [x.ref, x]));
  assert.equal(c.e2.context, 'article "Ann @ann: shipping v2 today"');
  assert.equal(c.e4.context, 'article "Bob @bob: congrats"');
  assert.deepEqual(c.e5.state, { checked: "false" });
  assert.deepEqual(c.e6.state, { expanded: "false", value: "Small" });
  assert.equal(c.e7.position, "1 of 2");
  assert.equal(c.e8.position, "2 of 2");
});

test("only compatible elements are offered: a text box is never a button", () => {
  const cands = extractCandidates('- button "Reply" [ref=e1]\n- textbox "Post your reply" [ref=e2]\n- link "Reply guide" [ref=e3]');
  assert.deepEqual(shortlist(cands, "the text box for writing a reply").map((c) => c.ref), ["e2"]);
  assert.deepEqual(shortlist(cands, "the Reply button").map((c) => c.ref), ["e1"]);
  assert.deepEqual(shortlist(cands, "the reply guide link").map((c) => c.ref), ["e3"]);
  // No kind named: everything stays in play.
  assert.equal(shortlist(cands, "reply").length, 3);
  assert.equal(wantedRoles("something vague"), null);
});

test("several elements are found in ONE request, each from its own compatible pool", async () => {
  plan = [{ status: 200, choice: "e9" }];
  hits = 0;
  const r = await findElements(client(), snap, ["the reply text box", "the Like button"], { url: "https://x.com/a/status/1" });
  assert.equal(hits, 1);
  assert.deepEqual(Object.keys(lastBody.questions), ["target_0", "target_1"]);
  assert.deepEqual(Object.keys(lastBody.questions.target_0.criteria), ["e9", "none"]);
  assert.deepEqual(Object.keys(lastBody.questions.target_1.criteria), ["e7", "none"]);
  assert.match(lastBody.state, /x\.com\/a\/status\/1/);
  // e9 is valid for the text box; for the Like button it was never offered.
  assert.equal(r[0].ref, "e9");
  assert.ok("error" in r[1], "an answer outside the offered set is rejected");
});

test("'none of these' is offered, and choosing it means not found", async () => {
  plan = [{ status: 200, choice: "none", confidence: 0.9 }];
  const v = await findElement(client(), snap, "the reply text box");
  assert.ok("error" in v);
  assert.match(v.error, /No element on this page/);
});

test("a dropped connection is retried instead of failing the decision", async () => {
  let n = 0;
  const flaky = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (n++ === 0) return req.socket.destroy(); // reset before answering
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: answerAll(JSON.parse(raw)), usage: { input_tokens: 1 } }));
    });
  });
  await new Promise((r) => flaky.listen(0, r));
  const v = await findElement(new JevClient({ base_url: `http://127.0.0.1:${flaky.address().port}`, api_key: "k" }), snap, "the reply text box");
  flaky.close();
  assert.equal(v.ref, "e9");
  assert.equal(n, 2);
});
