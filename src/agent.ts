import { roleLabel } from "./models.ts";
import type { Budget } from "./budget.ts";
import type { Message, ModelSelection, Provider } from "./providers/types.ts";
import type { Tool } from "./tools.ts";
import type { EventSink } from "./trace.ts";

export interface AgentOptions {
  name: "lead" | "sidekick";
  selection: ModelSelection;
  provider: Provider;
  systemPrompt: string;
  tools: Tool[];
  budget: Budget;
  trace: EventSink;
  sessionId: string;
  maxTurns: number;
  maxOutputTokens: number;
  checkpoint?: () => Promise<void>;
  validateCompletion?: (report: string) => string | { reason: string; category: "review" } | undefined;
}

export class Agent {
  readonly messages: Message[];
  constructor(private readonly options: AgentOptions) {
    this.messages = [{ role: "system", content: options.systemPrompt }];
  }

  async run(task: string, signal: AbortSignal): Promise<string> {
    const o = this.options;
    this.messages.push({ role: "user", content: task });
    let maxOutputTokens = o.maxOutputTokens;
    let truncationRetries = 0;
    for (let turn = 0; turn < o.maxTurns; turn++) {
      signal.throwIfAborted();
      o.budget.beforeCall(o.name);
      await o.trace.record({ type: "model_start", agent: o.name, selection: o.selection, turn, maxOutputTokens });
      const started = performance.now();
      let completion;
      try {
        completion = await o.provider.complete({
          model: o.selection.model, messages: this.messages, tools: o.tools.map(tool => tool.definition),
          sessionId: o.sessionId, maxOutputTokens, signal,
          onProgress: update => o.trace.record({ type: "model_delta", agent: o.name, kind: update.type, text: update.text }),
        });
      } catch (error) {
        // A failed/aborted HTTP request may still have been billed upstream.
        o.budget.record({ inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null }, o.name);
        throw error;
      }
      o.budget.record(completion.usage, o.name);
      await o.trace.record({ type: "model_end", agent: o.name, id: completion.id, usage: completion.usage, finishReason: completion.finishReason, elapsedMs: performance.now() - started, message: completion.message });
      if (completion.finishReason === "length" && truncationRetries < 2) {
        const nextLimit = Math.min(maxOutputTokens * 2, Math.max(o.maxOutputTokens, 65536));
        if (nextLimit > maxOutputTokens && turn + 1 < o.maxTurns) {
          truncationRetries++;
          maxOutputTokens = nextLimit;
          const reason = `Output truncated; incomplete tool calls were discarded and no tools from that response ran. Retrying with ${maxOutputTokens} output tokens. Keep the response concise and split large file edits into smaller patches.`;
          await o.trace.record({ type: "completion_rejected", agent: o.name, reason, retry: truncationRetries, maxOutputTokens });
          // Do not replay incomplete assistant tool calls or broken reasoning blocks.
          this.messages.push({ role: "user", content: reason });
          await o.checkpoint?.();
          continue;
        }
      }
      // A truncated function call must never produce a file edit or command.
      if (!["stop", "tool_calls"].includes(completion.finishReason)) {
        throw new Error(`${roleLabel(o.name)} stopped with ${completion.finishReason}; no tools from that response were executed.`);
      }
      this.messages.push(completion.message);
      truncationRetries = 0;
      await o.checkpoint?.();
      if (!completion.message.toolCalls.length) {
        const report = completion.message.content?.trim();
        if (!report) throw new Error(`${roleLabel(o.name)} returned an empty response.`);
        const feedback = o.validateCompletion?.(report);
        if (feedback) {
          const reason = typeof feedback === "string" ? feedback : feedback.reason;
          await o.trace.record({ type: "completion_rejected", agent: o.name, reason, ...(typeof feedback === "string" ? {} : { category: feedback.category }) });
          this.messages.push({ role: "user", content: reason });
          await o.checkpoint?.();
          continue;
        }
        return report;
      }
      for (const call of completion.message.toolCalls) {
        signal.throwIfAborted();
        await o.trace.record({ type: "tool_start", agent: o.name, call });
        const tool = o.tools.find(candidate => candidate.definition.name === call.name);
        let result: string;
        try {
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);
          result = await tool.execute(JSON.parse(call.arguments), signal);
        } catch (error) {
          signal.throwIfAborted();
          result = JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed." });
        }
        this.messages.push({ role: "tool", callId: call.id, content: result });
        await o.trace.record({ type: "tool_end", agent: o.name, callId: call.id, result });
        await o.checkpoint?.();
      }
    }
    throw new Error(`${roleLabel(o.name)} reached its turn limit (${o.maxTurns}).`);
  }
}
