// Configuration types
export interface SlapifyConfig {
  /** Single model or an ordered fallback chain (tried in order on failure). */
  llm: LLMConfig | LLMConfig[];
  /**
   * Send screenshots to the model as images so it can actually look at the
   * page. Off by default: images cost a lot of tokens per call, and the
   * `claude-cli` provider cannot carry them at all (it runs `claude -p`,
   * which is text-only), so this needs an API-key provider.
   */
  vision?: boolean;
  /**
   * Literal substitutions applied to any text the agent types, before it
   * reaches the page. Style rules stated in a prompt are followed most of the
   * time but not all of the time; anything that must hold every time belongs
   * here, where it is enforced rather than requested.
   * Example: { "—": ", " } to guarantee no em dashes are ever typed.
   */
  text_filters?: Record<string, string>;
  /**
   * Optional Jev decision model. Speeds up narrow yes/no and "which one"
   * decisions (finding an element, checking a condition, skipping empty
   * popup checks) without replacing the main LLM, which still plans and
   * writes. Every Jev call falls back to the LLM when it is not confident.
   */
  jev?: JevConfig;
  /**
   * Review irreversible actions (posting, sending, buying, deleting) against a
   * policy before they happen. Uses Jev when configured, the main LLM as a
   * fallback. Off by default.
   */
  review?: ReviewConfig;
  /** Folders the agent may upload files from and save downloads to. */
  files?: FilesConfig;
  /** Ultrafast mode (`slapify fast`): Jev drives, the LLM only writes text. */
  fast?: FastConfig;
  browser?: BrowserConfig;
  report?: ReportConfig;
  plugins?: PluginsConfig;
  telegram?: TelegramConfig;
}

export interface FastConfig {
  /** Model that writes field values. A small, fast model is ideal. Default: the first llm. */
  text_llm?: LLMConfig;
  /** Browser actions before giving up. Default 60. */
  max_actions?: number;
  /** Jev decisions before giving up. Default 120. */
  max_decisions?: number;
}

export interface FilesConfig {
  /** Only files in here (or in downloads_dir) can be uploaded. Default: .slapify/uploads */
  uploads_dir?: string;
  /** Downloads are saved here. Default: .slapify/downloads */
  downloads_dir?: string;
}

export interface LLMConfig {
  provider:
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "groq"
  | "ollama"
  | "claude-cli";
  model: string;
  api_key?: string;
  base_url?: string;
  /** Human-readable label shown in fallback logs, e.g. 'Claude (primary)' */
  label?: string;
  /** claude-cli only: path to the claude binary (default: "claude" from PATH) */
  cli_path?: string;
  /** claude-cli only: max seconds per CLI call before it's killed (default: 600) */
  timeout_seconds?: number;
}

export interface JevConfig {
  /** Off unless set. Jev is an accelerator, never a requirement. */
  enabled?: boolean;
  /**
   * Fills in base_url and model. All three accept the same TypeSafe
   * "System One" request body, so only these defaults differ.
   */
  provider?: "typesafe" | "vercel" | "openrouter";
  /** Overrides the provider's base URL, e.g. for a proxy or LiteLLM pass-through. */
  base_url?: string;
  /** Request path appended to base_url. Default "/v1/systemone". */
  path?: string;
  api_key?: string;
  /** Overrides the provider's model id. */
  model?: string;
  /** Minimum confidence to act on a Choice answer. Default 0.7. */
  min_confidence?: number;
  /** Per-request timeout. Default 10000ms. */
  timeout_ms?: number;
  /** Turn individual integrations off. All default to on when Jev is enabled. */
  use?: {
    /** Task agent: find_element and check tools. */
    tools?: boolean;
    /** Flow runner: skip the popup-check LLM call when there is clearly no popup. */
    interruption_gate?: boolean;
    /** Flow runner: pass "Verify ..." steps without an LLM call when clearly true. */
    verify_fast_path?: boolean;
  };
}

