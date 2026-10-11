// Task-mode recording and the harness-enforced time limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScripted, call } from "./helpers/harness.mjs";

if (!process.env.AGENT_BROWSER_SESSION) process.env.AGENT_BROWSER_SESSION = "slapify-test";
const here = path.dirname(fileURLToPath(import.meta.url));
let hasBrowser = true;
try { execSync("agent-browser --version", { stdio: "ignore" }); } catch { hasBrowser = false; }

test("the time limit stops a task that would otherwise keep going", async () => {
  const busy = Array.from({ length: 400 }, (_, i) => call(["remember", { key: `k${i}`, value: "v" }]));
  const r = await runScripted(busy, { timeLimitMinutes: 0.004, maxIterations: 400 });
  assert.equal(r.session.status, "completed", `${r.session.finalSummary} | ${r.messages.slice(-3).join(" | ")}`);
  assert.match(r.session.finalSummary, /Time limit of 0.004 minutes reached/);
  assert.ok(r.session.iteration < 400, `stopped early at ${r.session.iteration}`);
});

test("a recorded run writes annotated frames, steps.json and replay.html", { skip: !hasBrowser && "agent-browser not installed", timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slapify-rec-"));
  const r = await runScripted(
    [
      call(["navigate", { url: `file://${path.join(here, "fixtures", "game.html")}` }]),
      call(["click_at", { x: 300, y: 230 }]),
      call(["hold_keys", { keys: ["w"], ms: 150 }]),
      call(["done", { summary: "recorded" }]),
    ],
    { record: dir, maxIterations: 10 }
  );
  assert.equal(r.session.status, "completed");
  const steps = JSON.parse(readFileSync(path.join(dir, "steps.json"), "utf8"));
  assert.deepEqual(steps.steps.map((s) => s.caption), ["Opened", "Click", "Hold w", "Finished"]);
  for (const s of steps.steps) assert.ok(existsSync(path.join(dir, s.frame)), s.frame);
  assert.ok(existsSync(path.join(dir, "replay.html")));
  assert.ok(r.messages.some((m) => /Recording: .*replay\.html/.test(m)));
});
