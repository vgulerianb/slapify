import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(__dirname, "rules");

// Cache rule files in memory — loaded once at module init, not per-iteration.
const RULE_CACHE = new Map<string, string>();

function rule(filename: string): string {
    if (!RULE_CACHE.has(filename)) {
        RULE_CACHE.set(filename, readFileSync(join(RULES_DIR, filename), "utf-8"));
    }
    return RULE_CACHE.get(filename)!;
}

import { PluginsConfig } from "../types.js";

/**
 * Build a system prompt for the task agent by combining the base rules
 * with relevant fragments detected from the goal string.
 *
 * This keeps the initial context window lean for simple tasks (e.g. data lookup
 * only needs ~800 tokens vs the old 4,500-token monolith) while preserving full
 * functionality for complex tasks by injecting the appropriate rule blocks.
 */
export function buildSystemPrompt(
    goal: string,
    schema?: object,
    plugins?: PluginsConfig,
    configDir?: string,
    vision?: boolean,
    jev?: boolean,
    persistent?: boolean
): string {
    const g = goal.toLowerCase();
    const fragments: string[] = [rule("base.md")];

    // ── Vision ─────────────────────────────────────────────────────────────────
    // Only when screenshots are actually attached as images; otherwise telling
    // the agent it can see would be a lie.
    if (vision) {
        fragments.push(rule("vision.md"));
    }

    // ── Jev ────────────────────────────────────────────────────────────────────
    // Only when the find_element / check tools are actually registered.
    if (jev) {
        fragments.push(rule("jev.md"));
    }

    // ── Persistent ────────────────────────────────────────────────────────────
    if (persistent) {
        fragments.push(rule("persistent.md"));
    }

    // ── Monitoring / scheduling ────────────────────────────────────────────────
    // Detected whenever the task is meant to run repeatedly or watch for events.
    if (
        /monitor|keep checking|keep watching|wait for reply|keep me updated|feel free to engage|notify when|let me know when|ongoing|until .*(happens|stops|replies|approved|resolves)|every \d+ (minute|hour|day)|daily at|check hourly|schedule|cron|recurring|spaces? (them )?out/.test(g)
    ) {
        fragments.push(rule("monitoring.md"));
    }

    // ── Authentication ─────────────────────────────────────────────────────────
    // Injected when task mentions logging in, accounts, or social platforms.
    if (
        /login|log in|sign in|account|credential|twitter|linkedin|instagram|facebook|gmail|github|password|authenticate|session/.test(g)
    ) {
        fragments.push(rule("auth.md"));
    }

    // ── CAPTCHA / Obstacles ────────────────────────────────────────────────────
    // Injected for any browser-based task where bot protection is likely.
    if (
        /captcha|cloudflare|bot|blocked|interact|navigate|browser|click|fill|form|post|tweet|reply|comment|search/.test(g)
    ) {
        fragments.push(rule("captcha.md"));
    }

    // ── Parallel batching ──────────────────────────────────────────────────────
    // Injected for any multi-step interactive task where batching adds value.
    if (
        /interact|search|browse|navigate|fill|click|post|tweet|reply|comment|form|login|log in|sign in/.test(g)
    ) {
        fragments.push(rule("batching.md"));
    }

    // ── Data lookup ────────────────────────────────────────────────────────────
    // Injected for factual data retrieval tasks.
    if (
        /price|news|weather|rate|stock|fact|data|api|fetch|lookup|find out|what is|how much|current|latest/.test(g)
    ) {
        fragments.push(rule("data_lookup.md"));
    }

    // ── Performance audit ─────────────────────────────────────────────────────
    // Injected only when the task explicitly asks for perf / audit / speed checks.
    if (
        /perf|audit|lighthouse|speed|score|lcp|fcp|cls|ttfb|core web vitals|page health|slow|fast/.test(g)
    ) {
        fragments.push(rule("perf_audit.md"));
    }

    let prompt = fragments.join("\n\n");

    // ── Structured output ──────────────────────────────────────────────────────
    if (schema) {
        prompt +=
            `\n\n## Structured Output Schema\nThe user expects output conforming to this JSON schema:\n` +
            "```json\n" +
            JSON.stringify(schema, null, 2) +
            "\n```\n" +
            `Use the **write_output** tool to write conforming data whenever you have results to record ` +
            `(after each scheduled run, after collecting data, or before calling done). ` +
            `For array schemas, each write_output call appends new entries. ` +
            `For object schemas, each call updates the object. Always call write_output before done() when a schema is provided.`;
    }

    // ── User Plugins ───────────────────────────────────────────────────────────
    if (plugins?.rules && configDir) {
        for (const rulePath of plugins.rules) {
            try {
                // Ensure we use an absolute path resolved relative to the .slapify dir
                const absolutePath = require("path").resolve(configDir, rulePath);
                // Load straight from disk. We don't cache these the same way we cache internal
                // rules because users might be actively editing them while the agent is running.
                const content = readFileSync(absolutePath, "utf-8");
                prompt += `\n\n## Custom User Rule: ${rulePath}\n${content}`;
            } catch (err: any) {
                console.error(`[Slapify] Warning: Failed to load user plugin rule "${rulePath}": ${err.message}`);
            }
        }
    }

    return prompt;
}
