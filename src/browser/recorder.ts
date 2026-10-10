/**
 * Record a run: an annotated frame per step, a WebM video when ffmpeg is
 * available, and a self-contained replay.html to step through them.
 *
 *   <dir>/frames/000.png …   the page just before each step, with the target
 *                             outlined and a caption bar saying what happens
 *   <dir>/video.webm          the whole run in real time, from a screencast
 *                             of the tab being driven (needs ffmpeg; the copy
 *                             Playwright ships is found automatically)
 *   <dir>/steps.json          what each frame shows, with timings
 *   <dir>/replay.html         open it in a browser: play, scrub, click a step
 *
 * The outline and caption are injected into the page for the moment of the
 * screenshot, so the video shows them too, and removed before the action
 * runs, so they can never cover or intercept anything.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawn, ChildProcess } from "child_process";
import http from "http";
import { BrowserAgent } from "./agent.js";

export interface RecordedStep {
  frame: string;
  caption: string;
  detail?: string;
  ref?: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

const OVERLAY_ID = "__slapify_rec";

/** An ffmpeg binary agent-browser can use for video, or null. */
export function findFfmpeg(): string | null {
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)[0]
      .trim();
    if (found) return found;
  } catch { }
  // Playwright downloads its own ffmpeg next to its browsers.
  const caches = [
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright"),
  ];
  for (const dir of caches) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((d) => d.startsWith("ffmpeg")).sort().reverse();
    } catch {
      continue;
    }
    for (const e of entries) {
      for (const bin of ["ffmpeg-mac", "ffmpeg-linux", "ffmpeg-win64.exe", "ffmpeg"]) {
        const p = path.join(dir, e, bin);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export class Recorder {
  readonly dir: string;
  private steps: RecordedStep[] = [];
  private started = Date.now();
  private video: string | null = null;
  private videoNote = "";

  private ffmpeg: string | null = null;

  private encoder: ChildProcess | null = null;
  private lastFrame: Buffer | null = null;
  private lastTs = 0;
  private static FPS = 25;

  private liveServer: http.Server | null = null;
  private liveClients = new Set<http.ServerResponse>();
  private liveCaption = "";
  private livePort: number | undefined;

  constructor(private browser: BrowserAgent, dir: string, private title = "Slapify run", options: { video?: boolean; livePort?: number } = {}) {
    this.dir = path.resolve(dir);
    if (options.video !== false) this.ffmpeg = findFfmpeg();
    this.livePort = options.livePort;
  }

  /**
   * Watch the run live: the same frames that go into video.webm, served as an
   * MJPEG stream at http://127.0.0.1:<port>/ with the current step as a
   * caption. Loopback only. For headless runs, where there is no window.
   */
  private startLive(port: number): Promise<string> {
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(this.title)} · live</title>
<style>body{margin:0;background:#0c1014;color:#e9ebe7;font:15px -apple-system,system-ui,sans-serif}
header{padding:10px 14px;display:flex;gap:12px;align-items:center}b{color:#ff8a5c}
img{display:block;width:100%;max-width:1280px;margin:0 auto}#cap{padding:10px 14px;color:#cfd4cf}</style></head>
<body><header><b>● LIVE</b><span>${esc(this.title)}</span></header><img src="/stream" alt="live view of the browser"><div id="cap"></div>
<script>setInterval(async()=>{try{const r=await fetch("/status");const j=await r.json();document.getElementById("cap").textContent=j.caption||""}catch{}},1000)</script></body></html>`;
    this.liveServer = http.createServer((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store", Connection: "close" });
        this.liveClients.add(res);
        if (this.lastFrame) this.pushLive(this.lastFrame, res);
        req.on("close", () => this.liveClients.delete(res));
        return;
      }
      if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ caption: this.liveCaption, steps: this.steps.length }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
    });
    return new Promise((resolve, reject) => {
      this.liveServer!.once("error", reject);
      this.liveServer!.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${(this.liveServer!.address() as any).port}/`));
    });
  }

  private pushLive(jpeg: Buffer, only?: http.ServerResponse): void {
    const head = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`;
    for (const res of only ? [only] : this.liveClients) {
      try {
        res.write(head);
        res.write(jpeg);
        res.write("\r\n");
      } catch { }
    }
  }

  /** Where to watch the run live, once started with a live port. */
  liveUrl: string | null = null;

  /**
   * Write frames at a constant rate: Chrome only sends a frame when the page
   * paints, so the previous frame is repeated to fill the gap in time.
   */
  private writeFrame(jpeg: Buffer, ts: number): void {
    if (this.liveClients.size) this.pushLive(jpeg);
    const stdin = this.encoder?.stdin;
    if (!stdin || stdin.destroyed) {
      this.lastFrame = jpeg;
      this.lastTs = ts;
      return;
    }
    // Keep video time equal to real time. Chrome paints faster than the
    // video's frame rate when the page animates and not at all when it is
    // still, so emit exactly as many frames as the elapsed time needs: none
    // for a frame that arrived early, several to fill a pause. (Writing at
    // least one per paint made a 15-minute run come out 32 minutes long.)
    if (this.firstTs === null) this.firstTs = ts;
    if (this.lastFrame) {
      const due = Math.round((ts - this.firstTs) * Recorder.FPS);
      const n = Math.min(due - this.written, Recorder.FPS * 60);
      for (let i = 0; i < n; i++) stdin.write(this.lastFrame);
      this.written += Math.max(0, n);
    }
    this.lastFrame = jpeg;
    this.lastTs = ts;
  }

  private firstTs: number | null = null;
  private written = 0;


  /** Call once the browser has a page open. */
  async start(options: { video?: boolean } = {}): Promise<void> {
    fs.mkdirSync(path.join(this.dir, "frames"), { recursive: true });
    this.started = Date.now();
    if (this.livePort !== undefined) {
      try {
        this.liveUrl = await this.startLive(this.livePort);
        // Frames for the live view even when there is no encoder.
        if (!this.ffmpeg || options.video === false) await this.browser.input().startScreencast((jpeg, ts) => this.writeFrame(jpeg, ts));
      } catch { }
    }
    if (options.video === false) return;
    if (!this.ffmpeg) {
      this.videoNote = "No video: ffmpeg not found (install it, or Playwright's copy, to get video.webm).";
      return;
    }
    const out = path.join(this.dir, "video.webm");
    try {
      // The same encoder settings Playwright uses for its own video capture.
      this.encoder = spawn(this.ffmpeg, [
        "-loglevel", "error", "-f", "image2pipe", "-avioflags", "direct", "-fpsprobesize", "0",
        "-probesize", "32", "-analyzeduration", "0", "-c:v", "mjpeg", "-i", "pipe:0",
        "-y", "-an", "-r", String(Recorder.FPS), "-c:v", "vp8", "-qmin", "0", "-qmax", "50",
        "-crf", "8", "-deadline", "realtime", "-speed", "8", "-b:v", "1M", out,
      ], { stdio: ["pipe", "ignore", "pipe"] });
      this.encoder.on("error", (e) => {
        this.videoNote = `No video: ${e.message}`;
        this.video = null;
      });
      this.encoder.stdin?.on("error", () => { });
      await this.browser.input().startScreencast((jpeg, ts) => this.writeFrame(jpeg, ts));
      this.video = out;
    } catch (e: any) {
      this.videoNote = `No video: ${String(e?.message || e).split("\n")[0]}`;
      this.encoder?.kill();
      this.encoder = null;
    }
  }

  /**
   * One annotated frame: outline `ref` (when given) and caption the page with
   * what is about to happen, screenshot, then take the annotations away.
   */
  async frame(caption: string, options: { ref?: string; point?: { x: number; y: number }; detail?: string; meta?: Record<string, unknown> } = {}): Promise<void> {
    const n = String(this.steps.length).padStart(3, "0");
    const file = path.join("frames", `${n}.png`);
    let box: { x: number; y: number; w: number; h: number } | null = null;
    if (options.ref) box = this.browser.boxOf(options.ref);
    const label = `${caption}${options.detail ? `  ·  ${options.detail}` : ""}`.slice(0, 180);
    this.liveCaption = `${Math.round((Date.now() - this.started) / 1000)}s · ${label}`;
    const inject =
      `(()=>{const o=document.createElement("div");o.id=${JSON.stringify(OVERLAY_ID)};o.setAttribute("aria-hidden","true");` +
      `o.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:2147483647";` +
      (box
        ? `const b=document.createElement("div");b.style.cssText="position:fixed;left:${box.x - 4}px;top:${box.y - 4}px;width:${box.w + 8}px;height:${box.h + 8}px;border:3px solid #ff6a3d;border-radius:6px;box-shadow:0 0 0 4px rgba(255,106,61,.25)";o.appendChild(b);`
        : "") +
      (options.point
        ? `const p=document.createElement("div");p.style.cssText="position:fixed;left:${options.point.x - 14}px;top:${options.point.y - 14}px;width:28px;height:28px;border:3px solid #ff6a3d;border-radius:50%;box-shadow:0 0 0 4px rgba(255,106,61,.3)";o.appendChild(p);`
        : "") +
      `const c=document.createElement("div");c.textContent=${JSON.stringify(label)};` +
      `c.style.cssText="position:fixed;left:0;right:0;bottom:0;padding:10px 16px;background:rgba(12,16,20,.88);color:#fff;font:600 15px/1.35 -apple-system,system-ui,sans-serif";` +
      `o.appendChild(c);document.documentElement.appendChild(o);return "ok"})()`;
    try {
      await this.browser.evaluate(inject);
    } catch { }
    try {
      await this.browser.screenshot(path.join(this.dir, file));
    } catch { }
    try {
      await this.browser.evaluate(`(()=>{document.getElementById(${JSON.stringify(OVERLAY_ID)})?.remove();return "ok"})()`);
    } catch { }
    this.steps.push({ frame: file, caption, detail: options.detail, ref: options.ref, elapsedMs: Date.now() - this.started, meta: options.meta });
  }

  /** Final frame, stop the video, write steps.json and replay.html. Returns the replay path. */
  async stop(summary: string): Promise<string> {
    await this.frame("Finished", { detail: summary.slice(0, 140) });
    if (this.video && this.encoder) {
      await this.browser.input().stopScreencast().catch(() => { });
      // Hold the last frame for a second so the ending is visible, then finish.
      if (this.lastFrame) this.writeFrame(this.lastFrame, this.lastTs + 1);
      const enc = this.encoder;
      this.encoder = null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { enc.kill("SIGKILL"); resolve(); }, 20_000);
        enc.on("close", () => { clearTimeout(t); resolve(); });
        enc.stdin?.end();
      });
      if (!fs.existsSync(this.video) || fs.statSync(this.video).size === 0) {
        this.video = null;
        this.videoNote = "No video: recording did not produce a file.";
      }
    }
    if (this.liveServer) {
      for (const res of this.liveClients) try { res.end(); } catch { }
      this.liveClients.clear();
      this.liveServer.close();
      this.liveServer = null;
    }
    fs.writeFileSync(path.join(this.dir, "steps.json"), JSON.stringify({ title: this.title, summary, video: this.video ? "video.webm" : null, steps: this.steps }, null, 2));
    const replay = path.join(this.dir, "replay.html");
    fs.writeFileSync(replay, this.html(summary));
    return replay;
  }

  private html(summary: string): string {
    const data = JSON.stringify({ steps: this.steps, video: this.video ? "video.webm" : null }).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(this.title)} · replay</title>
