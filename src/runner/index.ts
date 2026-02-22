import { BrowserAgent } from "../browser/agent.js";
import { AIInterpreter, BrowserCommand } from "../ai/interpreter.js";
import {
  SlapifyConfig,
  CredentialsConfig,
  FlowFile,
  FlowStep,
  StepResult,
  TestResult,
  ActionLog,
  CredentialProfile,
} from "../types.js";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import * as readline from "readline";

/**
 * Test runner that executes flow files
 */
export class TestRunner {
  private config: SlapifyConfig;
  private credentials: CredentialsConfig;
  private browser: BrowserAgent;
  private ai: AIInterpreter;
  private autoHandled: string[] = [];
  private allAssumptions: string[] = [];

  constructor(config: SlapifyConfig, credentials: CredentialsConfig) {
    this.config = config;
    this.credentials = credentials;
    this.browser = new BrowserAgent(config.browser);
    this.ai = new AIInterpreter(config.llm);
  }

  /**
   * Run a flow file
   * @param flow The flow file to run
   * @param onStep Optional callback for real-time step progress
   * @param runPerformanceAudit If true, collect perf metrics before closing the browser
   */
  async runFlow(
    flow: FlowFile,
    onStep?: (result: StepResult) => void,
    runPerformanceAudit?: boolean
  ): Promise<TestResult> {
    const startTime = new Date();
    const stepResults: StepResult[] = [];
    let perfAudit: import("../perf/audit.js").PerfAuditResult | undefined;

    try {
      for (const step of flow.steps) {
        let result = await this.executeStep(step);

        // Retry once on failure (for non-optional steps, but not @debug_wait)
        const isDebugWait = step.text.match(/@debug_wait/i);
        if (result.status === "failed" && !step.optional && !isDebugWait) {
          // Wait a bit before retry
          await this.browser.wait(1000);

          // Try again
          const retryResult = await this.executeStep(step);
          retryResult.retried = true;

          // Combine durations
          retryResult.duration += result.duration;

          // If retry succeeded or failed, use retry result
          result = retryResult;
        }

        stepResults.push(result);

        // Call progress callback
        if (onStep) {
          onStep(result);
        }

        // Stop on required step failure (after retry)
        if (result.status === "failed" && !step.optional) {
          break;
        }
      }

      // Collect Core Web Vitals and React Scan BEFORE closing the browser
      // (they read from the live DOM), then close, then run Lighthouse
      // sequentially so only one Chrome is alive at a time.
      if (runPerformanceAudit) {
        try {
          const finalUrl = await this.browser.getUrl();
          const { collectCoreWebVitals, collectReactScanResults } =
            await import("../perf/audit.js");

          const [vitals, react] = await Promise.all([
            collectCoreWebVitals(this.browser),
            collectReactScanResults(this.browser),
          ]);

          perfAudit = {
            url: finalUrl,
            auditedAt: new Date().toISOString(),
            vitals,
            react,
            scores: null, // filled in after browser closes
          };
        } catch {
          // Non-fatal
        }
      }
    } finally {
      await this.browser.close(); // ← browser fully closed here
    }

    // Run Lighthouse AFTER agent-browser is closed — only one Chrome at a time
    if (runPerformanceAudit && perfAudit) {
      try {
        const { runLighthouseAudit } = await import("../perf/audit.js");
        const reportDir = this.config.report?.output_dir || "./test-reports";
        const lhResult = await runLighthouseAudit(perfAudit.url, reportDir);
        if (lhResult) {
          perfAudit.scores = lhResult.scores;
          perfAudit.lighthouse = lhResult.scores; // backwards compat
          if (lhResult.reportPath)
            perfAudit.lighthouseReportPath = lhResult.reportPath;
        }
      } catch {
        // Non-fatal — Lighthouse failure doesn't break the test result
      }
    }

    const endTime = new Date();
    const passed = stepResults.filter((r) => r.status === "passed").length;
    const failed = stepResults.filter((r) => r.status === "failed").length;
    const skipped = stepResults.filter((r) => r.status === "skipped").length;

    return {
      flowFile: flow.path || flow.name,
      status:
        failed === 0 ||
        stepResults.every(
          (r) =>
            r.status !== "failed" ||
            flow.steps[stepResults.indexOf(r)]?.optional
        )
          ? "passed"
          : "failed",
      steps: stepResults,
      totalSteps: flow.steps.length,
      passedSteps: passed,
      failedSteps: failed,
      skippedSteps: skipped,
      duration: endTime.getTime() - startTime.getTime(),
      startTime,
      endTime,
      autoHandled: this.autoHandled,
      assumptions: this.allAssumptions,
      ...(perfAudit ? { perfAudit } : {}),
    };
  }

