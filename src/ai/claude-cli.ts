import { spawn } from "child_process";
import os from "os";
import path from "path";
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
} from "ai";

// Not re-exported by `ai` — derive from the LanguageModelV1 interface itself
type GenerateResult = Awaited<ReturnType<LanguageModelV1["doGenerate"]>>;
type CallWarning = NonNullable<GenerateResult["warnings"]>[number];
type FinishReason = GenerateResult["finishReason"];

/**
 * Claude Code CLI provider — runs prompts through the locally installed
 * `claude` binary (`claude -p`) instead of the Anthropic HTTP API.
 *
 * Why: `claude -p` uses the user's Claude Code login (Pro/Max subscription
 * OAuth), so slapify works with zero API key and bills against the user's
 * plan usage instead of pay-per-token API credits.
 *
 * How tool calling works: the AI SDK expects native tool-call support, but
 * `claude -p` only returns text. We bridge that with prompt-based tool
 * calling — tool JSON schemas are embedded in the system prompt, the model
 * is instructed to answer with a `{"tool_calls": [...]}` JSON object when it
 * wants to act, and we parse that back into LanguageModelV1 tool calls.
 */

// Structural equivalents of @ai-sdk/provider's tool types (not re-exported by `ai`)
interface CliToolCall {
  toolCallType: "function";
  toolCallId: string;
  toolName: string;
  args: string;
}

interface CliToolDef {
  type: "function";
  name: string;
  description?: string;
  parameters: unknown;
}

