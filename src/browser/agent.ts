import { execSync, execFileSync, spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { BrowserConfig, BrowserState, RefInfo } from "../types.js";
import { createBrowserbaseSession } from "./browserbase.js";

// Fingerprint-evasion script injected via `agent-browser --init-script` when
// `config.stealth` is enabled. Lives alongside the compiled agent.js.
const STEALTH_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "stealth-init.js"
);

// Chromium launch flag automation-detection scripts key off of.
const STEALTH_ARG = "--disable-blink-features=AutomationControlled";

// Cap on agent-browser stdout. Full-page snapshots of large SPAs run to
// several MB; Node's 1MB execSync default truncated them mid-JSON.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Transient errors that should trigger automatic retry
const TRANSIENT_ERRORS = [
  "Execution context was destroyed",
  "Target closed",
  "Navigation interrupted",
  "Protocol error",
  "Session closed",
  "Page crashed",
  "Frame was detached",
  "Cannot find context",
];

/**
 * Wrapper around agent-browser CLI
 */
export class BrowserAgent {
  private config: BrowserConfig;
  private isOpen: boolean = false;

  constructor(config: BrowserConfig = {}) {
    this.config = {
      headless: true,
      timeout: 30000,
      viewport: { width: 1280, height: 720 },
      ...config,
    };
  }

  /** Chromium launch args, including the stealth flag when enabled. */
  private launchArgList(): string[] {
    const args = new Set(this.config.args || []);
    // A headless browser has no window, so any sound it makes (a video, a
    // game) comes out of the speakers with nothing on screen to explain it.
    // Muted unless asked for. Headed browsers keep their sound.
    if (this.config.headless !== false && !this.config.audio) args.add("--mute-audio");
    if (this.config.stealth) {
      args.add(STEALTH_ARG);
    }
    return Array.from(args);
  }

  /**
   * Launch options as CLI flags for `open`.
   *
   * These have to go on the command line rather than through AGENT_BROWSER_*
   * env vars: agent-browser ignores/mishandles those when launching headed,
   * which strands the browser on about:blank (or chrome-error with a
   * profile). The CLI flags work in both modes, so they are always used.
   */
  private launchFlags(): string[] {
    const flags: string[] = [];
    if (this.config.profile) {
      flags.push("--profile", this.config.profile);
    }
    if (this.config.userAgent) {
      flags.push("--user-agent", this.config.userAgent);
    }
    if (this.config.stealth) {
      flags.push("--init-script", STEALTH_SCRIPT_PATH);
    }
    const args = this.launchArgList();
    if (args.length > 0) {
      flags.push("--args", args.join(","));
    }
    return flags;
  }

  /**
   * Check if an error is transient and should be retried
   */
  private isTransientError(errorMessage: string): boolean {
    return TRANSIENT_ERRORS.some((e) =>
      errorMessage.toLowerCase().includes(e.toLowerCase())
    );
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): void {
    execSync(`sleep ${ms / 1000}`);
  }

