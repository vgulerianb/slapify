import fs from "fs";
import path from "path";
import { generateText } from "ai";
import cron from "node-cron";
import { createSession as createWreqSession } from "wreq-js";
import { BrowserAgent } from "../browser/agent.js";
import { loadConfig, loadCredentials } from "../config/loader.js";
import { getModel } from "../ai/interpreter.js";
import { taskTools, TaskToolName } from "./tools.js";
import {
  createSession,
  loadSession,
  saveSessionMeta,
  appendEvent,
  updateSessionStatus,
} from "./session.js";
import {
  TaskRunOptions,
  TaskSession,
  TaskEvent,
  ToolCallRecord,
} from "./types.js";
import { CredentialProfile } from "../types.js";

const MAX_MESSAGES_BEFORE_COMPACT = 60;
const COMPACT_KEEP_RECENT = 20;
const DEFAULT_MAX_ITERATIONS = 400;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Slapify Task Agent — a fully autonomous web agent. You decide the best approach for any task yourself.

## Tools
- **fetch_url(url)** — Direct HTTP GET, bypasses browser. No CAPTCHA. Instant. Use for APIs and data.
- **navigate(url)** + **get_page_state()** — Browser navigation. get_page_state() returns all visible text and interactive refs.
- **click(ref)**, **type(ref, text)**, **press(key)**, **scroll(direction)**, **wait(seconds)** — Browser interaction.
- **list_credential_profiles()**, **inject_credentials(profile)**, **fill_login_form(profile)** — Authentication.
- **remember(key, value)**, **recall(key)**, **list_memories()** — Persistent memory.
- **schedule(cron, task)**, **sleep_until(datetime)** — Time-based control.
- **perf_audit(url)** — Full performance audit for a URL. Automatically navigates to the page, then collects: scores (Performance/Accessibility/SEO/Best Practices 0-100), real-user metrics (FCP, LCP, CLS, TTFB), framework detection, re-render analysis with simulated interactions, and network analysis (resource sizes, API calls, long tasks).
  You can call perf_audit multiple times with different URLs to compare pages — the report will show a side-by-side comparison table automatically.
  Do NOT call navigate() before perf_audit — it handles navigation itself.
  If the user asks to audit multiple pages on a domain (e.g. "check pricing and about on vercel.com"), also audit the root/home page (e.g. https://vercel.com/) unless they explicitly say to skip it.
  When summarising results, use neutral section labels. Never write "Lighthouse", "React Scan", or any vendor tool name. Use: "Performance Scores", "Real User Metrics", "Lab Metrics", "Framework & Re-renders", "Interaction Tests", "Network & Runtime".
  The result includes a "network" field with: totalRequests, totalKB, jsKB, apiCalls count, slowApiCalls (>500ms), failedApiCalls, longTasks count, totalBlockingMs, memoryMB, slowApis list, and heaviestResources list. Include these in your summary.
- **done(summary)** — Signal task complete with full results.

## How to approach any task

**Step 1 — Plan before acting.** Decide: is this a data lookup, an interactive task, or an authenticated task?

**Data lookup** (prices, news, weather, facts, rates):
  Think: does a free public HTTP API exist for this? Most financial/data topics have open APIs.
  Try fetch_url() on a likely API endpoint first — it returns data in <1s with no CAPTCHA or JS rendering issues.
  If you find useful JSON, parse it and call done() immediately.
  If no API works, navigate to a site and read get_page_state() — it contains all visible text.

**Interactive task** (filling forms, clicking buttons, posting content):
  Use the browser. Navigate → get_page_state() → interact using ref IDs from the snapshot.

**Authenticated task** (anything requiring login):
  1. Check memory for a saved thread_url or page_url — navigate directly there first.
  2. Call get_page_state() — if the URL is the target site (not a login page), you are already logged in. Proceed.
  3. Only if you see a login form: call list_credential_profiles() and use the best matching profile.
  This avoids unnecessary re-login on every scheduled check-in.

**Monitoring / ongoing task** — CRITICAL RULE:
  Keywords: "monitor", "keep checking", "wait for reply", "keep me updated", "feel free to engage",
  "notify when", "let me know when", "keep watching", "ongoing", "until X happens"

  These tasks NEVER call done() on their own. The user stops them with Ctrl+C.
  Correct flow (FIRST RUN — initial session):
    1. Perform the first action (send message, check price, etc.)
    2. IMMEDIATELY call remember() to store key context:
       - remember("thread_url", "<exact URL of the conversation/page>")
       - remember("last_message_sent", "<text of message you sent>")
       - remember("monitoring_target", "<name of person/thing being monitored>")
    3. Call status_update() to confirm what was done
    4. Call schedule() with a sensible cron interval (e.g. every 5 min for messages, every hour for prices)
    5. Do NOT call done() — the process stays alive, re-running at each cron interval

  Correct flow (SCHEDULED CHECK-IN — sub-run spawned by cron):
    1. Check memory for thread_url — navigate DIRECTLY there (do NOT start from homepage)
    2. Check if you are already logged in by reading get_page_state(). If the URL is the target page, you ARE logged in.
    3. Only log in if the page is a login form. Use list_credential_profiles() to find the right profile.
    4. After navigating to the thread, read get_page_state() to find the latest messages
    5. Compare with last_message_sent in memory — look for NEW messages from the other person
    6. If there is a new message: respond naturally, then update remember("last_message_sent", ...) with your reply
    7. If no new message: call status_update("No new reply from <person> yet. Checking again later.")
    8. Call done() — the cron will re-run automatically. Do NOT call schedule() again.

  Example — "send a message and monitor for reply":
    FIRST RUN:
      → Send message
      → remember("thread_url", "https://www.linkedin.com/messaging/thread/...")
      → remember("last_message_sent", "Hello Payal! 👋 How are you doing?")
      → status_update("✉️ Message sent. Monitoring for reply every 5 minutes.")
      → schedule("*/5 * * * *", "Check LinkedIn messages from Payal Sahu and respond if she replied")
      [do NOT call done()]

    SCHEDULED CHECK-IN:
      → recall("thread_url") → navigate directly to that URL
      → get_page_state() → find latest message in the thread
      → if Target replied: type and send a response, remember("last_message_sent", ...)
      → status_update("✅ Target replied: '...' — responded with '...'" OR "No new reply yet.")
      → done() [cron handles the next run]

**Recurring task** ("every day", "check hourly", "daily at 9am"):
  Execute once, then call schedule() with the cron expression you choose. Don't call done().

## Handling obstacles — figure it out

**CAPTCHA in browser:**
  → First try fetch_url() on the same URL or a different source — direct HTTP never triggers CAPTCHA.
  → If you must solve it in the browser: call get_page_state() to inspect the CAPTCHA. Look for an iframe or checkbox element. For reCAPTCHA v2, find and click the "I'm not a robot" checkbox ref. For image CAPTCHAs, look for the audio challenge link.
  → If one site gives CAPTCHA, try a completely different site with the same data.

**"Just a moment..." / Cloudflare:**
  → Bot protection. Switch to fetch_url() on that URL, or find a different site entirely.

**Empty page snapshot / "no interactive elements":**
  → JS-rendered page. Call wait(3) then get_page_state() again.
  → Still empty? Try fetch_url() on the same URL — the raw HTML often has the data even when browser rendering fails.

**API returns error / bad format:**
  → Try a different endpoint. Think what other public data sources exist for this topic.

**Stuck after multiple attempts:**
  → Change strategy completely. If browser isn't working, use fetch_url(). If one site fails, try another.
  → Never repeat the same failing action more than twice.
  -> Make sure to not guess URLs unless you are 100% sure about it, prefer navigating by clicking on available options.

## Batching tool calls — reduce round trips

You can return **multiple tool calls in a single response** when they don't depend on each other's output.
This is faster — all calls in one response execute in parallel before the next LLM turn.

**Good batching examples:**
- After a snapshot you already have refs → batch: type(emailRef, ...) + type(passwordRef, ...) + click(submitRef)
- Memory + notification → batch: remember(key, val) + status_update(msg)
- Click then wait → batch: click(ref) + wait(2)  (wait does not need click result)
- Multiple remembers → batch: remember(k1, v1) + remember(k2, v2) + remember(k3, v3)

**Do NOT batch when the second call needs the first call's output:**
- navigate + click → you need get_page_state() in between to learn the ref
- get_page_state + click → click ref comes FROM get_page_state result

**Login form shortcut** — once you have refs from a snapshot, fill the whole form in ONE response:
  type(emailRef, email) + type(passwordRef, password) + click(submitRef)
  Then in the NEXT response: wait(3) + get_page_state() to verify.

## Reading data

- get_page_state() snapshot contains ALL visible text: prices, numbers, paragraphs, labels. Read it carefully before giving up.
- Do NOT use screenshot() for data extraction — you cannot see images.
- Always call get_page_state() after every navigate().

## Human in the loop

Use **ask_user(question, hint?)** when you genuinely need information not available elsewhere:
- A one-time password (OTP) or 2FA code
- A missing password or PIN that isn't in the credential store
- Clarification about what the user wants when the goal is ambiguous
- Confirmation before taking a destructive or irreversible action

Keep questions concise. Use the hint field to tell them where to find the answer (e.g. "Check your authenticator app").

**MANDATORY after every successful login:**
1. Call save_credentials with capture_from_browser: true immediately after you verify the login worked.
   Use a sensible profile_name (e.g. "linkedin", "gmail", "twitter").
   This saves the session cookies so they can be reused next time without logging in again.
2. Then call status_update("✅ Logged in as [username]. Session saved as '[profile_name]' for future use.")

Do not ask the user whether to save — just save automatically. If the site was already logged in via injected credentials, skip this step.

## Keeping the user informed

Use **status_update(message)** to post visible updates whenever something meaningful happens:
- When starting a scheduled check: "⏰ Running scheduled gold price check..."
- When you find data: "📊 Found gold price: $4,986/oz"
- When retrying or switching approach: "🔄 Switching to Yahoo Finance..."
- When sleeping: "😴 Waiting 30 minutes before next check. Last price: $4,986/oz"
- For recurring tasks: post a status_update at the start and end of each run

Do NOT use status_update for every small step — only for things the user would actually want to see.

## Completion rules
- Use remember() the moment you find important data, before calling done().
- Call done() with a complete, specific summary including exact data found.
- Never give up without trying at least 4-5 different approaches.
- Never ask the user for help — figure it out.
- **NEVER call done() if the task involves monitoring, waiting for replies, or ongoing engagement.**
  Those tasks end only when the user presses Ctrl+C. Use schedule() instead.
`;

// ─── Parse sleep duration ─────────────────────────────────────────────────────

function parseSleepMs(until: string): number {
  // Try ISO datetime first
  const asDate = new Date(until);
  if (!isNaN(asDate.getTime())) {
    const ms = asDate.getTime() - Date.now();
    return Math.max(0, ms);
  }

  // Natural language durations
  const lower = until.toLowerCase().trim();
  const patterns: Array<[RegExp, number]> = [
    [/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/, 1000],
    [/^(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?$/, 60_000],
    [/^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/, 3_600_000],
    [/^(\d+(?:\.\d+)?)\s*d(?:ays?)?$/, 86_400_000],
  ];
  for (const [re, mult] of patterns) {
    const m = lower.match(re);
    if (m) return Math.round(parseFloat(m[1]) * mult);
  }

  // "tomorrow 9am" — rough
  if (lower.includes("tomorrow")) {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2] || "0");
      if (timeMatch[3] === "pm" && hour < 12) hour += 12;
      if (timeMatch[3] === "am" && hour === 12) hour = 0;
      tomorrow.setHours(hour, min, 0, 0);
    }
    return Math.max(0, tomorrow.getTime() - Date.now());
  }

  // Fallback: 60 seconds
  return 60_000;
}

// ─── Tool executor ────────────────────────────────────────────────────────────

class ToolExecutor {
  // Persistent wreq-js session — impersonates Chrome TLS, bypasses Cloudflare/bot detection
  // Shared across all fetch_url calls within one task run so cookies are maintained
  private wreqSession: Awaited<ReturnType<typeof createWreqSession>> | null =
    null;

  constructor(
    private browser: BrowserAgent,
    private session: TaskSession,
    private credentials: Record<string, CredentialProfile>,
    private emit: (event: TaskEvent) => void,
    private onHumanInput: (q: string, hint?: string) => Promise<string>,
    private credentialsFilePath: string,
    private isScheduledRun: boolean = false,
    private schema?: Record<string, unknown>,
    private outputFile?: string
  ) {}

  private async getWreqSession() {
    if (!this.wreqSession) {
      this.wreqSession = await createWreqSession({
        browser: "chrome_131",
        os: "macos",
      });
    }
    return this.wreqSession;
  }

  async closeWreqSession() {
    if (this.wreqSession) {
      try {
        await this.wreqSession.close();
      } catch {}
      this.wreqSession = null;
    }
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (toolName as TaskToolName) {
      // ── Browser ────────────────────────────────────────────────────────

      case "navigate": {
        const url = args.url as string;
        await this.browser.navigate(url);
        // After navigation, patch new-tab openers so the agent stays in context
        try {
          await this.browser.evaluate(
            `(function(){` +
              `document.querySelectorAll('a[target="_blank"]').forEach(function(a){a.setAttribute('target','_self');});` +
              `if(!window.__slapifyPatched){window.__slapifyPatched=true;` +
              `var _orig=window.open;window.open=function(url,name,features){if(url&&String(url).startsWith('http')){window.location.href=url;return window;}return _orig.apply(this,arguments);};` +
              `}` +
              `})()`
          );
        } catch {
          // Non-fatal
        }
        return { ok: true, url };
      }

      case "get_page_state": {
        const state = await this.browser.getState();
        return {
          url: state.url,
          title: state.title,
          snapshot: state.snapshot,
          refsCount: Object.keys(state.refs).length,
        };
      }

      case "click": {
        const ref = args.ref as string;
        // Patch new-tab openers so the agent retains context after the click.
        // agent-browser operates on one active tab only — new tabs are invisible.
        try {
          await this.browser.evaluate(
            `(function(){` +
              // Rewrite all target="_blank" links to open in the same tab
              `document.querySelectorAll('a[target="_blank"]').forEach(function(a){a.setAttribute('target','_self');});` +
              // Override window.open so JS-driven popups navigate instead
              `if(!window.__slapifyPatched){window.__slapifyPatched=true;` +
              `var _orig=window.open;window.open=function(url,name,features){if(url&&String(url).startsWith('http')){window.location.href=url;return window;}return _orig.apply(this,arguments);};` +
              `}` +
              `})()`
          );
        } catch {
          // Non-fatal — some pages block eval via CSP; proceed anyway
        }
        await this.browser.click(ref);
        return { ok: true, clicked: ref };
      }

      case "type": {
        const ref = args.ref as string;
        const text = args.text as string;
        const append = args.append as boolean | undefined;
        if (!append) {
          await this.browser.fill(ref, text);
        } else {
          await this.browser.type(ref, text);
        }
        return { ok: true };
      }

      case "press": {
        const key = args.key as string;
        await this.browser.press(key);
        return { ok: true };
      }

      case "scroll": {
        const dir = args.direction as "up" | "down" | "left" | "right";
        const amount = (args.amount as number) || 300;
        await this.browser.scroll(dir, amount);
        return { ok: true };
      }

      case "wait": {
        const seconds = args.seconds as number;
        await this.browser.wait(seconds * 1000);
        return { ok: true, waited: `${seconds}s` };
      }

      case "screenshot": {
        const screenshotPath = await this.browser.screenshot();
        return {
          ok: true,
          path: screenshotPath,
          note: "Screenshot captured. Check get_page_state() for interactive elements.",
        };
      }

      case "reload": {
        await this.browser.reload();
        return { ok: true };
      }

      case "go_back": {
        await this.browser.goBack();
        return { ok: true };
      }

      // ── Credentials ────────────────────────────────────────────────────

      case "list_credential_profiles": {
        const profiles = Object.entries(this.credentials).map(([name, p]) => ({
          name,
          type: p.type,
          hasUsername: !!(p.username || p.email),
          hasCookies: !!(p.cookies && p.cookies.length > 0),
          hasLocalStorage: !!(
            p.localStorage && Object.keys(p.localStorage).length > 0
          ),
        }));
        return { profiles };
      }

      case "inject_credentials": {
        const profileName = args.profile_name as string;
        const profile = this.credentials[profileName];
        if (!profile) {
          return { ok: false, error: `Profile '${profileName}' not found` };
        }
        if (profile.type !== "inject") {
          return {
            ok: false,
            error: `Profile '${profileName}' is type '${profile.type}', use fill_login_form for login-form profiles`,
          };
        }
        await this.injectProfile(profile);
        await this.browser.wait(300);
        await this.browser.reload();
        return { ok: true, injected: profileName };
      }

      case "fill_login_form": {
        const profileName = args.profile_name as string;
        const profile = this.credentials[profileName];
        if (!profile) {
          return { ok: false, error: `Profile '${profileName}' not found` };
        }
        if (profile.type !== "login-form") {
          return {
            ok: false,
            error: `Profile '${profileName}' is type '${profile.type}'. Use inject_credentials for inject profiles.`,
          };
        }
        // Return credentials for the model to fill — it knows the page structure
        return {
          ok: true,
          username: profile.username || profile.email || profile.phone || "",
          password: profile.password || "",
          hint: "Use get_page_state() to find the username/password fields, then type into them and submit the form.",
        };
      }

      // ── CAPTCHA ────────────────────────────────────────────────────────

      case "solve_captcha": {
        // Get current page state to find CAPTCHA elements
        const state = await this.browser.getState();
        const snapshot = state.snapshot || "";
        const solved: string[] = [];
        const failed: string[] = [];

        // Strategy 1: find reCAPTCHA iframe checkbox via ref
        // The snapshot sometimes exposes the iframe or a button inside it
        const captchaRefs = Object.entries(state.refs).filter(([, info]) => {
          const text = (info.name || info.text || "").toLowerCase();
          return (
            text.includes("not a robot") ||
            text.includes("i'm not a robot") ||
            text.includes("checkbox") ||
            info.role === "checkbox"
          );
        });

        for (const [ref] of captchaRefs) {
          try {
            await this.browser.click(ref);
            await this.browser.wait(2000);
            solved.push(`Clicked checkbox ref ${ref}`);
          } catch {
            failed.push(`Failed to click ref ${ref}`);
          }
        }

        // Strategy 2: look for audio challenge link
        const audioRefs = Object.entries(state.refs).filter(([, info]) => {
          const text = (info.name || info.text || "").toLowerCase();
          return text.includes("audio") || text.includes("sound");
        });

        for (const [ref] of audioRefs.slice(0, 1)) {
          try {
            await this.browser.click(ref);
            await this.browser.wait(1500);
            solved.push(`Clicked audio challenge ref ${ref}`);
          } catch {
            failed.push(`Failed to click audio ref ${ref}`);
          }
        }

        // Re-read state to see if solved
        const newState = await this.browser.getState();
        const captchaStillPresent =
          newState.snapshot?.toLowerCase().includes("captcha") ||
          newState.snapshot?.toLowerCase().includes("not a robot") ||
          newState.url?.includes("sorry");

        return {
          attempted: solved.length > 0,
          solved: solved,
          failed: failed,
          captchaStillPresent,
          currentUrl: newState.url,
          hint: captchaStillPresent
            ? "CAPTCHA still present. Try fetch_url() on a different source for the same data."
            : "CAPTCHA appears resolved. Call get_page_state() to continue.",
        };
      }

      // ── HTTP / Data ────────────────────────────────────────────────────

      case "fetch_url": {
        const url = args.url as string;
        const extraHeaders = (args.headers as Record<string, string>) || {};
        // wreq-js impersonates Chrome TLS fingerprint at the Rust level
        // → bypasses Cloudflare, DataDome, and other bot detection without a browser
        // → session persists cookies across calls within this task run
        const wreq = await this.getWreqSession();
        const resp = await wreq.fetch(url, {
          headers: {
            Accept: "application/json, text/html, */*",
            "Accept-Language": "en-US,en;q=0.9",
            ...extraHeaders,
          },
        });
        const contentType = resp.headers.get("content-type") || "";
        const text = await resp.text();
        let body: unknown = text;
        if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
        return {
          ok: resp.ok,
          status: resp.status,
          body:
            bodyStr.slice(0, 8000) +
            (bodyStr.length > 8000 ? "…[truncated]" : ""),
        };
      }

      // ── Memory ─────────────────────────────────────────────────────────

      case "remember": {
        const key = args.key as string;
        const value = args.value as string;
        this.session.memory[key] = value;
        saveSessionMeta(this.session);
        appendEvent(this.session.id, {
          type: "memory_update",
          key,
          value,
          ts: new Date().toISOString(),
        });
        return { ok: true, stored: key };
      }

      case "recall": {
        const key = args.key as string;
        const value = this.session.memory[key];
        return value !== undefined
          ? { ok: true, key, value }
          : { ok: false, key, error: "Key not found in memory" };
      }

      case "list_memories": {
        return {
          keys: Object.keys(this.session.memory),
          count: Object.keys(this.session.memory).length,
        };
      }

      case "status_update": {
        const message = args.message as string;
        this.emit({ type: "status_update", message });
        return { ok: true };
      }

      case "ask_user": {
        const question = args.question as string;
        const hint = args.hint as string | undefined;
        this.emit({ type: "human_input_needed", question, hint });
        const answer = await this.onHumanInput(question, hint);
        appendEvent(this.session.id, {
          type: "tool_call",
          toolName: "ask_user",
          args: { question, hint },
          result: { answer: "[redacted from logs]" },
          ts: new Date().toISOString(),
        });

        // If the answer looks like it contains credentials (email+password pattern),
        // immediately offer to save them — don't rely on the LLM to remember
        const looksLikeCreds =
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i.test(answer) &&
          answer.includes(" ");
        if (looksLikeCreds) {
          const saveParts = answer.split(
            /\s+(?:and\s+)?(?:password\s+is\s+|pass(?:word)?[:\s]+)?/i
          );
          const suggestedEmail = saveParts[0]?.trim();
          const suggestedPassword = saveParts[1]?.trim();

          this.emit({
            type: "human_input_needed",
            question: `💾 Save these credentials for future sessions?`,
            hint: `Profile name to save as (or press Enter to skip)`,
          });
          const saveAs = await this.onHumanInput(
            "💾 Save these credentials for future sessions?",
            "Enter a profile name (e.g. 'linkedin', 'gmail') or leave blank to skip"
          );

          if (saveAs && saveAs.trim()) {
            const profileName = saveAs
              .trim()
              .toLowerCase()
              .replace(/\s+/g, "-");
            const profile: CredentialProfile = {
              type: "login-form",
              ...(suggestedEmail && { username: suggestedEmail }),
              ...(suggestedPassword && { password: suggestedPassword }),
            };
            try {
              const yaml = (await import("yaml")).default;
              let existing: { profiles: Record<string, CredentialProfile> } = {
                profiles: {},
              };
              if (fs.existsSync(this.credentialsFilePath)) {
                try {
                  const parsed = yaml.parse(
                    fs.readFileSync(this.credentialsFilePath, "utf-8")
                  );
                  if (parsed?.profiles) existing = parsed;
                } catch {}
              }
              existing.profiles[profileName] = profile;
              fs.mkdirSync(path.dirname(this.credentialsFilePath), {
                recursive: true,
              });
              fs.writeFileSync(
                this.credentialsFilePath,
                yaml.stringify(existing, { indent: 2, lineWidth: 0 })
              );
              this.credentials[profileName] = profile;
              this.emit({
                type: "credentials_saved",
                profileName,
                credType: "login-form",
              });
            } catch {}
          }
        }

        return { answer };
      }

      case "save_credentials": {
        const profileName = args.profile_name as string;
        const credType = args.type as "inject" | "login-form";
        const captureFromBrowser = args.capture_from_browser as
          | boolean
          | undefined;

        const profile: CredentialProfile = { type: credType };

        if (credType === "login-form") {
          if (args.username) profile.username = args.username as string;
          if (args.password) profile.password = args.password as string;
        }

        if (credType === "inject" && captureFromBrowser) {
          // Capture cookies + localStorage + sessionStorage from current browser state
          try {
            const cookies = await this.browser.getCookies();
            const localStorage = await this.browser.getLocalStorage();
            const sessionStorage = await this.browser.getSessionStorage();

            if (cookies.length > 0) {
              profile.cookies = cookies.map((c) => ({
                name: c.name,
                value: c.value,
              }));
            }
            const toStorageObj = (v: unknown): Record<string, string> => {
              if (!v || typeof v !== "object" || Array.isArray(v)) return {};
              const out: Record<string, string> = {};
              for (const [k, val] of Object.entries(v)) {
                out[String(k)] =
                  typeof val === "string" ? val : JSON.stringify(val);
              }
              return out;
            };
            const ls = toStorageObj(localStorage);
            const ss = toStorageObj(sessionStorage);
            if (Object.keys(ls).length > 0) profile.localStorage = ls;
            if (Object.keys(ss).length > 0) profile.sessionStorage = ss;
          } catch (e: any) {
            return {
              ok: false,
              error: `Failed to capture browser state: ${e.message}`,
            };
          }
        }

        // Write to credentials.yaml
        try {
          const yaml = (await import("yaml")).default;
          let existing: { profiles: Record<string, CredentialProfile> } = {
            profiles: {},
          };
          if (fs.existsSync(this.credentialsFilePath)) {
            try {
              const parsed = yaml.parse(
                fs.readFileSync(this.credentialsFilePath, "utf-8")
              );
              if (parsed?.profiles) existing = parsed;
            } catch {}
          }
          existing.profiles[profileName] = profile;
          fs.mkdirSync(path.dirname(this.credentialsFilePath), {
            recursive: true,
          });
          fs.writeFileSync(
            this.credentialsFilePath,
            yaml.stringify(existing, { indent: 2, lineWidth: 0 })
          );
          this.credentials[profileName] = profile;
          this.emit({ type: "credentials_saved", profileName, credType });
          return {
            ok: true,
            message: `Saved profile '${profileName}' (${credType}) to credentials.yaml`,
            cookieCount: profile.cookies?.length ?? 0,
            localStorageKeys: Object.keys(profile.localStorage ?? {}).length,
          };
        } catch (e: any) {
          return {
            ok: false,
            error: `Failed to save credentials: ${e.message}`,
          };
        }
      }

      // ── Performance audit ──────────────────────────────────────────────

      case "perf_audit": {
        const auditUrl = args.url as string;
        const runLh = args.lighthouse !== false;
        const runReact = args.react_scan !== false;

        this.emit({
          type: "status_update",
          message: `⚡ Auditing ${auditUrl}...`,
        });

        try {
          const { runPerfAudit } = await import("../perf/audit.js");
          const result = await runPerfAudit(auditUrl, this.browser, {
            lighthouse: runLh,
            reactScan: runReact,
            settleMs: 2000,
            navigate: true, // tool handles navigation — agent doesn't need to pre-navigate
          });

          // Append to the per-session audit list (multi-page comparison support)
          if (!this.session.perfAudits) this.session.perfAudits = [];
          this.session.perfAudits.push(result);
          // Keep legacy single field pointing to the latest for backwards compat
          this.session.perfAudit = result;
          saveSessionMeta(this.session);

          const scores = result.scores ?? result.lighthouse;
          const net = result.network;
          const summary: Record<string, unknown> = {
            url: result.url,
            vitals: result.vitals,
            scores,
            react: result.react,
            network: net
              ? {
                  totalRequests: net.totalRequests,
                  totalKB: Math.round((net.totalBytes || 0) / 1024),
                  jsKB: Math.round((net.jsBytes || 0) / 1024),
                  apiCalls: net.apiCalls.length,
                  slowApiCalls: net.slowApiCalls.length,
                  failedApiCalls: net.failedApiCalls.length,
                  longTasks: net.longTasks.length,
                  totalBlockingMs: net.totalBlockingMs,
                  memoryMB: net.memoryMB,
                  slowApis: net.slowApiCalls.slice(0, 5).map((r) => ({
                    url: r.url.length > 80 ? "…" + r.url.slice(-80) : r.url,
                    method: r.method,
                    status: r.status,
                    durationMs: r.duration,
                  })),
                  heaviestResources: net.heaviestResources
                    .slice(0, 5)
                    .map((r) => ({
                      url: r.url.split("/").slice(-2).join("/"),
                      type: r.type,
                      sizeKB: Math.round(r.size / 1024),
                    })),
                }
              : null,
          };

          const lines: string[] = [`Audit complete for ${auditUrl}`];
          if (result.vitals.fcp) lines.push(`FCP: ${result.vitals.fcp}ms`);
          if (result.vitals.lcp) lines.push(`LCP: ${result.vitals.lcp}ms`);
          if (result.vitals.cls != null)
            lines.push(`CLS: ${result.vitals.cls}`);
          if (scores) {
            lines.push(
              `Scores — Perf ${scores.performance}/100 · A11y ${scores.accessibility}/100 · SEO ${scores.seo}/100`
            );
          }
          if (result.react?.detected) {
            const fw = result.react.version?.startsWith("(")
              ? result.react.version.slice(1, -1)
              : result.react.version;
            const interactions = result.react.interactionTests ?? [];
            const flagged = interactions.filter((t) => t.flagged).length;
            lines.push(
              `Framework: ${fw || "React"} · Re-render issues: ${
                result.react.issues.length
              }${
                interactions.length
                  ? ` · Interaction tests: ${interactions.length} (${flagged} flagged)`
                  : ""
              }`
            );
          }
          if (net) {
            lines.push(
              `Network: ${net.totalRequests} requests · ${Math.round(
                (net.totalBytes || 0) / 1024
              )}KB total · JS ${Math.round((net.jsBytes || 0) / 1024)}KB · ${
                net.apiCalls.length
              } API calls${
                net.slowApiCalls.length
                  ? ` (${net.slowApiCalls.length} slow)`
                  : ""
              }${
                net.failedApiCalls.length
                  ? ` (${net.failedApiCalls.length} failed)`
                  : ""
              } · ${net.longTasks.length} long tasks (${net.totalBlockingMs}ms)`
            );
          }

          this.emit({ type: "status_update", message: lines.join(" · ") });
          return summary;
        } catch (e: any) {
          return { ok: false, error: `Performance audit failed: ${e.message}` };
        }
      }

      // ── Scheduling ─────────────────────────────────────────────────────

      case "schedule": {
        const cronExpr = args.cron as string;
        const taskDesc = args.task_description as string;

        // Sub-runs must NOT create new cron jobs — the parent already owns the schedule
        if (this.isScheduledRun) {
          return {
            ok: false,
            error:
              "You are already running as a scheduled sub-task. Do NOT call schedule() again — the parent cron is still active. " +
              "Use status_update() to report findings, then finish. The next check will happen automatically.",
          };
        }

        if (!cron.validate(cronExpr)) {
          return { ok: false, error: `Invalid cron expression: ${cronExpr}` };
        }
        this.session.scheduledJobs.push({
          id: `job-${Date.now()}`,
          cron: cronExpr,
          taskDescription: taskDesc,
          createdAt: new Date().toISOString(),
        });
        saveSessionMeta(this.session);
        appendEvent(this.session.id, {
          type: "scheduled",
          cron: cronExpr,
          task: taskDesc,
          ts: new Date().toISOString(),
        });
        this.emit({ type: "scheduled", cron: cronExpr, task: taskDesc });
        return {
          ok: true,
          message: `Task scheduled: '${taskDesc}' with cron '${cronExpr}'. The process will stay alive and re-run at each interval.`,
        };
      }

      case "sleep_until": {
        const until = args.until as string;
        const reason = (args.reason as string) || "";
        const ms = parseSleepMs(until);
        const wakeTime = new Date(Date.now() + ms).toISOString();
        appendEvent(this.session.id, {
          type: "sleeping_until",
          until: wakeTime,
          ts: new Date().toISOString(),
        });
        this.emit({ type: "sleeping", until: wakeTime });
        updateSessionStatus(this.session, "sleeping");
        await new Promise((resolve) => setTimeout(resolve, ms));
        updateSessionStatus(this.session, "running");
        return { ok: true, sleptUntil: wakeTime, reason };
      }

      // ── Structured output ──────────────────────────────────────────────

      case "write_output": {
        if (!this.outputFile && !this.schema) {
          return {
            ok: false,
            error:
              "No schema or output file configured. Pass --schema and --output when starting the task.",
          };
        }
        const data = args.data as Record<string, unknown>;
        const mode = (args.mode as string) || "append";
        this.session.structuredOutput = writeStructuredOutput(
          data,
          mode as "append" | "overwrite",
          this.session.structuredOutput,
          this.outputFile
        );
        saveSessionMeta(this.session);
        if (this.outputFile) {
          this.emit({ type: "output_written", path: this.outputFile, data });
        }
        return { ok: true, written: data };
      }

      // ── Control ────────────────────────────────────────────────────────

      case "done": {
        // Handled in the main loop — this is a sentinel
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  }

  private async injectProfile(profile: CredentialProfile): Promise<void> {
    if (profile.cookies) {
      for (const cookie of profile.cookies) {
        try {
          await this.browser.setCookie(cookie.name, cookie.value);
        } catch {
          // continue on individual cookie errors
        }
      }
    }
    if (profile.localStorage) {
      for (const [k, v] of Object.entries(profile.localStorage)) {
        try {
          await this.browser.setLocalStorage(k, v);
        } catch {}
      }
    }
    if (profile.sessionStorage) {
      for (const [k, v] of Object.entries(profile.sessionStorage)) {
        try {
          await this.browser.setSessionStorage(k, v);
        } catch {}
      }
    }
  }
}

// ─── Structured output helpers ───────────────────────────────────────────────

/**
 * Merge or append `data` into the current structured output, and persist
 * to `outputFile` if provided.
 *
 * - mode "append": if current output is an array, push new entries; if object, merge keys; if null, use data directly
 * - mode "overwrite": replace entirely with data
 */
function writeStructuredOutput(
  data: Record<string, unknown>,
  mode: "append" | "overwrite",
  current: unknown,
  outputFile?: string
): unknown {
  let next: unknown;

  if (mode === "overwrite" || current == null) {
    next = data;
  } else if (Array.isArray(current)) {
    // If data itself is an array, concat; otherwise push the object
    next = Array.isArray(data) ? [...current, ...data] : [...current, data];
  } else if (typeof current === "object") {
    // Deep-ish merge: if both have an array property with the same key, concat those
    const merged: Record<string, unknown> = {
      ...(current as Record<string, unknown>),
    };
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(merged[k]) && Array.isArray(v)) {
        merged[k] = [...(merged[k] as unknown[]), ...v];
      } else {
        merged[k] = v;
      }
    }
    next = merged;
  } else {
    next = data;
  }

  if (outputFile) {
    try {
      const dir = path.dirname(path.resolve(outputFile));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        outputFile,
        JSON.stringify(next, null, 2) + "\n",
        "utf8"
      );
    } catch {
      // Don't crash the agent if file write fails
    }
  }

  return next;
}

// ─── Context compaction ───────────────────────────────────────────────────────

async function compactMessages(
  messages: Array<{ role: string; content: unknown }>,
  model: ReturnType<typeof getModel>,
  sessionId: string
): Promise<Array<{ role: string; content: unknown }>> {
  const toSummarize = messages.slice(0, messages.length - COMPACT_KEEP_RECENT);
  const recent = messages.slice(messages.length - COMPACT_KEEP_RECENT);

  if (toSummarize.length === 0) return messages;

  try {
    const { text: summary } = await generateText({
      model,
      messages: [
        {
          role: "user",
          content:
            "Summarize the following agent conversation history into a compact but detailed summary. Include: what was accomplished, current state, important findings stored in memory, any failures and what was tried. This summary will replace the history to save context.\n\n" +
            JSON.stringify(toSummarize, null, 2),
        },
      ],
    });

    appendEvent(sessionId, {
      type: "context_compacted",
      fromMessages: messages.length,
      toMessages: 1 + recent.length,
      ts: new Date().toISOString(),
    });

    return [
      {
        role: "user",
        content: `[Session history summary]\n${summary}`,
      },
      ...recent,
    ];
  } catch {
    // If compaction fails, just keep the recent messages
    return recent;
  }
}

// ─── Loop detection ───────────────────────────────────────────────────────────

// These tools are utility calls that are naturally repeated — exclude from loop detection
const LOOP_EXEMPT_TOOLS = new Set([
  "get_page_state",
  "screenshot",
  "wait",
  "scroll",
  "recall",
  "list_memories",
  "list_credential_profiles",
  "go_back",
  "reload",
  "fetch_url",
  "solve_captcha",
  "status_update",
  "ask_user",
  "save_credentials",
]);

class LoopDetector {
  private recentActions: string[] = [];
  private readonly WINDOW = 20;
  private readonly THRESHOLD = 5;

  record(toolName: string, args: Record<string, unknown>): void {
    // Skip exempt tools — they're naturally repetitive
    if (LOOP_EXEMPT_TOOLS.has(toolName)) return;
    const key = `${toolName}:${JSON.stringify(args)}`;
    this.recentActions.push(key);
    if (this.recentActions.length > this.WINDOW) {
      this.recentActions.shift();
    }
  }

  isLooping(): boolean {
    if (this.recentActions.length < this.WINDOW) return false;
    const counts = new Map<string, number>();
    for (const a of this.recentActions) {
      counts.set(a, (counts.get(a) || 0) + 1);
    }
    return [...counts.values()].some((c) => c >= this.THRESHOLD);
  }
}

// ─── Main TaskRunner ──────────────────────────────────────────────────────────

export async function runTask(options: TaskRunOptions): Promise<TaskSession> {
  const {
    goal,
    sessionId,
    headed,
    executablePath,
    saveFlow,
    flowOutputDir,
    schema,
    outputFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    onEvent,
    onSessionUpdate,
    isScheduledRun = false,
    inheritedMemory,
  } = options;

  const emit = (event: TaskEvent) => onEvent?.(event);

  // Load config and credentials
  const config = loadConfig();
  const model = getModel(config.llm);
  let credentials: Record<string, CredentialProfile> = {};
  try {
    const creds = loadCredentials();
    credentials = creds.profiles || {};
  } catch {
    // No credentials file is fine
  }

  // Set up browser
  const browser = new BrowserAgent({
    headless:
      headed === true
        ? false
        : headed === false
        ? true
        : config.browser?.headless ?? true,
    timeout: config.browser?.timeout,
    viewport: config.browser?.viewport,
    executablePath: executablePath || config.browser?.executablePath,
  });

  // Set up or resume session
  let session: TaskSession;
  let messages: Array<{ role: string; content: unknown }>;

  if (sessionId) {
    const existing = loadSession(sessionId);
    if (!existing) {
      throw new Error(`Session '${sessionId}' not found.`);
    }
    session = existing;
    session.status = "running";
    saveSessionMeta(session);
    // Rebuild messages from events
    const { rebuildMessages } = await import("./session.js");
    const events = (await import("./session.js")).loadEvents(sessionId);
    messages = rebuildMessages(events);
    emit({
      type: "message",
      text: `Resuming session ${sessionId} (iteration ${session.iteration})`,
    });
  } else {
    session = createSession(goal);

    // Merge inherited memory from parent session into this new session
    if (inheritedMemory && Object.keys(inheritedMemory).length > 0) {
      Object.assign(session.memory, inheritedMemory);
      saveSessionMeta(session);
    }

    messages = [{ role: "user", content: goal }];
    appendEvent(session.id, {
      type: "session_start",
      goal,
      ts: new Date().toISOString(),
    });
    emit({ type: "message", text: `Session ${session.id} started` });
  }

  // Notify caller of session so they can reference it for SIGINT handling
  onSessionUpdate?.(session);

  // Resolve credentials file path for save_credentials tool
  let credentialsFilePath = path.join(
    process.cwd(),
    ".slapify",
    "credentials.yaml"
  );
  try {
    const { getConfigDir } = await import("../config/loader.js");
    const cfgDir = getConfigDir();
    if (cfgDir) credentialsFilePath = path.join(cfgDir, "credentials.yaml");
  } catch {}

  // Default human input handler — reads from stdin (CLI overrides this via onHumanInput option)
  const defaultHumanInput = async (
    question: string,
    hint?: string
  ): Promise<string> => {
    const rl = (await import("readline")).createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      const prompt = hint
        ? `\n  ${question}\n  (${hint})\n  > `
        : `\n  ${question}\n  > `;
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  };

  const humanInputHandler = options.onHumanInput ?? defaultHumanInput;

  const executor = new ToolExecutor(
    browser,
    session,
    credentials,
    emit,
    humanInputHandler,
    credentialsFilePath,
    isScheduledRun,
    schema,
    outputFile
  );
  const loopDetector = new LoopDetector();

  // Initial memory injection: add existing/inherited memory to context
  if (Object.keys(session.memory).length > 0) {
    const memLines = Object.entries(session.memory)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");

    let memNote: string;
    if (isScheduledRun) {
      const threadUrl =
        session.memory["thread_url"] || session.memory["conversation_url"];
      const navigationHint = threadUrl
        ? `\nIMPORTANT: Navigate directly to ${threadUrl} — do NOT start a new login flow if you are already on LinkedIn.`
        : "";
      memNote =
        `[SCHEDULED CHECK-IN — you are a recurring monitoring run]\n` +
        `This is NOT the first run. A parent cron job spawned you. Do NOT call schedule() again.\n` +
        `Your job: check for new activity, respond if needed, call done() when finished.\n` +
        `\nContext from parent session:\n${memLines}` +
        navigationHint;
    } else {
      memNote = `[Memory from previous session]\n${memLines}`;
    }

    messages.unshift({ role: "user", content: memNote });
  } else if (isScheduledRun) {
    // Even with no memory, tell the agent not to re-schedule
    messages.unshift({
      role: "user",
      content:
        "[SCHEDULED CHECK-IN] You are a recurring monitoring run. " +
        "Do NOT call schedule() again. Check for new activity, respond if needed, then call done().",
    });
  }

  let isDone = false;
  let doneSummary = "";

  try {
    while (!isDone && session.iteration < maxIterations) {
      session.iteration++;
      saveSessionMeta(session);
      onSessionUpdate?.(session);

      appendEvent(session.id, {
        type: "iteration_start",
        iteration: session.iteration,
        ts: new Date().toISOString(),
      });

      // Compact context if it's getting large
      if (messages.length > MAX_MESSAGES_BEFORE_COMPACT) {
        emit({ type: "message", text: "Compacting context..." });
        messages = await compactMessages(messages, model, session.id);
      }

      emit({ type: "thinking" });

      // Build per-run system prompt, appending schema instructions if provided
      const systemPrompt = schema
        ? SYSTEM_PROMPT +
          `\n\n## Structured Output Schema\nThe user expects output that conforms to this JSON schema:\n\`\`\`json\n${JSON.stringify(
            schema,
            null,
            2
          )}\n\`\`\`\nUse the **write_output** tool to write conforming data whenever you have results to record (after each scheduled run, after collecting data, or before calling done). For array schemas, each write_output call appends new entries. For object schemas, each call updates the object. Always call write_output before done() when a schema is provided.`
        : SYSTEM_PROMPT;

      // ── THINK ──────────────────────────────────────────────────────────
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: messages as Parameters<typeof generateText>[0]["messages"],
        tools: taskTools,
      });

      const toolCallRecords: ToolCallRecord[] = (result.toolCalls || []).map(
        (tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args as Record<string, unknown>,
        })
      );

      appendEvent(session.id, {
        type: "llm_response",
        text: result.text || "",
        toolCalls: toolCallRecords,
        ts: new Date().toISOString(),
      });

      // If the model said something (text), emit it
      if (result.text) {
        emit({ type: "message", text: result.text });
      }

      // Build assistant message for history
      const assistantContent: unknown[] = [];
      if (result.text) {
        assistantContent.push({ type: "text", text: result.text });
      }
      for (const tc of result.toolCalls || []) {
        assistantContent.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        });
      }
      if (assistantContent.length > 0) {
        messages.push({ role: "assistant", content: assistantContent });
      }

      // No tool calls = model is done thinking without acting
      if (!result.toolCalls || result.toolCalls.length === 0) {
        if (result.finishReason === "stop") {
          doneSummary = result.text || "Task complete.";
          isDone = true;
          break;
        }
        continue;
      }

      // ── ACT ────────────────────────────────────────────────────────────
      const toolResultContent: unknown[] = [];

      for (const tc of result.toolCalls) {
        const toolName = tc.toolName as string;
        const args = tc.args as Record<string, unknown>;

        // Check for done sentinel BEFORE executing
        if (toolName === "done") {
          doneSummary = (args.summary as string) || "Task complete.";
          isDone = true;

          // If save_flow requested, generate a .flow file
          if (args.save_flow || saveFlow) {
            const flowPath = await generateFlowFile(
              session,
              goal,
              flowOutputDir
            );
            session.savedFlowPath = flowPath;
            emit({ type: "flow_saved", path: flowPath });
          }

          // Still add tool result to history
          toolResultContent.push({
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName,
            result: JSON.stringify({ ok: true }),
          });
          appendEvent(session.id, {
            type: "tool_call",
            toolName,
            args: args as Record<string, unknown>,
            result: { ok: true },
            ts: new Date().toISOString(),
          });
          break;
        }

        // Loop detection
        loopDetector.record(toolName, args);
        if (loopDetector.isLooping()) {
          emit({
            type: "message",
            text: "Loop detected — changing approach...",
          });
          toolResultContent.push({
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName,
            result: JSON.stringify({
              ok: false,
              error:
                "Loop detected: you have been repeating the same actions. Change your approach or call done().",
            }),
          });
          continue;
        }

        emit({ type: "tool_start", toolName, args });

        let toolResult: unknown;
        try {
          toolResult = await executor.execute(toolName, args);

          appendEvent(session.id, {
            type: "tool_call",
            toolName,
            args,
            result: toolResult,
            ts: new Date().toISOString(),
          });

          const resultStr =
            typeof toolResult === "string"
              ? toolResult
              : JSON.stringify(toolResult);
          emit({
            type: "tool_done",
            toolName,
            result: resultStr.slice(0, 200),
          });

          toolResultContent.push({
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName,
            result: resultStr,
          });
        } catch (err: any) {
          const errorMsg = err?.message || String(err);
          appendEvent(session.id, {
            type: "tool_error",
            toolName,
            args,
            error: errorMsg,
            ts: new Date().toISOString(),
          });
          emit({ type: "tool_error", toolName, error: errorMsg });
          toolResultContent.push({
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName,
            result: JSON.stringify({ ok: false, error: errorMsg }),
          });
        }
      }

      if (toolResultContent.length > 0) {
        messages.push({ role: "tool", content: toolResultContent });
      }
    }

    if (session.iteration >= maxIterations && !isDone) {
      doneSummary = `Task hit the maximum iteration limit (${maxIterations}) without completing.`;
      updateSessionStatus(session, "failed");
    } else if (isDone) {
      // If there are scheduled jobs, keep alive
      if (session.scheduledJobs.length > 0) {
        await startScheduledJobs(session, options, credentials, config, emit);
      } else {
        updateSessionStatus(session, "completed");
      }
    }

    session.finalSummary = doneSummary;
    saveSessionMeta(session);

    appendEvent(session.id, {
      type: "session_end",
      summary: doneSummary,
      status: session.status,
      ts: new Date().toISOString(),
    });

    emit({ type: "done", summary: doneSummary });
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    updateSessionStatus(session, "failed");
    session.finalSummary = `Error: ${errorMsg}`;
    saveSessionMeta(session);
    emit({ type: "error", error: errorMsg });
    throw err;
  } finally {
    try {
      browser.close();
    } catch {}
    try {
      await executor.closeWreqSession();
    } catch {}
  }

  return session;
}

