# slapify 🖐️

**A fully autonomous browser agent.** Give it a goal in plain English and it does what a person at a keyboard would: reads pages, clicks, types, logs in, fills forms, uploads and downloads files, works across tabs, schedules itself, and keeps going for hours or days, telling you on Telegram what it's doing.

It is also a harness you can leave alone with that autonomy. Every action has a contract; irreversible ones (posting, sending, buying) can be reviewed against your own policy before they happen; repeated failures get guidance instead of dead ends; and a run never dies from a transient failure.

```bash
npx slapify task "Find three well-reviewed ramen places near Union Square open after 10pm and put them in ramen.json"
```

```ts
import { createAgent } from "slapify";

const agent = createAgent({ stealth: true });
const run = await agent.run("Check the status of my last three orders on example-shop.com");
console.log(run.finalSummary);
```


https://github.com/user-attachments/assets/52564f16-7664-4ac3-9e06-e04c17dc4bbf


---

## What can it do?

| Mode       | What it does                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`task`**   | Autonomous AI agent — give it any goal, it figures out how to achieve it. Browses, logs in, schedules itself, audits performance, remembers state across runs. |
| **SDK**      | `createAgent()` — the same agent from JS/TS, with inline config, event streaming and resumable sessions. |
| **`server`** | Persistent server mode — stays online and waits for instructions via Telegram. Start tasks remotely from your phone.                              |
| **`run`**    | Execute `.flow` test files — plain-English E2E tests with screenshots and HTML reports                                                         |

---

## Installation

```bash
npm install -g slapify

# or run without installing
npx slapify init
```

---

## Quick Start

```bash
# 1. Set up your project (interactive — picks LLM, browser, creates sample files)
npx slapify init

# 2. Set your API key
export ANTHROPIC_API_KEY=your-key
#    ...or skip this entirely: pick "Claude Code CLI" in init to run on your
#    Claude Pro/Max subscription via `claude -p`. See "Using your Claude subscription".
#    ...or pick "ChatGPT plan (Codex)" to run on your ChatGPT plan, signed in
#    with `npx slapify login codex`. See "Using your ChatGPT plan".

# 3a. Run an autonomous task
npx slapify task "Summarise the top posts on reddit.com/r/programming today" --report

# 3b. Run a test flow
npx slapify run tests/example.flow --report
```

---

## Autonomous Agent (`slapify task`)

Give it a goal in plain English. The agent decides what to do, browses pages, handles login, retries on errors, and keeps running until the goal is complete — even if that takes hours or days.

### CLI

```bash
# One-off research
npx slapify task "What is the current gold price?"
npx slapify task "Go to reddit.com/r/programming and summarise the top 5 posts"
npx slapify task "Check https://myapp.com and tell me if anything looks broken"

# Performance audits
npx slapify task "Audit the performance of slaps.dev" --report
npx slapify task "Audit the home, pricing, and about pages on vercel.com" --report

# Long-running / scheduled
npx slapify task "Check my LinkedIn messages every 30 minutes and summarise new ones"
npx slapify task "Monitor https://example.com/status every 5 minutes and alert if down"
npx slapify task "Check BTC price every hour for 24 hours and give me an end-of-day summary"

# Auth-required tasks (agent handles login automatically)
npx slapify task "Log into myapp.com and export my account data"
npx slapify task "Reply to any unread Slack DMs with a friendly holding message"

# Flags
npx slapify task "..." --report           # generate HTML report on exit
npx slapify task "..." --headed            # show the browser window
npx slapify task "..." --debug             # verbose logs
npx slapify task "..." --save-flow         # save steps as a reusable .flow file (in the current directory)
npx slapify task "..." --max-iterations N  # cap agent loop iterations (default 400)
npx slapify task "..." --stealth           # hide automation fingerprints (overrides config)
npx slapify task "..." --no-stealth        # force stealth off even if config enables it
npx slapify task "..." --persistent        # run until you stop it: the agent can't end the task itself
npx slapify task "..." --time-limit 30     # stop after 30 minutes, enforced by the harness
npx slapify task "..." --record runs/demo  # save annotated frames, video.webm and replay.html
npx slapify task "..." --record runs/demo --live   # ...and watch it live at http://127.0.0.1:8790/
npx slapify task "..." --schema <json> --output <file>  # structured JSON output (see below)

# Sessions — every task run is a session with its own memory and event log
npx slapify task --list-sessions           # list past and running sessions
npx slapify task --logs <id>               # show the event log for a session
npx slapify task "..." --session <id>      # resume a session, keeping its memory
npx slapify task "..." --memory-from <id>  # NEW session with a new goal, inheriting another session's memory
```

Resuming with `--session` restores the session's memory **and** its conversation history. That's usually what you want, but it means an instruction given earlier in that session (say, via Telegram) comes back with it. Start a fresh session when you want a clean slate.

### Server Mode (`slapify server`)

Run Slapify as a persistent background process that you control remotely via Telegram.

```bash
# Start the server (waits for Telegram commands)
npx slapify server

# With visible browser and debug logs
npx slapify server --headed --debug
```

**Structured output (JSON schema)** — Have the agent write data that matches a schema to a file. Use `--schema` (inline JSON or path to a `.json` file) and `--output` (file path). The agent uses a `write_output` tool to append or update the file whenever it has new data — ideal for recurring tasks that keep updating a report. Each scheduled run adds to what earlier runs left in the file.

```bash
# One-shot: write structured data once
npx slapify task "Get top 5 HN posts and their URLs" \
  --schema '{"type":"object","properties":{"posts":{"type":"array"}}}' \
  --output hn.json

# Recurring: schema in a file, agent appends to output each run
npx slapify task "Every day at 9am, collect top tech headlines and add to report" \
  --schema schema.json \
  --output daily-news.json \
  --max-iterations 2000
```

### What the agent can do

