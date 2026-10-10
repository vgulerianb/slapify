// Shared scaffolding: a throwaway project dir whose .slapify/config.yaml points
// the claude-cli provider at the fake binary, plus a scripted conversation.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(here, "fake-claude.mjs");
export const dist = (p) => path.join(here, "..", "..", "dist", p);

/** A tool call exactly as the claude-cli protocol expects it. */
export const call = (...calls) =>
  JSON.stringify({ tool_calls: calls.map(([name, args]) => ({ name, arguments: args || {} })) });

export function project(responses, extraConfig = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "slapify-test-"));
  mkdirSync(path.join(dir, ".slapify"));
  const scriptPath = path.join(dir, "script.json");
  const statePath = path.join(dir, "state");
  writeFileSync(scriptPath, JSON.stringify(responses));
  writeFileSync(
    path.join(dir, ".slapify", "config.yaml"),
    `llm:\n  provider: claude-cli\n  model: test\n  cli_path: ${FAKE_CLAUDE}\n  timeout_seconds: 20\n` +
      `browser:\n  headless: true\n  timeout: 15000\nreport:\n  format: json\n  output_dir: ./reports\n${extraConfig}`
  );
  const env = { FAKE_CLAUDE_SCRIPT: scriptPath, FAKE_CLAUDE_STATE: statePath };
  return {
    dir,
    env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run a task in a scripted project and collect the events it emits. */
export async function runScripted(responses, opts = {}, extraConfig = "") {
  const p = project(responses, extraConfig);
  if (opts.setup) opts.setup(p.dir);
  const prev = process.cwd();
  const prevEnv = { ...process.env };
  Object.assign(process.env, p.env);
  process.chdir(p.dir);
  const events = [];
  try {
    const { runTask } = await import(dist("task/runner.js"));
    const session = await runTask({
      goal: opts.goal || "test goal",
      maxIterations: opts.maxIterations || 8,
      onEvent: (e) => events.push(e),
      ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== "setup")),
    });
    return { session, events, messages: events.filter((e) => e.type === "message").map((e) => e.text) };
  } finally {
    process.chdir(prev);
    process.env = prevEnv;
    p.cleanup();
  }
}
