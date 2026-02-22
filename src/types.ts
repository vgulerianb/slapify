// Configuration types
export interface SlapifyConfig {
  llm: LLMConfig;
  browser?: BrowserConfig;
  report?: ReportConfig;
}

export interface LLMConfig {
  provider: "anthropic" | "openai" | "google" | "mistral" | "groq" | "ollama";
  model: string;
  api_key?: string;
  base_url?: string;
}

export interface BrowserConfig {
  headless?: boolean;
  timeout?: number;
  viewport?: {
    width: number;
    height: number;
  };
  executablePath?: string; // Path to Chrome/Chromium executable
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
