import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface SavedRun { key: string; mode: string; id: string; directory: string; status: string; cost: number | null }
export async function savedRuns(directory: string): Promise<SavedRun[]> {
  const root = await realpath(resolve(directory));
  const runs: SavedRun[] = [];
  // Benchmark copies and older workspaces may use arbitrary directory names.
  const groups = ["", ...(await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name)];
  for (const group of groups) {
    const base = join(root, group, ".bitzen", "runs");
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) {
      const actual = await realpath(join(base, entry.name));
      const rel = relative(root, actual);
      if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) continue;
      const summary = await Bun.file(join(actual, "summary.json")).json().catch(() => null);
      const recordedMode = summary?.mode ?? (group || "run");
      const mode = recordedMode === "single" || recordedMode === "run" ? recordedMode : "crew";
      runs.push({ key: `${group || "root"}/${entry.name}`, mode, id: entry.name, directory: actual, status: summary?.status ?? "running", cost: summary?.usage?.knownCostUsd ?? null });
    }
  }
  return runs.sort((a, b) => b.id.localeCompare(a.id));
}

export async function readRun(run: SavedRun): Promise<Record<string, any>[]> {
  const path = await realpath(join(run.directory, "events.jsonl"));
  if (relative(run.directory, path) !== "events.jsonl") throw new Error("Invalid trace location.");
  const file = Bun.file(path);
  if (file.size > 30_000_000) throw new Error("Trace exceeds the 30 MB replay limit.");
  const text = await file.text();
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete.trim() ? complete.trimEnd().split("\n").map(line => JSON.parse(line)) : [];
}

export function exposedReasoning(state: unknown): string {
  if (!state || typeof state !== "object") return "";
  const output=(state as Record<string,any>).openai?.output;
  if(Array.isArray(output))return output.filter(item=>item?.type==="reasoning").flatMap(item=>Array.isArray(item.summary)?item.summary:[]).filter(part=>part?.type==="summary_text"&&typeof part.text==="string").map(part=>part.text).join("");
  const raw = (state as Record<string, any>).openrouter;
  if (!raw || typeof raw !== "object") return "";
  const details = Array.isArray(raw.reasoning_details) ? raw.reasoning_details : [];
  return details.map((part: any) => part.type === "reasoning.summary" ? part.summary : part.type === "reasoning.text" ? part.text : "").filter((text: unknown) => typeof text === "string").join("") || (typeof raw.reasoning === "string" ? raw.reasoning : "");
}