// ─── Scheduled jobs ───────────────────────────────────────────────────────────

async function startScheduledJobs(
  session: TaskSession,
  options: TaskRunOptions,
  _credentials: Record<string, CredentialProfile>,
  _config: ReturnType<typeof loadConfig>,
  emit: (event: TaskEvent) => void
): Promise<void> {
  updateSessionStatus(session, "scheduled");

  for (const job of session.scheduledJobs) {
    emit({
      type: "message",
      text: `Registering cron: ${job.cron} — ${job.taskDescription}`,
    });

    cron.schedule(job.cron, async () => {
      const now = new Date().toISOString();
      job.lastRun = now;
      saveSessionMeta(session);
      emit({
        type: "message",
        text: `[cron ${job.cron}] Running: ${job.taskDescription}`,
      });

      // Snapshot current memory so sub-run inherits full context
      const memorySnapshot = { ...session.memory };

      // Augment the goal with a direct hint about the thread URL if we have it
      const threadUrl =
        memorySnapshot["thread_url"] || memorySnapshot["conversation_url"];
      const augmentedGoal = threadUrl
        ? `${job.taskDescription}\n\n[Use thread_url from memory: ${threadUrl}]`
        : job.taskDescription;

      try {
        await runTask({
          ...options,
          goal: augmentedGoal,
          sessionId: undefined, // always a fresh session (memory is passed via inheritedMemory)
          isScheduledRun: true,
          inheritedMemory: memorySnapshot,
        });
      } catch (err: any) {
        emit({ type: "error", error: `Cron job failed: ${err?.message}` });
      }
    });
  }

  emit({
    type: "message",
    text: `${session.scheduledJobs.length} cron job(s) active. Process will stay alive. Press Ctrl+C to stop.`,
  });

  // Keep process alive indefinitely for cron jobs
  await new Promise<void>(() => {});
}

