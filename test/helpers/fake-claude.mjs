#!/usr/bin/env node
// Stand-in for the `claude` binary, so provider and runner behaviour can be
// tested deterministically without a model. Replays FAKE_CLAUDE_SCRIPT (a JSON
// array of raw `result` strings) one per call, tracking position in
// FAKE_CLAUDE_STATE. After the script runs out, the last entry repeats.
//
// FAKE_CLAUDE_NO_STDIN=1 exits without reading stdin, to provoke EPIPE in the
// parent. FAKE_CLAUDE_HANG_MS delays the reply, to provoke timeouts.
// FAKE_CLAUDE_LOG appends each prompt received to that file, so tests can
// read what the model was actually shown (tool results in full).
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";

const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
const statePath = process.env.FAKE_CLAUDE_STATE;
const n = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) || 0 : 0;
writeFileSync(statePath, String(n + 1));

const reply = () => {
  const entry = script[Math.min(n, script.length - 1)];
  // { raw: "..." } prints stdout verbatim, to simulate a broken CLI response.
  if (entry && typeof entry === "object" && "raw" in entry) {
    process.stdout.write(entry.raw);
    return;
  }
  process.stdout.write(
    JSON.stringify({ result: entry, usage: { input_tokens: 100, output_tokens: 10 } })
  );
};

if (process.env.FAKE_CLAUDE_NO_STDIN === "1") {
  reply();
  process.exit(0);
}
const hang = Number(process.env.FAKE_CLAUDE_HANG_MS || 0);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, input + "\n\u0000\n");
  hang ? setTimeout(reply, hang) : reply();
});
