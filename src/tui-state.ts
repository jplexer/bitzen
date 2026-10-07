import { Budget, type AgentName, type BudgetSnapshot } from "./budget.ts";
import { exposedReasoning, type SavedRun } from "./history.ts";
import { commands, type CommandSuggestion } from "./commands.ts";
import { roleLabel as role, type ModelPicker } from "./models.ts";

export interface Entry {
  agent?: AgentName; kind: string; title: string; text: string; detail: string;
  callId?: string; toolName?: string; done?: boolean; failed?: boolean; expanded?: boolean;
}
function toolResult(text: string): string {
  try {
    const result = JSON.parse(text);
    if (result && typeof result === "object" && (typeof result.stdout === "string" || typeof result.stderr === "string")) {
      return `Exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`;
    }
    if (result?.error) return `Error: ${result.error}`;
    if (result && typeof result === "object") return JSON.stringify(result,null,2);
  } catch {}
  return text;
}
export class TuiState {
  modal?: "help" | "runs" | "models" | "login";
  suggestions: CommandSuggestion[] = [];
  suggestionIndex = 0;
  suggestionsDismissed = false;
  login?: {provider:string;label:string;browserAvailable:boolean;browserLabel:string;keyAvailable:boolean;providers:string[];phase:"choose"|"browser"|"key"|"saving";choice:number;keyLength:number;url:string;message:string;error:string};
  accountStatus = "";
  modelPicker?: ModelPicker;
  expanded = false;
  input = "";
  taskFile?: string;
  task = "";
  mode: "crew" | "single" = "crew";
  status = "Ready";
  started = 0;
  elapsedMs: number | null = null;
  traceDirectory = "";
  notice = "";
  entries: Entry[] = [];
  runs: SavedRun[] = [];
  selectedRun = 0;
  private budget = new Budget(Number.MAX_SAFE_INTEGER);
  usage: BudgetSnapshot = this.budget.snapshot();
  agents: Record<AgentName, { status: string; current?: Entry; reasoning?: Entry }> = { lead: { status: "Idle" }, sidekick: { status: "Idle" } };

  constructor(initialTask = "", taskFile?: string) { this.input = initialTask; this.taskFile = taskFile; }

