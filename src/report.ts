import type { BudgetSnapshot, UsageTotals } from "./budget.ts";
import { roleLabel } from "./models.ts";

export function formatRunSummary(run: { usage: BudgetSnapshot; traceDirectory: string }): string {
  const { calls, knownCostUsd } = run.usage;
  const planCalls=run.usage.planCalls??0,unpricedCalls=run.usage.unpricedCalls-planCalls;
  const missing = `${unpricedCalls} request${unpricedCalls === 1 ? "" : "s"} without cost data`;
  const cost = planCalls===calls&&calls>0?"Using ChatGPT plan (USD cost not reported)":unpricedCalls === 0
    ? `Total cost: $${knownCostUsd.toFixed(6)}`
    : unpricedCalls === calls-planCalls
      ? `Total cost: unknown (${missing})`
      : `Reported cost: $${knownCostUsd.toFixed(6)} (partial; ${missing})`;
  const agentCost = (name: string, usage: UsageTotals) => {
    if (usage.calls === 0) return `${name}: unused`;
    const plans=usage.planCalls??0,missing=usage.unpricedCalls-plans;
    const amount = plans===usage.calls?"ChatGPT plan":missing===usage.calls?"unknown cost":`$${usage.knownCostUsd.toFixed(6)}${missing?" (partial)":""}${plans?" + ChatGPT plan":""}`;
    return `${name}: ${amount}, ${usage.calls} call${usage.calls === 1 ? "" : "s"}`;
  };
  return `${cost}${planCalls&&planCalls!==calls?` + ChatGPT plan (${planCalls} calls; USD cost not reported)`:""} | Model calls: ${calls}\n${agentCost(roleLabel("lead"), run.usage.byAgent.lead)} | ${agentCost(roleLabel("sidekick"), run.usage.byAgent.sidekick)}\nTrace: ${run.traceDirectory}`;
}
