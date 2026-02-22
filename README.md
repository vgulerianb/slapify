# slapify 🖐️

**AI-powered browser automation that slaps** — run autonomous agents, audit performance, and write E2E tests in plain English.


https://github.com/user-attachments/assets/52564f16-7664-4ac3-9e06-e04c17dc4bbf


---

## What can it do?

| Mode       | What it does                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`task`** | Autonomous AI agent — give it any goal, it figures out how to achieve it. Browses, logs in, schedules itself, audits performance, remembers state across runs. |
| **`run`**  | Execute `.flow` test files — plain-English E2E tests with screenshots and HTML reports                                                                         |

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
npx slapify task "..." --save-flow         # save steps as a reusable .flow file
npx slapify task "..." --max-iterations N  # cap agent loop iterations (default 400)
npx slapify task "..." --schema <json> --output <file>  # structured JSON output (see below)
```

**Structured output (JSON schema)** — Have the agent write data that matches a schema to a file. Use `--schema` (inline JSON or path to a `.json` file) and `--output` (file path). The agent uses a `write_output` tool to append or update the file whenever it has new data — ideal for recurring tasks that keep updating a report.

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
| **Bypass bot protection** | Falls back to HTTP-level requests when the browser is blocked                  |
| **Login automatically**   | Detects login forms, uses saved credential profiles, asks you to save new ones |
| **Persistent memory**     | Stores key facts between runs (thread URLs, last-seen items, etc.)             |
| **Schedule itself**       | Creates its own cron jobs for recurring subtasks                               |
| **Ask for input**         | Pauses and prompts you when it needs information (e.g. OTP, confirmation)      |
| **Performance audit**     | Scores, web vitals, network analysis, framework detection, re-render testing   |
| **Structured output**     | Writes JSON conforming to a schema to a file (append/update per run)           |
| **HTML report**           | Full session report with tool timeline, summaries, and perf data               |

### Programmatic (JS/TS)

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
| **Lab scores**        | Performance, Accessibility, SEO, Best Practices (0–100)          |
| **Framework**         | React / Next.js detection, re-render issues, interaction tests   |
| **Network**           | Total size, JS bundle size, CSS, images                          |
| **API calls**         | Method, URL, status, duration — slow (>500ms) and failed flagged |
| **Long tasks**        | JavaScript blocking the main thread (>50ms)                      |
| **Memory**            | JS heap usage                                                    |

### Multi-page comparison

Audit multiple pages in one command. The HTML report shows a **tab bar** — one tab per URL, click to switch. Each tab has the full breakdown for that page.

```bash
# Three-tab report: /, /pricing, /about
slapify task "Audit the home, pricing, and about pages on vercel.com" --report
```

### Programmatic

```typescript
import { runPerfAudit } from "slapify/perf";
import { BrowserAgent } from "slapify";

const browser = new BrowserAgent();
await browser.launch();

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
Log in                              # picks the right credential profile automatically
Fill shipping address
Click "Place Order"
Verify "Order confirmed" appears
```

**Syntax reference:**

| Syntax           | Example                                          |
| ---------------- | ------------------------------------------------ |
| Comment          | `# This is a comment`                            |
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

# Include performance audit in the report
slapify run tests/ --report --performance

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

This is equivalent to `slapify task "..." --save-flow --dir tests/` — the saved `.flow` file is proven to work, not just AI-guessed from a page snapshot.

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
    totp_secret: JBSWY3DPEHPK3PXP # TOTP 2FA

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
- If no profile matches, it asks you to enter credentials and offers to save them
- Saved sessions are reused on future runs — no re-login needed

---

## Configuration

### `.slapify/config.yaml`

```yaml
llm:
  provider: anthropic
  model: claude-haiku-4-5-20251001 # fast & cheap — recommended
  api_key: ${ANTHROPIC_API_KEY}

browser:
  headless: true
  timeout: 30000
  viewport:
    width: 1280
    height: 720

report:
  format: html
  screenshots: true
  output_dir: ./test-reports
```

---

## LLM Providers

Supports 6 providers via Vercel AI SDK.

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

- Node.js 18+
- `agent-browser` (installed as a peer dependency)

---

## License

MIT — Made with 🖐️ by [slaps.dev](https://slaps.dev)