export interface ClaudeCliSettings {
  /** Model alias or full id passed to `claude --model` (e.g. "sonnet", "opus", "haiku"). Omit to use the CLI default. */
  model?: string;
  /** Path to the claude binary. Defaults to "claude" resolved from PATH. */
  cliPath?: string;
  /** Max seconds to wait for one CLI call before killing it. Default 600. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 600;

// 64MB — page snapshots and fetch bodies can make responses large
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export function createClaudeCliModel(
  settings: ClaudeCliSettings = {}
): LanguageModelV1 {
  return new ClaudeCliLanguageModel(settings);
}

class ClaudeCliLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = "v1" as const;
  readonly provider = "claude-cli";
  readonly modelId: string;
  readonly defaultObjectGenerationMode = "json" as const;

  private settings: ClaudeCliSettings;

  constructor(settings: ClaudeCliSettings) {
    this.settings = settings;
    this.modelId = settings.model || "default";
  }

  async doGenerate(options: LanguageModelV1CallOptions) {
    const warnings: CallWarning[] = [];
    if (options.maxTokens != null) {
      warnings.push({ type: "unsupported-setting", setting: "maxTokens" });
    }
    if (options.temperature != null) {
      warnings.push({ type: "unsupported-setting", setting: "temperature" });
    }

    const { systemPrompt, transcript } = buildCliPrompt(options);

    const raw = await this.runCli(systemPrompt, transcript, options.abortSignal);

    const { text, toolCalls } = extractToolCalls(raw.resultText);

    const finishReason: FinishReason =
      toolCalls.length > 0 ? "tool-calls" : "stop";

    return {
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage: raw.usage,
      rawCall: {
        rawPrompt: transcript,
        rawSettings: { model: this.settings.model, systemPrompt },
      },
      warnings,
    };
  }

  async doStream(options: LanguageModelV1CallOptions) {
    // The CLI call is inherently non-streaming for our purposes — run
    // doGenerate and replay the result as a single-chunk stream.
    const result = await this.doGenerate(options);

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      start(controller) {
        if (result.text) {
          controller.enqueue({ type: "text-delta", textDelta: result.text });
        }
        for (const tc of result.toolCalls || []) {
          controller.enqueue({ type: "tool-call", ...tc });
        }
        controller.enqueue({
          type: "finish",
          finishReason: result.finishReason,
          usage: result.usage,
        });
        controller.close();
      },
    });

    return { stream, rawCall: result.rawCall, warnings: result.warnings };
  }

  private runCli(
    systemPrompt: string,
    transcript: string,
    abortSignal?: AbortSignal
  ): Promise<{
    resultText: string;
    usage: { promptTokens: number; completionTokens: number };
  }> {
    const bin = this.settings.cliPath || "claude";
    const args = [
      "-p",
      "--output-format",
      "json",
      // Disable Claude Code's own agentic tools — we only want the LLM turn.
      // NB: do NOT enable Read here to get vision. Tested: with real tools
      // available the model stops trusting the prompt-simulated tool protocol
      // above and answers in prose, which breaks every turn. Vision for this
      // provider goes through a separate one-shot call — see describeImage().
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--system-prompt",
      systemPrompt,
    ];
    if (this.settings.model) {
      args.push("--model", this.settings.model);
    }

    const timeoutMs =
      (this.settings.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;

    return new Promise((resolve, reject) => {
      // Strip ANTHROPIC_API_KEY so the CLI always uses its logged-in
      // subscription auth — that's the entire point of this provider.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const child = spawn(bin, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(
            new Error(
              `claude CLI timed out after ${timeoutMs / 1000}s. Increase timeoutSeconds in your llm config if the task legitimately needs longer.`
            )
          );
        }
      }, timeoutMs);

      const onAbort = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error("claude CLI call aborted"));
        }
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_STDOUT_BYTES) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            reject(new Error("claude CLI response exceeded 64MB"));
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        if (err.code === "ENOENT") {
          reject(
            new Error(
              `claude CLI not found at '${bin}'. Install Claude Code (https://claude.com/claude-code) and log in with your subscription, or set cli_path in your llm config.`
            )
          );
        } else {
          reject(err);
        }
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);

        if (code !== 0) {
          reject(
            new Error(
              `claude CLI exited with code ${code}: ${(stderr || stdout).slice(0, 500)}`
            )
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          if (parsed.is_error) {
            reject(
              new Error(`claude CLI error: ${String(parsed.result).slice(0, 500)}`)
            );
            return;
          }
          resolve({
            resultText: typeof parsed.result === "string" ? parsed.result : "",
            usage: {
              promptTokens: parsed.usage?.input_tokens ?? 0,
              completionTokens: parsed.usage?.output_tokens ?? 0,
            },
          });
        } catch {
          reject(
            new Error(
              `Failed to parse claude CLI JSON output: ${stdout.slice(0, 500)}`
            )
          );
        }
      });

      // The CLI can exit before it finishes reading stdin (bad flag, auth
      // failure, early abort). Writing to that closed pipe emits an 'error'
      // event on the socket, and an unhandled one takes the whole process
      // down — which killed long-running tasks with a bare "write EPIPE" and
      // no recoverable error anywhere. Swallow it here: the real failure
      // still surfaces through the exit code and stderr below.
      child.stdin.on("error", () => { });
      try {
        child.stdin.write(transcript);
        child.stdin.end();
      } catch {
        // Pipe already gone — handled by the close/error handlers.
      }
    });
  }
}

// ─── Prompt serialization ─────────────────────────────────────────────────────

function buildCliPrompt(options: LanguageModelV1CallOptions): {
  systemPrompt: string;
  transcript: string;
} {
  const systemParts: string[] = [];
  const transcriptParts: string[] = [];

  for (const message of options.prompt) {
    switch (message.role) {
      case "system":
        systemParts.push(message.content);
        break;

      case "user": {
        const text = message.content
          .map((part) =>
            part.type === "text"
              ? part.text
              : "[image omitted — this provider reads images via describeImage()]"
          )
          .join("\n");
        transcriptParts.push(`[USER]\n${text}`);
        break;
      }

      case "assistant": {
        const chunks: string[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            chunks.push(part.text);
          } else if (part.type === "tool-call") {
            chunks.push(
              `<tool_call id="${part.toolCallId}" name="${part.toolName}">${JSON.stringify(part.args)}</tool_call>`
            );
          }
        }
        transcriptParts.push(`[ASSISTANT]\n${chunks.join("\n")}`);
        break;
      }

      case "tool": {
        const chunks = message.content.map((part) => {
          const result =
            typeof part.result === "string"
              ? part.result
              : JSON.stringify(part.result);
          return `<tool_result id="${part.toolCallId}" name="${part.toolName}">${result}</tool_result>`;
        });
        transcriptParts.push(`[TOOL RESULTS]\n${chunks.join("\n")}`);
        break;
      }
    }
  }

  // Tool-calling / output-format instructions live in the system prompt
  if (options.mode.type === "regular" && options.mode.tools?.length) {
    systemParts.push(buildToolInstructions(options.mode.tools as CliToolDef[]));
  } else if (options.mode.type === "object-json") {
    systemParts.push(
      "Respond with ONLY a valid JSON object. No prose, no markdown fences."
    );
  } else if (options.mode.type === "object-tool") {
    const tool = options.mode.tool as CliToolDef;
    systemParts.push(
      buildToolInstructions([tool]) +
      `\nYou MUST call the '${tool.name}' tool — a plain text answer is not acceptable.`
    );
  }

  transcriptParts.push(
    "[ASSISTANT]\n(respond now — remember: to use tools, output ONLY the tool_calls JSON object)"
  );

  return {
    systemPrompt: systemParts.join("\n\n"),
    transcript: transcriptParts.join("\n\n"),
  };
}

/** Directory the one-shot vision call is allowed to read from. */
const VISION_TMP_DIR = path.join(os.tmpdir(), "slapify-vision");

/**
 * Describe an image using a separate one-shot `claude -p` call with the Read
 * tool enabled.
 *
 * `claude -p` accepts no inline image data, but it can read an image off
 * disk. That needs the Read tool — and enabling Read on the agent's own turns
 * makes the model abandon the prompt-simulated tool protocol this provider
 * runs on (verified: it answers in prose instead). So the image is described
 * by an isolated call whose only job is to look, and the resulting text goes
 * back to the agent as an ordinary tool result.
 */
export async function describeImage(
  imagePath: string | string[],
  question: string,
  opts: { cliPath?: string; model?: string; timeoutSeconds?: number } = {}
): Promise<string> {
  const bin = opts.cliPath || "claude";
  const images = (Array.isArray(imagePath) ? imagePath : [imagePath]).map((p) => path.resolve(p));
  // Read is confined to directories the CLI is told about.
  const dirs = [VISION_TMP_DIR, ...new Set(images.map((p) => path.dirname(p)))];
  const lead =
    images.length === 1
      ? `Look at the image at ${images[0]} using your Read tool.`
      : `Look at these ${images.length} images in order using your Read tool: ${images.map((p, i) => `(${i + 1}) ${p}`).join(", ")}.`;
  // Frame the request: without it, a screenshot of a crime game with a
  // question about finding a car and avoiding police was refused as "evading
  // law enforcement". The images are screens a browser agent is operating.
  const frame =
    "These are screenshots from a browser automation session (a website, web app or video game shown in the browser). " +
    "Describe what is on screen factually, for the agent operating it.";
  const args = [
    "-p",
    `${frame} ${lead} ${question}`,
    "--output-format",
    "json",
    "--allowedTools",
    "Read",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  for (const dir of dirs) args.push("--add-dir", dir);
  if (opts.model) args.push("--model", opts.model);

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      (opts.timeoutSeconds || 180) * 1000
    );
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        const text = (parsed.result || "").trim();
        if (!text) throw new Error("empty result");
        resolve(text);
      } catch {
        reject(
          new Error(
            `Vision call failed: ${err.trim() || out.trim().slice(0, 200) || "no output"}`
          )
        );
      }
    });
  });
}

