/**
 * Action review: a policy check before anything irreversible happens.
 *
 * An agent that can do anything a human can will eventually be about to do
 * something it shouldn't: post a reply that states a made-up fact, send a
 * message to the wrong person, buy the wrong thing. Review runs just before
 * an irreversible action (see contracts.ts) and answers one question — given
 * the policy, the page, and the exact action, is this clear or does it need
 * caution? — then the harness either lets it through or holds it.
 *
 * Modelled on fx's permission reviewer, including its most important choice:
 * when the review can't be done (reviewer down, not configured), the action is
 * HELD by default. Failing open would mean the safety check disappears exactly
 * when something is already going wrong.
 *
 * Jev answers in well under a second, which is what makes reviewing every
 * post affordable. An LLM reviewer is available as a fallback.
 */

import { generateText } from "ai";
import { JevClient } from "../jev/client.js";
import { clip } from "../jev/decisions.js";
import { ReviewConfig } from "../types.js";

/** Jev's answer when it was too unsure to act on and a second opinion was asked. */
export interface JevFirstOpinion {
  choice: string;
  confidence: number;
}

export type ReviewVerdict =
  | { outcome: "clear"; by: "jev" | "llm"; confidence?: number; ms: number; jev?: JevFirstOpinion }
  | { outcome: "caution"; by: "jev" | "llm"; confidence?: number; ms: number; reason: string; jev?: JevFirstOpinion }
  | { outcome: "unavailable"; reason: string; jev?: JevFirstOpinion };

/**
 * Jev's choice confidence is the margin between the two options, not a
 * probability: 0.10 means roughly 55/45. Live, a fifth of verdicts came in
 * under 0.3, and rewording the same state could flip them. Below this margin
 * the verdict is treated as "unsure" and the LLM gives a second opinion.
 */
export const DEFAULT_REVIEW_MIN_CONFIDENCE = 0.4;

export interface PendingAction {
  /** Human-readable, e.g. `click "Post"` or `press Meta+Enter`. */
  description: string;
  pageUrl: string;
  pageTitle?: string;
  /** The text the agent last typed, which this action is about to publish. */
  pendingText?: string;
  goal: string;
}

const CRITERIA = {
  clear:
    "The action, and any text it publishes, follows the policy. It is appropriate to do it now.",
  caution:
    "The action or its text may break the policy: off-topic, rude, political, a factual claim that can't be backed up, the wrong target, or anything else the policy forbids. It should be held.",
};

function compose(policy: string, a: PendingAction): string {
  return [
    `Policy:\n${policy.trim()}`,
    `Task: ${clip(a.goal, 600)}`,
    `Page: ${a.pageUrl}${a.pageTitle ? ` (${a.pageTitle})` : ""}`,
    a.pendingText ? `Text about to be published:\n${clip(a.pendingText, 2000)}` : "",
    `Pending action: ${a.description}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class ActionReviewer {
  constructor(
    private cfg: ReviewConfig,
    private jev: JevClient | null,
    private llm: Parameters<typeof generateText>[0]["model"] | null
  ) { }

  get enabled(): boolean {
    return !!this.cfg.enabled;
  }

  async review(action: PendingAction): Promise<ReviewVerdict> {
    const state = compose(this.cfg.policy || "Act only in line with the task.", action);
    const minConfidence = this.cfg.min_confidence ?? DEFAULT_REVIEW_MIN_CONFIDENCE;
    const llmAllowed = !!this.llm && this.cfg.fallback !== "none";

    // A Jev verdict too close to call, kept in case no second opinion comes.
    let unsure: Exclude<ReviewVerdict, { outcome: "unavailable" }> | null = null;

    if (this.jev) {
      const r = await this.jev.decide(state, {
        decision: {
          type: "choice",
          instructions: "Should this pending action go ahead under the policy?",
          criteria: CRITERIA,
        },
      });
      if (r.ok) {
        const a = r.answers.decision;
        if (a?.type === "choice") {
          const verdict: Exclude<ReviewVerdict, { outcome: "unavailable" }> =
            a.choice === "clear"
              ? { outcome: "clear", by: "jev", confidence: a.confidence, ms: r.ms }
              : {
                outcome: "caution",
                by: "jev",
                confidence: a.confidence,
                ms: r.ms,
                reason: "The reviewer judged this may break the policy.",
              };
          // Confident, or the LLM is not an option: Jev's answer stands.
          if ((a.confidence ?? 1) >= minConfidence || !llmAllowed) return verdict;
          unsure = verdict;
        }
      }
      // Jev unavailable or unsure: fall through to the LLM if allowed.
    }

    const first = unsure ? { choice: unsure.outcome, confidence: unsure.confidence ?? 0 } : undefined;

    if (llmAllowed) {
      const started = Date.now();
      try {
        const res = await generateText({
          model: this.llm!,
          system:
            "You review a pending action against a policy, the way a sensible human moderator would. " +
            "Hold only clear violations of the policy as written. Opinions, general advice and common technical knowledge are fine; " +
            "invented facts, statistics or personal experiences are not. When in doubt about wording rather than substance, clear it. " +
            "Reply with exactly one line: CLEAR, or CAUTION: <one-sentence reason>.",
          prompt: state,
        });
        const text = (res.text || "").trim();
        if (/^clear\b/i.test(text)) return { outcome: "clear", by: "llm", ms: Date.now() - started, jev: first };
        if (/^caution\b/i.test(text)) {
          return {
            outcome: "caution",
            by: "llm",
            ms: Date.now() - started,
            reason: text.replace(/^caution:?\s*/i, "") || "The reviewer judged this may break the policy.",
            jev: first,
          };
        }
      } catch {
        // fall through
      }
    }

    // No second opinion. An unsure caution still holds; an unsure clear is not
    // enough to publish on, so it is reported unavailable (held by default).
    if (unsure?.outcome === "caution") return unsure;
    return { outcome: "unavailable", reason: unsure ? "the reviewer was unsure and no second opinion was available" : "no reviewer could answer", jev: first };
  }
}

/** Whether a verdict means the action must not run. */
export function shouldHold(verdict: ReviewVerdict, cfg: ReviewConfig): boolean {
  if (verdict.outcome === "caution") return true;
  if (verdict.outcome === "unavailable") return cfg.on_unavailable !== "allow";
  return false;
}

/** The result handed back to the model when an action is held. */
export function heldByReview(verdict: ReviewVerdict, description: string): Record<string, unknown> {
  if (verdict.outcome === "caution") {
    return {
      ok: false,
      held: true,
      review: "caution",
      action: description,
      reason: verdict.reason,
      do_next:
        "Do not repeat this action as-is. Revise what you were about to publish so it clearly follows the policy and try again, or skip this item and move on.",
    };
  }
  return {
    ok: false,
    held: true,
    review: "unavailable",
    action: description,
    reason: "The safety review for irreversible actions is unavailable, so this action was held rather than done unreviewed.",
    do_next: "Skip this item for now and carry on with other work; the review may be back shortly.",
  };
}
