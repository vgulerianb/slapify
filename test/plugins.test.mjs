// plugins.rules: rule files are appended to the system prompt. Loading them
// called require() inside an ES module and failed with "require is not defined".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist } from "./helpers/harness.mjs";

const { buildSystemPrompt } = await import(dist("task/prompt.js"));

function capturingErrors(fn) {
  const errors = [];
  const real = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    return { result: fn(), errors };
  } finally {
    console.error = real;
  }
}

test("a rules file from plugins.rules is loaded, relative to the .slapify folder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slapify-rules-"));
  mkdirSync(path.join(dir, "rules"));
  writeFileSync(path.join(dir, "rules", "persona.md"), "Always sign off as Bob.");
  const { result: prompt, errors } = capturingErrors(() =>
    buildSystemPrompt("check the weather", undefined, { rules: ["rules/persona.md"] }, dir)
  );
  assert.deepEqual(errors, []);
  assert.match(prompt, /## Custom User Rule: rules\/persona\.md\nAlways sign off as Bob\./);
});

test("a missing rules file is a warning, not a crash", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "slapify-rules-"));
  const { result: prompt, errors } = capturingErrors(() =>
    buildSystemPrompt("check the weather", undefined, { rules: ["rules/missing.md"] }, dir)
  );
  assert.ok(prompt.length > 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing\.md.*ENOENT/);
});
