import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarness } from "./harness.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import type { Completion, CompletionRequest, Provider } from "./providers/types.ts";

export const demoSource = "export function add(a: number, b: number) { return a - b; }\n";
export const demoTests = `import { expect, test } from "bun:test";
import { add } from "./add.ts";
test("adds positive, negative, and zero values", () => {
  expect(add(2, 3)).toBe(5);
  expect(add(-2, 3)).toBe(1);
  expect(add(0, 0)).toBe(0);
});
`;

// Deliberately scripted: validates orchestration, not model intelligence or savings.
export class DemoProvider implements Provider {
  readonly id = "demo";
  private readonly turns = new Map<string, number>();

  async complete(request: CompletionRequest): Promise<Completion> {
    request.signal.throwIfAborted();
    const turn = this.turns.get(request.model) ?? 0;
    this.turns.set(request.model, turn + 1);
    const call = (name: string, args: unknown) => [{ id: `${request.model}-${turn}`, name, arguments: JSON.stringify(args) }];
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      // Do not let the scripted demo claim success after a failed edit or test.
      try {
        const result = JSON.parse(last.content);
        if (result.error || ("exitCode" in result && result.exitCode !== 0)) throw new Error(`Demo tool failed: ${last.content}`);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    let calls: Completion["message"]["toolCalls"] = [];
    let content: string | null = null;
    if (request.model === "lead") {
      if (turn === 0) calls = call("delegate", { objective: "Fix add() subtraction bug and test it.", constraints: ["Change only add.ts."], acceptance_criteria: ["bun test passes."] });
      else if (turn === 1) calls = call("read_file", { path: "add.ts" });
      else if (turn === 2) calls = call("run_command", { command: "bun test" });
      else content = "Fixed add() to add its operands. The crewmate ran the tests; the captain inspected the file and independently reran bun test successfully.";
    } else {
      if (turn === 0) calls = call("read_file", { path: "add.ts" });
      else if (turn === 1) calls = call("apply_patch", { path: "add.ts", old_text: "return a - b;", new_text: "return a + b;" });
      else if (turn === 2) calls = call("run_command", { command: "bun test" });
      else content = "Changed add.ts: subtraction -> addition. bun test exited 0. No unresolved issues.";
    }
    return {
      id: `demo-${request.model}-${turn}`, message: { role: "assistant", content, toolCalls: calls },
      finishReason: calls.length ? "tool_calls" : "stop",
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: 0 },
    };
  }
}

export async function runDemo(signal: AbortSignal) {
  const cwd = await mkdtemp(join(tmpdir(), "bitzen-demo-"));
  await Bun.write(join(cwd, "add.ts"), demoSource);
  await Bun.write(join(cwd, "add.test.ts"), demoTests);
  const result = await runHarness({
    cwd, task: "Fix add() so it adds numbers correctly.", mode: "crew", allowShell: true, signal,
    config: { lead: { provider: "demo", model: "lead" }, sidekick: { provider: "demo", model: "sidekick" }, maxCalls: 12, maxTurns: 8, maxOutputTokens: 1024 },
    providers: new ProviderRegistry().register(new DemoProvider()),
  });
  if (await Bun.file(join(cwd, "add.ts")).text() !== demoSource.replace("a - b", "a + b")) throw new Error("Demo did not apply the expected fix.");
  return { ...result, cwd };
}
