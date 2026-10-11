/**
 * `codex` provider — runs the agent on a ChatGPT plan through the Codex
 * Responses endpoint, the way vercel-labs/fx does (Apache-2.0,
 * src/gateway/openai_codex.zig and responses_protocol.zig).
 *
 * Unlike `claude-cli`, nothing is spawned and nothing is bridged through the
 * prompt: tools are native Responses function tools, screenshots go in as
 * real image parts, and usage comes back from the API. Sign in once with
 * `slapify login codex`; see chatgpt-auth.ts for where the tokens live.
 *
 * The endpoint is undocumented. It requires `stream: true` and `store: false`
 * and rejects `max_output_tokens`, so this provider reads the SSE stream to
 * the end and hands the AI SDK one complete result.
 */

import crypto from "crypto";
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
} from "ai";
import { getChatGPTAuth, isLoopbackUrl, ORIGINATOR, ChatGPTAuth } from "./chatgpt-auth.js";

type GenerateResult = Awaited<ReturnType<LanguageModelV1["doGenerate"]>>;
type CallWarning = NonNullable<GenerateResult["warnings"]>[number];
type FinishReason = GenerateResult["finishReason"];
type Prompt = LanguageModelV1CallOptions["prompt"];

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";

export interface CodexSettings {
  /** Model slug from `slapify login codex` / the Codex models list, e.g. gpt-5.4-mini. */
  model?: string;
  /** Reasoning effort for reasoning models. Default: the model's own default. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Max seconds for one request, including the whole stream. Default 600. */
  timeoutSeconds?: number;
}

/** The Codex endpoints, or a loopback test server from the environment. */
function codexBase(): string {
  const override = process.env.SLAPIFY_CODEX_BASE_URL;
  if (!override) return CODEX_BASE;
  if (!isLoopbackUrl(override)) throw new Error("SLAPIFY_CODEX_BASE_URL must be a loopback http URL");
  return override.replace(/\/+$/, "");
}

function authHeaders(auth: ChatGPTAuth, sessionId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${auth.access_token}`,
    "chatgpt-account-id": auth.account_id,
    originator: ORIGINATOR,
    "OpenAI-Beta": "responses=experimental",
    ...(sessionId ? { "session-id": sessionId, "x-client-request-id": sessionId } : {}),
  };
}

export function createCodexModel(settings: CodexSettings = {}): LanguageModelV1 {
  return new CodexLanguageModel(settings);
}

/** Models the signed-in plan can use, best first. */
export async function listCodexModels(): Promise<Array<{ slug: string; contextWindow?: number; images: boolean }>> {
  const auth = await getChatGPTAuth();
  const res = await fetch(`${codexBase()}/models`, {
    headers: authHeaders(auth),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Codex models list failed with HTTP ${res.status}`);
  const json: any = await res.json();
  return (Array.isArray(json?.models) ? json.models : [])
    .filter((m: any) => m?.visibility === "list" && m?.supported_in_api !== false && typeof m?.slug === "string")
    .sort((a: any, b: any) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m: any) => ({
      slug: m.slug,
      contextWindow: Number(m.context_window) || undefined,
      images: Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : true,
    }));
}

function dataUrl(data: Uint8Array | URL | string, mimeType = "image/png"): string {
  if (data instanceof URL) return data.toString();
  if (typeof data === "string") return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
  return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

function stringify(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

/** LanguageModelV1 prompt → Responses `instructions` + `input` items. */
export function toResponsesInput(prompt: Prompt): { instructions: string; input: unknown[] } {
  const system: string[] = [];
  const input: unknown[] = [];
  for (const msg of prompt as any[]) {
    switch (msg.role) {
      case "system":
        if (msg.content) system.push(msg.content);
        break;
      case "user": {
        const content = (msg.content as any[]).flatMap((p): unknown[] =>
          p.type === "text"
            ? [{ type: "input_text", text: p.text }]
            : p.type === "image"
              ? [{ type: "input_image", detail: "auto", image_url: dataUrl(p.image, p.mimeType) }]
              : []
        );
        if (content.length) input.push({ type: "message", role: "user", content });
        break;
      }
      case "assistant":
        for (const p of msg.content as any[]) {
          if (p.type === "text" && p.text) {
            input.push({
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: p.text }],
            });
          } else if (p.type === "tool-call") {
            input.push({ type: "function_call", call_id: p.toolCallId, name: p.toolName, arguments: stringify(p.args) });
          }
        }
        break;
      case "tool":
        for (const p of msg.content as any[]) {
          // Tool results that carry images (screenshots with vision on) go in
          // as a content array, exactly like fx does for its own tools.
          const parts = Array.isArray(p.content) ? (p.content as any[]) : null;
          const output = parts
            ? parts.flatMap((c): unknown[] =>
                c.type === "text"
                  ? [{ type: "input_text", text: c.text }]
                  : c.type === "image"
                    ? [{ type: "input_image", detail: "auto", image_url: dataUrl(c.data, c.mimeType) }]
                    : []
              )
            : stringify(p.result);
          input.push({ type: "function_call_output", call_id: p.toolCallId, output });
        }
        break;
    }
  }
  return { instructions: system.join("\n\n") || "You are a helpful assistant.", input };
}

