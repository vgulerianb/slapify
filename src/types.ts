// Configuration types
export interface SlapifyConfig {
  /** Single model or an ordered fallback chain (tried in order on failure). */
  llm: LLMConfig | LLMConfig[];
  browser?: BrowserConfig;
  report?: ReportConfig;
  plugins?: PluginsConfig;
  telegram?: TelegramConfig;
}

export interface LLMConfig {
  provider: "anthropic" | "openai" | "google" | "mistral" | "groq" | "ollama";
  model: string;
  api_key?: string;
  base_url?: string;
  /** Human-readable label shown in fallback logs, e.g. 'Claude (primary)' */
  label?: string;
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
}

// Browser state
export interface BrowserState {
  url: string;
  title: string;
  snapshot: string;
  refs: Record<string, RefInfo>;
}

export interface RefInfo {
  role: string;
  name?: string;
  text?: string;
}