  /**
   * Execute a single step
   */
  private async executeStep(step: FlowStep): Promise<StepResult> {
    const startTime = Date.now();
    const actions: ActionLog[] = [];
    const assumptions: string[] = [];

    try {
      // Get current browser state
      const state = await this.browser.getState();

      // Check for auto-handle opportunities
      await this.handleInterruptions(actions);

      // Check if this is a credential-related step
      // Supports multiple patterns:
      //   - "Login with <profile> credentials"  → explicit profile
      //   - "@inject <profile>" or "@inject:<profile>"
      //   - "Inject <profile> credentials"
      //   - "Use <profile> credentials"
      //   - "Login" / "Sign in" / "Log in" (no profile) → auto-pick best match
      const credentialPatterns = [
        /login\s+with\s+([\w-]+)\s+credentials/i,
        /@inject[:\s]+([\w-]+)/i,
        /inject\s+([\w-]+)\s+credentials/i,
        /use\s+([\w-]+)\s+credentials/i,
      ];

      // Generic login intent patterns (no explicit profile name)
      const genericLoginPatterns = [
        /^(log\s?in|sign\s?in|authenticate|login)(\s+to\s+\S+)?(\s+using\s+credentials?)?$/i,
        /^(log\s?in|sign\s?in)\s+with\s+credentials?$/i,
      ];

      let profileName: string | null = null;
      for (const pattern of credentialPatterns) {
        const match = step.text.match(pattern);
        if (match) {
          profileName = match[1];
          break;
        }
      }

      // Auto-pick a credential profile when none was named
      if (!profileName) {
        const isGenericLogin = genericLoginPatterns.some((p) =>
          p.test(step.text.trim())
        );
        if (isGenericLogin) {
          profileName = this.pickBestCredentialProfile(state.url);
        }
      }

      // Check for @debug_wait command
      const debugWaitMatch = step.text.match(/@debug_wait(?:[:\s]+(.+))?/i);

      if (debugWaitMatch) {
        const profileName = debugWaitMatch[1]?.trim() || "captured";
        await this.handleDebugWait(profileName, actions);

        return {
          step,
          status: "passed",
          duration: Date.now() - startTime,
          actions,
        };
      }

      if (profileName) {
        const profile = this.credentials.profiles[profileName];

        if (!profile) {
          throw new Error(`Credential profile not found: ${profileName}`);
        }

        await this.handleLogin(profile, actions);
      } else {
        // Interpret step with AI
        const interpreted = await this.ai.interpretStep(
          step,
          state,
          this.credentials.profiles
        );

        // If AI detected a login intent and returned a profile suggestion, use it
        if (
          interpreted.needsCredentials &&
          !profileName
        ) {
          const suggested = interpreted.credentialProfile;
          const profiles = this.credentials?.profiles || {};
          if (suggested && profiles[suggested]) {
            profileName = suggested;
          } else {
            // Fall back to best domain match
            profileName = this.pickBestCredentialProfile(state.url);
          }
          if (profileName) {
            await this.handleLogin(profiles[profileName], actions);
            // Skip remaining command execution for this step
            const screenshot2 = this.config.report?.screenshots
              ? await this.browser.screenshot(`step-${step.line}.png`).catch(() => undefined)
              : undefined;
            return {
              step,
              status: "passed",
              duration: Date.now() - startTime,
              actions,
              assumptions: [`Auto-selected credential profile: ${profileName}`],
              screenshot: screenshot2 as string | undefined,
            };
          }
        }

        // Handle skip reason
        if (interpreted.skipReason) {
          if (step.optional || step.conditional) {
            return {
              step,
              status: "skipped",
              duration: Date.now() - startTime,
              actions: [
                {
                  type: "info",
                  description: interpreted.skipReason,
                  timestamp: Date.now(),
                },
              ],
            };
          } else {
            throw new Error(interpreted.skipReason);
          }
        }

        // Record assumptions
        if (interpreted.assumptions.length > 0) {
          assumptions.push(...interpreted.assumptions);
          this.allAssumptions.push(...interpreted.assumptions);
        }

        // Execute browser commands
        for (const cmd of interpreted.actions) {
          await this.executeCommand(cmd, actions);
        }
      }

      // After every step: silently solve captchas and dismiss interruptions
      await this.handleCaptcha(actions);
      await this.handleInterruptions(actions);

      // Take screenshot if enabled
      let screenshot: string | undefined;
      if (this.config.report?.screenshots) {
        const screenshotPath = `step-${step.line}.png`;
        await this.browser.screenshot(screenshotPath);
        screenshot = screenshotPath;
      }

      return {
        step,
        status: "passed",
        duration: Date.now() - startTime,
        actions,
        assumptions: assumptions.length > 0 ? assumptions : undefined,
        screenshot,
      };
    } catch (error: any) {
      // Take failure screenshot
      let screenshot: string | undefined;
      try {
        if (this.config.report?.screenshots) {
          const screenshotPath = `step-${step.line}-failed.png`;
          await this.browser.screenshot(screenshotPath);
          screenshot = screenshotPath;
        }
      } catch {
        // Ignore screenshot errors
      }

      if (step.optional) {
        return {
          step,
          status: "skipped",
          duration: Date.now() - startTime,
          actions,
          error: error.message,
          screenshot,
        };
      }

      return {
        step,
        status: "failed",
        duration: Date.now() - startTime,
        actions,
        error: error.message,
        screenshot,
      };
    }
  }

