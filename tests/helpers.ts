import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Completion, Provider } from "../src/providers/types.ts";

export const signal = () => new AbortController().signal;
export const tempDirectories: string[] = [];
export async function tempRepo() {
  const path = await mkdtemp(join(tmpdir(), "bitzen-test-"));
  tempDirectories.push(path);
  return path;
}
export async function cleanup() {
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
}
export function completion(content: string | null, name?: string, args?: unknown): Completion {
  return {
    id: crypto.randomUUID(),
    message: { role: "assistant", content, toolCalls: name ? [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }] : [] },
    finishReason: name ? "tool_calls" : "stop",
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, cacheWriteTokens: 0, reasoningTokens: 1, costUsd: 0.01 },
  };
}
export function provider(complete: Provider["complete"]): Provider {
  return { id: "test", complete };
}
