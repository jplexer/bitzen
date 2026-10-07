import type { CompletionRequest } from "./types.ts";
import { object } from "../validate.ts";

export async function* frames(stream: ReadableStream<Uint8Array>, provider="OpenRouter"): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      if(frame.length>2_000_000)throw new Error(`${provider} stream frame exceeds the limit.`);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data) yield data;
    }
    if (buffer.length > 2_000_000) throw new Error(`${provider} stream frame exceeds the limit.`);
  }
  buffer += decoder.decode();
  if (buffer.trim() && !buffer.trim().startsWith(":")) throw new Error(`${provider} stream ended with an incomplete frame.`);
}

export async function readOpenRouterStream(
  response: Response,
  request: CompletionRequest,
  signal: AbortSignal,
  errorMessage: (value: unknown) => string,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("OpenRouter returned an empty stream.");
  let id: unknown;
  let usage: unknown;
  let finishReason: unknown;
  let content = "";
  let reasoning = "";
  let done = false;
  const calls = new Map<number, Record<string, any>>();
  const details: Record<string, unknown>[] = [];
  const detailKeys = new Map<string, number>();
  try {
    for await (const data of frames(response.body)) {
      signal.throwIfAborted();
      if (data === "[DONE]") { done = true; break; }
      const chunk = object(JSON.parse(data), "stream chunk");
      if (chunk.error) throw new Error(errorMessage(chunk));
      id = chunk.id ?? id;
      usage = chunk.usage ?? usage;
      if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
      const choice = object(chunk.choices[0], "stream choice");
      if (choice.index !== undefined && choice.index !== 0) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = object(choice.delta ?? {}, "stream delta");
      if (typeof delta.content === "string") {
        content += delta.content;
        await request.onProgress?.({ type: "text", text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) for (const value of delta.tool_calls) {
        const part = object(value, "stream tool call");
        if (!Number.isInteger(part.index) || (part.index as number) < 0) throw new Error("Invalid streamed tool index.");
        const index = part.index as number;
        const call = calls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (typeof part.id === "string") call.id += part.id;
        if (part.type !== undefined) call.type = part.type;
        if (part.function) {
          const fn = object(part.function, "stream function");
          if (typeof fn.name === "string") call.function.name += fn.name;
          if (typeof fn.arguments === "string") call.function.arguments += fn.arguments;
        }
        calls.set(index, call);
      }
      let detailedReasoning = "";
      if (Array.isArray(delta.reasoning_details)) for (const value of delta.reasoning_details) {
        const part = object(value, "reasoning detail");
        const key = typeof part.index === "number" ? `${part.type}:${part.index}` : typeof part.id === "string" ? `${part.type}:${part.id}` : undefined;
        const position = key ? detailKeys.get(key) : undefined;
        const current: Record<string, unknown> = position === undefined ? {} : details[position]!;
        for (const [name, value] of Object.entries(part)) {
          if (["text", "summary", "data", "signature"].includes(name) && typeof value === "string") current[name] = `${current[name] ?? ""}${value}`;
          else if (value !== null || current[name] === undefined) current[name] = value;
        }
        if (position === undefined) { if (key) detailKeys.set(key, details.length); details.push(current); }
        // Opaque/encrypted blocks and signatures are replayed, never visualized.
        if (part.type === "reasoning.summary" && typeof part.summary === "string") detailedReasoning += part.summary;
        if (part.type === "reasoning.text" && typeof part.text === "string") detailedReasoning += part.text;
      }
      if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
      const visible = detailedReasoning || (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (visible) await request.onProgress?.({ type: "reasoning", text: visible });
    }
  } catch (error) {
    // Breaking the stream cancels its reader; no partially assembled tools escape.
    throw error;
  }
  if (!done || !finishReason) throw new Error("OpenRouter stream ended before completion; no tools were executed.");
  return {
    id, usage, choices: [{ finish_reason: finishReason, message: {
      role: "assistant", content: content || null,
      tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
      ...(details.length ? { reasoning_details: details } : {}), ...(reasoning ? { reasoning } : {}),
    } }],
  };
}