| Capability                | Details                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Browse & interact**     | Navigate, click, type, scroll, fill forms, handle popups                       |
| **Mouse & forms**         | `hover`, `double_click`, `drag`, idempotent `set_checked`, native `select_option` |
| **Files**                 | `upload_file` (sandboxed to an uploads folder) and `download_file` (sanitized, never overwrites) |
| **Tabs**                  | `list_tabs`, `switch_tab`, `close_tab` for sign-in popups and anything that opens a new window |
| **Fast decisions**        | Optional [Jev](#jev-optional-decision-model): `find_element` and `check` answer "which element" and "is this true" in under a second |
| **Read pages**            | `get_page_text()` reads body copy (posts, articles, results) that the interactive snapshot omits |
| **Find URLs**             | `get_links()` lists hrefs, so it can go straight to an item instead of hunting for its button |
| **See the page**          | Optional `vision` — screenshots sent to the model as images (see [Vision](#vision)) |
| **Bypass bot protection** | Falls back to HTTP-level requests when the browser is blocked                  |
| **Login automatically**   | Detects login forms, uses saved credential profiles, asks you to save new ones |
| **Persistent memory**     | Stores key facts between runs (thread URLs, last-seen items, etc.)             |
| **Schedule itself**       | Creates its own cron jobs for recurring subtasks                               |
| **Ask for input**         | Pauses and prompts you via CLI or **Live Telegram Chat** when it needs info (e.g. OTP, conf)  |
| **Performance audit**     | Scores, web vitals, network analysis, framework detection, re-render testing   |
| **Structured output**     | Writes JSON conforming to a schema to a file (append/update per run)           |
| **HTML report**           | Full session report with tool timeline, summaries, and perf data               |
| **Custom Plugins**        | Load your own markdown rules or `.ts` tools directly into the agent's brain    |

### Programmatic (JS/TS)

`createAgent()` is the simplest way in. Config is read from `.slapify/config.yaml` when there is one; anything you pass inline is laid over it, and inline config with an `llm` is enough on its own.

```typescript
import { createAgent } from "slapify";

const agent = createAgent({
  config: {
    llm: { provider: "anthropic", model: "claude-sonnet-5", api_key: process.env.ANTHROPIC_API_KEY },
    browser: { headless: true, stealth: true },
  },
});

// Run to completion
const run = await agent.run("Go to news.ycombinator.com and return the top 10 headlines");
console.log(run.finalSummary);

// Or stream events as they happen
const stream = agent.stream("Find the cheapest 27-inch 4K monitor on example-store.com");
for await (const event of stream) {
  if (event.type === "status_update") console.log("→", event.message);
  if (event.type === "tool_start") console.log(`  [${event.toolName}]`);
}
console.log((await stream.result).finalSummary);

// Pick up where an earlier session left off, memory included
await agent.resume(run.id, "Now open the top story and summarise the comments");
```

`runTask()` is the lower-level function underneath and takes the same options:

```typescript
import { runTask } from "slapify";

// Simple one-shot task
const result = await runTask({
  goal: "Go to news.ycombinator.com and return the top 10 headlines",
});

console.log(result.finalSummary);
```

```typescript
import { runTask, TaskEvent } from "slapify";

// With real-time events
const result = await runTask({
  goal: "Audit the performance of https://myapp.com/pricing and /about",

  onEvent: (event: TaskEvent) => {
    if (event.type === "message") console.log("Agent:", event.text);
    if (event.type === "status_update") console.log("→", event.message);
    if (event.type === "tool_start") console.log(`  [${event.toolName}]`);
    if (event.type === "done") console.log("✅", event.summary);
  },

  // Called when the agent needs a human answer (e.g. 2FA code, confirmation)
  onHumanInput: async (question, hint) => {
    return await promptUser(question); // plug in your own UI
  },
});
```

```typescript
import { runTask } from "slapify";

// Resume a previous session (credentials, memory, and context are preserved)
const result = await runTask({
  goal: "Continue monitoring LinkedIn messages",
  sessionId: "task-2026-02-19T20-19-44-dtbfu",
});
```

```typescript
import { runTask } from "slapify";

// Long-running scheduled task — agent sets its own cron internally
await runTask({
  goal:
    "Every hour, check the BTC price and store it. " +
    "After 24 hours, summarise the day's movements.",
  maxIterations: 500,
  onEvent: (e) => {
    if (e.type === "scheduled") console.log(`Scheduled: ${e.cron}`);
    if (e.type === "sleeping") console.log(`Sleeping until: ${e.until}`);
    if (e.type === "done") console.log(e.summary);
  },
});
```

```typescript
import { runTask } from "slapify";

// Structured output — agent writes JSON matching the schema to a file
const result = await runTask({
  goal: "Get the current gold price and record it",
  schema: {
    type: "object",
    properties: { price: { type: "number" }, currency: { type: "string" } },
  },
  outputFile: "gold.json",
});
// gold.json is written; result.structuredOutput has the same data
console.log(result.structuredOutput);
```

---

## Performance Auditing

The agent has a built-in `perf_audit` tool. Just ask it to check performance — it navigates, injects observers, collects everything, and includes it all in the HTML report.

### What's measured

| Category              | Metrics                                                          |
| --------------------- | ---------------------------------------------------------------- |
| **Real-user metrics** | FCP, LCP, CLS, TTFB                                              |
| **Lab scores**        | Performance, Accessibility, SEO, Best Practices (0–100), via Lighthouse |
| **Framework**         | React / Next.js detection, re-render issues, interaction tests   |
| **Network**           | Total size, JS bundle size, CSS, images                          |
| **API calls**         | Method, URL, status, duration — slow (>500ms) and failed flagged |
| **Long tasks**        | JavaScript blocking the main thread (>50ms)                      |
| **Memory**            | JS heap usage                                                    |

Lab scores come from [Lighthouse](https://github.com/GoogleChrome/lighthouse), an optional peer dependency (it brings a large dependency tree, so it isn't installed by default). Add it with `npm install lighthouse`; without it, audits still report every other metric and say the Lighthouse scores were skipped.

### Multi-page comparison

Audit multiple pages in one command. The HTML report shows a **tab bar** — one tab per URL, click to switch. Each tab has the full breakdown for that page.

```bash
# Three-tab report: /, /pricing, /about
slapify task "Audit the home, pricing, and about pages on vercel.com" --report
```

### Programmatic

```typescript
import { BrowserAgent, runPerfAudit } from "slapify";

// There is no launch step: the browser starts on first use, and
// runPerfAudit navigates to the URL itself.
const browser = new BrowserAgent({ headless: true });

const result = await runPerfAudit("https://myapp.com/pricing", browser, {
  lighthouse: true, // lab scores — Performance/A11y/SEO/Best Practices (default: true)
  reactScan: true, // framework detection + re-render analysis (default: true)
  navigate: true, // navigate to the URL before auditing (default: true)
});

console.log(result.vitals); // { fcp, lcp, cls, ttfb }
console.log(result.scores); // { performance, accessibility, seo, bestPractices }
console.log(result.react); // { detected, version, issues, interactionTests }
console.log(result.network); // { totalRequests, totalBytes, apiCalls, longTasks, ... }

await browser.close();
```

---

## Test Flows (`slapify run`)

Write tests as `.flow` files in plain English. The AI interprets each line and executes browser actions, with screenshots and auto-retry on failure.

### Smart by default

You don't need to spell out every edge case. The runner handles these automatically on every step:

| What happens automatically               | How                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Cookie banners, popups, chat widgets** | Detected and dismissed before they block the next step                                                                                    |
| **CAPTCHAs**                             | Detected by page content signals (reCAPTCHA, hCaptcha, Cloudflare Turnstile) and solved automatically                                     |
| **Credential lookup**                    | Steps like `Log in` or `Sign in` (no profile named) auto-pick the best matching profile for the current domain, falling back to `default` |
| **Auto-retry**                           | Failed steps are retried once before being marked failed                                                                                  |

### Writing `.flow` files

```
# tests/checkout.flow

Go to https://myshop.com
[Optional] Close cookie banner
Click "Add to Cart" on the first product
Go to checkout
# Picks the right credential profile automatically
Log in
Fill shipping address
Click "Place Order"
Verify "Order confirmed" appears
```

**Syntax reference:**

| Syntax           | Example                                          |
| ---------------- | ------------------------------------------------ |
| Comment          | `# This is a comment` (on its own line)          |
| Required step    | `Click the login button`                         |
| Optional step    | `[Optional] Close popup`                         |
| Conditional      | `If "Accept cookies" appears, click Accept`      |
| Named credential | `Login with admin credentials`                   |
| Auto credential  | `Log in` — picks best profile for current domain |
| Assertion        | `Verify "Welcome" message appears`               |

### CLI

```bash
# Run a single flow
slapify run tests/login.flow

# Run all flows in a directory
slapify run tests/

# With visible browser
slapify run tests/ --headed

# Generate HTML report with screenshots
slapify run tests/ --report

# Include performance audit in the report (not with --parallel)
slapify run tests/ --report --performance

# Use a different credentials file than .slapify/credentials.yaml
slapify run tests/ --credentials staging-credentials.yaml

# Run in parallel (4 workers by default)
slapify run tests/ --parallel

# Run in parallel with 8 workers
slapify run tests/ --parallel --workers 8

# Auto-fix a failing flow
slapify fix tests/broken.flow

# Other utilities
slapify list             # list all flow files
slapify validate         # validate flow syntax
slapify create my-test   # create a blank flow
```

### Generating flows

Instead of writing flows by hand, use `generate` to have the agent discover the real path by actually running it in the browser — handles login, captcha, and dynamic content automatically, and only records steps that worked.

```bash
# Agent runs the goal, saves verified steps to tests/
slapify generate "test the login flow on github.com"

# Save to a specific directory
slapify generate "test checkout on myshop.com" --dir tests/checkout

# With visible browser
slapify generate "sign up flow on myapp.com" --headed
```

It runs the goal as a task with `--save-flow` — the saved `.flow` file is proven to work, not just AI-guessed from a page snapshot. `slapify task "..." --save-flow` does the same but always writes the `.flow` file to the current directory; `generate` saves it to `--dir` (default `tests/`).

### Programmatic (JS/TS)

```typescript
import { Slapify } from "slapify";

const slapify = new Slapify({ configDir: ".slapify" });

// Run inline steps
const result = await slapify.run(
  [
    "Go to https://example.com",
    'Click "More information"',
    'Verify URL contains "iana.org"',
  ],
  "example-test"
);

console.log(result.status); // 'passed' | 'failed'
console.log(result.passedSteps); // number
console.log(result.duration); // ms
```

```typescript
// Run from file
const result = await slapify.runFile("./tests/checkout.flow");

// Run multiple — sequential
const results = await slapify.runMultiple([
  "tests/login.flow",
  "tests/checkout.flow",
]);

// Run multiple — parallel
const results = await slapify.runMultiple(["tests/"], {
  parallel: true,
  workers: 4,
});
```

```typescript
// Step-level callbacks
const result = await slapify.run(steps, "my-test", {
  onTestStart: (name, totalSteps) =>
    console.log(`Starting ${name} (${totalSteps} steps)`),
  onStep: (stepResult) => {
    const icon = stepResult.status === "passed" ? "✓" : "✗";
    console.log(`  ${icon} ${stepResult.step.text}`);
  },
  onTestComplete: (result) => console.log(`Done: ${result.status}`),
});
```

```typescript
// Save reports
const reportPath = slapify.saveReport(result); // single test
const suiteReport = slapify.saveSuiteReport(results); // full suite
const html = slapify.generateReport(result); // HTML as string
```

### Jest / Vitest integration

```typescript
import { Slapify } from "slapify";

const slapify = new Slapify({ configDir: ".slapify" });

test("user can log in", async () => {
  const result = await slapify.run(
    [
      "Go to https://myapp.com/login",
      "Fill email with test@example.com",
      "Fill password with secret123",
      "Click Login",
      'Verify "Dashboard" appears',
    ],
    "login-test"
  );
  expect(result.status).toBe("passed");
}, 60_000);

test("checkout flow", async () => {
  const result = await slapify.runFile("tests/checkout.flow");
  expect(result.failedSteps).toBe(0);
}, 120_000);
```

---

## Credential Management

Slapify handles credentials for any site — login forms, OAuth, or injecting an existing session.

### `.slapify/credentials.yaml`

```yaml
profiles:
  default:
    type: login-form
    username: ${TEST_USERNAME}
    password: ${TEST_PASSWORD}

  admin:
    type: login-form
    username: admin@example.com
    password: ${ADMIN_PASSWORD}
    totp_secret: JBSWY3DPEHPK3PXP # TOTP 2FA (base32, as your authenticator app shows it)
    # fixed_otp: "000000"         # or a static code, for test environments

  # Skip login entirely — inject an existing session
  my-session:
    type: inject
    cookies:
      - name: auth_token
        value: ${AUTH_TOKEN}
        domain: .example.com
    localStorage:
      user_id: "12345"
      theme: dark
```

In **task mode**, credentials are fully automatic:

- The agent detects login forms and picks the right profile
- If the site asks for a 2FA code and the profile has `totp_secret` (or `fixed_otp`), the agent gets the current code itself instead of asking you
- If no profile matches, it asks you to enter credentials and offers to save them
- Saved sessions are reused on future runs — no re-login needed

In **flows**, a login step (`Login with admin credentials`, `Log in`) fills the form and, when the profile has `totp_secret` or `fixed_otp` and the site asks for a code, enters it.

In both, cookies in `inject` profiles are set with their `domain` and `path` when given, otherwise for the current page.

### Persistent Browser Profiles (Anti-Bot)

Instead of relying solely on `credentials.yaml`, you can configure the browser to use a persistent Chromium profile on disk. This saves everything natively: cookies, `localStorage`, `sessionStorage`, and cached 2FA tokens. It also helps evade bot detection since the browser builds up a real history.

See the `browser.profile` setting in the Configuration section below.

### Stealth Mode

Set `browser.stealth: true` to hide the automation fingerprints that bot-detection services commonly check for. It does three things:

1. Adds `--disable-blink-features=AutomationControlled` to the Chromium launch args.
2. Strips `HeadlessChrome` from the User-Agent, if the browser advertises it and you haven't set `browser.userAgent` yourself. This happens at launch (one extra relaunch on first navigation) so the HTTP header and `navigator.userAgent` always agree — patching only the JS value would be its own tell.
3. Injects a fingerprint script into every frame before any page script runs.

The injected script follows one rule: **patch nothing that isn't already a tell.**

Serious fingerprinters don't check values, they check for *patching*. CreepJS compares built-ins against pristine copies pulled from a fresh iframe realm, inspects stack traces to catch a cloaked `Function.prototype.toString`, and walks property descriptors looking for getters that aren't native. So every patch is a detection candidate in its own right, and one that replaces an already-realistic value is a pure loss. Injected script can't reach a Web Worker either, so spoofing a value workers also expose just creates a main-thread-vs-worker mismatch — a *stronger* signal than what it replaced.

Each patch is therefore gated on the underlying value actually looking automated:

| Fingerprint | Patched only when |
| --- | --- |
| `navigator.webdriver` | it still reports `true` — normally it doesn't, because the launch flag above makes Chromium report `false` natively. Patched to `false`, not `undefined`: the property is specified to exist |
| `window.chrome` | missing entirely |
| `navigator.plugins` / `mimeTypes` | the list is empty — rebuilt on the real `PluginArray`/`Plugin` prototypes, which detectors check |
| `navigator.languages` | the list is empty |
| WebGL vendor/renderer | the real renderer is a software rasteriser (SwiftShader, llvmpipe, Mesa offscreen). Probed up front, so no wrapper is installed on a machine with a real GPU |

`navigator.permissions.query` is deliberately **not** patched, though stealth libraries commonly do: the `denied`/`default` mismatch it fixes doesn't exist in current Chrome, and it can only be detected asynchronously — so the patch would have to wrap a native method on every page just in case.

If any patch does apply, `Function.prototype.toString` is cloaked so the patched getters report `[native code]`. That cloak is installed *only* if something was patched, since the cloak is itself detectable via stack traces. On a current Chrome the whole script ends up a no-op.

Combine it with `browser.profile` for the best results — a persistent profile with real history plus a clean fingerprint.

**What it does and doesn't get you.** Measured on macOS, headless Chrome 152, stealth off → on:

| Test | Off | On |
| --- | --- | --- |
| [bot.sannysoft.com](https://bot.sannysoft.com) | 4 failures (`User Agent`, `WebDriver`, `HEADCHR_UA`, `CHR_MEMORY`) | **0 failures** |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) headless score | 100% | **33%** |
| CreepJS *stealth* score | 0% | **0%** — same fingerprint hash as an unpatched browser |
| [nowsecure.nl](https://nowsecure.nl) (live Cloudflare) | passes | passes |

The 0% stealth score is the point: there's nothing for a fingerprinter to catch, because on a modern browser stealth mode changes launch flags rather than patching JavaScript.

It is still not invisible — CreepJS puts it at 33% headless. What remains is out of reach of anything a page script can do: `Sec-CH-UA` client-hint headers still identify the browser as headless, and Worker scopes, timing and GPU behaviour still differ. Closing those means moving below the JS layer entirely — patching and rebuilding the browser engine, as [invisible_playwright](https://github.com/feder-cr/invisible_playwright) does — or renting real hardware browsers via `browser.browserbase`. And only automate sites you're authorized to test.

---

## Configuration

### `.slapify/config.yaml`

```yaml
# You can define an array of models! If the primary API drops/rate-limits, 
# Slapify instantly falls back to the next model in the list.
llm:
  - provider: anthropic
    model: claude-3-7-sonnet-20250219 
    api_key: ${ANTHROPIC_API_KEY}
  - provider: openai
    model: o3-mini
    api_key: ${OPENAI_API_KEY}
  # No API key? Run on a subscription instead:
  # - provider: codex          # ChatGPT plan, after `npx slapify login codex`
  #   model: gpt-5.4-mini
  # - provider: claude-cli     # Claude Pro/Max, through the local `claude` binary
  #   model: sonnet

browser:
  headless: true
  timeout: 30000
  viewport:
    width: 1280
    height: 720
  # Anti-Bot Stealth & Persistence
  stealth: true
  profile: ".slapify/browser-profile"
  # userAgent is derived from the real browser when stealth is on — pin one
  # only to override it, since a pinned string drifts out of date.
  args:
    - "--no-sandbox"

# Let the agent look at screenshots (off by default)
vision: true

# Optional fast decision model (see "Jev")
jev:
  enabled: true
  provider: typesafe          # or vercel, openrouter, openai (OpenAI Decisions)
  api_key: ${TYPESAFE_API_KEY}

# Review irreversible actions against a policy before they happen (see "The harness")
review:
  enabled: true
  policy: |
    Replies must be on-topic, friendly and free of made-up facts.
    Never buy anything or delete anything.

# Where uploads may come from and downloads go (defaults shown)
files:
  uploads_dir: .slapify/uploads
  downloads_dir: .slapify/downloads

# Rewrite text before the agent types it into a page (see "Text filters")
text_filters:
  " — ": ", "   # never type an em dash
  "—": ", "

report:
  format: html
  screenshots: true
  output_dir: ./test-reports

# Extend the agent with your own rules and Vercel AI SDK tools
plugins:
  rules:
    - "rules/my-persona.md"
  tools:
    - "tools/query_database.ts"

# Get live status updates and send instructions to the agent mid-run via Telegram
telegram:
  bot_token: ${TELEGRAM_BOT_TOKEN}
  allowed_chat_id: 123456789
```

---

## Vision

`vision: true` lets the agent actually look at the page instead of only reading its accessibility tree. Reach for it when text isn't the answer — a CAPTCHA, a chart, an image-only post, a layout that looks wrong. For reading text, `get_page_text()` stays the better tool: cheaper, and exact characters rather than pixels.

```
screenshot(look_for: "what characters are in the CAPTCHA?")
```

`look_for` is worth using — a specific question gets a far more useful answer than a generic description.

How the image reaches the model depends on the provider:

| Provider | Mechanism |
| --- | --- |
| `anthropic`, `google`, `codex` | the image is attached inline as a real image part |
| `openai`, `mistral`, `groq`, `ollama` | not supported: their chat APIs can't carry an image in a tool result, so the model gets the screenshot's text result only |
| `claude-cli` | a separate one-shot `claude -p` call reads the image off disk and returns a description |

The `claude-cli` path exists because `claude -p` accepts no inline image data. It *can* read an image with its own `Read` tool — but enabling `Read` on the agent's normal turns makes the model stop trusting the prompt-simulated tool protocol this provider runs on, and it starts answering in prose, which breaks every turn. Isolating vision in its own call keeps the protocol intact. The upside: vision works on Claude Code subscription auth, with no API key.

Only the most recent screenshot is kept in context — base64 images dominate token cost, and a stale screenshot is worth little. Older ones become a placeholder telling the agent to take a fresh one.

## Text filters

A rule in your prompt — "never use an em dash", "never mention pricing" — is followed most of the time, not every time. When something has to hold on *every* reply, put it in `text_filters` instead. Each entry is a literal find-and-replace applied inside the `type` tool, after the model writes the text and before it reaches the page:

```yaml
text_filters:
  " — ": ", "    # em dash with spaces, the common case
  "—": ", "      # bare em dash
  " – ": " - "   # en dash with spaces
  "–": "-"       # bare en dash
```

Entries run in order, so list the spaced variants first — that gives `point, the` rather than `point ,  the`.

When a filter fires, the tool result tells the model its text was corrected, so it tends to stop making the mistake. But compliance no longer depends on that: the filter is the guarantee, the prompt rule just makes it fire less often.

---

## Extensibility & Live Chat

### Custom User Tools
You can give Slapify access to your local system or database by exporting Vercel AI SDK `tool()` definitions from a `.ts` or `.js` file, and adding the path to `plugins.tools` in your config.

```typescript
// .slapify/tools/database.ts
import { tool } from "ai";
import { z } from "zod";

export const queryProdDB = tool({
  description: "Execute a secure read-only SQL query.",
  inputSchema: z.object({ sql: z.string() }),
  execute: async ({ sql }) => {
    // Custom logic here...
    return { rows: [{ id: 1 }] };
  }
});
```

Tools written for older AI SDK versions, with `parameters` in place of `inputSchema`, keep working. Slapify calls `execute` itself, once per call, the same way it runs its own tools.

When the Slapify agent hits an obstacle, it will seamlessly fall back to using your custom `queryProdDB` right alongside its native browser tools!

### Telegram Integration
Add a `telegram` block to your config. The agent will:
1. Message you when long-running background tasks start and finish.
2. Ping you via Telegram when it gets stuck or needs a 2FA code (instead of waiting at the CLI). You can reply directly in the chat!
3. **Listen for instructions:** You can text the bot mid-run ("Hey, don't click that button") and it will process your instruction live.
4. **Remote Activation:** Use the `/task` command (e.g. `/task Buy more coffee`) to start a new mission from your phone anytime while the server is running.

---

## Using your Claude subscription (`claude -p`)

Already pay for Claude Pro or Max? Slapify can run every agent turn through your local [Claude Code](https://claude.com/claude-code) install instead of the Anthropic API. No API key, no per-token bill — usage counts against your plan.

### Setup

```bash
# 1. Install Claude Code and log in once
npm install -g @anthropic-ai/claude-code
claude            # opens a login flow the first time

# 2. Confirm print mode works
claude -p "hi"

# 3. Pick "Claude Code CLI" in init — it runs a test call to verify the login
npx slapify init
```

Or set it by hand in `.slapify/config.yaml`:

```yaml
llm:
  provider: claude-cli
  model: sonnet                 # CLI aliases (sonnet, opus, haiku) or a full model id
  # cli_path: /usr/local/bin/claude   # only if `claude` isn't on your PATH
  # timeout_seconds: 600              # max seconds per LLM call (default 600)
```

Then run tasks exactly as you would with any other provider:

```bash
npx slapify task "Summarise the top 5 posts on news.ycombinator.com"
```

### How it works

Each agent turn is one `claude -p` call. `claude -p` only returns text, so Slapify does tool calling through the prompt: the tool schemas go into the system prompt, Claude answers with a `{"tool_calls": [...]}` JSON object, and Slapify parses that and runs the tools.

A few deliberate choices keep that reliable:

- **Claude Code's own tools are switched off** (`--tools ""`) on agent turns. It's used purely as a model. With its real tools enabled, the model stops trusting the prompt-based protocol and answers in prose, which breaks the turn.
- **`ANTHROPIC_API_KEY` is stripped** from the environment for every call, so it always runs on your subscription login — never silently on an API key that happens to be set.
- **Cut-off responses are repaired.** If a long response is truncated mid-JSON, Slapify closes the open strings and brackets and recovers the tool calls rather than treating the fragment as a final answer.

### What to know

- **It uses your plan's allowance.** A long-running task makes a `claude -p` call every turn, which adds up. When you hit your usage limit, every call fails instantly — the error shows `"duration_api_ms": 0`, meaning the request never reached the API. Retrying won't help until the limit resets.
- **Slower per turn than the API**, since each call starts a process. Timeouts and dropped connections are retried 3 times with backoff; raise `timeout_seconds` if your tasks legitimately need longer turns.
- **`temperature` and `maxOutputTokens` are not supported** — they're ignored with a warning.
- **Vision works**, through a separate one-shot call. See [Vision](#vision).

### Driving Slapify *from* Claude Code

The reverse direction also works: Slapify is a CLI, so Claude Code can call it as a tool — Claude Code plans, Slapify does the browsing. Allow the command and let it run:

```bash
claude -p "Use slapify to fetch the top 5 posts on news.ycombinator.com as JSON, then summarise the themes." \
  --allowedTools "Bash(npx slapify:*)"
```

For results Claude Code can reliably read back, have Slapify write structured output with `--schema` and `--output`:

```bash
claude -p "Run: npx slapify task 'Get the top 5 HN posts with titles and URLs' \
  --schema '{\"type\":\"object\",\"properties\":{\"posts\":{\"type\":\"array\"}}}' \
  --output hn.json — then read hn.json and tell me which post is most relevant to TypeScript." \
  --allowedTools "Bash(npx slapify:*)" "Read"
```

If Slapify is *also* configured with the `claude-cli` provider, every Slapify turn spawns its own `claude -p` call. That works, but it's usage-heavy — for high-volume scripting, an API-key provider inside Slapify is the lighter setup.

---

## Using your ChatGPT plan (`codex`)

Pay for ChatGPT Plus, Pro or Business? The `codex` provider runs every agent turn on that plan, the way [fx](https://github.com/vercel-labs/fx) does: Slapify signs in with ChatGPT itself and talks to the Codex endpoint directly. No API key, no `codex` binary, no subprocess per turn.

```bash
npx slapify login codex          # opens your browser; lists the models your plan can use
npx slapify login codex --status # who is signed in
npx slapify logout codex
```

```yaml
llm:
  provider: codex
  model: gpt-5.4-mini            # any model `slapify login codex` lists
  # reasoning_effort: medium     # minimal | low | medium | high
```

Unlike `claude-cli`, nothing is bridged through the prompt: tools are native function calls, screenshots go in as real images (so `vision: true` just works), and token usage comes back from the API.

### What to know

- **Tokens** live in `~/.slapify/chatgpt-auth.json` (mode 600), are refreshed shortly before they expire, and a refresh that would switch accounts is refused. Slapify never reads or writes `~/.codex`.
- **Plan limits apply.** A usage or rate limit is treated like any provider outage: the run waits and retries rather than exiting.
- **The endpoint is undocumented** (`chatgpt.com/backend-api/codex/responses`) and can change without notice. Sign-in uses the Codex CLI's public OAuth client, as fx does; OpenAI's terms apply to how your plan is used. For automation OpenAI recommends an API key (`provider: openai`).

---

## The harness

Autonomy is the easy part; an agent that can do anything will eventually be about to do the wrong thing, or get stuck, or hit an outage at 3am. These are the pieces that make it safe to leave running. Several are adapted from ideas in [vercel-labs/fx](https://github.com/vercel-labs/fx), a coding agent, applied here to a browser.

### Tool contracts

Every call is classified before it runs as `read`, `navigate`, `mutate`, `irreversible` or `control`. Some tools are fixed (`get_page_text` is a read, `upload_file` is irreversible). Clicks and key presses are judged by what they touch: a click on a control labelled *Post*, *Send*, *Buy*, *Delete*, *Confirm* and so on is irreversible, a click on a tab is not, and `Meta+Enter` (the submit chord on most composers) is irreversible while `Enter` is not.

### Tool admission

Repetition isn't blocked. Blocking a read helps nobody, and on a feed of ten identical-looking posts, pressing the same "send" chord ten times is correct. Instead:

- Calls are keyed by tool, arguments **and the page they run on**.
- After two identical failures, the result gains a `guidance` field telling the model to change approach.
- After three identical results from the same read, it is told nothing is changing.
- The one hold: an irreversible action that already **succeeded** on this page isn't run again. That's the difference between a stuck agent and one that pays twice.

### Action review

With `review.enabled`, every irreversible action is checked against your `policy` just before it runs, together with the page it's on and the exact text it's about to publish. The answer is *clear* or *caution*; a caution holds the action and tells the agent why, so it can revise or skip.

Review uses Jev when it's configured (well under a second per check, which is what makes reviewing every post affordable) and your main LLM otherwise. If no reviewer can answer, the action is **held** by default: failing open would make the safety check disappear exactly when something is already going wrong. Set `on_unavailable: allow` to change that.

### Recovery

LLM errors are classified. Bad tool arguments are handed back for correction. Timeouts and dropped connections are retried. Rate limits, quota and usage limits rotate to the next model in your `llm` list and, once every model has failed, wait patiently instead of exiting. A text reply that is really a broken tool call is not mistaken for a final answer. Only five failed turns *in a row* end a run.

### Compaction

When history nears the context limit, older turns are summarised. Two rules keep this from quietly changing the task: the original goal is always kept **verbatim**, along with any memory it started with (`--memory-from`, scheduled runs), since a paraphrase of "never use an em dash" turned out to be much weaker than the original; and the cut never separates a tool call from its result.

---

## Jev (optional decision model)

[Jev](https://www.browserbase.com/blog/what-is-jev) is TypeSafe's decision model. It doesn't write or plan; it answers narrow questions ("which of these elements is the reply box?", "does this page show my reply?") with calibrated probabilities, fast and cheaply. Slapify uses it as an accelerator next to your main LLM, never instead of it:

| Where | What Jev does | When it isn't sure |
| --- | --- | --- |
| `find_element(description)` | Picks the matching ref from the page | Returns `confident: false`; the agent reads the snapshot itself |
| `check(statement)` | Probability a statement about the page is true | Anything between 0.15 and 0.85 means the agent looks itself |
| Action review | Clear / caution on irreversible actions | Falls back to the LLM reviewer |
| Flow runner | Skips the popup-check LLM call when there's clearly no popup; passes clearly-true `Verify …` steps | The normal LLM path runs |

It works through TypeSafe directly, Vercel AI Gateway or OpenRouter, which all take the same request, or through OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions):

```yaml
jev:
  enabled: true
  provider: typesafe            # api.typesafe.ai — key from console.typesafe.ai
  api_key: ${TYPESAFE_API_KEY}

# or through Vercel AI Gateway
jev:
  enabled: true
  provider: vercel
  api_key: ${AI_GATEWAY_API_KEY}

# or through OpenRouter
jev:
  enabled: true
  provider: openrouter
  api_key: ${OPENROUTER_API_KEY}

# or OpenAI Decisions (gpt-6-luna) instead of Jev
jev:
  enabled: true
  provider: openai
  api_key: ${OPENAI_API_KEY}
```

OpenAI Decisions answers the same three kinds of question (yes/no as `predicate`, `choice`, `score`) with calibrated probabilities, so Slapify translates its questions on the way out and the answers back on the way in. Every row in the table above works with either backend, unchanged. It needs an OpenAI API key; a ChatGPT plan sign-in doesn't cover it.

`base_url`, `path` and `model` override the provider defaults (for a proxy, say; add `protocol: decisions` when the proxy fronts OpenAI); `min_confidence` (default 0.7) and `timeout_ms` (default 10000) tune it; and `use.tools`, `use.interruption_gate` and `use.verify_fast_path` switch individual integrations off. A misconfigured Jev (no `api_key`, or neither a `provider` nor a `base_url`) is switched off at startup with a warning, and the run carries on without it. A configured Jev that can't be reached stays on: each call that fails falls back to the LLM, the same as when Jev isn't sure. The exception is `slapify fast`, which needs Jev to drive and ends with an error if it can't get an answer.

---

## Ultrafast mode (`slapify fast`)

For goals that are mostly clicking and filling in (search, filter, add to cart, fill a form), Jev can drive the browser on its own. Each step is **one Jev request** that picks the operation and, speculatively, a target for every operation (click, type, select), each from only the elements compatible with it. The LLM is called only to write the text for a field. The idea comes from browser-use's [jev-ultrafast](https://github.com/browser-use/jev-ultrafast).

```bash
slapify fast "Find a waterproof jacket under $150 and add it to the cart in size M with gift wrap" \
  --url https://shop.example
```

```
   6.1s  CLICK link "Drizzle Rain Jacket"      (43% / 97%, jev 1230ms)
   8.0s  SELECT option "M"                     (62% / 92%, jev 1097ms)
   9.7s  CLICK checkbox "Gift wrap (+$5)"      (73% / 95%, jev 317ms)
  11.7s  CLICK button "Add to cart"            (98% / 100%, jev 313ms)
  12.3s  DONE                                  verification p=0.96
  ✅ done in 12.3s · 5 Jev decisions · 0 text calls
```

On that demo store the regular agent takes 79 seconds; ultrafast takes about 12. What keeps it honest:

- **Validated answers.** An operation or target outside the offered set never runs.
- **DONE has to be verified.** A separate Jev check judges the actions taken plus the page; a rejected claim goes back into the loop, three rejections stop the run.
- **Stops when stuck.** Three actions in a row that change nothing end the run as `blocked`, rather than looping.
- **The same guards as the agent.** Clicks are checked for staleness and covering elements first, irreversible clicks go through review when it's on, and text filters apply to typed values.
- **Budgets.** 60 actions and 120 decisions by default (`--max-actions`, or `fast.max_actions` in config).

It's the right tool for well-defined flows, not for open-ended research or writing: there is no planning model, so anything that needs judgement beyond "which element next" belongs in `slapify task`. From code: `createAgent().fast(goal, { url })`. A small, fast model for field values can be set with `fast.text_llm`.

---

## Running long tasks unattended

Tasks like "monitor this every 30 minutes" can run for days. Slapify recovers from most failures on its own:

| Failure | What Slapify does |
| --- | --- |
| LLM call times out or the connection drops | Retries 3 times with backoff, then rotates to the next model in your `llm` list |
| Model emits a tool call with missing arguments | Hands the validation error back and asks for a corrected call (up to 3 times) |
| Tool-call JSON cut off mid-response | Repairs it and recovers the calls |
| Page snapshot fails on a heavy page | Falls back to a compact snapshot, fails fast, tells the agent to move on |
| Agent repeats the same failing action | Runs it, then adds guidance to the result telling it to change approach. Nothing is blocked |
| Agent tries to post the same thing twice | The second identical irreversible action on the same page is held, not run |
| Every model in the chain is rate-limited or out of quota | Waits patiently (1, 2, 4, then every 5 minutes) instead of exiting, and messages you on Telegram once after 10 minutes |
| History grows past the context window | Compacts older turns into a summary, keeping the original goal word for word |
| Anything else goes wrong in a turn | Records it, tells the agent what broke, continues. Only **5 failures in a row** end the run |

What it can't catch is the process itself dying — an uncaught crash, running out of memory, the machine sleeping. For that, wrap it in a small supervisor that restarts it, backing off if it keeps failing immediately (a usage limit or expired login won't fix itself, and a tight restart loop just burns through retries):

```bash
#!/bin/bash
# run.sh — restart slapify if it exits; give up if it keeps dying at startup
BACKOFF=15; FAST_FAILS=0
while true; do
  STARTED=$(date +%s)
  npx slapify task "$(cat goal.txt)" --max-iterations 999999
  RAN_FOR=$(( $(date +%s) - STARTED ))

  if [ "$RAN_FOR" -lt 60 ]; then
    FAST_FAILS=$((FAST_FAILS + 1))
    if [ "$FAST_FAILS" -ge 8 ]; then
      echo "Keeps failing at startup — likely a usage limit or expired login. Stopping."
      exit 1
    fi
    sleep "$BACKOFF"; BACKOFF=$(( BACKOFF * 2 > 600 ? 600 : BACKOFF * 2 ))
  else
    FAST_FAILS=0; BACKOFF=15; sleep 15
  fi
done
```

Other tips for long runs:

- **Headless + a persistent profile + stealth** — `headless: true`, `profile: ".slapify/browser-profile"`, `stealth: true`. The login survives restarts and nothing needs a window.
- **Keep memory values short.** Long `remember()` values make responses long enough to get cut off. One line per item is plenty; say so in your goal.
- **Use `--persistent` for monitors and loops.** The agent can't end the task itself: `done()` is refused and a text-only reply counts as a pause. Each time it sleeps between cycles, the cycle's history is compacted, so a run can go for days without the context filling up.
- **Put lasting rules in the goal, not in live messages.** A Telegram instruction applies to the cycle it arrives in. It carries forward only if you say it should ("from now on…").

---

## LLM Providers

Supports 8 providers. Six go through the Vercel AI SDK's provider packages: `anthropic`, `openai`, `google`, `mistral`, `groq` and `ollama` (via its OpenAI-compatible API). The other two are Slapify's own: `claude-cli` runs on your Claude subscription through the local `claude` binary, and `codex` runs on your ChatGPT plan.

### Claude subscription (no API key)

```yaml
llm:
  provider: claude-cli
  model: sonnet
```

Runs through the local `claude` binary on your Claude Pro/Max plan. Full setup and caveats: [Using your Claude subscription](#using-your-claude-subscription-claude--p).

### ChatGPT plan (no API key)

```yaml
llm:
  provider: codex
  model: gpt-5.4-mini
```

Sign in once with `npx slapify login codex`. Full setup and caveats: [Using your ChatGPT plan](#using-your-chatgpt-plan-codex).

### Budget-friendly (recommended)

```yaml
# Anthropic — Claude Haiku 4.5 (fast, ~$1/5M tokens)
llm:
  provider: anthropic
  model: claude-haiku-4-5-20251001
  api_key: ${ANTHROPIC_API_KEY}

# OpenAI — GPT-4o Mini
llm:
  provider: openai
  model: gpt-4o-mini
  api_key: ${OPENAI_API_KEY}

# Google — Gemini 2.0 Flash (generous free tier)
llm:
  provider: google
  model: gemini-2.0-flash
  api_key: ${GOOGLE_API_KEY}

# Groq — free tier available
llm:
  provider: groq
  model: llama-3.3-70b-versatile
  api_key: ${GROQ_API_KEY}
```

### More capable

```yaml
# Anthropic — Claude Sonnet
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514

# OpenAI — GPT-4o
llm:
  provider: openai
  model: gpt-4o
```

### Local (no API key)

```yaml
# Ollama — runs on your machine, completely free
llm:
  provider: ollama
  model: llama3 # or mistral, codellama, phi3
  base_url: http://localhost:11434/v1
```

---

## Project Structure

```
your-project/
├── .slapify/
│   ├── config.yaml          # LLM + browser + report settings
│   ├── credentials.yaml     # Saved login profiles
│   └── tasks/               # Persisted agent sessions (auto-created)
│       └── task-2026-....jsonl
├── tests/
│   ├── auth/
│   │   ├── login.flow
│   │   └── signup.flow
│   └── checkout.flow
└── test-reports/            # HTML reports
    └── login-1234567890/
        ├── report.html
        └── screenshots/
```

---

## Requirements

- Node.js 22+ (the AI SDK requires it)
- `agent-browser` (installed with slapify)
- Optional: `lighthouse`, for Lighthouse lab scores in performance audits (`npm install lighthouse`)
- An LLM: an API key for any supported provider, **or** [Claude Code](https://claude.com/claude-code) installed and logged in to use your Claude subscription, **or** a ChatGPT plan signed in with `npx slapify login codex`

---

## Security

Slapify drives a real browser and can log in on your behalf, so it does things a scanner will flag: it launches other programs (agent-browser, and optionally the `claude` CLI, ffmpeg and Lighthouse), patches automation fingerprints in stealth mode, and handles credentials. [SECURITY.md](SECURITY.md) explains each of these, what stays on your machine, and how to report a vulnerability.

---

## License

MIT — Made with 🖐️ by [slaps.dev](https://slaps.dev)