function buildToolInstructions(tools: CliToolDef[]): string {
  const defs = tools
    .map((t) =>
      JSON.stringify(
        { name: t.name, description: t.description, parameters: t.parameters },
        null,
        1
      )
    )
    .join("\n");

  return `## TOOL CALLING PROTOCOL

You have access to the following tools (JSON schema per tool):

${defs}

To call one or more tools, your ENTIRE response must be a single JSON object in exactly this shape (no markdown fences, no text before or after):

{"tool_calls": [{"name": "tool_name", "arguments": { ... }}]}

Rules:
- "arguments" must match the tool's parameters schema.
- You may include multiple tool calls in the array; they run in order.
- When you are completely finished and no tool call is needed, respond with plain text instead (your final answer or summary).
- Never mix prose and the tool_calls JSON in one response.
- The conversation transcript shows your earlier tool calls as <tool_call> tags and their results as <tool_result> tags.`;
}

// ─── Tool call extraction ─────────────────────────────────────────────────────

export function extractToolCalls(raw: string): {
  text: string;
  toolCalls: CliToolCall[];
} {
  let text = raw.trim();

  // Strip a single wrapping markdown fence if present
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  const idx = text.indexOf('{"tool_calls"');
  const altIdx = idx === -1 ? text.indexOf('{ "tool_calls"') : idx;
  if (altIdx === -1) {
    return { text: raw.trim(), toolCalls: [] };
  }

  const jsonStr =
    extractBalancedJson(text, altIdx) ??
    repairTruncatedJson(text.slice(altIdx));
  if (!jsonStr) {
    return { text: raw.trim(), toolCalls: [] };
  }

  try {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Balanced-looking but still invalid (e.g. cut inside the last object).
      const repaired = repairTruncatedJson(text.slice(altIdx));
      if (!repaired) throw new Error("unparseable");
      parsed = JSON.parse(repaired);
    }
    if (!Array.isArray(parsed.tool_calls)) {
      return { text: raw.trim(), toolCalls: [] };
    }

    const toolCalls: CliToolCall[] = parsed.tool_calls
      .filter((tc: any) => tc && typeof tc.name === "string")
      .map((tc: any, i: number) => ({
        toolCallType: "function" as const,
        toolCallId: `call_${Date.now()}_${i}`,
        toolName: tc.name,
        args: JSON.stringify(tc.arguments ?? {}),
      }));

    // Parsed, but nothing usable came out (e.g. a call cut off before its
    // name). Hand back the raw text: returning only the text before the JSON
    // would be an empty string, and the runner would read that as a finished
    // task instead of a broken attempt to act.
    if (toolCalls.length === 0) {
      return { text: raw.trim(), toolCalls: [] };
    }
    const before = text.slice(0, altIdx).trim();
    return { text: before, toolCalls };
  } catch {
    return { text: raw.trim(), toolCalls: [] };
  }
}

/**
 * Close a JSON object that was cut off mid-emission.
 *
 * `claude -p` can stop mid-response, leaving tool-call JSON one or two
 * brackets short. Without repair the whole turn parses as plain text, which
 * for a never-ending task reads as "the agent chose to stop" and silently
 * completes it. Appending the missing closers recovers the calls.
 */
export function repairTruncatedJson(fragment: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of fragment) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (stack.length === 0) return null;

  let out = fragment;
  // Cut in the middle of a string value: close the quote first. Anything
  // after the cut is lost, but the calls decoded so far are recoverable,
  // which beats discarding the whole turn.
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';

  // A dangling separator would still be invalid once brackets are closed.
  const tail = out.replace(/\s+$/, "");
  if (tail.endsWith(",")) out = tail.slice(0, -1);
  else if (tail.endsWith(":")) out = tail + "null";

  return (
    out +
    stack
      .reverse()
      .map((c) => (c === "{" ? "}" : "]"))
      .join("")
  );
}

/** Extract a balanced JSON object starting at `start`, respecting strings/escapes. */
function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
