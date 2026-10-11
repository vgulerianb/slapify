// Task mode builds its own browser. It used to copy a handful of `browser:`
// fields by hand and drop the rest, so browserbase and audio never applied,
// though flows and `slapify fast` honoured them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dist, runScripted, call } from "./helpers/harness.mjs";

const { BrowserAgent } = await import(dist("browser/agent.js"));

/** The BrowserAgent a task run created, caught when the run closes it. */
async function browserOfRun(opts) {
  let agent = null;
  const realClose = BrowserAgent.prototype.close;
  BrowserAgent.prototype.close = async function () {
    agent = this;
  };
  try {
    await runScripted([call(["done", { summary: "ok" }])], opts);
  } finally {
    BrowserAgent.prototype.close = realClose;
  }
  return agent;
}

test("task mode applies browser.browserbase and browser.audio from config", async () => {
  const agent = await browserOfRun({
    config: { browser: { audio: true, browserbase: { api_key: "bb-test", project_id: "proj" } } },
  });
  assert.deepEqual(agent.config.browserbase, { api_key: "bb-test", project_id: "proj" });
  assert.equal(agent.config.audio, true);
  assert.ok(!agent.launchArgList().includes("--mute-audio"), "a headless browser with audio on is not muted");
  assert.equal(agent.config.timeout, 15000, "the rest of browser: still applies");
});

test("run options still override their config counterparts", async () => {
  const agent = await browserOfRun({ headed: true, stealth: true, config: { browser: { headless: true, stealth: false } } });
  assert.equal(agent.config.headless, false);
  assert.equal(agent.config.stealth, true);
  assert.equal(agent.config.audio, undefined);
});
