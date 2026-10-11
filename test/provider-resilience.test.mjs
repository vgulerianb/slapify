// Failures that used to crash or silently end a run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist, FAKE_CLAUDE, call } from "./helpers/harness.mjs";
const require = createRequire(import.meta.url);
const { generateText, tool } = require("ai");
const { z } = require("zod");
const { getModel } = await import(dist("ai/interpreter.js"));

function scripted(responses, env = {}) {
  const d = mkdtempSync(path.join(tmpdir(), "slapify-cli-"));
  const s = path.join(d, "s.json"); writeFileSync(s, JSON.stringify(responses));
  Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: s, FAKE_CLAUDE_STATE: path.join(d, "n"), ...env });
  return getModel({ provider: "claude-cli", model: "t", cli_path: FAKE_CLAUDE, timeout_seconds: 5 });
}
const tools = { navigate: tool({ description: "go", inputSchema: z.object({ url: z.string() }) }) };

test("CLI exiting before reading stdin does not crash the process (EPIPE)", async () => {
  let crashed = false;
  const onCrash = () => { crashed = true; };
  process.on("uncaughtException", onCrash);
  const model = scripted([call(["navigate", { url: "u" }])], { FAKE_CLAUDE_NO_STDIN: "1" });
  const big = "y".repeat(4_000_000); // guarantees the write hits a closed pipe
  const r = await generateText({ model, system: "t", tools, messages: [{ role: "user", content: big }] });
  await new Promise((r) => setTimeout(r, 300));
  process.off("uncaughtException", onCrash);
  delete process.env.FAKE_CLAUDE_NO_STDIN;
  assert.equal(crashed, false);
  assert.equal(r.toolCalls.length, 1);
});

test("a hung CLI call times out with a clear message", async () => {
  const model = scripted([call(["navigate", { url: "u" }])], { FAKE_CLAUDE_HANG_MS: "8000" });
  await assert.rejects(
    generateText({ model, system: "t", tools, messages: [{ role: "user", content: "go" }] }),
    /timed out/
  );
  delete process.env.FAKE_CLAUDE_HANG_MS;
});