// ─── Flow file generation ─────────────────────────────────────────────────────

async function generateFlowFile(
  session: TaskSession,
  goal: string,
  outputDir?: string
): Promise<string> {
  const lines: string[] = [
    `# Generated from task: ${goal}`,
    `# Session: ${session.id}`,
    `# Generated: ${new Date().toISOString()}`,
    "",
  ];

  // Walk events and build flow steps
  const { loadEvents } = await import("./session.js");
  const events = loadEvents(session.id);

  for (const event of events) {
    if (event.type === "tool_call") {
      const line = toolCallToFlowStep(event.toolName, event.args);
      if (line) lines.push(line);
    }
  }

  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");

  const dir = outputDir
    ? path.resolve(process.cwd(), outputDir)
    : process.cwd();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const flowPath = path.join(dir, `${slug}.flow`);
  fs.writeFileSync(flowPath, lines.join("\n") + "\n");
  return flowPath;
}

function toolCallToFlowStep(
  toolName: string,
  args: Record<string, unknown>
): string | null {
  switch (toolName) {
    case "navigate":
      return `Go to ${args.url}`;
    case "click":
      return `Click ${args.description || args.ref}`;
    case "type":
      return `Type "${args.text}" into ${args.ref}`;
    case "press":
      return `Press ${args.key}`;
    case "wait":
      return `Wait ${args.seconds} seconds`;
    case "scroll":
      return `Scroll ${args.direction}`;
    case "reload":
      return `Reload page`;
    case "go_back":
      return `Go back`;
    case "inject_credentials":
      return `@inject ${args.profile_name}`;
    case "schedule":
      return `# Scheduled: ${args.cron} — ${args.task_description}`;
    case "fetch_url":
      return `# Fetched: ${args.url}`;
    case "done":
      return `# Done: ${args.summary}`;
    default:
      return null;
  }
}
