// codex provider: ChatGPT sign-in tokens, the Responses request it sends, the
// SSE stream it reads, and token refresh, against local fakes (no network).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateText, tool } from "ai";
import { z } from "zod";
import { dist } from "./helpers/harness.mjs";

// A token whose claims carry the ChatGPT account id, like OpenAI's.
const jwt = (claims) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const accessToken = (n, account = "acct_1") =>
  jwt({ n, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: account } });

// ── Fake Codex endpoint + fake OpenAI auth server ──────────────────────────
let plan = [];
const seen = [];
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ url: req.url, headers: req.headers, body: raw ? (req.url.includes("token") && !raw.startsWith("{") ? raw : JSON.parse(raw)) : null });
    const step = plan.shift() || { status: 500 };
    res.writeHead(step.status, { "content-type": step.events ? "text/event-stream" : "application/json" });
    res.end(step.events ? sse(step.events) : JSON.stringify(step.json || {}));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const dir = mkdtempSync(path.join(tmpdir(), "slapify-codex-"));
const authFile = path.join(dir, "chatgpt-auth.json");
process.env.SLAPIFY_CHATGPT_AUTH_FILE = authFile;
process.env.SLAPIFY_CHATGPT_ISSUER = base;
process.env.SLAPIFY_CODEX_BASE_URL = base;
const signIn = (extra = {}) =>
  writeFileSync(authFile, JSON.stringify({
    access_token: accessToken(1), refresh_token: "r1", expires_at: Date.now() + 3600_000, account_id: "acct_1", ...extra,
  }));

const { createCodexModel, toResponsesInput, readResponsesStream } = await import(dist("ai/codex.js"));
const { authorizeUrl, getChatGPTAuth, isLoopbackUrl } = await import(dist("ai/chatgpt-auth.js"));
const { classifyLlmError } = await import(dist("task/recovery.js"));

const completed = (output, usage = { input_tokens: 120, output_tokens: 7 }) => ({
  type: "response.completed",
  response: { status: "completed", output, usage },
});

test("sign-in URL is the Codex PKCE flow, with slapify as originator", () => {
  const u = new URL(authorizeUrl("http://localhost:1455/auth/callback", "chal", "st"));
  assert.equal(u.origin + u.pathname, `${base}/oauth/authorize`);
  assert.equal(u.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(u.searchParams.get("originator"), "slapify");
  assert.match(u.searchParams.get("scope"), /offline_access/);
});

test("only loopback URLs may override the real endpoints", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:9/x"), true);
  assert.equal(isLoopbackUrl("https://evil.example"), false);
  assert.equal(isLoopbackUrl("http://evil.example"), false);
});

test("prompt becomes instructions + Responses items, screenshots as real images", () => {
  const { instructions, input } = toResponsesInput([
    { role: "system", content: "You are slapify." },
    { role: "user", content: [{ type: "text", text: "Go" }] },
    { role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "tool-call", toolCallId: "c1", toolName: "screenshot", args: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "screenshot", result: { ok: true },
      content: [{ type: "text", text: "shot" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", toolName: "click", result: { ok: true } }] },
  ]);
  assert.equal(instructions, "You are slapify.");
  assert.deepEqual(input[0], { type: "message", role: "user", content: [{ type: "input_text", text: "Go" }] });
  assert.equal(input[1].content[0].type, "output_text");
  assert.deepEqual(input[2], { type: "function_call", call_id: "c1", name: "screenshot", arguments: "{}" });
  assert.equal(input[3].type, "function_call_output");
  assert.equal(input[3].output[1].type, "input_image");
  assert.equal(input[3].output[1].image_url, "data:image/png;base64,AAAA");
  assert.equal(input[4].output, '{"ok":true}');
});

test("a tool call comes back as a native tool call, with usage", async () => {
  signIn();
  seen.length = 0;
  plan = [{ status: 200, events: [
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "navigate", arguments: '{"url":"https://example.com"}' } },
    completed([{ type: "function_call", call_id: "call_1", name: "navigate", arguments: '{"url":"https://example.com"}' }]),
  ] }];
  const r = await generateText({
    model: createCodexModel({ model: "gpt-5.4-mini", reasoningEffort: "low" }),
    system: "Be brief.",
    prompt: "Open example.com",
    tools: { navigate: tool({ description: "Open a URL", parameters: z.object({ url: z.string() }) }) },
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].toolName, "navigate");
  assert.deepEqual(r.toolCalls[0].args, { url: "https://example.com" });
  assert.equal(r.usage.promptTokens, 120);

  const req = seen[0];
  assert.equal(req.url, "/responses");
  assert.equal(req.headers.authorization, `Bearer ${accessToken(1)}`);
  assert.equal(req.headers["chatgpt-account-id"], "acct_1");
  assert.equal(req.headers.originator, "slapify");
  assert.equal(req.headers["openai-beta"], "responses=experimental");
  assert.equal(req.body.model, "gpt-5.4-mini");
  assert.equal(req.body.store, false);
  assert.equal(req.body.stream, true);
  assert.equal(req.body.instructions, "Be brief.");
  assert.equal(req.body.max_output_tokens, undefined);
  assert.deepEqual(req.body.reasoning, { effort: "low" });
  assert.equal(req.body.tools[0].type, "function");
  assert.equal(req.body.tools[0].name, "navigate");
  assert.equal(req.body.tools[0].strict, false);
  assert.equal(req.body.tool_choice, "auto");
});

test("streamed text is assembled when there is no final output", async () => {
  signIn();
  plan = [{ status: 200, events: [
    { type: "response.output_text.delta", output_index: 0, delta: "po" },
    { type: "response.output_text.delta", output_index: 0, delta: "ng" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1 } } },
  ] }];
  const r = await generateText({ model: createCodexModel(), prompt: "ping" });
  assert.equal(r.text, "pong");
});