  /**
   * Execute a browser command
   */
  private async executeCommand(
    cmd: BrowserCommand,
    actions: ActionLog[]
  ): Promise<void> {
    actions.push({
      type: this.getActionType(cmd.command),
      description: cmd.description,
      selector: cmd.args[0],
      value: cmd.args[1],
      timestamp: Date.now(),
    });

    switch (cmd.command) {
      case "navigate":
        await this.browser.navigate(cmd.args[0]);
        // Wait for page to stabilize after navigation
        await this.browser.waitForStable();
        break;
      case "click":
        await this.browser.click(cmd.args[0]);
        // Brief wait after click in case it triggers navigation
        await this.browser.wait(300);
        break;
      case "fill":
        await this.browser.fill(cmd.args[0], cmd.args[1]);
        break;
      case "type":
        await this.browser.type(cmd.args[0], cmd.args[1]);
        break;
      case "press":
        await this.browser.press(cmd.args[0]);
        break;
      case "hover":
        await this.browser.hover(cmd.args[0]);
        break;
      case "select":
        await this.browser.select(cmd.args[0], cmd.args[1]);
        break;
      case "scroll":
        await this.browser.scroll(cmd.args[0] as any, parseInt(cmd.args[1]));
        break;
      case "wait":
        await this.browser.wait(parseInt(cmd.args[0]));
        break;
      case "waitForText":
        await this.browser.wait(`text=${cmd.args[0]}`);
        break;
      case "getText":
        await this.browser.getText(cmd.args[0]);
        break;
      case "screenshot":
        await this.browser.screenshot(cmd.args[0]);
        break;
      case "goBack":
        await this.browser.goBack();
        break;
      case "reload":
        await this.browser.reload();
        break;
      default:
        throw new Error(`Unknown command: ${cmd.command}`);
    }

    // Small delay between actions for stability
    await this.browser.wait(100);
  }

