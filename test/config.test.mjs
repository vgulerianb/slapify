import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist } from "./helpers/harness.mjs";
const { loadConfig } = await import(dist("config/loader.js"));

function cfg(yaml) {
  const d = mkdtempSync(path.join(tmpdir(), "slapify-cfg-"));
  mkdirSync(path.join(d, ".slapify"));
  writeFileSync(path.join(d, ".slapify", "config.yaml"), yaml);
  return loadConfig(path.join(d, ".slapify"));
}

test("${VAR} is substituted from the environment", () => {
  process.env.SLAPIFY_TEST_KEY = "secret123";
  const c = cfg("llm:\n  provider: anthropic\n  model: m\n  api_key: ${SLAPIFY_TEST_KEY}\n");
  assert.equal(c.llm[0].api_key, "secret123");
});
test("an unset ${VAR} becomes an empty string (why run.sh must guard Telegram)", () => {
  delete process.env.SLAPIFY_TEST_UNSET;
  const c = cfg("llm:\n  provider: anthropic\n  model: m\ntelegram:\n  bot_token: t\n  allowed_chat_id: ${SLAPIFY_TEST_UNSET}\n");
  assert.equal(c.telegram.allowed_chat_id, "");
});
test("llm is always normalised to a fallback list", () => {
  assert.ok(Array.isArray(cfg("llm:\n  provider: anthropic\n  model: m\n").llm));
});
test("browser defaults to headless", () => {
  assert.equal(cfg("llm:\n  provider: anthropic\n  model: m\n").browser.headless, true);
});
