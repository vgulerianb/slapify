/**
 * Jev client — fast, calibrated decisions for browser navigation.
 *
 * Jev (by TypeSafe) is not a chat model. It takes some state plus typed
 * questions and returns a decision with probabilities attached: which of
 * these elements matches, is this condition true. It cannot plan or write
 * text, so it never replaces the main LLM — it answers the narrow questions
 * the agent would otherwise spend an LLM turn and a 20k-character snapshot on.
 *
 * TypeSafe, Vercel AI Gateway and OpenRouter all accept the same TypeSafe
 * "System One" request body, so one client covers every provider. Only the
 * base URL, key and model id differ.
 *
 * Every call degrades gracefully: on any failure decide() returns an error
 * instead of throwing, and callers fall back to the normal LLM path.
 */

import { JevConfig } from "../types.js";

/** Provider defaults. Any field can be overridden in config. */
const PRESETS: Record<string, { base_url: string; model: string }> = {
  typesafe: { base_url: "https://api.typesafe.ai", model: "jev-latest" },
  vercel: { base_url: "https://ai-gateway.vercel.sh/typesafe", model: "jev-latest" },
  openrouter: { base_url: "https://openrouter.ai/api", model: "~typesafe/jev-latest" },
};

const DEFAULT_PATH = "/v1/systemone";
/** Statuses that mean "try again shortly" rather than "this request is wrong". */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
/**
 * Retry budget. Kept small on purpose: Jev is only worth using because it is
 * faster than the LLM call it replaces, so after a couple of quick retries it
 * is better to fall back to the LLM than to keep waiting.
 */
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Below this, a Choice answer is not trusted and the caller falls back. */
const DEFAULT_MIN_CONFIDENCE = 0.7;
/** Jev's hard limit on options in a single Choice question. */
export const JEV_MAX_CHOICES = 255;

/**
 * Instructions, criteria and state may be plain text or structured JSON.
 * Structured criteria ({ element, role, in, position, ... }) let Jev tell apart
 * options whose labels are identical, like ten "Like" buttons in one thread.
 */
export type JevText = string | Record<string, unknown>;

export type JevQuestion =
  | { type: "choice"; instructions: JevText; criteria: Record<string, JevText> }
  | { type: "noul"; instructions: JevText; criteria: { true: JevText; false: JevText } }
  | { type: "score"; instructions: JevText; criteria: JevText[] };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export type JevResult =
  | { ok: true; answers: Record<string, JevAnswer>; ms: number; inputTokens: number }
  | { ok: false; error: string };

export class JevClient {
  readonly url: string;
  readonly model: string;
  readonly minConfidence: number;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: JevConfig) {
    const preset = config.provider ? PRESETS[config.provider] : undefined;
    const base = (config.base_url || preset?.base_url || "").replace(/\/+$/, "");
    this.url = base + (config.path || DEFAULT_PATH);
    this.model = config.model || preset?.model || "jev-latest";
    this.apiKey = config.api_key || "";
    this.minConfidence = config.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Build a client if Jev is enabled and usable, otherwise null. A missing
   * key or URL disables Jev with a reason rather than failing the run.
   */
  static fromConfig(config?: JevConfig): { client: JevClient | null; reason?: string } {
    if (!config?.enabled) return { client: null };
    if (!config.api_key) {
      return { client: null, reason: "jev.enabled is set but jev.api_key is empty" };
    }
    if (!config.base_url && !(config.provider && PRESETS[config.provider])) {
      return {
        client: null,
        reason: `jev needs a provider (${Object.keys(PRESETS).join(", ")}) or a base_url`,
      };
    }
    return { client: new JevClient(config) };
  }

  async decide(
    state: string,
    questions: Record<string, JevQuestion>
  ): Promise<JevResult> {
    const started = Date.now();
    const body = JSON.stringify({ model: this.model, state, questions });
    let lastError = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Never let retries run past the overall timeout.
      const remaining = this.timeoutMs - (Date.now() - started);
      if (remaining <= 0) break;
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(remaining),
        });

        if (res.ok) {
          const json: any = await res.json();
          if (!json?.answers || typeof json.answers !== "object") {
            return { ok: false, error: "Jev response had no answers" };
          }
          return {
            ok: true,
            answers: json.answers,
            ms: Date.now() - started,
            inputTokens: Number(json.usage?.input_tokens) || 0,
          };
        }

        const detail = (await res.text().catch(() => "")).slice(0, 200);
        lastError = `Jev HTTP ${res.status}: ${detail}`;
        if (res.status === 401) return { ok: false, error: `${lastError} (check jev.api_key)` };
        if (res.status === 422) return { ok: false, error: `${lastError} (request rejected)` };

        const shouldRetry =
          RETRYABLE.has(res.status) && res.headers.get("x-should-retry") !== "false";
        if (!shouldRetry || attempt === MAX_RETRIES) break;

        // Honour Retry-After when present, otherwise a short backoff.
        const header = Number(res.headers.get("retry-after"));
        const wait = Math.min(
          Number.isFinite(header) && header > 0 ? header * 1000 : 400 * 3 ** attempt,
          MAX_RETRY_WAIT_MS
        );
        await new Promise((r) => setTimeout(r, wait));
      } catch (err: any) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        lastError = timedOut
          ? `Jev timed out after ${this.timeoutMs}ms`
          : `Jev request failed: ${err?.message || err}`;
        // A dropped connection (a reused keep-alive socket the server had just
        // closed, a reset) never reached Jev: safe to send again, once, now.
        if (timedOut || attempt === MAX_RETRIES) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return { ok: false, error: lastError || "Jev request failed" };
  }
}