test("an expired access token is refreshed first, and a rotated refresh token is saved", async () => {
  signIn({ expires_at: Date.now() - 1000 });
  seen.length = 0;
  plan = [
    { status: 200, json: { access_token: accessToken(2), refresh_token: "r2", expires_in: 3600 } },
    { status: 200, events: [completed([{ type: "message", content: [{ type: "output_text", text: "ok" }] }])] },
  ];
  const r = await generateText({ model: createCodexModel(), prompt: "hi" });
  assert.equal(r.text, "ok");
  assert.equal(seen[0].url, "/oauth/token");
  assert.equal(seen[0].body.grant_type, "refresh_token");
  assert.equal(seen[0].body.refresh_token, "r1");
  assert.equal(seen[1].headers.authorization, `Bearer ${accessToken(2)}`);
  const saved = JSON.parse(readFileSync(authFile, "utf8"));
  assert.equal(saved.refresh_token, "r2");
  assert.equal(statSync(authFile).mode & 0o777, 0o600);
});

test("a 401 forces one refresh and the request is retried", async () => {
  signIn();
  seen.length = 0;
  plan = [
    { status: 401, json: { error: "expired" } },
    { status: 200, json: { access_token: accessToken(3), expires_in: 3600 } },
    { status: 200, events: [completed([{ type: "message", content: [{ type: "output_text", text: "again" }] }])] },
  ];
  const r = await generateText({ model: createCodexModel(), prompt: "hi" });
  assert.equal(r.text, "again");
  assert.deepEqual(seen.map((s) => s.url), ["/responses", "/oauth/token", "/responses"]);
  // Not rotated: the old refresh token is kept.
  assert.equal(JSON.parse(readFileSync(authFile, "utf8")).refresh_token, "r1");
});

test("a refresh that switches accounts is refused", async () => {
  signIn({ expires_at: 0 });
  plan = [{ status: 200, json: { access_token: accessToken(4, "acct_OTHER"), expires_in: 3600 } }];
  await assert.rejects(getChatGPTAuth(), /different account/);
});

test("a plan usage limit is classified so the run waits instead of dying", async () => {
  signIn();
  plan = [{ status: 200, events: [
    { type: "response.failed", response: { error: { code: "usage_limit_reached", message: "You've hit your usage limit." } } },
  ] }];
  const err = await generateText({ model: createCodexModel(), prompt: "hi", maxRetries: 0 }).catch((e) => e);
  assert.match(String(err?.message), /usage limit reached/);
  assert.equal(classifyLlmError(err), "provider");

  plan = [{ status: 429, json: { error: { message: "slow down" } } }];
  const err2 = await generateText({ model: createCodexModel(), prompt: "hi", maxRetries: 0 }).catch((e) => e);
  assert.equal(classifyLlmError(err2), "provider");
});

test("not signed in gives a clear instruction", async () => {
  writeFileSync(authFile, "{}");
  const err = await generateText({ model: createCodexModel(), prompt: "hi", maxRetries: 0 }).catch((e) => e);
  assert.match(String(err?.message), /slapify login codex/);
});

test("the stream reader tolerates CRLF framing and ignores junk lines", async () => {
  const body = new Blob([
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"a"}\r\n\r\n',
    ": keep-alive\r\n\r\n",
    'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ab"}]}]}}\r\n\r\n',
  ]).stream();
  const r = await readResponsesStream(body);
  assert.equal(r.text, "ab");
});
