// Phase 4 capabilities: the rest of what a human does in a browser — hover,
// double-click, checkboxes, dropdowns, uploads, downloads, tabs — and the file
// sandbox that keeps uploads from leaking local files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { runScripted, call, dist } from "./helpers/harness.mjs";

const { resolveUploadPath, sanitizeFilename, downloadTarget, resolveFileRoots } = await import(dist("task/files.js"));
const { parseTabList } = await import(dist("browser/agent.js"));
const { effectOf } = await import(dist("task/contracts.js"));

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = `file://${path.join(here, "fixtures", "capabilities.html")}`;

function roots() {
  const dir = mkdtempSync(path.join(tmpdir(), "slapify-files-"));
  const r = { uploads: path.join(dir, "up"), downloads: path.join(dir, "down") };
  mkdirSync(r.uploads);
  mkdirSync(r.downloads);
  return { dir, r };
}

test("uploads resolve inside the uploads folder", () => {
  const { dir, r } = roots();
  writeFileSync(path.join(r.uploads, "cv.pdf"), "x");
  const ok = resolveUploadPath("cv.pdf", r);
  assert.equal(ok.ok, true);
  assert.ok(ok.path.endsWith(path.join("up", "cv.pdf")));
  rmSync(dir, { recursive: true, force: true });
});

test("uploads outside the allowed folders are refused, however they are spelled", () => {
  const { dir, r } = roots();
  writeFileSync(path.join(dir, "secret.txt"), "s");
  assert.equal(resolveUploadPath("/etc/hosts", r).ok, false);
  assert.equal(resolveUploadPath("../secret.txt", r).ok, false);
  assert.equal(resolveUploadPath(path.join(dir, "secret.txt"), r).ok, false);
  // A symlink inside the folder pointing out of it is still outside.
  symlinkSync(path.join(dir, "secret.txt"), path.join(r.uploads, "link.txt"));
  const viaLink = resolveUploadPath("link.txt", r);
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.error, /outside the allowed/);
  rmSync(dir, { recursive: true, force: true });
});

