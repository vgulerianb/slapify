import { execSync, spawn, ChildProcess } from "child_process";
import { BrowserConfig, BrowserState, RefInfo } from "../types.js";

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
    const fullCommand = ["agent-browser", command, ...args].join(" ");

    // Set up environment with executable path if configured
    const env = { ...process.env };
    if (this.config.executablePath) {
      env.AGENT_BROWSER_EXECUTABLE_PATH = this.config.executablePath;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = execSync(fullCommand, {
          encoding: "utf-8",
          timeout: this.config.timeout,
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });
        return result.trim();
      } catch (error: any) {
        let errorMsg = error.message || error.stderr?.toString() || "";

        // Filter out non-fatal daemon warnings
        const isJustWarning =
          errorMsg.includes("daemon already running") ||
          errorMsg.includes("--executable-path ignored");

        // If we have stdout, return it (some commands output to stdout even on "error")
        if (error.stdout) {
          const stdout = error.stdout.toString().trim();
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

  /**
   * Navigate to a URL
   */
  async navigate(url: string): Promise<void> {
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
      args.push("--executable-path", `"${this.config.executablePath}"`);
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
    this.exec("fill", [selector, `"${value}"`]);
  }

  /**
   * Type text (appends to existing value)
   */
  async type(selector: string, value: string): Promise<void> {
    this.exec("type", [selector, `"${value}"`]);
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
      this.exec("wait", ["--text", `"${condition.substring(5)}"`]);
    } else if (condition.startsWith("url=")) {
      this.exec("wait", ["--url", `"${condition.substring(4)}"`]);
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
    return this.exec("eval", [`"${script.replace(/"/g, '\\"')}"`]);
  }

  /**
   * Set cookies
   */
  async setCookie(name: string, value: string): Promise<void> {
    // Escape special shell characters in cookie value
    const escapedValue = `'${value.replace(/'/g, "'\\''")}'`;
    this.exec("cookies", ["set", name, escapedValue]);
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
    const script = `'(function(){var r={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);r[k]=localStorage.getItem(k);}return JSON.stringify(r);})()'`;
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
    const script = `'(function(){var r={};for(var i=0;i<sessionStorage.length;i++){var k=sessionStorage.key(i);r[k]=sessionStorage.getItem(k);}return JSON.stringify(r);})()'`;
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
    // Escape special shell characters
    const escapedValue = `'${value.replace(/'/g, "'\\''")}'`;
    this.exec("storage", ["local", "set", key, escapedValue]);
  }

  /**
   * Set sessionStorage value
   */
  async setSessionStorage(key: string, value: string): Promise<void> {
    // Escape special shell characters
    const escapedValue = `'${value.replace(/'/g, "'\\''")}'`;
    this.exec("storage", ["session", "set", key, escapedValue]);
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

    try {
      snapshotData = await this.snapshotJson();
    } catch {
      // Try plain snapshot as fallback
      try {
        const plainSnapshot = await this.snapshot();
        snapshotData = { snapshot: plainSnapshot, refs: {} };
      } catch {
        snapshotData = { snapshot: "Unable to get page snapshot", refs: {} };
      }
    }

    return {
      url,
      title,
      snapshot: snapshotData.snapshot,
      refs: snapshotData.refs,
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
