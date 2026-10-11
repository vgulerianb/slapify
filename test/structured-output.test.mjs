// Structured output across scheduled runs. Each cron run is a fresh session,
// so it used to start from nothing and its first write replaced the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScripted, call } from "./helpers/harness.mjs";

function outputFile(initial) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "slapify-out-")), "out.json");
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial));
  return file;
}

const write = (data) => call(["write_output", { data }]);
const done = call(["done", { summary: "recorded" }]);

test("a scheduled run appends to the entries earlier runs left in the file", async () => {
  const file = outputFile([{ headline: "from the first run" }]);
  await runScripted([write({ headline: "from this run" }), done], {
    isScheduledRun: true,
    outputFile: file,
    schema: { type: "array" },
  });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [
    { headline: "from the first run" },
    { headline: "from this run" },
  ]);
});

test("a scheduled run merges into an object, extending its arrays", async () => {
  const file = outputFile({ posts: ["a"], checked: "monday" });
  await runScripted([write({ posts: ["b"], checked: "tuesday" }), write({ posts: ["c"] }), done], {
    isScheduledRun: true,
    outputFile: file,
    schema: { type: "object" },
  });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { posts: ["a", "b", "c"], checked: "tuesday" });
});

test("the first scheduled run, with no file yet, just writes", async () => {
  const file = outputFile();
  await runScripted([write({ headline: "first" }), done], { isScheduledRun: true, outputFile: file });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { headline: "first" });
});