  receive(event: Record<string, any>): void {
    const name: AgentName | undefined = event.agent === "lead" || event.agent === "sidekick" ? event.agent : undefined;
    const actor = name ? this.agents[name] : undefined;
    const reasoning = (text: string, append: boolean) => {
      if (!actor || !name || !actor.current || !text) return;
      if (!actor.reasoning) {
        actor.reasoning = { agent: name, kind: "reasoning", title: `${role(name)} · Reasoning`, text: "", detail: "" };
        this.entries.splice(this.entries.indexOf(actor.current), 0, actor.reasoning);
      }
      actor.reasoning.text = append ? actor.reasoning.text + text : text;
    };
    if (event.type === "run_start") {
      this.task = event.task; this.mode = event.mode === "single" ? "single" : "crew"; this.status = "Running";
      this.started = event.time ? new Date(event.time).getTime() : Date.now();
      this.entries.push({kind:"user",title:"You",text:event.task,detail:""});
    }
    if (event.type === "model_start" && actor && name) {
      this.budget.beforeCall(name); actor.status = "Generating"; actor.reasoning = undefined;
      const entry: Entry = { agent: name, kind: "model", title: role(name), text: "", detail: "" };
      this.entries.push(entry); actor.current = entry;
    }
    if (event.type === "model_delta" && actor?.current) {
      if (event.kind === "reasoning") reasoning(event.text, true);
      else actor.current.text += event.text;
    }
    if (event.type === "model_end" && actor && name) {
      this.budget.record(event.usage, name); actor.status = "Ready";
      if (actor.current) {
        actor.current.done = true; actor.current.failed = event.finishReason === "length";
        actor.current.text = event.message.content || actor.current.text || (event.finishReason === "length" ? "Output truncated; incomplete tool calls discarded." : "");
        actor.current.detail = `${event.usage.billing==="chatgpt-plan"?"Using ChatGPT plan":"Cost: "+(event.usage.costUsd === null ? "unknown" : "$" + event.usage.costUsd.toFixed(6))} · ${(event.elapsedMs/1000).toFixed(1)}s`;
        reasoning(exposedReasoning(event.message.providerState), false);
        if (actor.reasoning) actor.reasoning.done = true;
      }
    }
    if (event.type === "tool_start" && actor && name) {
      actor.status = event.call.name === "delegate" ? "Delegating" : event.call.name;
      this.entries.push({ callId: event.call.id, toolName: event.call.name, agent: name, kind: "tool", title: `${role(name)} · ${event.call.name}`, text: "", detail: event.call.arguments });
    }
    if (event.type === "tool_end" && actor && name) {
      actor.status = name === "lead" ? "Reviewing" : "Ready";
      const entry = this.entries.findLast(entry => entry.agent === name && entry.callId === event.callId && !entry.done);
      if (entry) {
        entry.done = true;
        try { const result = JSON.parse(event.result); entry.failed = Boolean(result.error || result.timedOut || (typeof result.exitCode === "number" && result.exitCode !== 0)); } catch {}
        if (entry.toolName === "delegate") {
          // Its result arrives after the sidekick's chat. Keep that handoff in
          // chronological order without repeating the whole sidekick report.
          this.entries.push({agent:name,kind:"activity",title:role(name),text:entry.failed?toolResult(event.result):"Received crewmate result; reviewing.",detail:event.result,failed:entry.failed});
        } else entry.text = toolResult(event.result);
      }
    }
    if (event.type === "completion_rejected") {
      const review = event.category === "review";
      if (actor) {
        actor.status = review ? "Reviewing contract" : event.retry ? "Retrying" : actor.status;
        if (review && actor.current) { actor.current.kind = "draft"; actor.current.title = `${role(name!)} · Draft result`; }
      }
      this.entries.push({ agent: name, kind: "feedback", title: review ? "Final contract review" : event.retry ? "Retrying truncated response" : "Completion rejected", text: review ? "Checking the task requirements and verification evidence before finishing." : event.reason, detail: review ? event.reason : "" });
    }
    this.usage = this.budget.snapshot();
    if (event.type === "run_end") {
      this.status = event.status === "completed" ? "Completed" : "Failed"; this.elapsedMs = event.elapsedMs;
      if (event.usage) this.usage = { ...event.usage, byAgent: event.usage.byAgent ?? this.usage.byAgent };
      for (const name of ["lead", "sidekick"] as const) this.agents[name].status = this.usage.byAgent[name].calls ? this.status : "Unused";
      const reported = typeof event.report === "string" && this.agents.lead.current?.text.trim() === event.report.trim() && event.status === "completed";
      if (!reported) this.entries.push({ kind: "report", title: this.status, text: event.error || event.report || "", detail: "", failed: event.status !== "completed" });
    }
  }
}

export const helpText = `${commands.map(command=>`/${command.name} — ${command.description}`).join("\n")}

Type / for suggestions. Up/Down selects; Tab completes; Enter runs a command.
/help replies in chat and leaves the prompt ready for your next message.

Enter runs the task. Alt+Enter or Shift+Enter inserts a newline.
Multiline paste inserts text without starting a task.

Reasoning, messages, tools and results appear together in the chat.
Click an entry's heading to expand it. Ctrl+O toggles all details.
Mouse wheel or PageUp/PageDown scrolls. Tab or Ctrl+L switches editor/chat focus.

F2 switches Crew/single mode while idle. F3 opens saved runs.
Ctrl+P or /model opens the model picker. Tab chooses captain/crewmate; type to search.
Up/Down selects a model; Enter applies it; Escape keeps your current models.
/model captain ID or /model crewmate ID switches directly. /help shows this help.
In saved runs: Up/Down selects, Enter replays, Escape returns to chat.
F1 or Escape closes help. Escape in chat cancels active work.
Drag to select text and copy it. Cmd+C or Ctrl+Shift+C copies a selection.
Ctrl+C copies selected text; with no selection it exits.
Ctrl+N starts a fresh task; Ctrl+U clears the editor.

Reasoning shows only provider-exposed text; encrypted data is never displayed.
Cost updates after each model call. Shell execution follows --allow-shell.`;
