// Credential profiles. One-time codes: real RFC 6238 TOTP (the flow runner
// used to type nothing, from a stub that returned "000000"), get_otp in task
// mode, and the second login step in flows; the secret must never reach a
// log, event or prompt. And inject profiles' cookie domain and path, which
// used to be dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist, FAKE_CLAUDE, runScripted, call } from "./helpers/harness.mjs";

const { generateTOTP, base32Decode, oneTimeCode } = await import(dist("auth/otp.js"));
const { BrowserAgent } = await import(dist("browser/agent.js"));
const { TestRunner } = await import(dist("runner/index.js"));
const { parseFlowContent } = await import(dist("parser/flow.js"));

// RFC 6238 appendix B: the SHA1 seed is the ASCII "12345678901234567890".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

test("TOTP matches the RFC 6238 SHA1 test vectors", () => {
  assert.equal(base32Decode(RFC_SECRET).toString("ascii"), "12345678901234567890");
  for (const [seconds, expected] of RFC_VECTORS) {
    assert.equal(generateTOTP(RFC_SECRET, { time: seconds * 1000, digits: 8 }), expected, `T=${seconds}`);
    // The usual 6-digit code is the same number, truncated.
    assert.equal(generateTOTP(RFC_SECRET, { time: seconds * 1000 }), expected.slice(2), `T=${seconds}, 6 digits`);
  }
});

test("secrets are accepted the way authenticator apps show them", () => {
  const t = { time: 1111111109 * 1000 };
  const spaced = RFC_SECRET.toLowerCase().match(/.{4}/g).join(" ");
  assert.equal(generateTOTP(spaced, t), "081804");
  assert.equal(generateTOTP(`${RFC_SECRET}====`, t), "081804");
});

test("a bad secret is rejected without echoing it", () => {
  const bad = "NOT-A-SECRET-1890";
  assert.throws(() => generateTOTP(bad), (e) => /base32/.test(e.message) && !e.message.includes("1890"));
  assert.throws(() => generateTOTP("  "), /empty/);
});

test("fixed_otp wins over totp_secret, and a profile with neither has no code", async () => {
  assert.deepEqual(await oneTimeCode({ type: "login-form", fixed_otp: 123456, totp_secret: RFC_SECRET }), {
    code: "123456",
    source: "fixed_otp",
  });
  const totp = await oneTimeCode({ type: "login-form", totp_secret: RFC_SECRET });
  assert.equal(totp.source, "totp");
  assert.match(totp.code, /^\d{6}$/);
  assert.ok(totp.expiresInSeconds >= 1 && totp.expiresInSeconds <= 30);
  assert.equal(await oneTimeCode({ type: "login-form", username: "u" }), null);
});

/** Codes valid around now: the current window and the one before it. */
const recentCodes = (secret) => [Date.now(), Date.now() - 30_000].map((time) => generateTOTP(secret, { time }));

const CREDENTIALS =
  `profiles:\n` +
  `  admin:\n    type: login-form\n    username: admin@example.com\n    password: pw\n    totp_secret: ${RFC_SECRET}\n` +
  `  plain:\n    type: login-form\n    username: u\n    password: p\n`;

