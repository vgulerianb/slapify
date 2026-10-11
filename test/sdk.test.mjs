// The SDK: createAgent() runs the same harness as the CLI, from inline config
// alone, and streams events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { FAKE_CLAUDE, call, dist } from "./helpers/harness.mjs";

const { createAgent } = await import(dist("index.js"));

async function inBareDir(responses, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "slapify-sdk-"));
  const script = path.join(dir, "script.json");
  writeFileSync(script, JSON.stringify(responses));
  const prev = process.cwd();
  const prevEnv = { ...process.env };
  process.env.FAKE_CLAUDE_SCRIPT = script;
  process.env.FAKE_CLAUDE_STATE = path.join(dir, "state");
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(prev);
    process.env = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

const config = {
  llm: { provider: "claude-cli", model: "test", cli_path: FAKE_CLAUDE, timeout_seconds: 20 },
  browser: { headless: true },
};

test("createAgent runs a goal from inline config, with no .slapify folder", async () => {
  await inBareDir(
    [call(["remember", { key: "answer", value: "42" }]), call(["done", { summary: "the answer is 42" }])],
    async () => {
      const seen = [];
      const agent = createAgent({ config, onEvent: (e) => seen.push(e.type) });
      const session = await agent.run("find the answer");
      assert.equal(session.status, "completed");
      assert.equal(session.finalSummary, "the answer is 42");
      assert.equal(session.memory.answer, "42");
      assert.ok(seen.includes("done"));
    }
  );
});

test("agent.stream yields events in order and resolves the session", async () => {
  await inBareDir(
    [call(["status_update", { message: "halfway" }]), call(["done", { summary: "streamed" }])],
    async () => {
      const agent = createAgent({ config });
      const stream = agent.stream("stream a goal");
      const types = [];
      for await (const e of stream) types.push(e.type);
      assert.ok(types.indexOf("status_update") < types.indexOf("done"), types.join(","));
      assert.equal((await stream.result).finalSummary, "streamed");
    }
  );
});

test("without any config the error is clear", async () => {
  await inBareDir([], async () => {
    await assert.rejects(() => createAgent().run("anything"), /No \.slapify directory/);
  });
});