<style>
:root{--bg:#fafaf8;--fg:#1c1f1d;--muted:#667;--line:#e2e0da;--card:#fff;--accent:#e2572b;--soft:#fde8df}
@media (prefers-color-scheme:dark){:root{--bg:#121412;--fg:#e9ebe7;--muted:#9aa39c;--line:#2e332f;--card:#1a1d1b;--accent:#f0804a;--soft:#3a2519}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}.sum{color:var(--muted);margin:0 0 18px}
.stage{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#0c1014}.stage img,.stage video{display:block;width:100%;height:auto}
.bar{display:flex;gap:10px;align-items:center;margin:12px 0;flex-wrap:wrap}.bar input{flex:1;min-width:140px;accent-color:var(--accent)}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.tabs button[aria-pressed=true]{background:var(--soft)}
.steps{border:1px solid var(--line);border-radius:12px;max-height:320px;overflow:auto;background:var(--card)}
.step{display:grid;grid-template-columns:64px 1fr;gap:10px;padding:7px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.step:last-child{border-bottom:0}.step[aria-current=true]{background:var(--soft)}.t{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:13px}
.d{color:var(--muted)}.note{color:var(--muted);font-size:13px;margin-top:8px}
</style></head><body><main>
<h1>${esc(this.title)}</h1><p class="sum">${esc(summary)}</p>
<div class="tabs bar" id="tabs"></div>
<div class="stage" id="stage"></div>
<div class="bar" id="ctl"><button class="primary" id="play">▶ Play</button><button id="prev" aria-label="Previous">←</button><button id="next" aria-label="Next">→</button><input type="range" id="r" min="0" value="0" aria-label="Step"><span id="pos"></span></div>
<div class="steps" id="list"></div>
${this.videoNote ? `<p class="note">${esc(this.videoNote)}</p>` : ""}
</main><script>
const D=${data};let cur=0,timer=null,mode="frames";
const stage=document.getElementById("stage"),list=document.getElementById("list"),r=document.getElementById("r"),pos=document.getElementById("pos"),play=document.getElementById("play");
r.max=D.steps.length-1;
D.steps.forEach((s,i)=>{const row=document.createElement("div");row.className="step";row.innerHTML='<span class="t">+'+(s.elapsedMs/1000).toFixed(1)+'s</span><span><b></b> <span class="d"></span></span>';row.querySelector("b").textContent=s.caption;row.querySelector(".d").textContent=s.detail||"";row.onclick=()=>{stop();show(i)};list.appendChild(row)});
function show(i){cur=Math.max(0,Math.min(D.steps.length-1,i));if(mode==="video"){const v=stage.querySelector("video");if(v)v.currentTime=D.steps[cur].elapsedMs/1000}else{stage.innerHTML='<img alt="">';const img=stage.querySelector("img");img.src=D.steps[cur].frame;img.alt=D.steps[cur].caption+" "+(D.steps[cur].detail||"")}
r.value=cur;pos.textContent="step "+(cur+1)+" / "+D.steps.length;[...list.children].forEach((c,j)=>c.setAttribute("aria-current",j===cur));}
function stop(){clearInterval(timer);timer=null;play.textContent="▶ Play"}
play.onclick=()=>{if(timer)return stop();if(cur>=D.steps.length-1)show(0);play.textContent="❚❚ Pause";timer=setInterval(()=>cur>=D.steps.length-1?stop():show(cur+1),1400)};
document.getElementById("prev").onclick=()=>{stop();show(cur-1)};document.getElementById("next").onclick=()=>{stop();show(cur+1)};r.oninput=()=>{stop();show(+r.value)};
function setMode(m){mode=m;stop();[...document.querySelectorAll("#tabs button")].forEach(b=>b.setAttribute("aria-pressed",b.dataset.m===m));document.getElementById("ctl").style.display=m==="video"?"none":"flex";if(m==="video"){stage.innerHTML='<video controls src="'+D.video+'"></video>'}show(cur)}
const tabs=document.getElementById("tabs");for(const [m,l] of [["frames","Step by step"],["video","Video"]]){if(m==="video"&&!D.video)continue;const b=document.createElement("button");b.dataset.m=m;b.textContent=l;b.onclick=()=>setMode(m);tabs.appendChild(b)}
if(!D.video)tabs.style.display="none";setMode("frames");
</script></body></html>`;
  }
}
