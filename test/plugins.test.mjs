// plugins.rules: rule files are appended to the system prompt. Loading them
// called require() inside an ES module and failed with "require is not defined".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dist, runScripted, call } from "./helpers/harness.mjs";

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

// plugins.tools: tools written for AI SDK 3 (`parameters` + `execute`) must
// keep working alongside current ones (`inputSchema`), and run exactly once:
// the SDK used to run them too, before the runner ran them again.
test("plugin tools in the old (parameters) and new (inputSchema) style are called once, with their args", async () => {
  const zod = import.meta.resolve("zod");
  globalThis.__pluginCalls = [];
  const r = await runScripted(
    [
      call(["legacy_weather", { city: "Paris" }], ["modern_weather", { city: "Oslo" }]),
      call(["done", { summary: "checked" }]),
    ],
    {
      setup: (dir) => {
        mkdirSync(path.join(dir, ".slapify", "tools"));
        writeFileSync(
          path.join(dir, ".slapify", "tools", "weather.mjs"),
          `import { z } from ${JSON.stringify(zod)};\n` +
            `export const legacy_weather = { description: "Weather (AI SDK 3 style)", parameters: z.object({ city: z.string() }),\n` +
            `  execute: async (args) => { globalThis.__pluginCalls.push(["legacy", args]); return { forecast: "sun in " + args.city }; } };\n` +
            `export const modern_weather = { description: "Weather (current style)", inputSchema: z.object({ city: z.string() }),\n` +
            `  execute: async (args) => { globalThis.__pluginCalls.push(["modern", args]); return { forecast: "rain in " + args.city }; } };\n`
        );
      },
    },
    "plugins:\n  tools:\n    - tools/weather.mjs\n"
  );
  assert.equal(r.session.status, "completed");
  assert.deepEqual(globalThis.__pluginCalls, [["legacy", { city: "Paris" }], ["modern", { city: "Oslo" }]]);
  const done = (name) => r.events.find((e) => e.type === "tool_done" && e.toolName === name)?.result || "";
  assert.match(done("legacy_weather"), /sun in Paris/);
  assert.match(done("modern_weather"), /rain in Oslo/);
});
