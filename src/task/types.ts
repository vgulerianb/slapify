export type TaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "sleeping"
  | "scheduled";

export interface TaskSession {
  id: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  iteration: number;
  memory: Record<string, string>;
  scheduledJobs: ScheduledJob[];
  finalSummary?: string;
  savedFlowPath?: string;
  /**
   * All performance audit results collected this session.
   * Each call to perf_audit appends here, supporting multi-page comparisons.
   */
  perfAudits?: import("../perf/audit.js").PerfAuditResult[];
  /** @deprecated use perfAudits[0] — kept for backwards compat with old reports */
  perfAudit?: import("../perf/audit.js").PerfAuditResult;
  /** Accumulated structured output written by the agent via write_output */
  structuredOutput?: unknown;
}

export interface ScheduledJob {
  id: string;
  cron: string;
  taskDescription: string;
  createdAt: string;
  lastRun?: string;
  nextRun?: string;
}

// JSONL event format for session persistence
export type SessionEvent =
  | { type: "session_start"; goal: string; ts: string }
  | { type: "iteration_start"; iteration: number; ts: string }
  | {
      type: "llm_response";
      text: string;
      toolCalls: ToolCallRecord[];
      ts: string;
    }
  | {
      type: "tool_call";
      toolName: string;
      args: Record<string, unknown>;
      result: unknown;
      ts: string;
    }
  | {
      type: "tool_error";
      toolName: string;
      args: Record<string, unknown>;
      error: string;
      ts: string;
    }
  | { type: "memory_update"; key: string; value: string; ts: string }
  | { type: "scheduled"; cron: string; task: string; ts: string }
  | { type: "sleeping_until"; until: string; ts: string }
  | { type: "session_end"; summary: string; status: TaskStatus; ts: string }
  | {
      type: "context_compacted";
      fromMessages: number;
      toMessages: number;
      ts: string;
    };

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface TaskRunOptions {
  goal: string;
  sessionId?: string;
  headed?: boolean;
  executablePath?: string;
  saveFlow?: boolean;
  /** Directory to write the .flow file into (default: cwd) */
  flowOutputDir?: string;
  maxIterations?: number;
  onEvent?: (event: TaskEvent) => void;
  onSessionUpdate?: (session: TaskSession) => void;
  /** Called when the agent needs input from the user. Must resolve with the user's answer. */
  onHumanInput?: (question: string, hint?: string) => Promise<string>;
  /**
   * JSON Schema the agent should use to structure its output.
   * Injected into the system prompt; the agent uses write_output to produce
   * conforming data at any point (e.g. after each scheduled run).
   */
  schema?: Record<string, unknown>;
  /**
   * File path to write structured JSON output to.
   * For recurring tasks the agent appends entries; for one-shot tasks it overwrites.
   * If omitted, structured output is only available on the returned session object.
   */
  outputFile?: string;
  /**
   * When true this is a scheduled sub-run spawned by a cron job.
   * The agent must NOT call schedule() again — it would create runaway duplicates.
   */
  isScheduledRun?: boolean;
  /**
   * Memory key/value pairs inherited from the parent session.
   * Injected into the sub-run so it knows the thread URL, last message, etc.
   */
  inheritedMemory?: Record<string, string>;
}

export type TaskEvent =
  | { type: "thinking" }
  | { type: "tool_start"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_done"; toolName: string; result: string }
  | { type: "tool_error"; toolName: string; error: string }
  | { type: "message"; text: string }
  | { type: "status_update"; message: string }
  | { type: "human_input_needed"; question: string; hint?: string }
  | { type: "credentials_saved"; profileName: string; credType: string }
  | { type: "scheduled"; cron: string; task: string }
  | { type: "sleeping"; until: string }
  | { type: "done"; summary: string }
  | { type: "flow_saved"; path: string }
  | { type: "output_written"; path: string; data: unknown }
  | { type: "error"; error: string };