export interface ReviewConfig {
  enabled?: boolean;
  /** Plain-English rules the action and anything it publishes must follow. */
  policy?: string;
  /**
   * What to do when no reviewer can answer. "hold" (default) skips the action;
   * "allow" does it unreviewed. Holding is the safe default: otherwise the
   * check vanishes exactly when something is already going wrong.
   */
  on_unavailable?: "hold" | "allow";
  /** Use the main LLM when Jev is unavailable or unsure. Default "llm". */
  fallback?: "llm" | "none";
  /**
   * Jev verdicts with a smaller margin than this (its choice confidence) get a
   * second opinion from the LLM. Default 0.4, roughly a 70/30 split.
   */
  min_confidence?: number;
}

export interface PluginsConfig {
  /**
   * Paths to additional markdown rule files to always append to the system prompt.
   * Supports glob patterns relative to the .slapify directory.
   * Example: ["rules/my-persona.md", "rules/company-style.md"]
   */
  rules?: string[];
  /**
   * Paths to .js/.ts files exporting tools to merge with the agent's built-in tools.
   * Each file must export an object containing Vercel AI SDK `tool()` definitions.
   * Example: ["tools/custom-utils.js"]
   */
  tools?: string[];
}

export interface TelegramConfig {
  bot_token: string;
  /** Optional: only allow messages from this chat/user ID */
  allowed_chat_id?: string | number;
}

export interface BrowserConfig {
  /** Let a headless browser play sound. Off by default: headless is muted. */
  audio?: boolean;
  headless?: boolean;
  timeout?: number;
  viewport?: {
    width: number;
    height: number;
  };
  executablePath?: string; // Path to Chrome/Chromium executable
  /** Path to a persistent Chromium user-data-dir/profile (enables session saving) */
  profile?: string;
  /** Custom User-Agent string to bypass basic checks */
  userAgent?: string;
  /** Array of Chromium launch args (e.g. ['--disable-blink-features=AutomationControlled']) */
  args?: string[];
  /**
   * Patch common automation fingerprints (navigator.webdriver, missing
   * window.chrome, empty plugins/languages, WebGL vendor strings, etc.)
   * before any page script runs. Helps pass basic bot-detection checks.
   */
  stealth?: boolean;
  browserbase?: {
    api_key: string;
    project_id?: string;
  };
}

export interface ReportConfig {
  format?: "markdown" | "html" | "json";
  screenshots?: boolean;
  output_dir?: string;
}

// Credentials types
export interface CredentialsConfig {
  profiles: Record<string, CredentialProfile>;
}

export interface CredentialProfile {
  type: "login-form" | "oauth" | "otp" | "inject" | "headers";
  username?: string;
  password?: string;
  email?: string;
  phone?: string;
  totp_secret?: string;
  fixed_otp?: string;
  backup_codes?: string[];
  cookies?: CookieConfig[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface CookieConfig {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

// Flow file types
export interface FlowFile {
  path: string;
  name: string;
  steps: FlowStep[];
  comments: string[];
}

export interface FlowStep {
  line: number;
  text: string;
  optional: boolean;
  conditional: boolean;
  condition?: string;
  action?: string;
}

// Execution types
export interface StepResult {
  step: FlowStep;
  status: "passed" | "failed" | "skipped";
  duration: number;
  actions: ActionLog[];
  assumptions?: string[];
  error?: string;
  screenshot?: string;
  retried?: boolean; // True if this step was retried after initial failure
}

export interface ActionLog {
  type:
  | "navigate"
  | "click"
  | "fill"
  | "verify"
  | "wait"
  | "auto-handle"
  | "info";
  description: string;
  selector?: string;
  value?: string;
  timestamp: number;
}

export interface TestResult {
  flowFile: string;
  status: "passed" | "failed";
  steps: StepResult[];
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  duration: number;
  startTime: Date;
  endTime: Date;
  autoHandled: string[];
  assumptions: string[];
  /** Populated when --performance flag is used */
  perfAudit?: import("./perf/audit.js").PerfAuditResult;
  /** How many LLM calls Jev replaced during the run, when Jev is enabled. */
  jev?: {
    popupChecks: number;
    popupChecksSkipped: number;
    verifySteps: number;
    verifyFastPassed: number;
  };
}

// Browser state
export interface BrowserState {
  url: string;
  title: string;
  snapshot: string;
  refs: Record<string, RefInfo>;
  /** Set when the snapshot could not be captured, with the underlying reason. */
  error?: string;
}

export interface RefInfo {
  role: string;
  name?: string;
  text?: string;
}
