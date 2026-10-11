// pursue: the fast look → Jev picks a move → act loop for canvas apps.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScripted, call } from "./helpers/harness.mjs";

if (!process.env.AGENT_BROWSER_SESSION) process.env.AGENT_BROWSER_SESSION = "slapify-test";
const here = path.dirname(fileURLToPath(import.meta.url));
let hasBrowser = true;
try { execSync("agent-browser --version", { stdio: "ignore" }); } catch { hasBrowser = false; }

let moves = [];
const asked = [];
const jev = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    asked.push(body);
    const next = moves.shift() || { choice: "stuck", confidence: 0.9 };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers: { move: { type: "choice", ...next, probabilities: {} } }, usage: { input_tokens: 50 } }));
  });
});
await new Promise((r) => jev.listen(0, r));
after(() => jev.close());
const cfg = () => `vision: true\njev:\n  enabled: true\n  base_url: http://127.0.0.1:${jev.address().port}\n  api_key: k\n`;
const FIXTURE = `file://${path.join(here, "fixtures", "game.html")}`;
const skip = !hasBrowser && "agent-browser not installed";

test("pursue loops look → Jev move → act until done, in ONE model turn", { skip, timeout: 120_000 }, async () => {
  moves = [{ choice: "forward_short", confidence: 0.8 }, { choice: "interact", confidence: 0.7 }, { choice: "done", confidence: 0.9 }];
  asked.length = 0;
  const r = await runScripted(
    [
      call(["navigate", { url: FIXTURE }]),
      call(["click_at", { x: 300, y: 230 }]),
      call(["pursue", { goal: "walk to the box and open it", keys: { interact: "e" }, max_steps: 5 }]),
      // The three vision reads inside pursue come from the same fake model:
      "TARGET: box, centre, medium. BLOCKED: no. PROMPT: none. DONE: no",
      "TARGET: box, centre, touching. BLOCKED: no. PROMPT: Press E. DONE: no",
      "TARGET: box open. BLOCKED: no. PROMPT: none. DONE: yes",
      // The second look that confirms "done":
      "YES - the box is open on screen.",
      call(["done", { summary: "pursued" }]),
    ],
    { maxIterations: 10 },
    cfg()
  );
  assert.equal(r.session.status, "completed", r.messages.join(" | "));
  assert.equal(asked.length, 3, "one Jev decision per step");
  assert.match(asked[0].state, /centre, medium/, "Jev decides from the vision text");
  assert.deepEqual(Object.keys(asked[0].questions.move.criteria).sort(), ["back_up", "done", "forward_left", "forward_long", "forward_right", "forward_short", "interact", "stuck", "turn_left", "turn_right", "wait"]);
});

test("pursue hands back when Jev is unsure", { skip, timeout: 120_000 }, async () => {
  moves = [{ choice: "turn_left", confidence: 0.1 }];
  asked.length = 0;
  const r = await runScripted(
    [
      call(["navigate", { url: FIXTURE }]),
      call(["pursue", { goal: "find the exit" }]),
      "TARGET: not visible. BLOCKED: yes, wall. PROMPT: none. DONE: no",
      call(["done", { summary: "handed back" }]),
    ],
    { maxIterations: 8 },
    cfg()
  );
  assert.equal(r.session.status, "completed");
  assert.equal(asked.length, 1);
});

test("look_for on an action returns a before/after comparison in the same step", { skip, timeout: 90_000 }, async () => {
  const r = await runScripted(
    [
      call(["navigate", { url: FIXTURE }]),
      call(["hold_keys", { keys: ["w"], ms: 100, look_for: "did anything move?" }]),
      "BEFORE vs AFTER: the box moved left. Yes, it moved.",
      call(["done", { summary: "looked" }]),
    ],
    { maxIterations: 6 },
    "vision: true\n"
  );
  const res = r.events.find((e) => e.type === "tool_done" && e.toolName === "hold_keys")?.result || "";
  assert.match(res, /"look":"BEFORE vs AFTER: the box moved left/, res);
  assert.match(res, /"held":\["w"\]/);
});

test("a run of manual movement steps gets a hint to use pursue", { skip, timeout: 120_000 }, async () => {
  moves = [];
  const w = () => call(["hold_keys", { keys: ["w"], ms: 50 }]);
  const r = await runScripted(
    [call(["navigate", { url: FIXTURE }]), w(), w(), w(), w(), w(), call(["done", { summary: "walked" }])],
    { maxIterations: 10 },
    cfg()
  );
  const holds = r.events.filter((e) => e.type === "tool_done" && e.toolName === "hold_keys").map((e) => e.result);
  assert.equal(holds.length, 5);
  assert.doesNotMatch(holds[3], /hand it to pursue/);
  assert.match(holds[4], /5 manual movement steps in a row/);
});

test("a 'done' the second look disagrees with is rejected and the loop carries on", { skip, timeout: 120_000 }, async () => {
  moves = [{ choice: "done", confidence: 0.9 }, { choice: "stuck", confidence: 0.9 }];
  asked.length = 0;
  const r = await runScripted(
    [
      call(["navigate", { url: FIXTURE }]),
      call(["pursue", { goal: "get into the car", max_steps: 4 }]),
      "TARGET: car, touching. DONE: yes",
      "NO - he is standing beside the car, not in it.",
      "TARGET: car, touching. DONE: no",
      call(["done", { summary: "checked" }]),
    ],
    { maxIterations: 8 },
    cfg()
  );
  const res = r.events.find((e) => e.type === "tool_done" && e.toolName === "pursue")?.result || "";
  assert.match(res, /"outcome":"stuck"/, res);
  assert.match(res, /"steps":2/, "the rejected done counted as a step, then the loop went on");
  assert.equal(asked.length, 2, "kept deciding after the rejected done");
});