function toResponsesTools(mode: LanguageModelV1CallOptions["mode"]): { tools?: unknown[]; tool_choice?: unknown } {
  const fn = (t: any) => ({
    type: "function",
    name: t.name,
    description: t.description || "",
    parameters: t.parameters,
    strict: false,
  });
  if (mode.type === "object-tool") {
    return { tools: [fn(mode.tool)], tool_choice: { type: "function", name: mode.tool.name } };
  }
  if (mode.type !== "regular" || !mode.tools?.length) return {};
  const choice = mode.toolChoice;
  return {
    tools: mode.tools.filter((t: any) => t.type === "function").map(fn),
    tool_choice: !choice
      ? "auto"
      : choice.type === "tool"
        ? { type: "function", name: choice.toolName }
        : choice.type,
  };
}

interface ParsedResponse {
  text: string;
  toolCalls: Array<{ toolCallType: "function"; toolCallId: string; toolName: string; args: string }>;
  usage: { promptTokens: number; completionTokens: number };
  incomplete?: string;
}

function spell(code: unknown): string {
  return String(code).replace(/_/g, " ");
}

function textOf(item: any): string {
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}

/**
 * Reduce a Responses SSE stream to one result. The `response.completed`
 * output is authoritative when present; the streamed items are the fallback.
 */
export async function readResponsesStream(body: ReadableStream<Uint8Array>): Promise<ParsedResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";
  const deltas = new Map<number, string>();
  const done = new Map<number, any>();
  let final: any = null;
  let incomplete: string | undefined;

  const handle = (ev: any) => {
    switch (ev?.type) {
      case "response.output_text.delta":
        deltas.set(ev.output_index ?? 0, (deltas.get(ev.output_index ?? 0) || "") + (ev.delta || ""));
        break;
      case "response.output_item.done":
        done.set(ev.output_index ?? done.size, ev.item);
        break;
      case "response.completed":
        final = ev.response;
        break;
      case "response.incomplete":
        final = ev.response;
        incomplete = ev.response?.incomplete_details?.reason || "incomplete";
        break;
      // Codes like usage_limit_reached are spelled out so the recovery
      // policy recognises them ("usage limit", "rate limit") and waits.
      case "response.failed": {
        const err = ev.response?.error;
        throw new Error(`Codex response failed${err?.code ? ` (${spell(err.code)})` : ""}: ${err?.message || "unknown error"}`);
      }
      case "error":
        throw new Error(`Codex error${ev.code ? ` (${spell(ev.code)})` : ""}: ${ev.message || JSON.stringify(ev)}`);
    }
  };

  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(buf[sep] === "\r" ? sep + 4 : sep + 2);
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      handle(ev);
    }
    if (end) break;
  }

  const items: any[] = Array.isArray(final?.output) && final.output.length
    ? final.output
    : [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const messages = items.filter((i) => i?.type === "message").map(textOf).filter(Boolean);
  const text = messages.length ? messages.join("\n\n") : [...deltas.values()].join("");
  const toolCalls = items
    .filter((i) => i?.type === "function_call" && typeof i.name === "string")
    .map((i) => ({
      toolCallType: "function" as const,
      toolCallId: i.call_id || i.id || crypto.randomUUID(),
      toolName: i.name,
      args: typeof i.arguments === "string" && i.arguments.trim() ? i.arguments : "{}",
    }));
  if (!final && !text && toolCalls.length === 0) {
    throw new Error("Codex stream ended without a response (timeout or dropped connection)");
  }
  return {
    text,
    toolCalls,
    usage: {
      promptTokens: Number(final?.usage?.input_tokens) || 0,
      completionTokens: Number(final?.usage?.output_tokens) || 0,
    },
    incomplete,
  };
}

class CodexLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = "v1" as const;
  readonly provider = "codex";
  readonly modelId: string;
  readonly defaultObjectGenerationMode = "tool" as const;
  readonly supportsImageUrls = false;
  private readonly settings: CodexSettings;
  /** One session per model instance, like a Codex conversation. */
  private readonly sessionId = crypto.randomUUID();

  constructor(settings: CodexSettings) {
    this.settings = settings;
    this.modelId = settings.model || DEFAULT_CODEX_MODEL;
  }

  async doGenerate(options: LanguageModelV1CallOptions) {
    const warnings: CallWarning[] = [];
    // The Codex endpoint rejects max_output_tokens, and reasoning models
    // reject sampling settings, so these are dropped with a warning.
    for (const setting of ["maxTokens", "temperature", "topP", "frequencyPenalty", "presencePenalty"] as const) {
      if ((options as any)[setting] != null) warnings.push({ type: "unsupported-setting", setting });
    }

    const { instructions, input } = toResponsesInput(options.prompt);
    let extraInstructions = "";
    if (options.mode.type === "object-json") {
      extraInstructions = "\n\nReply with a single JSON object only." +
        (options.mode.schema ? ` It must match this JSON schema: ${JSON.stringify(options.mode.schema)}` : "");
    }
    const body = {
      model: this.modelId,
      store: false,
      stream: true,
      instructions: instructions + extraInstructions,
      input,
      ...toResponsesTools(options.mode),
      parallel_tool_calls: true,
      ...(this.settings.reasoningEffort
        ? { reasoning: { effort: this.settings.reasoningEffort === "minimal" ? "low" : this.settings.reasoningEffort } }
        : {}),
    };

    const parsed = await this.send(body, options.abortSignal);
    const finishReason: FinishReason = parsed.toolCalls.length
      ? "tool-calls"
      : parsed.incomplete
        ? parsed.incomplete.includes("content") ? "content-filter" : "length"
        : "stop";
    return {
      text: parsed.text || undefined,
      toolCalls: parsed.toolCalls.length ? parsed.toolCalls : undefined,
      finishReason,
      usage: parsed.usage,
      rawCall: { rawPrompt: input, rawSettings: { model: this.modelId, instructions } },
      warnings,
    };
  }

  private async send(body: unknown, abortSignal?: AbortSignal): Promise<ParsedResponse> {
    const timeoutMs = (this.settings.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      // An expired or revoked access token gets one forced refresh.
      const auth = await getChatGPTAuth({ forceRefresh: attempt > 0 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Codex request timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      const onAbort = () => controller.abort(abortSignal?.reason);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(`${codexBase()}/responses`, {
          method: "POST",
          headers: {
            ...authHeaders(auth, this.sessionId),
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: payload,
          signal: controller.signal,
        });
        if (res.status === 401 && attempt === 0) {
          await res.body?.cancel().catch(() => {});
          continue;
        }
        if (!res.ok || !res.body) {
          const detail = (await res.text().catch(() => "")).slice(0, 400);
          const hint =
            res.status === 401 || res.status === 403
              ? " Run `slapify login codex` to sign in again."
              : res.status === 429
                ? " (rate limit or plan usage limit)"
                : "";
          throw new Error(`Codex HTTP ${res.status}: ${detail}${hint}`);
        }
        return await readResponsesStream(res.body);
      } catch (err: any) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
        throw err;
      } finally {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
      }
    }
  }

  async doStream(options: LanguageModelV1CallOptions) {
    // The whole stream is read in doGenerate; replay it as one chunk.
    const result = await this.doGenerate(options);
    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      start(controller) {
        if (result.text) controller.enqueue({ type: "text-delta", textDelta: result.text });
        for (const tc of result.toolCalls || []) controller.enqueue({ type: "tool-call", ...tc });
        controller.enqueue({ type: "finish", finishReason: result.finishReason, usage: result.usage });
        controller.close();
      },
    });
    return { stream, rawCall: result.rawCall, warnings: result.warnings };
  }
}