  /**
   * Pick the best credential profile for a given URL.
   * Prefers profiles whose name matches the current domain, falls back to "default".
   * Returns null when no profiles exist.
   */
  private pickBestCredentialProfile(url: string): string | null {
    const profiles = this.credentials?.profiles;
    if (!profiles || Object.keys(profiles).length === 0) return null;

    // Try to match profile name against the current domain
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      // e.g. hostname = "github.com" → try "github", "github.com"
      const domainBase = hostname.split(".")[0];
      for (const name of Object.keys(profiles)) {
        if (
          name.toLowerCase() === domainBase.toLowerCase() ||
          name.toLowerCase() === hostname.toLowerCase()
        ) {
          return name;
        }
      }
    } catch {
      // Invalid URL — fall through to "default"
    }

    // Fall back to "default" profile if it exists
    if (profiles["default"]) return "default";

    // Last resort: first available profile
    return Object.keys(profiles)[0];
  }

  /**
   * Detect and solve captchas on the current page.
   * Handles common captcha patterns — checkbox reCAPTCHA, hCaptcha, Cloudflare Turnstile.
   * Runs silently; any failure is swallowed so the main flow continues.
   */
  private async handleCaptcha(actions: ActionLog[]): Promise<void> {
    try {
      const state = await this.browser.getState();
      const snap = (state.snapshot || "").toLowerCase();
      const title = (state.title || "").toLowerCase();
      const url = (state.url || "").toLowerCase();

      // Detect captcha presence via page content signals
      const captchaSignals = [
        snap.includes("recaptcha"),
        snap.includes("hcaptcha"),
        snap.includes("turnstile"),
        snap.includes("i'm not a robot"),
        snap.includes("i am not a robot"),
        snap.includes("verify you are human"),
        snap.includes("verify you're human"),
        title.includes("just a moment"),       // Cloudflare waiting room
        url.includes("challenge"),
      ];

      if (!captchaSignals.some(Boolean)) return;

      // Ask AI to find the captcha checkbox / button to click
      const result = await this.ai.findCaptchaAction(state);
      if (!result) return;

      await this.browser.click(result.ref);
      await this.browser.wait(2000); // wait for challenge to process

      const description = `Auto-solved captcha: ${result.description}`;
      this.autoHandled.push(description);
      actions.push({
        type: "auto-handle",
        description,
        selector: result.ref,
        timestamp: Date.now(),
      });
    } catch {
      // Never let captcha handling crash the flow
    }
  }

  /**
   * Handle automatic dismissal of interruptions
   */
  private async handleInterruptions(actions: ActionLog[]): Promise<void> {
    try {
      const state = await this.browser.getState();
      const interruptions = await this.ai.checkAutoHandle(state);

      for (const int of interruptions) {
        try {
          await this.browser.click(int.ref);

          const description = `Auto-handled: ${int.description}`;
          this.autoHandled.push(description);

          actions.push({
            type: "auto-handle",
            description,
            selector: int.ref,
            timestamp: Date.now(),
          });

          // Wait for any animations
          await this.browser.wait(500);
        } catch {
          // Ignore failed auto-handles
        }
      }
    } catch {
      // Ignore auto-handle errors
    }
  }

  /**
   * Handle login with credentials
   */
  private async handleLogin(
    profile: CredentialProfile,
    actions: ActionLog[]
  ): Promise<void> {
    // Handle inject type (cookies/localStorage)
    if (profile.type === "inject") {
      let successCount = 0;
      let failCount = 0;

      if (profile.cookies) {
        for (const cookie of profile.cookies) {
          try {
            await this.browser.setCookie(cookie.name, cookie.value);
            actions.push({
              type: "fill",
              description: `Set cookie: ${cookie.name}`,
              timestamp: Date.now(),
            });
            successCount++;
          } catch (error: any) {
            // Log but continue - some cookies may fail due to domain restrictions
            actions.push({
              type: "info",
              description: `⚠ Failed to set cookie: ${cookie.name} (${
                error.message?.split("\n")[0] || "unknown error"
              })`,
              timestamp: Date.now(),
            });
            failCount++;
          }
        }
      }

      if (profile.localStorage) {
        for (const [key, value] of Object.entries(profile.localStorage)) {
          try {
            await this.browser.setLocalStorage(key, value);
            actions.push({
              type: "fill",
              description: `Set localStorage: ${key}`,
              timestamp: Date.now(),
            });
            successCount++;
          } catch (error: any) {
            actions.push({
              type: "info",
              description: `⚠ Failed to set localStorage: ${key} (${
                error.message?.split("\n")[0] || "unknown error"
              })`,
              timestamp: Date.now(),
            });
            failCount++;
          }
        }
      }

      if (profile.sessionStorage) {
        for (const [key, value] of Object.entries(profile.sessionStorage)) {
          try {
            await this.browser.setSessionStorage(key, value);
            actions.push({
              type: "fill",
              description: `Set sessionStorage: ${key}`,
              timestamp: Date.now(),
            });
            successCount++;
          } catch (error: any) {
            actions.push({
              type: "info",
              description: `⚠ Failed to set sessionStorage: ${key} (${
                error.message?.split("\n")[0] || "unknown error"
              })`,
              timestamp: Date.now(),
            });
            failCount++;
          }
        }
      }

      if (failCount > 0) {
        console.log(
          `    ⚠ ${failCount} item(s) failed to inject (continuing with ${successCount} successful)`
        );
      }

      // Reload so the page picks up the injected cookies/storage
      await this.browser.wait(300);
      await this.browser.reload();
      return;
    }

    // Handle login form type
    if (profile.type === "login-form" && profile.username && profile.password) {
      const state = await this.browser.getState();
      const loginForm = await this.ai.findLoginForm(state);

      if (!loginForm) {
        throw new Error("Could not find login form on page");
      }

      // Fill username
      await this.browser.fill(loginForm.usernameRef, profile.username);
      actions.push({
        type: "fill",
        description: "Filled username field",
        selector: loginForm.usernameRef,
        timestamp: Date.now(),
      });

      // Fill password
      await this.browser.fill(loginForm.passwordRef, profile.password);
      actions.push({
        type: "fill",
        description: "Filled password field",
        selector: loginForm.passwordRef,
        timestamp: Date.now(),
      });

      // Click submit
      await this.browser.click(loginForm.submitRef);
      actions.push({
        type: "click",
        description: "Clicked login button",
        selector: loginForm.submitRef,
        timestamp: Date.now(),
      });

      // Wait for navigation
      await this.browser.wait(2000);

      // Handle TOTP if configured
      if (profile.totp_secret) {
        const totp = this.generateTOTP(profile.totp_secret);
        // TODO: Find OTP input and fill
        actions.push({
          type: "fill",
          description: `Entered TOTP code`,
          timestamp: Date.now(),
        });
      }

      // Handle fixed OTP
      if (profile.fixed_otp) {
        // TODO: Find OTP input and fill
        actions.push({
          type: "fill",
          description: `Entered fixed OTP`,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Generate TOTP code from secret
   */
  private generateTOTP(secret: string): string {
    // Basic TOTP implementation
    // In production, use a proper TOTP library
    const epoch = Math.floor(Date.now() / 1000 / 30);
    // Simplified - would need proper HMAC-SHA1 implementation
    return "000000"; // Placeholder
  }

  /**
   * Handle @debug_wait - pause for user interaction, then capture credentials
   */
  private async handleDebugWait(
    profileName: string,
    actions: ActionLog[]
  ): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log("🔴 DEBUG WAIT - Browser paused for manual interaction");
    console.log("=".repeat(60));
    console.log("\nYou can now interact with the browser manually.");
    console.log("(e.g., log in, complete 2FA, accept cookies, etc.)\n");
    console.log("Press ENTER when done to capture cookies & localStorage...\n");

    actions.push({
      type: "info",
      description: "Paused for manual interaction (@debug_wait)",
      timestamp: Date.now(),
    });

    // Wait for user input using raw stdin
    await new Promise<void>((resolve) => {
      const onData = () => {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve();
      };
      process.stdin.resume();
      process.stdin.once("data", onData);
    });

    console.log("\n📸 Capturing browser state...\n");

    // Capture cookies
    const cookies = await this.browser.getCookies();
    let localStorage = await this.browser.getLocalStorage();
    let sessionStorage = await this.browser.getSessionStorage();

    // Normalize to plain Record<string, string> (in case we got a string or nested structure)
    const toStorageObject = (v: unknown): Record<string, string> => {
      if (typeof v === "string") {
        try {
          v = JSON.parse(v);
        } catch {
          return {};
        }
      }
      if (!v || typeof v !== "object" || Array.isArray(v)) return {};
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        out[String(k)] = typeof val === "string" ? val : JSON.stringify(val);
      }
      return out;
    };
    localStorage = toStorageObject(localStorage);
    sessionStorage = toStorageObject(sessionStorage);

    // Build credential profile with correct shape for .slapify/credentials.yaml
    const capturedProfile: CredentialProfile = {
      type: "inject",
    };

    if (cookies.length > 0) {
      capturedProfile.cookies = cookies.map((c) => ({
        name: c.name,
        value: c.value,
      }));
    }

    if (Object.keys(localStorage).length > 0) {
      capturedProfile.localStorage = localStorage;
    }

    if (Object.keys(sessionStorage).length > 0) {
      capturedProfile.sessionStorage = sessionStorage;
    }

    // Save to temp_credentials.yaml (format compatible with .slapify/credentials.yaml)
    const outputPath = path.join(process.cwd(), "temp_credentials.yaml");

    let existingData: { profiles: Record<string, CredentialProfile> } = {
      profiles: {},
    };
    if (fs.existsSync(outputPath)) {
      try {
        const parsed = yaml.parse(fs.readFileSync(outputPath, "utf-8"));
        if (parsed && parsed.profiles && typeof parsed.profiles === "object") {
          existingData = { profiles: parsed.profiles };
        }
      } catch {
        existingData = { profiles: {} };
      }
    }

    existingData.profiles[profileName] = capturedProfile;

    // Stringify with block style so localStorage/sessionStorage are key: value per line
    const yamlContent = `# Captured credentials from @debug_wait
# Generated: ${new Date().toISOString()}
#
# To use: copy the profile you need to .slapify/credentials.yaml
# Then use: @inject ${profileName}

${yaml.stringify(existingData, { indent: 2, lineWidth: 0 })}`;

    fs.writeFileSync(outputPath, yamlContent);

    // Summary
    console.log("✅ Captured:");
    console.log(`   - ${cookies.length} cookie(s)`);
    console.log(
      `   - ${Object.keys(localStorage).length} localStorage item(s)`
    );
    console.log(
      `   - ${Object.keys(sessionStorage).length} sessionStorage item(s)`
    );
    console.log(`\n📁 Saved to: ${outputPath}`);
    console.log(`   Profile name: "${profileName}"`);
    console.log("\n" + "=".repeat(60) + "\n");

    actions.push({
      type: "info",
      description: `Captured ${cookies.length} cookies, ${
        Object.keys(localStorage).length
      } localStorage, ${
        Object.keys(sessionStorage).length
      } sessionStorage to temp_credentials.yaml`,
      timestamp: Date.now(),
    });
  }

  /**
   * Get action type from command
   */
  private getActionType(command: string): ActionLog["type"] {
    switch (command) {
      case "navigate":
        return "navigate";
      case "click":
      case "hover":
      case "press":
        return "click";
      case "fill":
      case "type":
      case "select":
        return "fill";
      case "wait":
      case "waitForText":
        return "wait";
      default:
        return "info";
    }
  }
}
