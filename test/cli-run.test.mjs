// `slapify run` flags: --credentials was accepted and ignored, and
// --performance was silently dropped under --parallel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "./helpers/harness.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "slapify.js");

function slapify(dir, args, env) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A project with two flows that have no steps, so nothing needs a browser or a model. */
function withFlows() {
  const p = project([]);
  for (const name of ["a", "b"]) writeFileSync(path.join(p.dir, `${name}.flow`), `# ${name}: nothing to do\n`);
  return p;
}

test("--credentials loads profiles from the given file", () => {
  const p = withFlows();
  try {
    writeFileSync(path.join(p.dir, "staging.yaml"), "profiles:\n  admin:\n    type: login-form\n    username: a\n    password: b\n");
    const r = slapify(p.dir, ["run", "a.flow", "--credentials", "staging.yaml"], p.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Using credentials from staging\.yaml \(1 profile\)/);
  } finally {
    p.cleanup();
  }
});

test("--credentials with a missing file is an error, not a silent fallback", () => {
  const p = withFlows();
  try {
    const r = slapify(p.dir, ["run", "a.flow", "--credentials", "nope.yaml"], p.env);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Credentials file not found: nope\.yaml/);
  } finally {
    p.cleanup();
  }
});

test("--performance with --parallel says it will not run, instead of skipping silently", () => {
  const p = withFlows();
  try {
    const r = slapify(p.dir, ["run", "a.flow", "b.flow", "--parallel", "--performance"], p.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /--performance is not supported with --parallel/);
    const sequential = slapify(p.dir, ["run", "a.flow", "b.flow"], p.env);
    assert.doesNotMatch(sequential.out, /not supported/);
  } finally {
    p.cleanup();
  }
});
