import type { Selections } from "./profile.ts";
import type { ModelSelection } from "./providers/types.ts";
import { object, positive, string } from "./validate.ts";

export interface Config {
  lead: ModelSelection;
  sidekick: ModelSelection;
  maxCalls: number;
  maxOutputTokens: number;
  maxCostUsd?: number;
}

export async function loadConfig(path?: string, overrides: { lead?: string; sidekick?: string; maxCalls?: number; maxCostUsd?: number; maxOutputTokens?: number } = {}, startup: {selections?:Selections;allowUnconfigured?:boolean} = {}): Promise<Config> {
  const raw = path ? object(await Bun.file(path).json(), "config") : {};
  const selection = (value: unknown, role: "lead" | "sidekick", override?: string): ModelSelection => {
    const entry = value === undefined ? startup.selections?.[role] ?? {} : object(value, "model selection");
    return {
      provider: string(entry.provider ?? "openrouter", "provider"),
      model: string(override ?? entry.model ?? "", "model (choose one with /model in the TUI)", startup.allowUnconfigured ?? false),
    };
  };
  const maxCost = overrides.maxCostUsd ?? raw.maxCostUsd;
  const lead = selection(raw.lead, "lead", overrides.lead);
  const sidekick = selection(raw.sidekick, "sidekick", overrides.sidekick);
  return {
    lead,
    sidekick,
    maxCalls: positive(overrides.maxCalls ?? raw.maxCalls ?? 40, "maxCalls", true),
    maxOutputTokens: positive(overrides.maxOutputTokens ?? raw.maxOutputTokens ?? 8192, "maxOutputTokens", true),
    ...(maxCost === undefined ? {} : { maxCostUsd: positive(maxCost, "maxCostUsd") }),
  };
}