test("a file downloaded earlier can be uploaded", () => {
  const { dir, r } = roots();
  writeFileSync(path.join(r.downloads, "invoice.pdf"), "x");
  assert.equal(resolveUploadPath(path.join(r.downloads, "invoice.pdf"), r).ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("download names are sanitized and never overwrite", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("..\\..\\boot.ini"), "boot.ini");
  assert.equal(sanitizeFilename(".bashrc"), "bashrc");
  assert.equal(sanitizeFilename('a<b>:"c".txt'), "a_b___c_.txt");
  assert.match(sanitizeFilename(""), /^download-\d+$/);
  const { dir, r } = roots();
  const first = downloadTarget("report.txt", r);
  writeFileSync(first, "1");
  const second = downloadTarget("report.txt", r);
  assert.notEqual(first, second);
  assert.equal(path.dirname(second), r.downloads);
  assert.equal(path.basename(second), "report-1.txt");
  rmSync(dir, { recursive: true, force: true });
});

test("file folders default under .slapify and honour config", () => {
  const d = resolveFileRoots(undefined, "/p/.slapify");
  assert.equal(d.uploads, "/p/.slapify/uploads");
  assert.equal(d.downloads, "/p/.slapify/downloads");
  const c = resolveFileRoots({ uploads_dir: "files/in", downloads_dir: "/abs/out" }, "/p/.slapify");
  assert.equal(c.uploads, "/p/files/in");
  assert.equal(c.downloads, "/abs/out");
});

test("tab list output is parsed, including the active marker", () => {
  const tabs = parseTabList(
    "  [t1] Home - Site - https://a.com/\n→ [t2] Sign in - https://b.com/login?x=1\n"
  );
  assert.deepEqual(tabs, [
    { id: "t1", title: "Home - Site", url: "https://a.com/", active: false },
    { id: "t2", title: "Sign in", url: "https://b.com/login?x=1", active: true },
  ]);
});

test("new tools have contracts: uploads are irreversible, a committing double-click too", () => {
  const ctx = { labels: { e1: 'button "Submit"', e2: 'row "Draft"' } };
  assert.equal(effectOf("upload_file", { ref: "e1", paths: ["a"] }, ctx), "irreversible");
  assert.equal(effectOf("double_click", { ref: "e1" }, ctx), "irreversible");
  assert.equal(effectOf("double_click", { ref: "e2" }, ctx), "mutate");
  assert.equal(effectOf("set_checked", { ref: "e2", checked: true }, ctx), "mutate");
  assert.equal(effectOf("list_tabs", {}, ctx), "read");
  assert.equal(effectOf("switch_tab", { id: "t1" }, ctx), "navigate");
});

// Browser tests run in their own agent-browser session (set by `npm test`),
// so they never touch a live agent's browser in the default session.
if (!process.env.AGENT_BROWSER_SESSION) process.env.AGENT_BROWSER_SESSION = "slapify-test";
let hasBrowser = true;
try {
  execSync("agent-browser --version", { stdio: "ignore" });
} catch {
  hasBrowser = false;
}

test("an agent uses every capability on a real page", { skip: !hasBrowser && "agent-browser not installed", timeout: 180_000 }, async () => {
  let downloadsDir;
  const r = await runScripted(
    [
      call(["navigate", { url: FIXTURE }]),
      call(["get_page_state", {}]),
      call(["set_checked", { ref: "e2", checked: true }]),
      call(["set_checked", { ref: "e2", checked: true }]),
      call(["select_option", { ref: "e3", option: "Large" }]),
      call(["hover", { ref: "e4" }]),
      call(["double_click", { ref: "e5" }]),
      call(["upload_file", { ref: "e6", paths: ["/etc/hosts"] }]),
      call(["upload_file", { ref: "e6", paths: ["hello.txt"] }]),
      call(["download_file", { ref: "e7", filename: "../../report.txt" }]),
      call(["get_page_text", {}]),
      call(["list_tabs", {}]),
      call(["done", { summary: "all done" }]),
    ],
    {
      maxIterations: 20,
      setup: (dir) => {
        mkdirSync(path.join(dir, ".slapify", "uploads"));
        writeFileSync(path.join(dir, ".slapify", "uploads", "hello.txt"), "hi");
        downloadsDir = path.join(dir, ".slapify", "downloads");
      },
    }
  );
  const done = (name) => r.events.filter((e) => e.type === "tool_done" && e.toolName === name).map((e) => e.result);
  const errors = r.events.filter((e) => e.type === "tool_error");
  assert.equal(r.session.status, "completed", JSON.stringify(errors));

  const text = done("get_page_text").join("\n");
  // Checking twice is idempotent: exactly one change event, still checked.
  assert.equal((text.match(/agree=true/g) || []).length, 1, text);
  assert.doesNotMatch(text, /agree=false/);
  assert.match(text, /size=l/);
  assert.match(text, /hovered/);
  assert.match(text, /dblclicked/);
  assert.match(text, /file=hello\.txt/);

  const uploads = done("upload_file");
  assert.match(uploads[0], /outside the allowed/);
  assert.match(uploads[1], /hello\.txt/);

  const dl = done("download_file")[0];
  assert.match(dl, /"bytes":14/);
  assert.match(dl, new RegExp(`downloads/report\\.txt`));
  assert.match(done("list_tabs")[0], /"id":"t\d+"/);
  void downloadsDir;
});

test("tabs can be listed, switched and closed", { skip: !hasBrowser && "agent-browser not installed", timeout: 60_000 }, async () => {
  const { BrowserAgent } = await import(dist("browser/agent.js"));
  const b = new BrowserAgent({ headless: true, timeout: 15000 });
  try {
    await b.navigate(FIXTURE);
    execFileSync("agent-browser", ["tab", "new", FIXTURE + "?second"], { stdio: "ignore" });
    const tabs = await b.listTabs();
    assert.equal(tabs.length, 2);
    assert.equal(tabs.filter((t) => t.active).length, 1);
    const first = tabs[0].id;
    await b.switchTab(first);
    assert.doesNotMatch(await b.getUrl(), /second/);
    await b.closeTab(tabs[1].id);
    assert.equal((await b.listTabs()).length, 1);
    await assert.rejects(() => b.switchTab("1; rm -rf /"), /Invalid tab id/);
  } finally {
    await b.close();
  }
});

test("typed text and URLs reach the browser exactly, with no shell in between", { skip: !hasBrowser && "agent-browser not installed", timeout: 60_000 }, async () => {
  const { BrowserAgent } = await import(dist("browser/agent.js"));
  const b = new BrowserAgent({ headless: true, timeout: 15000 });
  // Everything a shell would mangle or execute: backticks, $(), $VAR, quotes,
  // ; & | and a newline-free but glob-heavy tail.
  const nasty = "Pair it with `as const`, costs $5 $(echo pwned) $HOME \"quoted\" it's; a & b | c *.ts";
  try {
    await b.navigate(FIXTURE + "?a=1&b=two&c=3");
    assert.match(await b.getUrl(), /\?a=1&b=two&c=3$/);
    const snap = await b.snapshot();
    const ref = snap.match(/(?:textbox|searchbox)[^\n]*ref=(e\d+)/)?.[1];
    assert.ok(ref, "fixture has a text box");
    await b.fill("@" + ref, nasty);
    // eval prints its result as JSON
    assert.equal(JSON.parse(await b.evaluate("document.getElementById('note').value")), nasty);
    assert.equal(JSON.parse(await b.evaluate("`${1 + 1}`")), "2");
    // Labels for refs without a new snapshot: aria-label first, then text.
    const hov = snap.match(/button "Hover target" \[ref=(e\d+)\]/)[1];
    assert.deepEqual(await b.describeRef(hov), { name: "Hover target", unknown: false });
    assert.deepEqual(await b.describeRef(ref), { name: "Note", unknown: false });
    assert.equal((await b.describeRef("e999")).unknown, true);
  } finally {
    await b.close();
  }
});

test("clicks are checked first: disabled and covered targets are refused", { skip: !hasBrowser && "agent-browser not installed", timeout: 60_000 }, async () => {
  const { BrowserAgent } = await import(dist("browser/agent.js"));
  const b = new BrowserAgent({ headless: true, timeout: 15000 });
  try {
    await b.navigate(`file://${path.join(here, "fixtures", "cover.html")}`);
    const snap = await b.snapshot();
    const ref = (name) => snap.match(new RegExp(`"${name}"[^\\n]*ref=(e\\d+)`))[1];
    assert.match(await b.clickBlocker(ref("Buy now")), /covered by "Cookie banner"/);
    assert.equal(await b.clickBlocker(ref("Free sample")), null);
    assert.match(await b.clickBlocker(ref("Sold out")), /disabled/);
    assert.equal(await b.clickBlocker(ref("Icon link")), null, "a click landing on an icon inside the link is fine");
    assert.match(await b.clickBlocker("e999"), /unknown ref/);
    await b.evaluate("document.getElementById('banner').remove()");
    assert.equal(await b.clickBlocker(ref("Buy now")), null, "clear once the banner is gone");
  } finally {
    await b.close();
  }
});

test("held keys and coordinate clicks reach a canvas inside an iframe", { skip: !hasBrowser && "agent-browser not installed", timeout: 60_000 }, async () => {
  const { BrowserAgent } = await import(dist("browser/agent.js"));
  const b = new BrowserAgent({ headless: true, timeout: 15000 });
  try {
    await b.navigate(`file://${path.join(here, "fixtures", "game.html")}`);
    const input = b.input();
    await input.click(300, 230); // inside the iframe: 200,150 in its own coordinates
    await input.holdKeys(["w"], 400);
    await input.holdKeys(["w", "a"], 150);
    await new Promise((r) => setTimeout(r, 200));
    const log = await b.getText("#log");
    assert.match(log, /click 200,150/, log);
    const held = Number(log.match(/up KeyW (\d+)ms/)?.[1]);
    assert.ok(held >= 350 && held < 900, `W held ${held}ms: ${log}`);
    assert.match(log, /down KeyA held=KeyW\+KeyA/, "two keys down at once");
    await assert.rejects(() => input.holdKeys(["nope"], 10), /Unknown key/);
  } finally {
    await b.close();
  }
});

test("clicks and keys reach a CROSS-ORIGIN iframe (its own process), and the guard doesn't call it covered", { skip: !hasBrowser && "agent-browser not installed", timeout: 60_000 }, async () => {
  // Servers in a child process: BrowserAgent calls are synchronous, so a
  // server in this process could not answer while the browser waits on it.
  const { spawn } = await import("node:child_process");
  const server = spawn(process.execPath, ["-e", `
    const http = require("http");
    const serve = (body) => http.createServer((q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(body()); });
    const child = serve(() => '<body style="margin:0"><button id="b" style="position:absolute;left:150px;top:130px;width:100px;height:40px">PLAY</button><script>const say=m=>parent.postMessage(m,"*");b.onclick=()=>say("button clicked");addEventListener("keydown",e=>say("key "+e.code))</script></body>');
    child.listen(0, "127.0.0.1", () => {
      const cp = child.address().port;
      // 127.0.0.1 vs localhost: different sites, so Chrome isolates the iframe.
      const parent = serve(() => '<body style="margin:0"><p id="log">log:</p><iframe src="http://localhost:' + cp + '/" style="position:absolute;left:100px;top:80px;width:400px;height:300px;border:0"></iframe><script>addEventListener("message",e=>{document.getElementById("log").textContent+=" | "+e.data})</script></body>');
      parent.listen(0, "127.0.0.1", () => console.log(parent.address().port));
    });`], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((r) => server.stdout.once("data", (d) => r(String(d).trim())));
  const { BrowserAgent } = await import(dist("browser/agent.js"));
  const b = new BrowserAgent({ headless: true, timeout: 15000 });
  try {
    await b.navigate(`http://127.0.0.1:${port}/`);
    await new Promise((r) => setTimeout(r, 500));
    const snap = await b.snapshot();
    const play = snap.match(/button "PLAY" \[ref=(e\d+)\]/)?.[1];
    assert.ok(play, snap);
    assert.equal(await b.clickBlocker(play), null, "a target inside an iframe is not 'covered' by the iframe");
    // agent-browser boxes are frame-relative; boxOf adds the frame's offset.
    const box = b.boxOf(play);
    assert.ok(Math.abs(box.x - 250) < 3 && Math.abs(box.y - 210) < 3, JSON.stringify(box));
    await b.input().click(300, 230);
    await b.input().holdKeys(["w"], 80);
    await new Promise((r) => setTimeout(r, 300));
    const log = await b.getText("#log");
    assert.match(log, /button clicked/, log);
    assert.match(log, /key KeyW/, "keys follow the click into the frame");
  } finally {
    await b.close();
    server.kill();
  }
});

test("recording captures the tab being driven: no second tab, input still works, video written", { skip: !hasBrowser && "agent-browser not installed", timeout: 90_000 }, async () => {
  const { BrowserAgent } = await import(dist("browser/agent.js"));
  const { Recorder, findFfmpeg } = await import(dist("browser/recorder.js"));
  if (!findFfmpeg()) return; // no encoder here: nothing to record
  const dir = mkdtempSync(path.join(tmpdir(), "slapify-rec2-"));
  const b = new BrowserAgent({ headless: true, timeout: 15000 });
  const rec = new Recorder(b, dir);
  try {
    await b.navigate(`file://${path.join(here, "fixtures", "game.html")}`);
    await rec.start();
    // agent-browser's own recorder opened a copy of the page in a new tab,
    // which doubled (and in a headed browser broke) a game.
    assert.equal((await b.listTabs()).length, 1, "recording must not open a second tab");
    await b.input().click(300, 230);
    await b.input().holdKeys(["w"], 400);
    await new Promise((r) => setTimeout(r, 300));
    const log = await b.getText("#log");
    assert.match(log, /click 200,150/, log);
    assert.match(log, /up KeyW/, log);
    // Something animating, so Chrome paints far faster than the video rate.
    await b.evaluate("(()=>{let n=0;const d=document.createElement('div');document.body.appendChild(d);(function f(){d.textContent=n++;requestAnimationFrame(f)})();return 'ok'})()");
    const recordedFor = 3000;
    await new Promise((r) => setTimeout(r, recordedFor));
    await rec.stop("done");
    const size = readFileSync(path.join(dir, "video.webm")).length;
    assert.ok(size > 1000, `video.webm is ${size} bytes`);
    // The video must last about as long as the recording did, not longer.
    const probe = (() => { try { execFileSync(findFfmpeg(), ["-i", path.join(dir, "video.webm")], { stdio: "pipe" }); } catch (e) { return String(e.stderr || ""); } return ""; })();
    const m = probe.match(/Duration: (\d+):(\d+):([\d.]+)/);
    assert.ok(m, "ffmpeg reports the video's duration");
    const secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
    const real = (Date.now() - rec.started) / 1000;
    // Both ways: too long (a frame per paint) and too short (a hidden tab
    // that sent no frames) have each happened.
    assert.ok(secs > real * 0.7 && secs < real * 1.3, `video is ${secs}s for a ${real.toFixed(1)}s recording`);
  } finally {
    await b.close();
  }
});

test("once a page is driven by direct input, press() goes the same way (it reaches the iframe)", { skip: !hasBrowser && "agent-browser not installed", timeout: 90_000 }, async () => {
  const { runScripted, call } = await import("./helpers/harness.mjs");
  const r = await runScripted(
    [
      call(["navigate", { url: `file://${path.join(here, "fixtures", "game.html")}` }]),
      call(["click_at", { x: 300, y: 230 }]),
      call(["press", { key: "Enter" }]),
      call(["get_page_text", {}]),
      call(["done", { summary: "ok" }]),
    ],
    { maxIterations: 8 }
  );
  const text = r.events.filter((e) => e.type === "tool_done" && e.toolName === "get_page_text").map((e) => e.result).join("");
  assert.match(text, /down Enter/, text);
});

test("a recording can be watched live: an MJPEG stream of the tab being driven", { skip: !hasBrowser && "agent-browser not installed", timeout: 60_000 }, async () => {
  const { BrowserAgent } = await import(dist("browser/agent.js"));
  const { Recorder } = await import(dist("browser/recorder.js"));
  const http = await import("node:http");
  const b = new BrowserAgent({ headless: true, timeout: 15000 });
  const rec = new Recorder(b, mkdtempSync(path.join(tmpdir(), "slapify-live-")), "live test", { livePort: 0 });
  // Asynchronous reads: the live server runs in this process.
  const readStream = (url) => new Promise((resolve, reject) => {
    const req = http.get(url + "stream", (res) => {
      let got = 0;
      res.on("data", (d) => { got += d.length; if (got > 2000) { req.destroy(); resolve({ type: res.headers["content-type"], bytes: got }); } });
    });
    req.on("error", () => { });
    setTimeout(() => { req.destroy(); reject(new Error("no frames within 10s")); }, 10_000);
  });
  const readJson = (url) => new Promise((resolve, reject) => {
    http.get(url + "status", (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve(JSON.parse(body))); }).on("error", reject);
  });
  try {
    await b.navigate(`file://${path.join(here, "fixtures", "game.html")}`);
    await rec.start();
    assert.match(rec.liveUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    await rec.frame("Looking", { detail: "a caption" });
    const stream = await readStream(rec.liveUrl);
    assert.match(stream.type, /multipart\/x-mixed-replace/);
    assert.ok(stream.bytes > 2000);
    assert.match((await readJson(rec.liveUrl)).caption, /a caption/);
  } finally {
    await rec.stop("done").catch(() => { });
    await b.close();
  }
});

test("page state points out parts the snapshot cannot describe, once per page", async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "slapify-log-")), "prompts.txt");
  process.env.FAKE_CLAUDE_LOG = log;
  await runScripted(
    [
      call(["navigate", { url: `file://${path.join(here, "fixtures", "board.html")}` }]),
      call(["get_page_state", {}]),
      call(["get_page_state", {}]),
      call(["done", { summary: "ok" }]),
    ],
    { maxIterations: 6 }
  );
  const prompts = readFileSync(log, "utf8").split("\n\u0000\n").filter(Boolean);
  const results = [...prompts[prompts.length - 1].matchAll(/name="get_page_state">(.*?)<\/tool_result>/g)].map((m) => m[1]);
  const all = prompts.join("\n");
  // The full advice, shown after the first page state (history may drop it later).
  assert.match(all, /Part of this page is drawn without readable elements.*div#board \(400x400\)/);
  assert.match(all, /text route/);
  assert.doesNotMatch(all, /canvas#bg/, "a background painted behind the page is not flagged");
  // The second call lists the part again with a short reminder, not the full advice.
  const second = JSON.parse(results[results.length - 1]);
  assert.deepEqual(second.unreadable, ["div#board (400x400)"]);
  assert.equal(second.guidance, undefined, "full advice is given once per page");
  assert.match(second.note, /text route/);
});

