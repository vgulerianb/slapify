// OpenAI Decisions as a Jev backend: questions translated out, answers
// translated back, and the existing Jev helpers working on top of it,
// against a local fake of POST /v1/decisions (no network).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { dist } from "./helpers/harness.mjs";
const { JevClient, toDecisionsRequest, fromDecisionsResponse } = await import(dist("jev/client.js"));
const { findElement, checkStatement } = await import(dist("jev/decisions.js"));

test("config: the openai preset targets /v1/decisions with gpt-6-luna", () => {
  const c = new JevClient({ provider: "openai", api_key: "k" });
  assert.equal(c.url, "https://api.openai.com/v1/decisions");
  assert.equal(c.model, "gpt-6-luna");
  assert.equal(c.label, "OpenAI Decisions");
  assert.match(JevClient.fromConfig({ enabled: true, provider: "openai" }).reason, /OPENAI_API_KEY/);
  // A proxy in front of it keeps the protocol when told to.
  const p = new JevClient({ base_url: "http://proxy", path: "/v1/decisions", protocol: "decisions", api_key: "k" });
  assert.equal(p.label, "OpenAI Decisions");
});

test("questions translate: choice → choice, yes/no → predicate, score → levels", () => {
  const { body, names } = toDecisionsRequest("gpt-6-luna", "page text", {
    target: { type: "choice", instructions: "Which button posts?", criteria: { e7: "Like", e9: { role: "button", name: "Post" } } },
    done: { type: "noul", instructions: "Is it posted?", criteria: { true: "A success toast shows", false: "No toast" } },
    severity: { type: "score", instructions: "How bad?", criteria: ["fine", "broken"] },
  });
  assert.deepEqual(names, ["target", "done", "severity"]);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.input, "page text");
  const [c, p, s] = body.questions;
  assert.deepEqual(c, {
    type: "choice", name: "q0", instructions: "Which button posts?",
    choices: [{ value: "e7", description: "Like" }, { value: "e9", description: '{"role":"button","name":"Post"}' }],
  });
  assert.equal(p.type, "predicate");
  assert.equal(p.name, "q1");
  assert.match(p.instructions, /True when: A success toast shows\nFalse when: No toast/);
  assert.equal(s.type, "score");
  assert.deepEqual(s.levels.map((l) => l.description), ["fine", "broken"]);
});

test("answers translate back to Jev's shape; refusals and unknown choices are dropped", () => {
  const questions = {
    target: { type: "choice", instructions: "", criteria: { e7: "", e9: "" } },
    done: { type: "noul", instructions: "", criteria: { true: "", false: "" } },
    bad: { type: "choice", instructions: "", criteria: { a: "" } },
    refused: { type: "noul", instructions: "", criteria: { true: "", false: "" } },
  };
  const a = fromDecisionsResponse({ answers: [
    { type: "choice", name: "q0", choice: "e9", confidence: 0.91, probabilities: [{ value: "e7", probability: 0.04 }, { value: "e9", probability: 0.96 }] },
    { type: "predicate", name: "q1", probability: 0.12 },
    { type: "choice", name: "q2", choice: "zzz", confidence: 0.99, probabilities: [] },
    { type: "refusal", name: "q3" },
  ] }, ["target", "done", "bad", "refused"], questions);
  assert.deepEqual(a.target, { type: "choice", choice: "e9", confidence: 0.91, probabilities: { e7: 0.04, e9: 0.96 } });
  assert.deepEqual(a.done, { type: "noul", noul: 0.12 });
  assert.equal(a.bad, undefined);
  assert.equal(a.refused, undefined);
});

// ── The Jev helpers, end to end, on the Decisions backend ─────────────────
let lastReq = null;
let reply = null;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    lastReq = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(reply.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.json));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const client = () => new JevClient({
  base_url: `http://127.0.0.1:${server.address().port}`, path: "/v1/decisions", protocol: "decisions",
  model: "gpt-6-luna", api_key: "sk-test",
});

test("find_element works unchanged on the Decisions backend", async () => {
  reply = { json: { answers: [{ type: "choice", name: "q0", choice: "e9", confidence: 0.9, probabilities: [] }] } };
  const v = await findElement(client(), '- button "Like" [ref=e7]\n- textbox "Post text" [ref=e9]', "reply box");
  assert.equal(v.ref, "e9");
  assert.equal(v.confident, true);
  assert.equal(lastReq.url, "/v1/decisions");
  assert.equal(lastReq.auth, "Bearer sk-test");
  assert.equal(lastReq.body.questions[0].type, "choice");
});

test("check works unchanged on the Decisions backend", async () => {
  reply = { json: { answers: [{ type: "predicate", name: "q0", probability: 0.97 }] } };
  const v = await checkStatement(client(), "Your post was sent.", "The post was sent");
  assert.equal(v.probability, 0.97);
  assert.equal(lastReq.body.questions[0].type, "predicate");
});

test("errors are labelled as OpenAI Decisions and never throw", async () => {
  reply = { status: 401, json: { error: { message: "bad key" } } };
  const r = await client().decide("x", { q: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /^OpenAI Decisions HTTP 401/);
});
