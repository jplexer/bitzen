import type { Usage } from "./providers/types.ts";

export type AgentName = "lead" | "sidekick";
export interface UsageTotals {
  calls: number;
  knownCostUsd: number;
  unpricedCalls: number;
  planCalls?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}
export type BudgetSnapshot = UsageTotals & { byAgent: Record<AgentName, UsageTotals> };

function emptyUsage(): UsageTotals {
  return { calls: 0, knownCostUsd: 0, unpricedCalls: 0, planCalls:0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

function addUsage(total: UsageTotals, usage: Usage): void {
  if(usage.billing==="chatgpt-plan")total.planCalls=(total.planCalls??0)+1;
  if (usage.costUsd === null) total.unpricedCalls++;
  else total.knownCostUsd += usage.costUsd;
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.cachedInputTokens += usage.cachedInputTokens ?? 0;
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  total.reasoningTokens += usage.reasoningTokens ?? 0;
}

export class Budget {
  calls = 0;
  knownCostUsd = 0;
  unpricedCalls = 0;
  planCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cachedInputTokens = 0;
  cacheWriteTokens = 0;
  reasoningTokens = 0;
  private readonly byAgent: Record<AgentName, UsageTotals> = { lead: emptyUsage(), sidekick: emptyUsage() };

  constructor(private readonly maxCalls: number, private readonly maxCostUsd?: number) {}

  beforeCall(agent: AgentName = "lead"): void {
    if (this.calls >= this.maxCalls) throw new Error(`Model call limit reached (${this.maxCalls}).`);
    if (this.maxCostUsd !== undefined) {
      if (this.unpricedCalls > 0) throw new Error("Cannot continue with a cost cutoff: the provider omitted cost usage.");
      if (this.knownCostUsd >= this.maxCostUsd) throw new Error(`Cost cutoff reached ($${this.maxCostUsd}).`);
    }
    this.calls++;
    this.byAgent[agent].calls++;
  }

  record(usage: Usage, agent: AgentName = "lead"): void {
    addUsage(this, usage);
    addUsage(this.byAgent[agent], usage);
  }

  snapshot(): BudgetSnapshot {
    return {
      calls: this.calls, knownCostUsd: this.knownCostUsd, unpricedCalls: this.unpricedCalls,planCalls:this.planCalls,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens, cacheWriteTokens: this.cacheWriteTokens,
      reasoningTokens: this.reasoningTokens,
      byAgent: { lead: { ...this.byAgent.lead }, sidekick: { ...this.byAgent.sidekick } },
    };
  }
}