test("a control hidden off-screen for keyboard users is pressed from the keyboard", async () => {
  const r = await runScripted(
    [
      call(["navigate", { url: `file://${path.join(here, "fixtures", "hidden-control.html")}` }]),
      call(["get_page_state", {}]),
      call(["click", { ref: "e1" }]),
      call(["get_page_text", {}]),
      call(["done", { summary: "ok" }]),
    ],
    { maxIterations: 6 }
  );
  const done = (name) => r.events.filter((e) => e.type === "tool_done" && e.toolName === name).map((e) => String(e.result)).join("");
  // A mouse click at left:-99999px lands on nothing and still "succeeds".
  assert.match(done("get_page_text"), /text mode on/, done("get_page_text"));
  assert.match(done("click"), /keyboard/);
});

test("a click that changes nothing on the page says so, one that does says nothing", async () => {
  const r = await runScripted(
    [
      call(["navigate", { url: `file://${path.join(here, "fixtures", "dead-button.html")}` }]),
      call(["get_page_state", {}]),
      call(["click", { ref: "e1" }]),
      call(["click", { ref: "e2" }]),
      call(["done", { summary: "ok" }]),
    ],
    { maxIterations: 6 }
  );
  const clicks = r.events.filter((e) => e.type === "tool_done" && e.toolName === "click").map((e) => String(e.result));
  assert.equal(clicks.length, 2);
  assert.match(clicks[0], /"page_changed":\s*false/, clicks[0]);
  assert.doesNotMatch(clicks[1], /page_changed/, clicks[1]);
});
