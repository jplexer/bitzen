import type { CredentialSource } from "../auth.ts";
import { numberOrNull, object, string } from "../validate.ts";
import type { Completion, CompletionRequest, Message, ModelInfo, Provider } from "./types.ts";
import { readOpenRouterStream } from "./stream.ts";

export type FetchTransport = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export class OpenRouter implements Provider {
  readonly id = "openrouter";

  constructor(
    private readonly credentials: CredentialSource,
    private readonly options: { baseUrl?: string; fetch?: FetchTransport; timeoutMs?: number } = {},
  ) {}

  async listModels(parentSignal: AbortSignal): Promise<ModelInfo[]> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.min(this.options.timeoutMs ?? 15_000, 15_000))]);
    const token = await this.credentials.getToken(signal);
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl ?? "https://openrouter.ai/api/v1"}/models`, {
      method: "GET", headers: { Authorization: `Bearer ${token}`, "X-Title": "Bitzen" }, signal,
    });
    if (!response.ok) {
      const detail = safeErrorMessage(await response.json().catch(() => null), token);
      throw new Error(`OpenRouter catalogue returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    const body = object(await response.json(), "model catalogue");
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalogue.");
    const result: ModelInfo[] = [], seen = new Set<string>();
    for (const raw of body.data) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id.trim() || seen.has(raw.id)) continue;
      if (!Array.isArray(raw.supported_parameters) || !raw.supported_parameters.includes("tools")) continue;
      if (!Array.isArray(raw.architecture?.input_modalities) || !raw.architecture.input_modalities.includes("text") || !Array.isArray(raw.architecture?.output_modalities) || !raw.architecture.output_modalities.includes("text")) continue;
      seen.add(raw.id);
      const price = (value: unknown) => {
        if (typeof value !== "number" && typeof value !== "string" || value === "") return undefined;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 && Number.isFinite(number * 1e6) ? number * 1e6 : undefined;
      };
      result.push({ id: raw.id, name: typeof raw.name === "string" ? raw.name : raw.id,
        contextLength: typeof raw.context_length === "number" && Number.isFinite(raw.context_length) && raw.context_length > 0 ? raw.context_length : undefined,
        inputUsdPerMillion: price(raw.pricing?.prompt), outputUsdPerMillion: price(raw.pricing?.completion),
      });
    }
    return result;
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.options.timeoutMs ?? 120_000)]);
    const token = await this.credentials.getToken(signal);
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Title": "Bitzen" },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toWireMessage),
          tools: request.tools.map(tool => ({ type: "function", function: tool })),
          // Anthropic endpoints advertise max_tokens, even though the generic
          // schema prefers max_completion_tokens. Strict routing uses metadata.
          max_tokens: request.maxOutputTokens,
          stream: Boolean(request.onProgress),
          // Execute tools sequentially in Agent; do not require endpoint support
          // for parallel_tool_calls merely to control local execution order.
          session_id: request.sessionId,
          provider: { require_parameters: true },
        }),
        signal,
      },
    );
    if (!response.ok) {
      const detail = safeErrorMessage(await response.json().catch(() => null), token);
      throw new Error(`OpenRouter returned HTTP ${response.status} for ${request.model}${detail ? `: ${detail}` : "; check your key, model, and account limits."}`);
    }
    const payload = request.onProgress && response.headers.get("content-type")?.includes("text/event-stream")
      ? await readOpenRouterStream(response, request, signal, value => `OpenRouter returned an inference error: ${safeErrorMessage(value, token) ?? "stream failed"}`)
      : await response.json();
    const body = object(payload, "OpenRouter response");
    if (body.error) {
      const detail = safeErrorMessage(body, token);
      throw new Error(`OpenRouter returned an inference error${detail ? `: ${detail}` : "."}`);
    }
    if (!Array.isArray(body.choices) || body.choices.length === 0) throw new Error("OpenRouter returned no choices.");
    const choice = object(body.choices[0], "choice");
    const raw = object(choice.message, "assistant message");
    if (raw.role !== "assistant") throw new Error("Expected an assistant message.");
    if (raw.content !== null && raw.content !== undefined && typeof raw.content !== "string") {
      throw new Error("Expected text content from OpenRouter.");
    }
    const calls = raw.tool_calls ?? [];
    if (!Array.isArray(calls)) throw new Error("Invalid tool calls from OpenRouter.");
    const seen = new Set<string>();
    const toolCalls = calls.map(value => {
      const call = object(value, "tool call");
      if (call.type !== "function") throw new Error("Unsupported tool call type.");
      const fn = object(call.function, "tool function");
      const id = string(call.id, "tool call id");
      if (seen.has(id)) throw new Error("Duplicate tool call id.");
      seen.add(id);
      return { id, name: string(fn.name, "tool name"), arguments: string(fn.arguments, "tool arguments", true) };
    });
    const usage = body.usage ? object(body.usage, "usage") : {};
    const inputDetails = usage.prompt_tokens_details ? object(usage.prompt_tokens_details, "input usage") : {};
    const outputDetails = usage.completion_tokens_details ? object(usage.completion_tokens_details, "output usage") : {};
    const state: Record<string, unknown> = {};
    // Preserve reasoning signatures across tool turns (e.g. Gemini).
    for (const key of ["reasoning_details", "reasoning"]) {
      if (raw[key] !== undefined) state[key] = raw[key];
    }
    return {
      id: string(body.id, "completion id"),
      message: { role: "assistant", content: raw.content as string | null ?? null, toolCalls, providerState: { openrouter: state } },
      finishReason: string(choice.finish_reason, "finish reason"),
      usage: {
        inputTokens: numberOrNull(usage.prompt_tokens),
        outputTokens: numberOrNull(usage.completion_tokens),
        cachedInputTokens: numberOrNull(inputDetails.cached_tokens),
        cacheWriteTokens: numberOrNull(inputDetails.cache_write_tokens),
        reasoningTokens: numberOrNull(outputDetails.reasoning_tokens),
        costUsd: numberOrNull(usage.cost),
      },
    };
  }
}

function safeErrorMessage(body: unknown, token: string): string | undefined {
  if (!body || typeof body !== "object") return;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return;
  const message = (error as Record<string, unknown>).message;
  if (typeof message !== "string") return;
  // Print only the documented message, never raw metadata or response bodies.
  return message.split(token).join("[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 600);
}

function toWireMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.content };
  if (message.role !== "assistant") return { role: message.role, content: message.content };
  return {
    ...message.providerState?.openrouter as Record<string, unknown> | undefined,
    role: "assistant",
    content: message.content,
    ...(message.toolCalls.length ? {
      tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    } : {}),
  };
}
