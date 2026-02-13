import { tool } from "ai";
import { z } from "zod";

/**
 * All tools available to the task agent.
 * The LLM decides which tools to call and when — including scheduling,
 * sleeping, credential injection, and signalling completion.
 */
export const taskTools = {
  // ── Browser ──────────────────────────────────────────────────────────────

  navigate: tool({
    description:
      "Navigate the browser to a URL. Always call get_page_state() afterwards to see the result.",
    parameters: z.object({
      url: z.string().describe("Full URL including https://"),
    }),
  }),

  get_page_state: tool({
    description:
      "Get the current browser state: URL, page title, and an accessibility snapshot of all interactive elements with their ref IDs. Use ref IDs with click/type tools.",
    parameters: z.object({}),
  }),

  click: tool({
    description:
      "Click an element identified by its ref ID from get_page_state(). Use for buttons, links, checkboxes, etc.",
    parameters: z.object({
      ref: z.string().describe("The ref ID of the element to click"),
      description: z
        .string()
        .optional()
        .describe("Human-readable description of what you're clicking"),
    }),
  }),

  type: tool({
    description:
      "Type text into an input field identified by its ref ID. Clears the field first unless append is true.",
    parameters: z.object({
      ref: z.string().describe("The ref ID of the input element"),
      text: z.string().describe("The text to type"),
      append: z
        .boolean()
        .optional()
        .describe("If true, append to existing text instead of replacing"),
    }),
  }),

  press: tool({
    description:
      "Press a keyboard key or key combination (e.g. Enter, Tab, Escape, Control+A, ArrowDown).",
    parameters: z.object({
      key: z.string().describe("Key or key combo to press"),
    }),
  }),

  scroll: tool({
    description: "Scroll the page in a direction.",
    parameters: z.object({
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().optional().describe("Pixels to scroll (default 300)"),
    }),
  }),

  wait: tool({
    description:
      "Wait for a specified number of seconds. Use when waiting for page loads, animations, or time-sensitive operations.",
    parameters: z.object({
      seconds: z.number().min(0.1).max(60).describe("Seconds to wait"),
    }),
  }),

  screenshot: tool({
    description:
      "Take a screenshot of the current browser state and return a description of what is visible.",
    parameters: z.object({
      description: z
        .string()
        .optional()
        .describe("Why you are taking this screenshot"),
    }),
  }),

  reload: tool({
    description: "Reload the current page.",
    parameters: z.object({}),
  }),

  go_back: tool({
    description: "Navigate back to the previous page.",
    parameters: z.object({}),
  }),

  // ── Credentials ──────────────────────────────────────────────────────────

  list_credential_profiles: tool({
    description:
      "List all available credential profiles and their types (e.g. login-form, inject, oauth). " +
      "Call this when you reach a login page or need to authenticate — the agent picks the right profile automatically.",
    parameters: z.object({}),
  }),

  inject_credentials: tool({
    description:
      "Inject a credential profile into the browser (sets cookies, localStorage, sessionStorage) and reload. " +
      "Use for 'inject' type profiles. After injection call get_page_state() to verify login status. " +
      "If the injected session is expired (redirected to login page), fall back to fill_login_form.",
    parameters: z.object({
      profile_name: z
        .string()
        .describe("The name of the credential profile to inject"),
    }),
  }),

  fill_login_form: tool({
    description:
      "Fill and submit a login form using credentials from a profile. " +
      "Use for 'login-form' type profiles. " +
      "After verifying login succeeded, call save_credentials(capture_from_browser: true) to save the session.",
    parameters: z.object({
      profile_name: z
        .string()
        .describe("The name of the credential profile to use"),
    }),
  }),

  // ── Memory ────────────────────────────────────────────────────────────────

  remember: tool({
    description:
      "Store a piece of information in persistent memory that survives across iterations and sessions. " +
      "Use for important findings, extracted data, or state you'll need later.",
    parameters: z.object({
      key: z.string().describe("Unique key for this memory"),
      value: z
        .string()
        .describe("Value to store (use JSON string for structured data)"),
    }),
  }),

  recall: tool({
    description: "Retrieve a previously stored memory value by key.",
    parameters: z.object({
      key: z.string().describe("The memory key to retrieve"),
    }),
  }),

  list_memories: tool({
    description: "List all keys currently stored in memory.",
    parameters: z.object({}),
  }),

  // ── Scheduling / Time ─────────────────────────────────────────────────────

  schedule: tool({
    description:
      "Schedule this task (or a sub-task) to run on a recurring cron schedule. " +
      "For example: monitor every 30 minutes, check daily at 9am, etc. " +
      "The process will stay alive and re-run the goal at each interval. " +
      "Examples: '*/30 * * * *' every 30 min, '0 9 * * *' every day at 9am.",
    parameters: z.object({
      cron: z
        .string()
        .describe(
          "Standard cron expression (5 fields: min hour dom month dow)"
        ),
      task_description: z
        .string()
        .describe(
          "What to do when this schedule fires (can be same as main goal)"
        ),
    }),
  }),

  sleep_until: tool({
    description:
      "Pause the agent until a specific time or after a duration, then continue. " +
      "Use when you need to wait before doing something (e.g. 'try again in 5 minutes', 'wait until 2pm'). " +
      "Provide an ISO datetime string or a natural phrase like '5 minutes', '1 hour', 'tomorrow 9am'.",
    parameters: z.object({
      until: z
        .string()
        .describe(
          "ISO datetime string OR duration phrase like '5 minutes', '2 hours', 'tomorrow 9am'"
        ),
      reason: z.string().optional().describe("Why the agent is sleeping"),
    }),
  }),

  // ── CAPTCHA ───────────────────────────────────────────────────────────────

  solve_captcha: tool({
    description:
      "Attempt to automatically solve a CAPTCHA on the current page. " +
      "Tries: reCAPTCHA v2 checkbox click, audio challenge fallback. " +
      "Call get_page_state() first to confirm a CAPTCHA is present. " +
      "Returns whether it succeeded and the updated page state.",
    parameters: z.object({
      type: z
        .enum(["recaptcha_v2", "image", "text", "auto"])
        .optional()
        .describe("CAPTCHA type hint — use 'auto' if unsure"),
    }),
  }),

  // ── HTTP / Data ───────────────────────────────────────────────────────────

  fetch_url: tool({
    description:
      "Make a direct HTTP GET request and return the response text or JSON. " +
      "Uses Chrome TLS fingerprint impersonation (wreq-js) to bypass Cloudflare and bot detection. " +
      "Much faster than browser navigation. Try this first for any data lookup — " +
      "public APIs for prices, weather, news, finance, etc. usually return JSON directly.",
    parameters: z.object({
      url: z.string().describe("URL to fetch"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Optional HTTP headers as key-value pairs"),
    }),
  }),

  // ── Control ───────────────────────────────────────────────────────────────

  status_update: tool({
    description:
      "Post a visible status message to the user. Use this for long-running tasks to keep " +
      "the user informed — e.g. when starting a scheduled check, when something interesting " +
      "is found, or when waiting before the next run. This always shows regardless of debug mode.",
    parameters: z.object({
      message: z.string().describe("The message to show the user"),
    }),
  }),

  ask_user: tool({
    description:
      "Ask the user a question and wait for their response. Use when you need information " +
      "that is not available elsewhere — e.g. an OTP, a 2FA code, a missing password, " +
      "a clarification about what to do next, or confirmation before a destructive action. " +
      "The task pauses until the user replies. Returns the user's answer as a string.",
    parameters: z.object({
      question: z.string().describe("The question to ask the user"),
      hint: z
        .string()
        .optional()
        .describe(
          "Optional hint shown below the question, e.g. 'Check your phone for the OTP'"
        ),
    }),
  }),

  save_credentials: tool({
    description:
      "Save credentials or session cookies to the .slapify/credentials.yaml file so they can " +
      "be reused in future sessions. Call this after successfully authenticating, or after the " +
      "user confirms they want to save. " +
      "Use type='inject' for cookies/localStorage/sessionStorage. " +
      "Use type='login-form' for username+password.",
    parameters: z.object({
      profile_name: z
        .string()
        .describe("Name for this credential profile, e.g. 'linkedin', 'gmail'"),
      type: z.enum(["inject", "login-form"]),
      username: z
        .string()
        .optional()
        .describe("Username or email (for login-form type)"),
      password: z
        .string()
        .optional()
        .describe("Password (for login-form type)"),
      capture_from_browser: z
        .boolean()
        .optional()
        .describe(
          "If true, capture current browser cookies + localStorage + sessionStorage automatically"
        ),
    }),
  }),

  perf_audit: tool({
    description:
      "Run a full performance audit on a URL. Returns: " +
      "real-user metrics (FCP, LCP, CLS, TTFB), " +
      "scores (Performance, Accessibility, SEO, Best Practices 0-100), " +
      "framework detection, and re-render analysis — including simulated user interactions " +
      "that click buttons/tabs to measure how much DOM activity each interaction triggers. " +
      "Use when the user asks about performance, speed, scores, or page health. " +
      "The deep audit runs in an isolated browser so the current session is not affected.",
    parameters: z.object({
      url: z.string().describe("URL to audit"),
      lighthouse: z
        .boolean()
        .optional()
        .default(true)
        .describe("Run deep performance scoring (default: true)"),
      react_scan: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Run framework & re-render analysis including interaction tests (default: true)"
        ),
    }),
  }),

  write_output: tool({
    description:
      "Write structured data that matches the user-provided JSON schema to the output file. " +
      "Call this whenever you have new data to record — after each scheduled run, after collecting results, or at the end of a task. " +
      "For array schemas (e.g. list of news items), each call APPENDS new entries. " +
      "For object schemas, each call MERGES/UPDATES the existing object. " +
      "This tool is a no-op if no schema or output file was provided by the user.",
    parameters: z.object({
      data: z
        .record(z.unknown())
        .describe(
          "The structured data to write, conforming to the user-provided JSON schema"
        ),
      mode: z
        .enum(["append", "overwrite"])
        .optional()
        .default("append")
        .describe(
          "append: add to existing file (good for recurring tasks); overwrite: replace file contents (good for single snapshots)"
        ),
    }),
  }),

  done: tool({
    description:
      "Signal that the task is complete. Provide a clear summary of everything that was accomplished. " +
      "If save_flow is true, the agent's action history will be saved as a .flow file.",
    parameters: z.object({
      summary: z.string().describe("Detailed summary of what was accomplished"),
      save_flow: z
        .boolean()
        .optional()
        .describe("If true, save the action history as a reusable .flow file"),
    }),
  }),
};

export type TaskToolName = keyof typeof taskTools;
