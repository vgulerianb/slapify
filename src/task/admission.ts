/**
 * Tool admission: what to do about repeated calls.
 *
 * Replaces the old loop guard, which counted any identical (tool, args) pair
 * and then blocked it. That design failed three ways in practice:
 *  - it deadlocked, walling off every tool once tripped;
 *  - it blocked legitimate repetition, like pressing the same "send" chord on
 *    ten different tweets, because it ignored which page the call was on;
 *  - blocking a read-only call helps nobody, the model just asks again.
 *
 * The rules now, following fx's tool admission design:
 *  1. Calls are keyed by tool + arguments + the page they run on.
 *  2. Nothing is blocked for being repeated. Repeated FAILURES and repeated
 *     no-progress reads get guidance appended to their result instead; the
 *     model keeps authority over what to do next.
 *  3. The one hold: an irreversible action that already succeeded on this
 *     page is not run again. That is the difference between a stuck agent and
 *     one that posts the same reply twice or pays twice.
 */

import crypto from "crypto";
import { Effect } from "./contracts.js";

/** Failures of one identical call before the model is told to change approach. */
const FAILURE_GUIDANCE_AT = 2;
/** Identical results from one identical read before it is called a stall. */
const NO_PROGRESS_GUIDANCE_AT = 3;
/** Identical successful clicks on one page before the model is asked to rethink. */
const REPEATED_CLICK_GUIDANCE_AT = 3;
/**
 * Clicks, where doing the same thing again is rarely what helps. Held keys
 * are not here: holding W again is how you keep driving.
 */
const CLICK_TOOLS = new Set(["click", "click_at", "double_click"]);

/** Naturally repetitive tools that should never get no-progress guidance. */
const REPEAT_OK = new Set([
  "wait",
  "sleep_until",
  "status_update",
  "ask_user",
  "recall",
  "list_memories",
]);

interface Record_ {
  failures: number;
  successes: number;
  lastResult: string;
  sameResultStreak: number;
}

export interface Admission {
  admit: boolean;
  /** When held: a result to hand back to the model in place of running the call. */
  heldResult?: Record<string, unknown>;
}

export class ToolAdmission {
  private calls = new Map<string, Record_>();
  /**
   * Per page: the click being repeated and how many times in a row. Only
   * reads and waits in between keep the streak going; any other action
   * resets it, so "click to focus, hold a key, click to focus" is not a repeat.
   */
  private clickStreak = new Map<string, { key: string; count: number }>();
  private committed = new Set<string>();

  private key(toolName: string, args: Record<string, unknown>, page: string): string {
    return `${page}::${toolName}::${stableStringify(args)}`;
  }

  /** Decide whether a call may run. */
  admit(
    toolName: string,
    args: Record<string, unknown>,
    effect: Effect,
    page: string
  ): Admission {
    if (effect === "irreversible" && this.committed.has(this.key(toolName, args, page))) {
      return {
        admit: false,
        heldResult: {
          ok: false,
          held: true,
          error: `Not run again: this exact action already succeeded on this page. Repeating it could post, send or buy twice.`,
          do_next:
            "If it genuinely did not take effect, use a DIFFERENT control (for example click the Post button instead of repeating the keyboard shortcut), or move on to the next item.",
        },
      };
    }
    return { admit: true };
  }

  /**
   * Record the outcome of a call that ran. Returns guidance to append to the
   * model-visible result, or null when there is nothing to say.
   */
  observe(
    toolName: string,
    args: Record<string, unknown>,
    effect: Effect,
    page: string,
    result: unknown,
    failed: boolean
  ): string | null {
    const k = this.key(toolName, args, page);
    const rec = this.calls.get(k) || { failures: 0, successes: 0, lastResult: "", sameResultStreak: 0 };
    const digest = hash(result);
    rec.sameResultStreak = digest === rec.lastResult ? rec.sameResultStreak + 1 : 1;
    rec.lastResult = digest;
    if (failed) rec.failures++;
    else rec.successes++;
    this.calls.set(k, rec);
    if (this.calls.size > 5000) this.calls.delete(this.calls.keys().next().value as string);

    if (!failed && effect === "irreversible") this.committed.add(k);

    if (failed && rec.failures >= FAILURE_GUIDANCE_AT) {
      return `This exact call has now failed ${rec.failures} times on this page. Retrying it unchanged will not work: change the arguments, pick a different element, or take a different approach.`;
    }
    // Seen live: a game loads for ~25s behind an unchanged screen after its
    // PLAY button is clicked, and the agent clicked it again every 4s, for
    // ten minutes. The click worked every time; the repetition was the bug.
    if (CLICK_TOOLS.has(toolName)) {
      // Compare what was clicked, not how the model described it: seen live,
      // the same Reply button clicked three times, worded differently each
      // time ("...tweet about learning tech stack", "...'s tech stack tweet"),
      // never counted as a repeat.
      const { description: _d, ...target } = args;
      const ck = this.key(toolName, target, page);
      const streak = this.clickStreak.get(page);
      const count = !failed && streak?.key === ck ? streak.count + 1 : failed ? 0 : 1;
      this.clickStreak.set(page, { key: ck, count });
      if (count >= REPEATED_CLICK_GUIDANCE_AT) {
        return `You have now done this exact click ${count} times in a row on this page and it succeeded each time. If nothing seemed to happen, clicking again the same way is unlikely to help: slow pages, apps and games can take 30 seconds or more to respond, so wait longer and look again, or try something different.`;
      }
    } else if (effect !== "read" && !REPEAT_OK.has(toolName)) {
      this.clickStreak.delete(page);
    }
    if (
      !failed &&
      !REPEAT_OK.has(toolName) &&
      (effect === "read" || effect === "navigate") &&
      rec.sameResultStreak >= NO_PROGRESS_GUIDANCE_AT
    ) {
      return `This returned exactly the same result ${rec.sameResultStreak} times in a row on this page, so nothing is changing. Stop re-checking: act on what you already have, or move on.`;
    }
    return null;
  }
}

/** Did a tool result report failure? */
export function isFailure(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as any).ok === false;
}

function hash(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return crypto.createHash("sha1").update(s).digest("hex");
}

/** JSON with sorted keys, so {a,b} and {b,a} are the same call. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