  /**
   * Execute an agent-browser command with auto-retry for transient errors
   */
  private exec(
    command: string,
    args: string[] = [],
    retries: number = 2
  ): string {
    // Arguments go straight to agent-browser with no shell in between. Text
    // the model types, URLs it navigates to and scripts it evaluates are
    // arbitrary strings, often shaped by the page: through a shell, a backtick
    // or $(...) in a reply would run as a command, "$5" would vanish, and an
    // "&" in a URL would cut it short. Only used for display below.
    const fullCommand = ["agent-browser", command, ...args].join(" ");

    // Launch options are passed as CLI flags on `open` (see launchFlags()).
    // They are ALSO exported as AGENT_BROWSER_* env vars, but only in headless
    // mode: agent-browser does not apply those env vars correctly when it
    // launches headed — any of AGENT_BROWSER_ARGS / _PROFILE / _USER_AGENT
    // leaves the browser stranded on about:blank or chrome-error. In headless
    // they work, and they usefully cover the case where a command other than
    // `open` is what auto-launches the browser.
    const env = { ...process.env };
    if (this.config.headless !== false) {
      if (this.config.executablePath) {
        env.AGENT_BROWSER_EXECUTABLE_PATH = this.config.executablePath;
      }
      if (this.config.profile) {
        env.AGENT_BROWSER_PROFILE = this.config.profile;
      }
      if (this.config.userAgent) {
        env.AGENT_BROWSER_USER_AGENT = this.config.userAgent;
      }
      if (this.config.stealth) {
        env.AGENT_BROWSER_INIT_SCRIPTS = STEALTH_SCRIPT_PATH;
      }
      const launchArgs = this.launchArgList();
      if (launchArgs.length > 0) {
        // agent-browser expects comma or newline separated args via environment
        env.AGENT_BROWSER_ARGS = launchArgs.join(",");
      }
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = execFileSync("agent-browser", [command, ...args], {
          encoding: "utf-8",
          timeout: this.config.timeout,
          stdio: ["pipe", "pipe", "pipe"],
          env,
          // Node defaults to 1MB. A full accessibility snapshot of a heavy SPA
          // blows past that, and execSync then throws ENOBUFS *with partial
          // stdout attached* — which used to be returned as if it were the
          // whole result, yielding truncated JSON and silently empty refs.
          maxBuffer: MAX_OUTPUT_BYTES,
        });
        return result.trim();
      } catch (error: any) {
        const stderrStr = error.stderr?.toString() || "";
        const stdoutStr = error.stdout?.toString() || "";
        let errorMsg = error.message || stderrStr || "";
        const fullErrorText = `${errorMsg} ${stdoutStr}`;

        // Output overflowed the buffer. The partial stdout attached to this
        // error is a truncated fragment — returning it downstream produces
        // unparseable JSON and an empty ref set with no visible failure, so
        // surface it as an error instead of passing the fragment along.
        if (error.code === "ENOBUFS") {
          throw new Error(
            `Browser command produced more than ${Math.round(
              MAX_OUTPUT_BYTES / (1024 * 1024)
            )}MB of output and was truncated: ${fullCommand}`
          );
        }

        // Special case: If browser daemon is dead/stuck, try to close it and retry
        if (fullErrorText.includes("Browser not launched") && attempt < retries) {
          try {
            execSync("agent-browser close", { stdio: "ignore" });
          } catch {
            // ignore close error
          }
          this.sleep(1000);
          continue;
        }

        // Filter out non-fatal daemon warnings
        const isJustWarning =
          fullErrorText.includes("daemon already running") ||
          fullErrorText.includes("--executable-path ignored");

        // If we have stdout, return it (some commands output to stdout even on "error")
        if (stdoutStr) {
          const stdout = stdoutStr.trim();
          // If it's just a warning and we have stdout, return stdout
          if (isJustWarning && stdout) {
            return stdout;
          }
          // Check if stdout contains an actual error message
          if (!this.isTransientError(stdout)) {
            return stdout;
          }
        }

        // If it's just a warning with no output, consider it success
        if (isJustWarning) {
          return "";
        }

        // Check if this is a transient error worth retrying
        if (this.isTransientError(errorMsg) && attempt < retries) {
          // Wait before retry (with exponential backoff)
          this.sleep(500 * (attempt + 1));
          continue;
        }

        lastError = new Error(
          `Browser command failed: ${fullCommand}\n${errorMsg}`
        );
      }
    }

