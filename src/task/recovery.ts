/**
 * Recovery policy for failed LLM calls.
 *
 * Principle, from fx: a long-running turn never dies from a transient
 * failure. It retries quickly first, then patiently, and tells a human if the
 * outage lasts. What it must NOT do is exit — that is what turned one usage
 * limit into 273 process restarts overnight.
 *
 * This module is pure policy: it classifies errors and says how long to wait.
 * The runner does the waiting, the retrying and the talking.
 */

export type LlmFailure =
  /** The model produced a tool call with missing or invalid arguments. */
  | "bad_tool_args"
  /** The call didn't complete: timeout, dropped connection. Retry the same model. */
  | "transient"
  /** The provider refused: rate limit, quota, usage limit, auth. Rotate or wait. */
  | "provider"
  /** Anything else. Surfaced to the iteration's own recovery. */
  | "unknown";

export function classifyLlmError(error: unknown): LlmFailure {
  const e = error as { message?: string; name?: string };
  const msg = String(e?.message || error || "").toLowerCase();
  const name = String(e?.name || "").toLowerCase();

  // "Invalid input for tool" / InvalidToolInputError is the AI SDK 5+ wording.
  if (
    msg.includes("invalid arguments for tool") ||
    msg.includes("invalid input for tool") ||
    msg.includes("type validation failed") ||
    name.includes("invalidtoolarguments") ||
    name.includes("invalidtoolinput")
  ) {
    return "bad_tool_args";
  }

  // A CLI provider that never reached the API reports `duration_api_ms: 0`.
  // That is the signature of a plan usage limit (or a logged-out CLI): nothing
  // is wrong with this request, the account just can't serve it right now.
  if (/duration_api_ms"?\s*:\s*0\b/.test(msg)) return "provider";

  if (
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  ) {
    return "transient";
  }

  if (
    msg.includes("too many requests") ||
    msg.includes("429") ||
    msg.includes("402") ||
    msg.includes("payment required") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("quota") ||
    msg.includes("exhausted") ||
    msg.includes("overloaded") ||
    msg.includes("rate limit") ||
    msg.includes("usage limit") ||
    msg.includes("limit reached") ||
    msg.includes("credit balance") ||
    msg.includes("billing")
  ) {
    return "provider";
  }

  return "unknown";
}

/** Quick retries of the same model for a transient failure. */
export const MAX_TRANSIENT_RETRIES = 3;
export function transientBackoffMs(attempt: number): number {
  return 5000 * attempt;
}

/**
 * Patient wait once every model in the chain has failed: 1, 2, 4 minutes,
 * then every 5. A usage limit resets on its own schedule; checking every few
 * minutes costs nothing and hammering it helps nobody.
 */
export function patientBackoffMs(round: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, round - 1), 300_000);
}

/** After this long waiting on the same outage, tell a human once. */
export const OUTAGE_NOTIFY_AFTER_MS = 10 * 60_000;
