import type { Config } from "./config.ts";
import type { ModelInfo, ModelSelection } from "./providers/types.ts";

export type ModelRole = "lead" | "sidekick";
export const roleLabel = (role: ModelRole) => role === "lead" ? "Captain" : "Crewmate";
export interface ModelChoice extends ModelInfo { provider: string }
export interface ModelPicker {
  role: ModelRole;
  query: string;
  index: number;
  choices: ModelChoice[];
  loading: boolean;
  error: string;
}
export const modelKey = (choice: ModelChoice | ModelSelection) => `${choice.provider}\0${"id" in choice ? choice.id : choice.model}`;

export function modelChoices(config: Config, catalogue: ModelChoice[], role: ModelRole): ModelChoice[] {
  const choices = new Map<string, ModelChoice>();
  for (const selected of [config.lead, config.sidekick]) if (selected.model) choices.set(modelKey(selected), { provider: selected.provider, id: selected.model, name: selected.model });
  for (const entry of catalogue) choices.set(modelKey(entry), entry);
  const current = modelKey(config[role]);
  return [...choices.values()].sort((a,b) => Number(modelKey(b) === current) - Number(modelKey(a) === current) || a.id.localeCompare(b.id) || a.provider.localeCompare(b.provider));
}

export function matchingModels(picker: ModelPicker): ModelChoice[] {
  const words = picker.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return picker.choices.filter(choice => words.every(word => `${choice.provider} ${choice.id} ${choice.name}`.toLowerCase().includes(word)));
}

export function validModelId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\s\x00-\x1f\x7f-\x9f]/.test(value);
}