    throw lastError || new Error(`Browser command failed: ${fullCommand}`);
  }

  /**
   * Check if agent-browser is installed
   */
  static isInstalled(): boolean {
    try {
      execSync("agent-browser --version", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install agent-browser and its browser
   */
  static install(): void {
    console.log("Installing agent-browser...");
    execSync("npm install -g agent-browser", { stdio: "inherit" });
    console.log("Installing browser...");
    execSync("agent-browser install", { stdio: "inherit" });
  }

  private hasInitialized = false;
  /** Guards the one-time stealth User-Agent relaunch (see navigate()). */
  private uaFixupDone = false;
  /** CDP URL for Browserbase remote sessions — set once, reused for the lifetime of the task. */
  private browserbaseCdpUrl: string | null = null;
  private browserbaseSessionId: string | null = null;

  /**
   * Navigate to a URL
   */
  async navigate(url: string): Promise<void> {
    // ── Browserbase: create session on first use, connect via CDP ──────────
    if (this.config.browserbase && !this.hasInitialized) {
      const { api_key, project_id } = this.config.browserbase;
      try {
        const session = await createBrowserbaseSession(api_key, project_id);
        this.browserbaseCdpUrl = session.cdpUrl;
        this.browserbaseSessionId = session.id;
        // Attach agent-browser to the remote session
        this.exec("connect", [this.browserbaseCdpUrl]);
        this.hasInitialized = true;
      } catch (err: any) {
        throw new Error(`Browserbase session error: ${err.message}`);
      }
    }

    const args: string[] = [];

    // On first navigation, close any existing browser to apply our settings
    // This ensures headed mode, executable path, and stealth init scripts are
    // applied correctly — a daemon left running by an earlier call was launched
    // without them, and they can only be registered before the first navigation
    if (
      !this.hasInitialized &&
      (this.config.headless === false ||
        this.config.executablePath ||
        this.config.stealth)
    ) {
      // Only worth doing if a browser is actually running. On a fresh run
      // there is nothing to reconfigure, and closing anyway costs a visible
      // window flashing shut plus a relaunch that races the profile lock when
      // a persistent profile is in use.
      let alreadyRunning = false;
      try {
        this.exec("get", ["url"], 0);
        alreadyRunning = true;
      } catch {
        alreadyRunning = false;
      }
      if (alreadyRunning) {
        try {
          this.exec("close", []);
          // Give daemon time to fully shut down before reopening
          this.sleep(1000);
        } catch {
          // Ignore if no browser to close
        }
      }
      this.hasInitialized = true;
    }

    if (this.config.headless === false) {
      args.push("--headed");
    }

    // Use custom executable path if specified
    if (this.config.executablePath) {
      args.push("--executable-path", this.config.executablePath);
    }

    const doOpen = () => this.exec("open", [url, ...args, ...this.launchFlags()]);

    doOpen();
    this.isOpen = true;

    // Stealth: a headless browser advertises "HeadlessChrome" in its
    // User-Agent — the loudest automation signal there is. Patching it from a
    // page script isn't enough (the UA is also an HTTP request header, and a
    // header/JS mismatch is its own tell), so relaunch once with the
    // de-headlessed string. Runs before the about:blank check below so that
    // loop verifies the relaunched page too.
    //
    // Only in headless mode: a headed browser never reports "HeadlessChrome",
    // so there the probe could never do anything except put an extra command
    // between `open` and the page being ready.
    //
    // The probe passes retries=0 deliberately. exec()'s retry path closes the
    // browser when it sees "Browser not launched", so letting this speculative
    // read retry would mean a transient error right after `open` tears down a
    // perfectly good (and, in headed mode, user-visible) browser.
    if (
      this.config.stealth &&
      this.config.headless !== false &&
      !this.config.userAgent &&
      !this.uaFixupDone
    ) {
      this.uaFixupDone = true;
      try {
        const ua = JSON.parse(this.exec("eval", ["navigator.userAgent"], 0));
        if (typeof ua === "string" && ua.includes("HeadlessChrome")) {
          this.config.userAgent = ua.replace("HeadlessChrome", "Chrome");
          this.exec("close", []);
          this.sleep(1000);
          doOpen();
        }
      } catch {
        // Couldn't read or apply the UA — carry on with the JS-level patches.
      }
    }

    // If we're stuck on about:blank (e.g. daemon in bad state), retry open
    const maxNavigateRetries = 2;
    for (let r = 0; r < maxNavigateRetries; r++) {
      this.sleep(1500);
      try {
        const currentUrl = this.exec("get", ["url"]).trim();
        if (
          currentUrl &&
          currentUrl !== "about:blank" &&
          currentUrl !== "about:blank/"
        ) {
          break;
        }
        // Still on about:blank - close and try open again
        try {
          this.exec("close", []);
          this.sleep(1000);
        } catch {
          // ignore
        }
        doOpen();
        this.sleep(1500);
      } catch {
        break;
      }
    }

    // Set viewport if specified
    if (this.config.viewport) {
      this.exec("set", [
        "viewport",
        String(this.config.viewport.width),
        String(this.config.viewport.height),
      ]);
    }
  }

  /**
   * Get page snapshot (accessibility tree)
   */
  async snapshot(interactive: boolean = true): Promise<string> {
    const args = interactive ? ["-i"] : [];
    const out = this.exec("snapshot", args);
    this.lastSnapshot = out;
    return out;
  }

  /** The most recent snapshot text, for working out which iframe a ref is in. */
  private lastSnapshot = "";

  /**
   * The ref of the iframe an element sits in, from the snapshot tree, or null
   * for an element in the top document.
   */
  iframeOf(ref: string): string | null {
    const lines = this.lastSnapshot.split("\n");
    const i = lines.findIndex((l) => new RegExp(`\\bref=${ref}\\b`).test(l));
    if (i < 0) return null;
    let indent = lines[i].search(/\S/);
    for (let j = i - 1; j >= 0; j--) {
      const d = lines[j].search(/\S/);
      if (d < 0 || d >= indent) continue;
      indent = d;
      if (/^\s*-\s*Iframe\b/i.test(lines[j])) return lines[j].match(/\bref=(e\d+)/)?.[1] || null;
    }
    return null;
  }

  /**
   * Get page snapshot as JSON with refs
   */
  async snapshotJson(): Promise<{
    snapshot: string;
    refs: Record<string, RefInfo>;
  }> {
    const result = this.exec("snapshot", ["-i", "--json"]);
    try {
      const parsed = JSON.parse(result);
      return {
        snapshot: parsed.data?.snapshot || result,
        refs: parsed.data?.refs || {},
      };
    } catch {
      return { snapshot: result, refs: {} };
    }
  }

  /**
   * Click an element by ref or selector
   */
  async click(selector: string): Promise<"mouse" | "keyboard"> {
    // Controls hidden for sighted users but kept for keyboard and screen-reader
    // users (placed at left:-99999px, or clipped to 1x1) can't be reached with
    // the mouse: a click there lands on nothing and still reports success.
    // Press them the way a keyboard user would: focus, then Enter.
    const b = /^@?e\d+$/.test(selector) ? this.boxOf(selector.replace(/^@/, "")) : null;
    if (b && (b.x + b.w <= 0 || (b.w <= 1 && b.h <= 1))) {
      this.exec("focus", [selector]);
      this.exec("press", ["Enter"]);
      return "keyboard";
    }
    this.exec("click", [selector]);
    return "mouse";
  }

  /**
   * Fill an input field
   */
  async fill(selector: string, value: string): Promise<void> {
    this.exec("fill", [selector, value]);
  }

  /**
   * Type text (appends to existing value)
   */
  async type(selector: string, value: string): Promise<void> {
    this.exec("type", [selector, value]);
  }

  /**
   * Press a key
   */
  async press(key: string): Promise<void> {
    this.exec("press", [key]);
  }

  /**
   * Hover over an element
   */
  async hover(selector: string): Promise<void> {
    this.exec("hover", [selector]);
  }

  /**
   * Select dropdown option
   */
  async select(selector: string, value: string): Promise<void> {
    this.exec("select", [selector, value]);
  }

  /**
   * Accessible name of an element from the last snapshot, without taking a
   * new one (a fresh snapshot can renumber refs under the model's feet).
   * aria-label first, since that is what icon buttons are named by, then text.
   */
  async describeRef(ref: string): Promise<{ name: string; unknown: boolean }> {
    let unknown = false;
    const read = (args: string[]): string => {
      try {
        const t = this.exec("get", args, 0).trim();
        if (!t || /^(null|undefined|""|✓ Done$)/.test(t)) return "";
        try {
          const parsed = JSON.parse(t);
          return typeof parsed === "string" ? parsed.trim() : "";
        } catch {
          return t;
        }
      } catch (e: any) {
        if (/unknown ref/i.test(String(e?.message || ""))) unknown = true;
        return "";
      }
    };
    let name = read(["attr", ref, "aria-label"]);
    if (!name && !unknown) name = read(["text", ref]);
    return { name: name.replace(/\s+/g, " ").slice(0, 120), unknown };
  }

  /**
   * Check a target just before clicking it, the way jev-ultrafast's executor
   * does: it must exist, be enabled, and not be covered by something else (a
   * cookie banner, a modal, a sticky header). Returns a reason it can't be
   * clicked, or null when it can. Never throws: a check that can't run lets
   * the click go ahead as before.
   */
  async clickBlocker(ref: string): Promise<string | null> {
    try {
      const { name, unknown } = await this.describeRef(ref);
      if (unknown) return `unknown ref ${ref}`;
      try {
        if (this.exec("is", ["enabled", ref], 0).trim() === "false") return `${ref} is disabled`;
      } catch { }
      if (!name) return null;
      // Inside an iframe this page can't look for covers (it only sees the
      // iframe element), and the box is frame-relative: let the click go.
      if (this.iframeOf(ref)) return null;
      const b = this.boxOf(ref);
      if (!b) return null;
      const [x, y, w, h] = [b.x, b.y, b.w, b.h];
      const cx = Math.round(x + w / 2), cy = Math.round(y + h / 2);
      // Who is on top at the centre point? (An iframe on top means the target
      // is inside it: this page can't see in, so that is not a cover.) Walk up from the hit element and
      // collect the names a person would read. Off-screen targets are skipped:
      // the click scrolls them into view first, so there is nothing to check.
      const probe = `(()=>{if(${cx}<0||${cy}<0||${cx}>innerWidth||${cy}>innerHeight)return JSON.stringify({skip:true});let e=document.elementFromPoint(${cx},${cy});if(e&&/^(IFRAME|FRAME)$/.test(e.tagName))return JSON.stringify({skip:true});const names=[];let cover="";for(let i=0;e&&e!==document.body&&i<8;i++,e=e.parentElement){const n=(e.getAttribute("aria-label")||e.innerText||e.value||"").replace(/\\s+/g," ").trim();if(n&&n.length<=${Math.max(80, name.length * 3)})names.push(n);if(!cover&&(e.getAttribute("aria-label")||e.getAttribute("role")))cover=(e.getAttribute("aria-label")||e.getAttribute("role")||"").slice(0,80);}return JSON.stringify({names,cover});})()`;
      let out: any = JSON.parse(this.exec("eval", [probe], 0));
      if (typeof out === "string") out = JSON.parse(out);
      if (out?.skip || !Array.isArray(out?.names)) return null;
      const want = name.toLowerCase();
      const hit = out.names.some((n: string) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase()));
      return hit ? null : `"${name}" is covered by ${out.cover ? `"${out.cover}"` : "another element"}`;
    } catch {
      return null;
    }
  }

  /**
   * Box of an element in page viewport coordinates, or null. agent-browser
   * reports boxes of elements inside an iframe relative to that iframe, so
   * the iframe's own position is added (nested frames included).
   */
  boxOf(ref: string): { x: number; y: number; w: number; h: number } | null {
    const raw = (r: string) => {
      const box = this.exec("get", ["box", r], 0);
      const num = (k: string) => Number(box.match(new RegExp(`${k}:\\s*(-?[\\d.]+)`))?.[1]);
      const b = { x: num("x"), y: num("y"), w: num("width"), h: num("height") };
      return Object.values(b).every(Number.isFinite) && b.w > 0 && b.h > 0 ? b : null;
    };
    try {
      const b = raw(ref);
      if (!b) return null;
      for (let frame = this.iframeOf(ref), depth = 0; frame && depth < 4; frame = this.iframeOf(frame), depth++) {
        const f = raw(frame);
        if (!f) break;
        b.x += f.x;
        b.y += f.y;
      }
      return b;
    } catch {
      return null;
    }
  }

  /**
   * Double-click an element
   */
  async doubleClick(selector: string): Promise<void> {
    this.exec("dblclick", [selector]);
  }

  /**
   * Check or uncheck a checkbox / radio / switch
   */
  async setChecked(selector: string, checked: boolean): Promise<void> {
    this.exec(checked ? "check" : "uncheck", [selector]);
  }

  /**
   * Drag one element onto another
   */
  async drag(source: string, target: string): Promise<void> {
    this.exec("drag", [source, target]);
  }

  /**
   * Set files on a file input (absolute paths)
   */
  async upload(selector: string, files: string[]): Promise<void> {
    this.exec("upload", [selector, ...files]);
  }

  /**
   * Click an element that triggers a download and save it to `path`
   */
  async download(selector: string, path: string): Promise<void> {
    this.exec("download", [selector, path]);
  }

  /**
   * Open tabs. agent-browser prints one line per tab: `→ [t2] Title - url`,
   * with the arrow marking the active one.
   */
  async listTabs(): Promise<Array<{ id: string; title: string; url: string; active: boolean }>> {
    return parseTabList(this.exec("tab", ["list"]));
  }

  /**
   * Switch to a tab by its id (`t1`, `t2`, ...)
   */
  async switchTab(id: string): Promise<void> {
    this.exec("tab", [assertTabId(id)]);
  }

  /**
   * Close a tab by id, or the active tab when no id is given
   */
  async closeTab(id?: string): Promise<void> {
    this.exec("tab", id ? ["close", assertTabId(id)] : ["close"]);
  }

  /**
   * Scroll the page
   */
  async scroll(
    direction: "up" | "down" | "left" | "right",
    amount?: number
  ): Promise<void> {
    const args = amount ? [direction, String(amount)] : [direction];
    this.exec("scroll", args);
  }

  /**
   * Wait for various conditions
   */
  async wait(condition: string | number): Promise<void> {
    if (typeof condition === "number") {
      this.exec("wait", [String(condition)]);
    } else if (condition.startsWith("text=")) {
      this.exec("wait", ["--text", condition.substring(5)]);
    } else if (condition.startsWith("url=")) {
      this.exec("wait", ["--url", condition.substring(4)]);
    } else {
      this.exec("wait", [condition]);
    }
  }

  /**
   * Take a screenshot
   */
  async screenshot(path?: string, fullPage: boolean = false): Promise<string> {
    const args: string[] = [];
    if (path) args.push(path);
    if (fullPage) args.push("--full");
    return this.exec("screenshot", args);
  }

  /**
   * Get text content of an element
   */
  async getText(selector: string): Promise<string> {
    return this.exec("get", ["text", selector]);
  }

  /**
   * Visible links on the page as {href, text} pairs.
   *
   * Neither the accessibility snapshot nor the page text carries URLs — the
   * snapshot names links but drops their href, and page text is innerText.
   * Without this there is no way to discover a permalink (a tweet, a search
   * result, an article) in order to navigate straight to it.
   */
  async getLinks(contains?: string, limit: number = 100): Promise<
    Array<{ href: string; text: string }>
  > {
    const script =
      "(function(){var out=[];var seen={};" +
      "document.querySelectorAll('a[href]').forEach(function(a){" +
      "var h=a.href;if(!h||seen[h])return;seen[h]=1;" +
      "var t=(a.innerText||'').trim().replace(/\\s+/g,' ').slice(0,120);" +
      "out.push({href:h,text:t});});" +
      "return JSON.stringify(out.slice(0,400));})()";
    const raw = await this.evaluate(script);
    let list: Array<{ href: string; text: string }> = [];
    try {
      let parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      if (Array.isArray(parsed)) list = parsed as typeof list;
    } catch {
      return [];
    }
    const filtered = contains
      ? list.filter((l) => l.href.includes(contains))
      : list;
    return filtered.slice(0, limit);
  }

  /**
   * Large visible parts of the page that the snapshot cannot describe.
   *
   * A canvas, or a block drawn from many unlabelled elements (a game board,
   * a map, a drawing app), shows up in the snapshot as nothing or as empty
   * containers. The agent then has no signal that it is missing something,
   * and either gives up or goes straight to screenshots. Finding these lets
   * the harness tell it so, and suggest looking for a text route first.
   */
  async findOpaqueRegions(): Promise<Array<{ element: string; width: number; height: number }>> {
    const script = `(function(){
      var out=[];
      var named='a,button,input,select,textarea,summary,[role],[tabindex],[aria-label],[aria-labelledby],[contenteditable],label,img[alt]:not([alt=""])';
      function scan(doc,win){
        var vw=win.innerWidth, vh=win.innerHeight, minArea=vw*vh*0.08;
        function visible(el,r){if(r.width<120||r.height<120||r.bottom<0||r.right<0||r.top>vh||r.left>vw)return false;
          var s=win.getComputedStyle(el);return s.visibility!=='hidden'&&s.display!=='none'&&+s.opacity>0.05;}
        // On top at most sample points: a canvas painted behind the real
        // content (a decorative background) is not something to work with.
        function onTop(el,r){var hits=0;[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].forEach(function(f){
          var h=doc.elementFromPoint(r.left+r.width*f[0],r.top+r.height*f[1]);if(h&&(h===el||el.contains(h)))hits++;});return hits>=3;}
        function inside(el){return out.some(function(o){return o.el.contains(el)||el.contains(o.el);});}
        function add(el,r){if(inside(el)||!onTop(el,r))return;var d=el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+
          (typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):'');
          out.push({el:el,element:d,width:Math.round(r.width),height:Math.round(r.height)});}
        doc.querySelectorAll('canvas').forEach(function(c){var r=c.getBoundingClientRect();
          if(r.width*r.height>=minArea&&visible(c,r)&&!c.closest(named))add(c,r);});
        var all=doc.body?doc.body.getElementsByTagName('*'):[];
        for(var i=0;i<all.length&&i<20000;i++){var el=all[i];
          if(el.childElementCount<8||/^(canvas|iframe|video|img|picture)$/i.test(el.tagName))continue;
          var r=el.getBoundingClientRect();if(r.width*r.height<minArea||!visible(el,r))continue;
          if(el.matches(named)||el.querySelector(named))continue;
          if((el.innerText||el.textContent||'').replace(/\s+/g,'').length>8)continue;
          add(el,r);}
        // Same-origin frames (games are often embedded); others cannot be read.
        doc.querySelectorAll('iframe').forEach(function(f){try{var d=f.contentDocument;if(d&&d.body)scan(d,f.contentWindow);}catch(e){}});
      }
      scan(document,window);
      return JSON.stringify(out.slice(0,5).map(function(o){return{element:o.element,width:o.width,height:o.height};}));
    })()`;
    try {
      let parsed: unknown = JSON.parse(await this.evaluate(script));
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return Array.isArray(parsed) ? (parsed as any) : [];
    } catch {
      return [];
    }
  }

  /**
   * A cheap digest of what a person would notice changing on the page: the
   * URL, the title, open dialogs, the visible text, the state of toggles and
   * expanders (pressed, expanded, checked, selected, their labels), and focus
   * in a text field. Two
   * equal digests either side of a click mean the click changed nothing.
   * Returns "" when the page can't be read, which never compares as equal.
   */
  async pageFingerprint(): Promise<string> {
    const script = `(function(){
      var h=0;function mix(s){for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0;}}
      mix(location.href);mix(document.title);
      mix(String(document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]').length));
      mix(document.body?document.body.innerText:'');
      var els=document.querySelectorAll('[aria-pressed],[aria-expanded],[aria-checked],[aria-selected],input,textarea,[aria-label]');
      for(var i=0;i<els.length&&i<5000;i++){var e=els[i];
        mix((e.getAttribute('aria-pressed')||'')+(e.getAttribute('aria-expanded')||'')+(e.getAttribute('aria-checked')||'')+
          (e.getAttribute('aria-selected')||'')+(e.getAttribute('aria-label')||'')+(e.checked?'c':'')+(e.value!==undefined?String(e.value).length:''));}
      // Clicking any button focuses it, so focus only counts when it lands
      // somewhere you can type (a click that opens a text box does change things).
      var a=document.activeElement;if(a&&(a.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)))mix('f'+a.tagName+(a.getAttribute('aria-label')||''));
      return String(h);})()`;
    try {
      let out: unknown = JSON.parse(await this.evaluate(script));
      if (typeof out !== "string") out = String(out);
      return out as string;
    } catch {
      return "";
    }
  }

  /**
   * Readable text of the whole page.
   *
   * The interactive snapshot (`snapshot -i`) lists only focusable elements, so
   * body copy — an article, a post, a feed of them — never appears in it. This
   * is how the agent actually reads a page's content.
   */
  async getPageText(): Promise<string> {
    return this.exec("get", ["text", "body"]);
  }

  /**
   * Get current URL
   */
  async getUrl(): Promise<string> {
    return this.exec("get", ["url"]);
  }

  /**
   * Get page title
   */
  async getTitle(): Promise<string> {
    return this.exec("get", ["title"]);
  }

  /**
   * Check if element is visible
   */
  async isVisible(selector: string): Promise<boolean> {
    const result = this.exec("is", ["visible", selector]);
    return result.toLowerCase().includes("true");
  }

  /**
   * Execute JavaScript
   */
  async evaluate(script: string): Promise<string> {
    return this.exec("eval", [script]);
  }

  /**
   * Set cookies
   */
  async setCookie(name: string, value: string): Promise<void> {
    // Escape special shell characters in cookie value
    this.exec("cookies", ["set", name, value]);
  }

  /**
   * Get all cookies
   */
  async getCookies(): Promise<Array<{ name: string; value: string }>> {
    const result = this.exec("cookies", ["get"]);
    // Parse cookie string: "name1=value1; name2=value2" or "name1=value1\nname2=value2"
    const cookies: Array<{ name: string; value: string }> = [];
    if (!result || result.trim() === "") return cookies;

    // Split by newline or semicolon
    const parts = result.includes("\n")
      ? result.split("\n")
      : result.split("; ");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        cookies.push({
          name: trimmed.substring(0, eqIndex),
          value: trimmed.substring(eqIndex + 1),
        });
      }
    }
    return cookies;
  }

  /**
   * Get all localStorage
   */
  async getLocalStorage(): Promise<Record<string, string>> {
    // Use single quotes to avoid shell escaping issues with parentheses
    const script = `(function(){var r={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);r[k]=localStorage.getItem(k);}return JSON.stringify(r);})()`;
    const result = this.exec("eval", [script]);
    try {
      // Result might be double-quoted string, so parse twice if needed
      let parsed = JSON.parse(result);
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
      return parsed || {};
    } catch {
      return {};
    }
  }

  /**
   * Get all sessionStorage
   */
  async getSessionStorage(): Promise<Record<string, string>> {
    const script = `(function(){var r={};for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);r[k]=sessionStorage.getItem(k);}return JSON.stringify(r);})()`;
    const result = this.exec("eval", [script]);
    try {
      // Result might be double-quoted string, so parse twice if needed
      let parsed = JSON.parse(result);
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
      return parsed || {};
    } catch {
      return {};
    }
  }

  /**
   * Set localStorage value
   */
  async setLocalStorage(key: string, value: string): Promise<void> {
    this.exec("storage", ["local", "set", key, value]);
  }

  /**
   * Set sessionStorage value
   */
  async setSessionStorage(key: string, value: string): Promise<void> {
    this.exec("storage", ["session", "set", key, value]);
  }

  /**
   * Go back
   */
  async goBack(): Promise<void> {
    this.exec("back", []);
  }

  /**
   * Go forward
   */
  async goForward(): Promise<void> {
    this.exec("forward", []);
  }

  /**
   * Reload page
   */
  async reload(): Promise<void> {
    this.exec("reload", []);
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.isOpen) {
      try {
        this.exec("close", []);
      } catch {
        // Ignore close errors
      }
      this.isOpen = false;
    }
  }

  /**
   * Get current browser state (with graceful error handling)
   */
  async getState(): Promise<BrowserState> {
    // Get each piece of state individually, with fallbacks
    let url = "";
    let title = "";
    let snapshotData = { snapshot: "", refs: {} as Record<string, RefInfo> };

    try {
      url = await this.getUrl();
    } catch {
      url = "unknown";
    }

    try {
      title = await this.getTitle();
    } catch {
      title = "";
    }

    let snapshotError: string | null = null;
    try {
      snapshotData = await this.snapshotJson();
    } catch (jsonErr: any) {
      // A heavy page can make the full interactive snapshot time out. Try the
      // compact form next — it drops empty structural nodes and is far
      // smaller, so it often succeeds where the full one does not.
      // retries=0 on every fallback. exec() otherwise makes 3 attempts at the
      // configured timeout each, and this chain has four links — a page whose
      // snapshot fails then costs ~10 minutes of wall clock instead of
      // failing fast and letting the agent move on.
      try {
        const compact = this.exec("snapshot", ["-i", "-c"], 0);
        if (!compact.trim()) throw new Error("compact snapshot was empty");
        snapshotData = { snapshot: compact, refs: {} };
      } catch (compactErr: any) {
        try {
          const plainSnapshot = this.exec("snapshot", [], 0);
          snapshotData = { snapshot: plainSnapshot, refs: {} };
        } catch (plainErr: any) {
          // Report why rather than returning a bare sentence the caller cannot
          // distinguish from a genuinely empty page.
          snapshotError =
            plainErr?.message || compactErr?.message || jsonErr?.message || "unknown error";
          snapshotData = { snapshot: "", refs: {} };
        }
      }
    }

    // The interactive snapshot carries refs but no body copy, so on a
    // content-heavy page (a feed, an article, search results) it can come back
    // with plenty of buttons and nothing readable. When that happens, fall
    // back to the full snapshot so the caller isn't left flying blind and
    // guessing which ref is which.
    if (!snapshotData.snapshot || snapshotData.snapshot.trim() === "") {
      try {
        const full = this.exec("snapshot", [], 0);
        if (full.trim()) {
          snapshotData = { snapshot: full, refs: snapshotData.refs };
        }
      } catch {
        // Keep whatever we already had.
      }
    }

    this.lastSnapshot = snapshotData.snapshot || this.lastSnapshot;
    return {
      url,
      title,
      snapshot: snapshotData.snapshot,
      refs: snapshotData.refs,
      ...(snapshotError ? { error: snapshotError } : {}),
    };
  }

  /**
   * Wait for page to be stable (no navigation in progress)
   */
  async waitForStable(timeout: number = 2000): Promise<void> {
    const startTime = Date.now();
    let lastUrl = "";

    while (Date.now() - startTime < timeout) {
      try {
        const currentUrl = await this.getUrl();
        if (currentUrl === lastUrl && currentUrl !== "about:blank") {
          // URL hasn't changed, page is likely stable
          return;
        }
        lastUrl = currentUrl;
      } catch {
        // Ignore errors during stability check
      }
      this.sleep(200);
    }
  }
}


function assertTabId(id: string): string {
  const s = String(id).trim();
  if (!/^t\d+$/.test(s)) {
    throw new Error(`Invalid tab id "${id}": expected an id like t1 from list_tabs()`);
  }
  return s;
}

/** Parse `agent-browser tab list` output. */
export function parseTabList(
  out: string
): Array<{ id: string; title: string; url: string; active: boolean }> {
  const tabs: Array<{ id: string; title: string; url: string; active: boolean }> = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(→)?\s*\[(t\d+)\]\s*(.*)$/);
    if (!m) continue;
    const rest = m[3];
    const sep = rest.lastIndexOf(" - ");
    tabs.push({
      id: m[2],
      title: sep >= 0 ? rest.slice(0, sep).trim() : rest.trim(),
      url: sep >= 0 ? rest.slice(sep + 3).trim() : "",
      active: !!m[1],
    });
  }
  return tabs;
}