test("task mode: get_otp hands the model the current code, and keeps code and secret out of the log", async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "slapify-log-")), "prompts.txt");
  process.env.FAKE_CLAUDE_LOG = log;
  let sessionLog = "";
  const events = [];
  try {
    await runScripted(
      [
        call(["list_credential_profiles", {}]),
        call(["get_otp", { profile_name: "admin" }]),
        call(["get_otp", { profile_name: "plain" }]),
        call(["done", { summary: "ok" }]),
      ],
      {
        maxIterations: 6,
        setup: (dir) => writeFileSync(path.join(dir, ".slapify", "credentials.yaml"), CREDENTIALS),
        onEvent: (e) => {
          events.push(e);
          if (e.type !== "done") return;
          const tasks = path.join(process.cwd(), ".slapify", "tasks");
          sessionLog = readdirSync(tasks).map((f) => readFileSync(path.join(tasks, f), "utf8")).join("\n");
        },
      }
    );
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
  }

  const prompts = readFileSync(log, "utf8").split("\n\u0000\n").filter(Boolean);
  const last = prompts[prompts.length - 1];
  const result = (name) => [...last.matchAll(new RegExp(`name="${name}">(.*?)</tool_result>`, "g"))].map((m) => JSON.parse(m[1]));

  const [profiles] = result("list_credential_profiles");
  assert.deepEqual(profiles.profiles.map((p) => [p.name, p.hasOtp]), [["admin", true], ["plain", false]]);

  const [admin, plain] = result("get_otp");
  assert.equal(admin.ok, true);
  assert.ok(recentCodes(RFC_SECRET).includes(admin.code), `got ${admin.code}`);
  assert.ok(admin.expires_in_seconds >= 8, "a code about to expire is not handed out");
  assert.equal(plain.ok, false);
  assert.match(plain.error, /no totp_secret or fixed_otp/);

  // The model saw the code; the session log and the progress events did not.
  const emitted = JSON.stringify(events);
  assert.ok(sessionLog.includes("[redacted]"), "get_otp was logged, redacted");
  for (const text of [sessionLog, emitted]) assert.ok(!text.includes(admin.code));
  for (const text of [sessionLog, emitted, prompts.join("\n")]) assert.ok(!text.includes(RFC_SECRET));
});

// ─── Flow runner ──────────────────────────────────────────────────────────────

/**
 * Run one flow step against a stand-in browser (every call recorded) and a
 * scripted model, so the login sequence can be checked call by call.
 */
async function runFlowStep(step, profiles, responses) {
  const d = mkdtempSync(path.join(tmpdir(), "slapify-flow-"));
  writeFileSync(path.join(d, "script.json"), JSON.stringify(responses));
  const prevEnv = { ...process.env };
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: path.join(d, "script.json"), FAKE_CLAUDE_STATE: path.join(d, "n") });

  const calls = [];
  const fake = {
    getState: async () => ({ url: "https://app.example.com/login", title: "Sign in", snapshot: "- textbox \"Email\" [ref=e1]", refs: {} }),
    fill: async (ref, value) => void calls.push(["fill", ref, value]),
    click: async (ref) => void calls.push(["click", ref]),
    press: async (key) => void calls.push(["press", key]),
    setCookie: async (...args) => void calls.push(["setCookie", ...args]),
    setLocalStorage: async () => { },
    setSessionStorage: async () => { },
    wait: async () => { },
    reload: async () => void calls.push(["reload"]),
    close: async () => { },
  };
  const real = {};
  for (const [name, fn] of Object.entries(fake)) {
    real[name] = BrowserAgent.prototype[name];
    BrowserAgent.prototype[name] = fn;
  }
  try {
    const runner = new TestRunner(
      { llm: { provider: "claude-cli", model: "t", cli_path: FAKE_CLAUDE, timeout_seconds: 20 }, browser: { headless: true }, report: {} },
      { profiles }
    );
    const result = await runner.runFlow(parseFlowContent(step, "otp"));
    return { result, calls, actions: result.steps.flatMap((s) => s.actions) };
  } finally {
    Object.assign(BrowserAgent.prototype, real);
    process.env = prevEnv;
  }
}

const NO_POPUPS = '{"interruptions": []}';
const LOGIN_FORM = '{"found": true, "usernameRef": "e1", "passwordRef": "e2", "submitRef": "e3"}';

test("flows: after the password, the current TOTP code is typed into the code field and submitted", async () => {
  const { result, calls, actions } = await runFlowStep(
    "Login with admin credentials",
    { admin: { type: "login-form", username: "admin@example.com", password: "pw", totp_secret: RFC_SECRET } },
    [NO_POPUPS, LOGIN_FORM, '{"found": true, "inputRef": "e7", "submitRef": "e8"}', NO_POPUPS]
  );
  assert.equal(result.status, "passed", JSON.stringify(result.steps[0].error));
  const fills = calls.filter((c) => c[0] === "fill");
  assert.deepEqual(fills.slice(0, 2), [["fill", "e1", "admin@example.com"], ["fill", "e2", "pw"]]);
  assert.equal(fills[2][1], "e7");
  assert.ok(recentCodes(RFC_SECRET).includes(fills[2][2]), `typed ${fills[2][2]}`);
  assert.notEqual(fills[2][2], "000000");
  assert.deepEqual(calls.filter((c) => c[0] === "click"), [["click", "e3"], ["click", "e8"]]);
  assert.ok(actions.some((a) => a.description === "Entered TOTP code"));
  // Neither the code nor the secret goes into the step log (it ends up in reports).
  const logged = JSON.stringify(actions);
  assert.ok(!logged.includes(fills[2][2]) && !logged.includes(RFC_SECRET));
});

