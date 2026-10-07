import { describe, expect, test } from "bun:test";
import { EnvironmentApiKey } from "../src/auth.ts";
import { OpenRouter, type FetchTransport } from "../src/providers/openrouter.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { CompletionRequest } from "../src/providers/types.ts";
import { signal } from "./helpers.ts";

const request = (): CompletionRequest => ({
  model: "test/model", sessionId: "run:lead", maxOutputTokens: 1024, signal: signal(),
  messages: [{ role: "system", content: "You code." }, { role: "user", content: "Fix it." }],
  tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
});

const body = () => ({
  id: "generation-1", choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null,
    tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-signature", id: "signature-1" }],
  } }],
  usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.004, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 20 } },
});

describe("OpenRouter adapter", () => {
  test("normalizes tools and usage; preserves reasoning signatures and resolves fresh credentials", async () => {
    const sent: { headers: Headers; body: Record<string, any> }[] = [];
    let credentialReads = 0;
    const adapter = new OpenRouter({ kind: "oauth", getToken: async () => `token-${++credentialReads}` }, {
      fetch: (async (url, options) => {
        expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
        sent.push({ headers: new Headers(options?.headers), body: JSON.parse(options?.body as string) });
        return Response.json(body());
      }) as FetchTransport,
    });
    const first = await adapter.complete(request());
    expect(first.message.toolCalls).toEqual([{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }]);
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 30, cachedInputTokens: 80, cacheWriteTokens: 10, reasoningTokens: 20, costUsd: 0.004 });
    const second = request();
    second.messages = [...second.messages, first.message, { role: "tool", callId: "call-1", content: "file contents" }];
    await adapter.complete(second);
    expect(sent[0]!.headers.get("Authorization")).toBe("Bearer token-1");
    expect(sent[1]!.headers.get("Authorization")).toBe("Bearer token-2");
    expect(sent[1]!.body.messages[2].reasoning_details).toEqual(body().choices[0]!.message.reasoning_details);
    expect(sent[1]!.body.messages[3]).toEqual({ role: "tool", tool_call_id: "call-1", content: "file contents" });
    expect(sent[1]!.body.session_id).toBe("run:lead");
    expect(sent[0]!.body.tools[0]).toEqual({ type: "function", function: request().tools[0] });
    expect(sent[0]!.body.provider.require_parameters).toBe(true);
    expect(sent[0]!.body.max_tokens).toBe(1024);
  });

  test("missing usage stays unknown rather than becoming zero cost", async () => {
    const data: Record<string, unknown> = body();
    delete data.usage;
    const adapter = mockAdapter(data);
    expect((await adapter.complete(request())).usage.costUsd).toBeNull();
    expect((await adapter.complete(request())).usage.cachedInputTokens).toBeNull();
  });

  test("strict routing works with Anthropic's advertised parameter support", async () => {
    const supported = new Set(["max_tokens", "tools", "tool_choice", "reasoning"]);
    const routingParameters = ["max_tokens", "max_completion_tokens", "parallel_tool_calls"];
    const adapter = new OpenRouter({ kind: "api-key", getToken: async () => "test-key" }, {
      fetch: (async (_url, options) => {
        const sent = JSON.parse(options?.body as string);
        const incompatible = routingParameters.filter(parameter => parameter in sent && !supported.has(parameter));
        if (sent.provider.require_parameters && incompatible.length) {
          return Response.json({ error: { message: "No endpoints found that can handle the requested parameters." } }, { status: 404 });
        }
        return Response.json(body());
      }) as FetchTransport,
    });
    expect((await adapter.complete({ ...request(), model: "anthropic/claude-opus-5.5" })).message.toolCalls[0]!.name).toBe("read_file");
  });

  test("rejects duplicate tool IDs and malformed tool responses", async () => {
    const duplicate = body();
    duplicate.choices[0]!.message.tool_calls.push(duplicate.choices[0]!.message.tool_calls[0]!);
    await expect(mockAdapter(duplicate).complete(request())).rejects.toThrow("Duplicate tool call id");
    await expect(mockAdapter({ id: "gen", choices: [] }).complete(request())).rejects.toThrow("no choices");
    await expect(mockAdapter({ error: { message: "secret" } }).complete(request())).rejects.toThrow("inference error");
  });

  test("HTTP failures do not expose response bodies or credentials", async () => {
    const adapter = new OpenRouter({ kind: "api-key", getToken: async () => "private-key" }, {
      fetch: (async () => new Response("private-key echoed", { status: 401 })) as FetchTransport,
    });
    await expect(adapter.complete(request())).rejects.toThrow("HTTP 401");
    try { await adapter.complete(request()); } catch (error) { expect(String(error)).not.toContain("private-key"); }
  });

  test("HTTP failures show useful provider messages while redacting secrets and metadata", async () => {
    const adapter = new OpenRouter({ kind: "api-key", getToken: async () => "private-key" }, {
      fetch: (async () => Response.json({ error: {
        message: "No endpoints found. private-key sk-other-secret Bearer opaque-token\nTry another parameter.",
        metadata: { raw: "private metadata" },
      } }, { status: 404 })) as FetchTransport,
    });
    try {
      await adapter.complete(request());
      throw new Error("Expected request to fail.");
    } catch (error) {
      const message = String(error);
      expect(message).toContain("HTTP 404 for test/model: No endpoints found");
      expect(message).toContain("Try another parameter");
      expect(message).not.toContain("private-key");
      expect(message).not.toContain("sk-other-secret");
      expect(message).not.toContain("opaque-token");
      expect(message).not.toContain("private metadata");
      expect(message).not.toContain("\n");
    }
  });

  test("request timeout interrupts transport", async () => {
    const adapter = new OpenRouter({ kind: "api-key", getToken: async () => "test-key" }, {
      timeoutMs: 15,
      fetch: ((_url, options) => new Promise((_resolve, reject) => {
        const abort = options!.signal!;
        abort.addEventListener("abort", () => reject(abort.reason), { once: true });
      })) as FetchTransport,
    });
    await expect(adapter.complete(request())).rejects.toThrow();
  });
});

test("credential and provider errors are actionable", async () => {
  await expect(new EnvironmentApiKey("BITZEN_TEST_MISSING_KEY").getToken(signal())).rejects.toThrow("BITZEN_TEST_MISSING_KEY");
  expect(() => new ProviderRegistry().get("chatgpt")).toThrow("Unknown provider");
});

function mockAdapter(data: unknown) {
  return new OpenRouter({ kind: "api-key", getToken: async () => "test-key" }, {
    fetch: (async () => Response.json(data)) as FetchTransport,
  });
}
