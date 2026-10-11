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
    inputSchema: z.object({
      url: z.string().describe("Full URL including https://"),
    }),
  }),

  get_page_state: tool({
    description:
      "Get the current browser state: URL, page title, and an accessibility snapshot of all interactive elements with their ref IDs. Use ref IDs with click/type tools. " +
      "This lists only interactive elements — buttons, links, inputs — so body text (posts, articles, comments, search results) will NOT appear here. To read what a page actually says, call get_page_text().",
    inputSchema: z.object({}),
  }),

  get_links: tool({
    description:
      "List the links on the current page as {href, text} pairs. This is the ONLY way to discover URLs: get_page_state() names links but omits their href, and get_page_text() returns visible text with no URLs. " +
      "Use it to grab a permalink so you can navigate straight to a specific item instead of hunting for the right button in a long list. Filter with `contains` (e.g. '/status/' for tweet permalinks).",
    inputSchema: z.object({
      contains: z
        .string()
        .optional()
        .describe("Only return links whose URL contains this substring"),
      limit: z.number().optional().describe("Max links to return (default 100)"),
    }),
  }),

  get_page_text: tool({
    description:
      "Read the visible text of the current page. Use this whenever you need to know what the page SAYS rather than what you can click on: reading posts or tweets and their replies, articles, notifications, search results, error messages. " +
      "get_page_state() only reports interactive elements and omits body text, so an empty-looking snapshot does not mean the page is empty — call this to read it.",
    inputSchema: z.object({}),
  }),

  click: tool({
    description:
      "Click an element identified by its ref ID from get_page_state(). Use for buttons, links, checkboxes, etc.",
    inputSchema: z.object({
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
    inputSchema: z.object({
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
    inputSchema: z.object({
      key: z.string().describe("Key or key combo to press"),
    }),
  }),

  hover: tool({
    description:
      "Move the mouse over an element by ref, to reveal menus, tooltips or controls that only appear on hover.",
    inputSchema: z.object({
      ref: z.string().describe("The ref ID of the element to hover"),
    }),
  }),

  double_click: tool({
    description: "Double-click an element by ref (e.g. to open an item or select a word).",
    inputSchema: z.object({
      ref: z.string().describe("The ref ID of the element"),
      description: z.string().optional().describe("Human-readable description of the element"),
    }),
  }),

  set_checked: tool({
    description:
      "Set a checkbox, radio button or switch to checked or unchecked. Safer than click() for these: it is idempotent, so calling it twice never flips the state back.",
    inputSchema: z.object({
      ref: z.string().describe("The ref ID of the checkbox / radio / switch"),
      checked: z.boolean().describe("true to check, false to uncheck"),
    }),
  }),

  select_option: tool({
    description:
      "Choose an option in a native <select> dropdown (a combobox in get_page_state()). Pass the option's visible label or its value.",
    inputSchema: z.object({
      ref: z.string().describe("The ref ID of the select / combobox"),
      option: z.string().describe("The option label or value to choose"),
    }),
  }),

  drag: tool({
    description: "Drag one element and drop it onto another (sortable lists, kanban boards, sliders).",
    inputSchema: z.object({
      source_ref: z.string().describe("The ref ID of the element to drag"),
      target_ref: z.string().describe("The ref ID of the element to drop onto"),
    }),
  }),

  upload_file: tool({
    description:
      "Attach local files to a file input (the 'Choose file' / upload button). Only files in the configured uploads folder, or files you downloaded earlier in this task, can be uploaded; give a filename relative to the uploads folder or the path download_file returned.",
    inputSchema: z.object({
      ref: z.string().describe("The ref ID of the file input or upload button"),
      paths: z.array(z.string()).min(1).describe("Files to upload"),
    }),
  }),

  download_file: tool({
    description:
      "Click an element that starts a download, and save the file. Returns the saved path and size; the path can be passed to upload_file later.",
    inputSchema: z.object({
      ref: z.string().describe("The ref ID of the download link or button"),
      filename: z.string().optional().describe("Name to save it as (optional)"),
    }),
  }),

  hold_keys: tool({
    description:
      "Hold one or more keys down together for a duration, then release them. Real key-down/key-up events, so this works where press() does not: games (hold W to move forward, W+A to turn), canvas apps and anything that reads held keys. " +
      "Keys: letters, digits, F1-F12, Enter, Escape, Space, Tab, Shift, Control, Alt, ArrowUp/Down/Left/Right. A short ms (80) is a tap. The page must have focus: click_at() on it first if keys seem to do nothing.",
    inputSchema: z.object({
      keys: z.array(z.string()).min(1).max(4).describe("Keys held together, e.g. ['w'] or ['w','a']"),
      ms: z.number().min(20).max(10000).describe("How long to hold them, in milliseconds"),
      look_for: z.string().optional().describe("Also look at the screen right after, and answer this question about it (saves a separate screenshot turn)"),
      settle_ms: z.number().min(0).max(5000).optional().describe("How long to wait before looking (default 300). Raise it (2000-3000) when the action starts an animation or transition: opening, entering, loading, a dialog sliding in. Looking too early shows a half-finished frame."),
    }),
  }),

  click_at: tool({
    description:
      "Click at a position in the viewport, in CSS pixels from the top-left (the same coordinates as a screenshot at 1x). For canvas apps and games, which have no element refs. Also gives that spot keyboard focus.",
    inputSchema: z.object({
      x: z.number().describe("Pixels from the left edge of the viewport"),
      y: z.number().describe("Pixels from the top edge of the viewport"),
      button: z.enum(["left", "right"]).optional(),
      look_for: z.string().optional().describe("Also look at the screen right after, and answer this question about it (saves a separate screenshot turn)"),
      settle_ms: z.number().min(0).max(5000).optional().describe("How long to wait before looking (default 300). Raise it (2000-3000) when the click starts an animation or transition."),
    }),
  }),

  move_mouse: tool({
    description:
      "Move the mouse pointer to a viewport position without clicking (hover menus, a cursor in canvas apps). " +
      "It cannot turn a 3D game camera that uses a captured mouse (pointer lock): those read relative motion this does not produce. Turn with the keys instead (usually A/D or the arrows).",
    inputSchema: z.object({
      x: z.number(),
      y: z.number(),
    }),
  }),

  list_tabs: tool({
    description:
      "List open browser tabs with their ids, titles and URLs. Use when a click may have opened a new tab or window (OAuth sign-in, a popup, a checkout).",
    inputSchema: z.object({}),
  }),

  switch_tab: tool({
    description: "Make a tab the active one, by its id from list_tabs() (e.g. t2). Call get_page_state() afterwards.",
    inputSchema: z.object({
      id: z.string().describe("Tab id, e.g. t2"),
    }),
  }),

  close_tab: tool({
    description: "Close a tab by id, or the active tab when no id is given.",
    inputSchema: z.object({
      id: z.string().optional().describe("Tab id, e.g. t2"),
    }),
  }),

  scroll: tool({
    description: "Scroll the page in a direction.",
    inputSchema: z.object({
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().optional().describe("Pixels to scroll (default 300)"),
    }),
  }),

  wait: tool({
    description:
      "Wait for a specified number of seconds. Use when waiting for page loads, animations, or time-sensitive operations.",
    inputSchema: z.object({
      seconds: z.number().min(0.1).max(60).describe("Seconds to wait"),
    }),
  }),

  screenshot: tool({
    description:
      "Look at the current page as an image. Use it when text is not enough: a CAPTCHA, a chart, an image-only post, or a layout that looks wrong and you want to see why. " +
      "For reading text, prefer get_page_text() — it is cheaper and gives exact characters. " +
      "If vision is disabled the image is only saved to disk and you will be told you cannot see it.",
    inputSchema: z.object({
      description: z
        .string()
        .optional()
        .describe("Why you are taking this screenshot"),
      look_for: z
        .string()
        .optional()
        .describe(
          "What you need to know from the image, as a question (e.g. 'what characters are in the CAPTCHA?', 'is there an error banner?'). Asking something specific gives a far more useful answer than a generic description."
        ),
    }),
  }),

  reload: tool({
    description: "Reload the current page.",
    inputSchema: z.object({}),
  }),

  go_back: tool({
    description: "Navigate back to the previous page.",
    inputSchema: z.object({}),
  }),

  // ── Credentials ──────────────────────────────────────────────────────────

  list_credential_profiles: tool({
    description:
      "List all available credential profiles and their types (e.g. login-form, inject, oauth). " +
      "Call this when you reach a login page or need to authenticate — the agent picks the right profile automatically.",
    inputSchema: z.object({}),
  }),

  inject_credentials: tool({
    description:
      "Inject a credential profile into the browser (sets cookies, localStorage, sessionStorage) and reload. " +
      "Use for 'inject' type profiles. After injection call get_page_state() to verify login status. " +
      "If the injected session is expired (redirected to login page), fall back to fill_login_form.",
    inputSchema: z.object({
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
    inputSchema: z.object({
      profile_name: z
        .string()
        .describe("The name of the credential profile to use"),
    }),
  }),

  get_otp: tool({
    description:
      "Get the current one-time code (2FA / OTP) for a credential profile that has one configured (hasOtp in list_credential_profiles): " +
      "the live authenticator (TOTP) code, or the profile's fixed test code. Call it when the site asks for the code, usually right after the password step, " +
      "and type it straight away: TOTP codes change every 30 seconds. Use this instead of ask_user() whenever the profile has a code configured.",
    inputSchema: z.object({
      profile_name: z
        .string()
        .describe("The name of the credential profile to get the code for"),
    }),
  }),

  // ── Memory ────────────────────────────────────────────────────────────────

  remember: tool({
    description:
      "Store a piece of information in persistent memory that survives across iterations and sessions. " +
      "Use for important findings, extracted data, or state you'll need later.",
    inputSchema: z.object({
      key: z.string().describe("Unique key for this memory"),
      value: z
        .string()
        .describe("Value to store (use JSON string for structured data)"),
    }),
  }),

  recall: tool({
    description: "Retrieve a previously stored memory value by key.",
    inputSchema: z.object({
      key: z.string().describe("The memory key to retrieve"),
    }),
  }),

  list_memories: tool({
    description: "List all keys currently stored in memory.",
    inputSchema: z.object({}),
  }),

  // ── Scheduling / Time ─────────────────────────────────────────────────────

  schedule: tool({
    description:
      "Schedule this task (or a sub-task) to run on a recurring cron schedule. " +
      "For example: monitor every 30 minutes, check daily at 9am, etc. " +
      "The process will stay alive and re-run the goal at each interval. " +
      "Examples: '*/30 * * * *' every 30 min, '0 9 * * *' every day at 9am.",
    inputSchema: z.object({
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
    inputSchema: z.object({
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
    inputSchema: z.object({
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
    inputSchema: z.object({
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
    inputSchema: z.object({
      message: z.string().describe("The message to show the user"),
    }),
  }),

  ask_user: tool({
    description:
      "Ask the user a question and wait for their response. Use when you need information " +
      "that is not available elsewhere — e.g. an OTP, a 2FA code, a missing password, " +
      "a clarification about what to do next, or confirmation before a destructive action. " +
      "The task pauses until the user replies. Returns the user's answer as a string.",
    inputSchema: z.object({
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
    inputSchema: z.object({
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
    inputSchema: z.object({
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
    inputSchema: z.object({
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
    inputSchema: z.object({
      summary: z.string().describe("Detailed summary of what was accomplished"),
      save_flow: z
        .boolean()
        .optional()
        .describe("If true, save the action history as a reusable .flow file"),
    }),
  }),
};

/**
 * Tools backed by the Jev decision model. Only offered to the agent when
 * `jev.enabled` is set, so an agent without Jev never sees them.
 */
export const jevTools = {
  find_element: tool({
    description:
      "Find the element on the current page that matches a plain-English description, and get its ref. " +
      "Much faster and cheaper than reading the whole get_page_state() snapshot yourself, and good at telling apart elements that look alike (a reply COUNT button vs the reply box, a placeholder vs the real input). " +
      "Returns a ref with a confidence. If `confident` is false, do not trust the ref: call get_page_state() and choose yourself. " +
      "Say what kind of element it is (text box, button, link, checkbox): only matching elements are considered. Pass `descriptions` to find several elements in one call.",
    inputSchema: z.object({
      description: z
        .string()
        .optional()
        .describe("What the element is, e.g. 'the text box for writing a reply', 'the Like button for this tweet', 'the search input'"),
      descriptions: z
        .array(z.string())
        .max(8)
        .optional()
        .describe("Several elements at once, answered in a single fast request, e.g. ['the reply text box', 'the Like button for the main tweet']. Use instead of calling find_element repeatedly."),
    }),
  }),

  check: tool({
    description:
      "Check whether a statement is true about what the current page says, and get a calibrated probability. " +
      "Use it for yes/no questions you would otherwise answer by reading the whole page: did my reply post, am I logged in, is this a login wall or an error page, is this tweet actually about TypeScript. " +
      "One call, no need to read the page text yourself. Treat probability >= 0.85 as yes and <= 0.15 as no; anything in between is uncertain, so look for yourself.",
    inputSchema: z.object({
      statement: z
        .string()
        .describe("A statement to test, phrased so 'true' means yes, e.g. 'My reply appears on this page', 'The user is logged in'"),
    }),
  }),
};

/**
 * Offered when Jev AND vision are on: a fast look–decide–act loop for canvas
 * apps and games, where Jev picks each small move from what the screen shows.
 */
export const pursueTools = {
  pursue: tool({
    description:
      "Hand a short physical sub-goal to a fast inner loop: it repeatedly looks at the screen, lets a fast decision model pick the next small move (forward, turn left/right, forward while turning, back up, interact, wait) and does it, about every 6 seconds, without asking you each time. " +
      "Use it in games and canvas apps once you know the movement keys, for things like 'walk to the red car and get in' or 'go through the door on the left'. It stops when the goal is done, it is stuck, it is unsure, or max_steps runs out, and returns what it did and the last view. Check the result before relying on it.",
    inputSchema: z.object({
      goal: z.string().describe("A short, concrete, visible sub-goal, e.g. 'walk up to the red car and get in'"),
      keys: z
        .object({ forward: z.string().optional(), back: z.string().optional(), left: z.string().optional(), right: z.string().optional(), interact: z.string().optional() })
        .optional()
        .describe("Key bindings (defaults: w, s, a, d, f)"),
      max_steps: z.number().min(1).max(30).optional().describe("Moves before handing back (default 12)"),
      settle_ms: z.number().min(0).max(5000).optional().describe("Wait after each movement before looking again (default 400)"),
      interact_settle_ms: z.number().min(0).max(8000).optional().describe("Wait after an interact before looking again (default 2500): interactions usually start an animation, and acting again mid-way can cancel it"),
    }),
  }),
};

export type TaskToolName = keyof typeof taskTools | keyof typeof jevTools | keyof typeof pursueTools;