test("flows: a fixed_otp is entered as is, submitted with Enter when there is no button", async () => {
  const { calls, actions } = await runFlowStep(
    "Login with staging credentials",
    { staging: { type: "login-form", username: "qa", password: "pw", fixed_otp: 111222 } },
    [NO_POPUPS, LOGIN_FORM, '{"found": true, "inputRef": "e5"}', NO_POPUPS]
  );
  assert.deepEqual(calls.filter((c) => c[0] === "fill")[2], ["fill", "e5", "111222"]);
  assert.deepEqual(calls[calls.length - 1], ["press", "Enter"]);
  assert.ok(actions.some((a) => a.description === "Entered fixed OTP"));
});

test("flows: a site that doesn't ask for a code (remembered device) still logs in", async () => {
  const { result, calls, actions } = await runFlowStep(
    "Login with admin credentials",
    { admin: { type: "login-form", username: "a", password: "b", totp_secret: RFC_SECRET } },
    [NO_POPUPS, LOGIN_FORM, '{"found": false}', NO_POPUPS]
  );
  assert.equal(result.status, "passed");
  assert.equal(calls.filter((c) => c[0] === "fill").length, 2);
  assert.ok(actions.some((a) => /No one-time code was asked for/.test(a.description)));
});

test("flows: inject profiles pass each cookie's domain and path", async () => {
  const { calls } = await runFlowStep(
    "@inject session",
    {
      session: {
        type: "inject",
        cookies: [
          { name: "auth", value: "t0k", domain: ".example.com", path: "/app" },
          { name: "theme", value: "dark" },
        ],
      },
    },
    [NO_POPUPS]
  );
  assert.deepEqual(calls.filter((c) => c[0] === "setCookie"), [
    ["setCookie", "auth", "t0k", { domain: ".example.com", path: "/app" }],
    ["setCookie", "theme", "dark", { domain: undefined, path: undefined }],
  ]);
});

/**
 * A page that shows which cookies it was sent. It runs in its own process:
 * BrowserAgent drives agent-browser synchronously, which would block a
 * server in this process from ever answering the page load.
 */
async function cookieEchoServer() {
  const child = spawn(process.execPath, [
    "-e",
    `require("http").createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body><p>cookies: " + (req.headers.cookie || "none") + "</p></body></html>");
    }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`,
  ]);
  const port = await new Promise((resolve, reject) => {
    child.stdout.once("data", (d) => resolve(Number(String(d).trim())));
    child.once("error", reject);
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

test("task mode: inject profiles scope cookies to their domain and path", async () => {
  const server = await cookieEchoServer();
  const base = server.base;
  try {
    const r = await runScripted(
      [
        call(["navigate", { url: `${base}/` }]),
        call(["inject_credentials", { profile_name: "session" }]),
        call(["get_page_text", {}]),
        call(["navigate", { url: `${base}/api/` }]),
        call(["get_page_text", {}]),
        call(["done", { summary: "ok" }]),
      ],
      {
        maxIterations: 8,
        setup: (dir) =>
          writeFileSync(
            path.join(dir, ".slapify", "credentials.yaml"),
            "profiles:\n  session:\n    type: inject\n    cookies:\n" +
              "      - name: api_token\n        value: t0k\n        domain: 127.0.0.1\n        path: /api\n" +
              "      - name: theme\n        value: dark\n"
          ),
      }
    );
    const texts = r.events.filter((e) => e.type === "tool_done" && e.toolName === "get_page_text").map((e) => e.result);
    assert.equal(texts.length, 2, JSON.stringify(r.events.filter((e) => e.type === "tool_error")));
    // Without its path, api_token would be set for "/" and sent everywhere.
    assert.match(texts[0], /theme=dark/);
    assert.doesNotMatch(texts[0], /api_token/);
    assert.match(texts[1], /api_token=t0k/);
  } finally {
    server.stop();
  }
});
