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
 * OpenAI's Decisions API (`provider: openai`, gpt-6-luna) answers the same
 * kinds of question — predicate, choice, score — with calibrated
 * probabilities, so it plugs in behind the same decide() call: questions are
 * translated on the way out and answers back into Jev's shape on the way in,
 * and every caller (find_element, check, review, the flow runner's fast paths,
 * ultrafast mode) works with either backend unchanged.
 *
 * Every call degrades gracefully: on any failure decide() returns an error
 * instead of throwing, and callers fall back to the normal LLM path.
 */

import { JevConfig } from "../types.js";

type Protocol = "systemone" | "decisions";

/** Provider defaults. Any field can be overridden in config. */
const PRESETS: Record<string, { base_url: string; model: string; path?: string; protocol?: Protocol }> = {
  typesafe: { base_url: "https://api.typesafe.ai", model: "jev-latest" },
  vercel: { base_url: "https://ai-gateway.vercel.sh/typesafe", model: "jev-latest" },
  openrouter: { base_url: "https://openrouter.ai/api", model: "~typesafe/jev-latest" },
  openai: { base_url: "https://api.openai.com", model: "gpt-6-luna", path: "/v1/decisions", protocol: "decisions" },
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

function textOf(t: JevText): string {
  return typeof t === "string" ? t : JSON.stringify(t);
}

/**
 * Jev questions → a Decisions request. Question names are replaced by
 * q0, q1, … (Jev keys can be anything) and mapped back in fromDecisions().
 */
export function toDecisionsRequest(
  model: string,
  state: string,
  questions: Record<string, JevQuestion>
): { body: Record<string, unknown>; names: string[] } {
  const names = Object.keys(questions);
  const out = names.map((key, i) => {
    const q = questions[key];
    const name = `q${i}`;
    switch (q.type) {
      case "choice":
        return {
          type: "choice",
          name,
          instructions: textOf(q.instructions),
          choices: Object.entries(q.criteria).map(([value, why]) => ({ value, description: textOf(why) })),
        };
      case "noul":
        return {
          type: "predicate",
          name,
          instructions:
            `${textOf(q.instructions)}\n\nTrue when: ${textOf(q.criteria.true)}\nFalse when: ${textOf(q.criteria.false)}`,
        };
      case "score":
        return {
          type: "score",
          name,
          instructions: textOf(q.instructions),
          levels: q.criteria.map((c, level) => ({ label: `Level ${level}`, description: textOf(c) })),
        };
    }
  });
  return { body: { model, input: state, questions: out }, names };
}

/**
 * Decisions answers → Jev answers. A refusal, or an answer that doesn't match
 * its question, is left out; callers already treat a missing answer as
 * "not confident" and fall back to the LLM.
 */
export function fromDecisionsResponse(
  json: any,
  names: string[],
  questions: Record<string, JevQuestion>
): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {};
  for (const a of Array.isArray(json?.answers) ? json.answers : []) {
    const idx = typeof a?.name === "string" && /^q\d+$/.test(a.name) ? Number(a.name.slice(1)) : -1;
    const key = names[idx];
    if (key === undefined) continue;
    const q = questions[key];
    const probs = (list: unknown): Record<string, number> =>
      Object.fromEntries(
        (Array.isArray(list) ? list : [])
          .filter((p: any) => p && Number.isFinite(p.probability))
          .map((p: any) => [String(p.value), Number(p.probability)])
      );
    if (a.type === "predicate" && q.type === "noul" && Number.isFinite(a.probability)) {
      answers[key] = { type: "noul", noul: Number(a.probability) };
    } else if (a.type === "choice" && q.type === "choice" && typeof a.choice === "string" && a.choice in q.criteria) {
      answers[key] = {
        type: "choice",
        choice: a.choice,
        confidence: Number.isFinite(a.confidence) ? Number(a.confidence) : 0,
        probabilities: probs(a.probabilities),
      };
    } else if (a.type === "score" && q.type === "score" && Number.isFinite(a.score)) {
      answers[key] = {
        type: "score",
        score: Number(a.score),
        confidence: Number.isFinite(a.confidence) ? Number(a.confidence) : 0,
        probabilities: probs(a.probabilities),
      };
    }
  }
  return answers;
}

export class JevClient {
  readonly url: string;
  readonly model: string;
  readonly minConfidence: number;
  /** Which backend this is, for logs and error messages. */
  readonly label: string;
  private readonly protocol: Protocol;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: JevConfig) {
    const preset = config.provider ? PRESETS[config.provider] : undefined;
    const base = (config.base_url || preset?.base_url || "").replace(/\/+$/, "");
    this.protocol = config.protocol || preset?.protocol || "systemone";
    this.url = base + (config.path || preset?.path || DEFAULT_PATH);
    this.model = config.model || preset?.model || "jev-latest";
    this.label = this.protocol === "decisions" ? "OpenAI Decisions" : "Jev";
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
      return {
        client: null,
        reason:
          config.provider === "openai"
            ? "jev.provider is openai but jev.api_key is empty (set it to ${OPENAI_API_KEY})"
            : "jev.enabled is set but jev.api_key is empty",
      };
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
    const decisions = this.protocol === "decisions" ? toDecisionsRequest(this.model, state, questions) : null;
    const body = JSON.stringify(decisions ? decisions.body : { model: this.model, state, questions });
    const label = this.label;
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
            return { ok: false, error: `${label} response had no answers` };
          }
          return {
            ok: true,
            answers: decisions ? fromDecisionsResponse(json, decisions.names, questions) : json.answers,
            ms: Date.now() - started,
            inputTokens: Number(json.usage?.input_tokens) || 0,
          };
        }

        const detail = (await res.text().catch(() => "")).slice(0, 200);
        lastError = `${label} HTTP ${res.status}: ${detail}`;
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
          ? `${label} timed out after ${this.timeoutMs}ms`
          : `${label} request failed: ${err?.message || err}`;
        // A dropped connection (a reused keep-alive socket the server had just
        // closed, a reset) never reached Jev: safe to send again, once, now.
        if (timedOut || attempt === MAX_RETRIES) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return { ok: false, error: lastError || `${label} request failed` };
  }
}
