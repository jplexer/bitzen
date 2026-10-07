import { expect, test } from "bun:test";
import { Budget } from "../src/budget.ts";
import { formatRunSummary } from "../src/report.ts";

test("task summary distinguishes complete, partial, and unknown costs", () => {
  const budget = new Budget(10);
  budget.beforeCall("lead");
  budget.record({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.12 }, "lead");
  budget.beforeCall("sidekick");
  budget.record({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.003456 }, "sidekick");
  const usage = budget.snapshot();
  expect(formatRunSummary({ usage, traceDirectory: "/tmp/run" })).toBe("Total cost: $0.123456 | Model calls: 2\nCaptain: $0.120000, 1 call | Crewmate: $0.003456, 1 call\nTrace: /tmp/run");
  expect(formatRunSummary({ usage: { ...usage, unpricedCalls: 1 }, traceDirectory: "/tmp/run" })).toContain("Reported cost: $0.123456 (partial; 1 request without cost data)");
  const unknown = formatRunSummary({ usage: { ...usage, knownCostUsd: 0, unpricedCalls: 2 }, traceDirectory: "/tmp/run" });
  expect(unknown).toContain("Total cost: unknown (2 requests without cost data)");
  expect(unknown).not.toContain("$0.000000");
});

test("single-agent summary clearly shows the sidekick was unused", () => {
  const budget = new Budget(10);
  budget.beforeCall("lead");
  budget.record({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01 }, "lead");
  expect(formatRunSummary({ usage: budget.snapshot(), traceDirectory: "/tmp/run" })).toContain("Captain: $0.010000, 1 call | Crewmate: unused");
});
