/**
 * The SDK: an autonomous browser agent in a few lines.
 *
 * ```ts
 * import { createAgent } from "slapify";
 *
 * const agent = createAgent({ stealth: true });
 * const run = await agent.run("Find the cheapest direct flight from SFO to JFK next Friday");
 * console.log(run.finalSummary);
 *
 * for await (const event of agent.stream("Check my inbox for anything urgent")) {
 *   if (event.type === "status_update") console.log(event.message);
 * }
 * ```
 *
 * It is a thin layer over runTask(): same harness, same tools, same safety
 * (admission, review, recovery, compaction). Defaults set here apply to
 * every run and can be overridden per run.
 */

import { runTask } from "./task/runner.js";
import { runFast, FastRunOptions, FastResult } from "./fast/agent.js";
import { listSessions, loadSession } from "./task/session.js";
import type { TaskEvent, TaskRunOptions, TaskSession } from "./task/types.js";
import type { SlapifyConfig } from "./types.js";

export type AgentRunOptions = Omit<TaskRunOptions, "goal" | "config">;

export interface AgentOptions extends AgentRunOptions {
  /** Inline config, laid over .slapify/config.yaml when there is one. */
  config?: Partial<SlapifyConfig>;
}

export interface Agent {
  /** Run a goal to completion (or until stopped, with `persistent`). */
  run(goal: string, options?: AgentRunOptions): Promise<TaskSession>;
  /** Continue an earlier session with its memory and context. */
  resume(sessionId: string, goal: string, options?: AgentRunOptions): Promise<TaskSession>;
  /**
   * Run a goal and iterate its events as they happen. The final session is
   * available afterwards from `result`.
   */
  stream(goal: string, options?: AgentRunOptions): AgentStream;
  /**
   * Ultrafast mode: Jev picks every step and the LLM only writes text. For
   * goals that are mostly clicking and filling in. Needs jev in the config.
   */
  fast(goal: string, options?: Omit<FastRunOptions, "goal" | "config">): Promise<FastResult>;
  /** Past sessions, newest first. */
  sessions(): TaskSession[];
  /** Load one past session. */
  session(id: string): TaskSession | null;
}

export interface AgentStream extends AsyncIterable<TaskEvent> {
  result: Promise<TaskSession>;
}

export function createAgent(defaults: AgentOptions = {}): Agent {
  const { config, ...runDefaults } = defaults;

  const run = (goal: string, options: AgentRunOptions = {}) => {
    const onEvent = (e: TaskEvent) => {
      runDefaults.onEvent?.(e);
      options.onEvent?.(e);
    };
    return runTask({ ...runDefaults, ...options, onEvent, goal, config });
  };

  return {
    run,
    resume: (sessionId, goal, options = {}) => run(goal, { ...options, sessionId }),
    stream(goal, options = {}) {
      const queue: TaskEvent[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const notify = () => {
        wake?.();
        wake = null;
      };
      const result = run(goal, {
        ...options,
        onEvent: (e) => {
          options.onEvent?.(e);
          queue.push(e);
          notify();
        },
      }).finally(() => {
        finished = true;
        notify();
      });
      // The iterator surfaces a failed run by throwing; `result` rejects too.
      result.catch(() => { });
      return {
        result,
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            if (finished) {
              await result;
              return;
            }
            await new Promise<void>((r) => (wake = r));
          }
        },
      };
    },
    fast: (goal, options = {}) => runFast({ ...options, goal, config }),
    sessions: () => listSessions(),
    session: (id) => loadSession(id),
  };
}
