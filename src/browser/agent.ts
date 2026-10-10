import { execSync, execFileSync, spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { BrowserConfig, BrowserState, RefInfo } from "../types.js";
import { createBrowserbaseSession } from "./browserbase.js";

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

    // Set up environment with executable path if configured
    const env = { ...process.env };
    if (this.config.executablePath) {
      env.AGENT_BROWSER_EXECUTABLE_PATH = this.config.executablePath;
    }
    if (this.config.profile) {
      env.AGENT_BROWSER_PROFILE = this.config.profile;
    }
    if (this.config.userAgent) {
      env.AGENT_BROWSER_USER_AGENT = this.config.userAgent;
    }
    if (this.config.args && this.config.args.length > 0) {
      // agent-browser expects comma or newline separated args via environment
      env.AGENT_BROWSER_ARGS = this.config.args.join(",");
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
    // This ensures headed mode and executable path are applied correctly
    if (
      !this.hasInitialized &&
      (this.config.headless === false || this.config.executablePath)
    ) {
      try {
        this.exec("close", []);
        // Give daemon time to fully shut down before reopening
        this.sleep(1000);
      } catch {
        // Ignore if no browser to close
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

    const doOpen = () => this.exec("open", [url, ...args]);

    doOpen();
    this.isOpen = true;

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
    return this.exec("snapshot", args);
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
  async click(selector: string): Promise<void> {
    this.exec("click", [selector]);
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
