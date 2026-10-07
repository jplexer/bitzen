import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Budget } from "../src/budget.ts";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { runDemo } from "../src/demo.ts";
import { HarnessRunError, runHarness } from "../src/harness.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { CompletionRequest } from "../src/providers/types.ts";
import { cleanup, completion, provider, signal, tempDirectories, tempRepo } from "./helpers.ts";

afterAll(cleanup);

const config: Config = {
  lead: { provider: "test", model: "lead" }, sidekick: { provider: "test", model: "worker" },
  maxCalls: 12, maxTurns: 8, maxOutputTokens: 1024,
};
const delegate = (objective: string) => completion(null, "delegate", { objective, constraints: ["Keep scope small."], acceptance_criteria: ["Tests pass."] });

test("offline demo edits a real fixture, runs tests, and independently reviews", async () => {
  const result = await runDemo(signal());
  tempDirectories.push(result.cwd);
  expect(await Bun.file(join(result.cwd, "add.ts")).text()).toContain("return a + b");
  const summary = await Bun.file(join(result.traceDirectory, "summary.json")).json();
  expect(summary.status).toBe("completed");
  expect(summary.usage.calls).toBe(9);
  expect(summary.delegations).toBe(1);
  expect(summary.usage.byAgent.lead.calls).toBe(5);
  expect(summary.usage.byAgent.sidekick.calls).toBe(4);
  const events = (await Bun.file(join(result.traceDirectory, "events.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
  const tests = events.filter(event => event.type === "tool_start" && event.call.name === "run_command");
  expect(tests.map(event => event.agent)).toEqual(["sidekick", "lead"]);
  for (const event of tests) {
    const resultEvent = events.find(candidate => candidate.type === "tool_end" && candidate.callId === event.call.id);
    expect(JSON.parse(resultEvent.result).exitCode).toBe(0);
  }
  const sessions = await Bun.file(join(result.traceDirectory, "sessions.json")).json();
  expect(sessions).toHaveLength(2);
  expect(sessions[0].messages.some((message: any) => message.role === "tool" && message.content.includes("applied"))).toBe(true);
  expect(sessions[1].messages.some((message: any) => message.role === "tool" && message.content.includes("applied"))).toBe(false);
});

test("correction rounds retain sidekick history without copying lead history", async () => {
  const requests: Omit<CompletionRequest, "signal" | "onProgress">[] = [];
  let leadTurns = 0;
  let workerTurns = 0;
  const adapter = provider(async request => {
    const { signal: _signal, onProgress: _onProgress, ...record } = request;
    requests.push(structuredClone(record));
    if (request.model === "worker") return completion(++workerTurns === 1 ? "First result" : "Corrected result");
    if (leadTurns++ === 0) return delegate("Implement fix");
    if (leadTurns === 2) return delegate("Correct the missed edge case");
    return completion("Reviewed corrections.");
  });
  const result = await runHarness({ cwd: await tempRepo(), task: "PRIVATE LEAD TASK", mode: "crew", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() });
  expect(result.usage.calls).toBe(5);
  expect(result.usage.byAgent.lead.knownCostUsd).toBeCloseTo(0.03);
  expect(result.usage.byAgent.sidekick.knownCostUsd).toBeCloseTo(0.02);
  const workers = requests.filter(request => request.model === "worker");
  expect(JSON.stringify(workers[0]!.messages)).not.toContain("PRIVATE LEAD TASK");
  expect(JSON.stringify(workers[1]!.messages)).toContain("First result");
  expect(JSON.stringify(workers[1]!.messages)).toContain("missed edge case");
  expect(workers[0]!.sessionId).toBe(workers[1]!.sessionId);
  expect(workers[0]!.sessionId).not.toBe(requests[0]!.sessionId);
});

test("Crew allows the captain to make a small edit and review it without delegation", async () => {
  const root = await tempRepo();
  await Bun.write(join(root, "a.txt"), "before");
  let leadTurns = 0;
  const adapter = provider(async request => {
    expect(request.model).toBe("lead");
    switch (leadTurns++) {
      case 0: return completion(null, "apply_patch", { path: "a.txt", old_text: "before", new_text: "after" });
      case 1:
        expect(await Bun.file(join(root, "a.txt")).text()).toBe("after");
        return completion("Implemented the change.");
      case 2:
        expect(request.messages.at(-1)!.content).toContain("final contract review");
        return completion("Reviewed the change.");
      default: throw Error("Unexpected extra work");
    }
  });
  const result = await runHarness({ cwd: root, task: "Edit", mode: "crew", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() });
  expect(await Bun.file(join(root, "a.txt")).text()).toBe("after");
  expect(result.usage.calls).toBe(3);expect(result.usage.byAgent.sidekick.calls).toBe(0);
  const events = (await Bun.file(join(result.traceDirectory, "events.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(events.filter(event => event.type === "completion_rejected" && event.category === "review")).toHaveLength(1);
  expect(events.filter(event => event.type === "tool_start" && event.call.name === "delegate")).toHaveLength(0);
});

test("Crew answers installation advice directly within one call without forcing delegation or review", async () => {
  const root = await tempRepo();
  const events:Record<string,any>[]=[];
  const adapter = provider(async request => {
    expect(request.model).toBe("lead");expect(request.tools.map(tool=>tool.name)).toContain("delegate");
    expect(request.messages[0]?.content).toContain("Delegation is optional");
    return completion("Use a launcher on PATH that preserves your working directory.");
  });
  const result=await runHarness({ cwd: root, task: "how do I install this current version of bitzen to my terminal. So that I can code on it using bitzen", mode: "crew", allowShell: false, config: { ...config, maxCalls:1 }, providers: new ProviderRegistry().register(adapter), signal: signal(),onEvent:event=>{events.push(event);} });
  expect(result.usage.calls).toBe(1);expect(result.usage.byAgent.sidekick.calls).toBe(0);
  expect(events.filter(event=>event.type==="completion_rejected")).toHaveLength(0);
  const summary=await Bun.file(join(result.traceDirectory,"summary.json")).json();
  expect(summary.delegations).toBe(0);expect(summary.contractReviewStarted).toBe(false);
});

test.each(["single","crew"] as const)("%s read-only inspection can finish without an implementation review",async mode=>{
  const root=await tempRepo();await Bun.write(join(root,"package.json"),JSON.stringify({scripts:{tui:"bun index.ts tui"}}));
  let calls=0;
  const adapter=provider(async request=>{
    expect(request.model).toBe("lead");
    if(calls++===0)return completion(null,"read_file",{path:"package.json"});
    expect(request.messages.at(-1)?.content).toContain("bun index.ts tui");return completion("Run bun run tui in this checkout.");
  });
  const result=await runHarness({cwd:root,task:"How do I launch the TUI?",mode,allowShell:false,config,providers:new ProviderRegistry().register(adapter),signal:signal()});
  expect(result.report).toBe("Run bun run tui in this checkout.");expect(result.usage.calls).toBe(2);expect(result.usage.byAgent.sidekick.calls).toBe(0);
  expect((await Bun.file(join(result.traceDirectory,"summary.json")).json()).contractReviewStarted).toBe(false);
});

test("read-only shell inspection and failed edits do not force delegation or an implementation review",async()=>{
  const root=await tempRepo();await Bun.write(join(root,"a.txt"),"before");let calls=0;
  const adapter=provider(async request=>{
    expect(request.model).toBe("lead");
    switch(calls++) {
      case 0:return completion(null,"run_command",{command:"printf inspected"});
      case 1:expect(JSON.parse(request.messages.at(-1)!.content!).stdout).toBe("inspected");return completion(null,"apply_patch",{path:"a.txt",old_text:"does not match",new_text:"after"});
      default:expect(JSON.parse(request.messages.at(-1)!.content!).error).toContain("does not match");return completion("Inspected the workspace; the attempted edit failed and no file changed.");
    }
  });
  const result=await runHarness({cwd:root,task:"Inspect the workspace",mode:"crew",allowShell:true,config,providers:new ProviderRegistry().register(adapter),signal:signal()});
  expect(result.usage.calls).toBe(3);expect(result.usage.byAgent.sidekick.calls).toBe(0);expect(await Bun.file(join(root,"a.txt")).text()).toBe("before");
  expect((await Bun.file(join(result.traceDirectory,"summary.json")).json()).contractReviewStarted).toBe(false);
});

test.each(["single", "crew"] as const)("%s requires one final contract review after implementation", async mode => {
  const feedback: Record<string,unknown>[] = [];
  const root=await tempRepo();await Bun.write(join(root,"a.txt"),"before");
  let leadCalls = 0,workerCalls=0;
  const adapter = provider(async request => {
    if(request.model === "worker")return workerCalls++===0?completion(null,"apply_patch",{path:"a.txt",old_text:"before",new_text:"after"}):completion("Implemented");
    leadCalls++;
    if(mode === "crew" && leadCalls === 1)return delegate("Implement");
    if(mode === "single" && leadCalls === 1)return completion(null,"apply_patch",{path:"a.txt",old_text:"before",new_text:"after"});
    if(request.messages.at(-1)?.role === "user" && request.messages.at(-1)!.content?.includes("Before the final response")) {
      expect(request.messages.at(-1)!.content).toContain("exact API/output/error wording");
      expect(request.messages.at(-1)!.content).toContain("all paths to the same kind of error");
      return completion("Reviewed the contract");
    }
    return completion("Draft result");
  });
  const result = await runHarness({cwd:root,task:"Preserve the error contract",mode,allowShell:false,config,providers:new ProviderRegistry().register(adapter),signal:signal(),onEvent:event=>{if(event.type==="completion_rejected")feedback.push(event);}});
  expect(result.report).toBe("Reviewed the contract");
  expect(feedback.filter(event=>event.category === "review")).toHaveLength(1);
  expect(result.usage.calls).toBe(mode === "single" ? 3 : 5);
});

test("contract review can correct an error-message omission and verify the fix",async()=>{
  const root=await tempRepo();
  await Bun.write(join(root,"graph.ts"),'export function rejectSelf() { throw new Error("self dependency"); }');
  await Bun.write(join(root,"graph.test.ts"),'import {test,expect} from "bun:test"; import {rejectSelf} from "./graph.ts"; test("self edge reports cycle",()=>expect(rejectSelf).toThrow(/cycle/i));');
  let calls=0;
  const adapter=provider(async request=>{
    switch(calls++) {
      case 0:return completion(null,"apply_patch",{path:"graph.ts",old_text:'"self dependency"',new_text:'"depends on itself"'});
      case 1:return completion("Draft says implemented");
      case 2:
        expect(request.messages.at(-1)!.content).toContain("final contract review");
        return completion(null,"apply_patch",{path:"graph.ts",old_text:'"depends on itself"',new_text:'"cycle: depends on itself"'});
      case 3:return completion(null,"run_command",{command:"bun test"});
      default:
        expect(JSON.parse(request.messages.at(-1)!.content!).exitCode).toBe(0);
        return completion("Verified error contract");
    }
  });
  const result=await runHarness({cwd:root,task:'Self-dependency errors must contain "cycle".',mode:"single",allowShell:true,config,providers:new ProviderRegistry().register(adapter),signal:signal()});
  expect(result.report).toBe("Verified error contract");expect(result.usage.calls).toBe(5);
});

test("final review obeys the existing model call limit",async()=>{
  const root=await tempRepo();await Bun.write(join(root,"a.txt"),"before");let calls=0;
  const adapter=provider(async()=>calls++===0?completion(null,"apply_patch",{path:"a.txt",old_text:"before",new_text:"after"}):completion("Draft"));
  await expect(runHarness({cwd:root,task:"Edit a.txt",mode:"single",allowShell:false,config:{...config,maxCalls:2},providers:new ProviderRegistry().register(adapter),signal:signal()})).rejects.toThrow("call limit");
});

test("single mode performs edits without creating a sidekick", async () => {
  const root = await tempRepo();
  await Bun.write(join(root, "a.txt"), "before");
  let calls = 0;
  const adapter = provider(async request => {
    expect(request.tools.map(tool => tool.name)).not.toContain("delegate");
    return calls++ === 0 ? completion(null, "apply_patch", { path: "a.txt", old_text: "before", new_text: "after" }) : completion("Done");
  });
  const observed: Record<string, unknown>[] = [];
  const result = await runHarness({ cwd: root, task: "Edit", mode: "single", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal(), onEvent:event=>{observed.push(event);} });
  expect(await Bun.file(join(root, "a.txt")).text()).toBe("after");
  expect(result.usage.calls).toBe(3);
  expect(await Bun.file(join(result.traceDirectory, "sessions.json")).json()).toHaveLength(1);
  expect(observed.at(-1)?.type).toBe("run_end");
  expect(observed.at(-1)?.status).toBe("completed");
});

test("truncated tool responses cannot edit files", async () => {
  const root = await tempRepo();
  await Bun.write(join(root, "a.txt"), "before");
  const adapter = provider(async () => ({ ...completion(null, "apply_patch", { path: "a.txt", old_text: "before", new_text: "after" }), finishReason: "length" }));
  await expect(runHarness({ cwd: root, task: "Edit", mode: "single", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() })).rejects.toThrow("length");
  expect(await Bun.file(join(root, "a.txt")).text()).toBe("before");
});

test("truncation retries enlarge output allowance without replaying or executing incomplete tools", async () => {
  const root = await tempRepo();
  await Bun.write(join(root, "a.txt"), "before");
  const limits: number[] = [];
  const adapter = provider(async request => {
    limits.push(request.maxOutputTokens);
    if (limits.length === 1) return { ...completion(null, "apply_patch", { path: "a.txt", old_text: "before", new_text: "INCOMPLETE" }), finishReason: "length" };
    expect(await Bun.file(join(root, "a.txt")).text()).toBe(limits.length === 2 ? "before" : "after");
    expect(JSON.stringify(request.messages)).not.toContain("INCOMPLETE");
    if (limits.length === 2) return completion(null, "apply_patch", { path: "a.txt", old_text: "before", new_text: "after" });
    return completion("Done");
  });
  const result = await runHarness({ cwd: root, task: "Edit", mode: "single", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() });
  expect(limits).toEqual([1024, 2048, 2048, 2048]);
  expect(result.usage.calls).toBe(4);
  expect(result.usage.knownCostUsd).toBeCloseTo(0.04);
  const events = (await Bun.file(join(result.traceDirectory, "events.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(events.filter(event => event.type === "completion_rejected")[0].maxOutputTokens).toBe(2048);
  expect(events.filter(event => event.type === "tool_start")).toHaveLength(1);
});

test("truncation retries stop after two retries and obey the shared call limit", async () => {
  const limits: number[] = [];
  const adapter = provider(async request => { limits.push(request.maxOutputTokens); return { ...completion("partial"), finishReason: "length" }; });
  await expect(runHarness({ cwd: await tempRepo(), task: "Edit", mode: "single", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() })).rejects.toThrow("length");
  expect(limits).toEqual([1024, 2048, 4096]);
  limits.length = 0;
  await expect(runHarness({ cwd: await tempRepo(), task: "Edit", mode: "single", allowShell: false, config: { ...config, maxCalls: 1 }, providers: new ProviderRegistry().register(adapter), signal: signal() })).rejects.toThrow("call limit");
  expect(limits).toEqual([1024]);
});

test("multiple tools in one response execute sequentially", async () => {
  const root = await tempRepo();
  await Bun.write(join(root, "a.txt"), "before");
  let calls = 0;
  const adapter = provider(async () => {
    if (calls++ > 0) return completion("Done");
    const response = completion(null);
    response.finishReason = "tool_calls";
    response.message.toolCalls = [
      { id: "first", name: "apply_patch", arguments: JSON.stringify({ path: "a.txt", old_text: "before", new_text: "middle" }) },
      { id: "second", name: "apply_patch", arguments: JSON.stringify({ path: "a.txt", old_text: "middle", new_text: "after" }) },
    ];
    return response;
  });
  await runHarness({ cwd: root, task: "Edit", mode: "single", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() });
  expect(await Bun.file(join(root, "a.txt")).text()).toBe("after");
});

test("tool errors are returned for recovery, rather than silently succeeding", async () => {
  let calls = 0;
  const adapter = provider(async request => {
    if (calls++ === 0) return completion(null, "unknown_tool", {});
    const last = request.messages.at(-1)!;
    if (calls === 2) { expect(last.role).toBe("tool"); expect(last.content).toContain("Unknown tool"); }
    return completion("Could not execute that tool.");
  });
  await runHarness({ cwd: await tempRepo(), task: "Edit", mode: "single", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() });
});

test("shared call limit stops nested delegation and persists failed run", async () => {
  const root = await tempRepo();
  const adapter = provider(async request => request.model === "lead" ? delegate("Investigate") : completion(null, "read_file", { path: "missing.ts" }));
  await expect(runHarness({ cwd: root, task: "Investigate", mode: "crew", allowShell: false, config: { ...config, maxCalls: 3 }, providers: new ProviderRegistry().register(adapter), signal: signal() })).rejects.toThrow("call limit");
  const summaries = [...new Bun.Glob("*/summary.json").scanSync(join(root, ".bitzen", "runs"))];
  const summary = await Bun.file(join(root, ".bitzen", "runs", summaries[0]!)).json();
  expect(summary.status).toBe("failed");
  expect(summary.usage.calls).toBe(3);
});

test("a failed task retains its incurred cost for the CLI summary", async () => {
  const root = await tempRepo();
  let calls = 0;
  const adapter = provider(async () => {
    if (calls++ === 0) return completion(null, "read_file", { path: "missing.ts" });
    throw new Error("Transport failed");
  });
  try {
    await runHarness({ cwd: root, task: "Investigate", mode: "single", allowShell: false, config, providers: new ProviderRegistry().register(adapter), signal: signal() });
    throw new Error("Expected the task to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessRunError);
    const failure = error as HarnessRunError;
    expect(failure.usage.knownCostUsd).toBeCloseTo(0.01);
    expect(failure.usage.unpricedCalls).toBe(1);
    expect(failure.usage.calls).toBe(2);
    const summary = await Bun.file(join(failure.traceDirectory, "summary.json")).json();
    expect(summary.usage).toEqual(failure.usage);
  }
});

test("cost cutoff accounts for actual usage and refuses unknown-cost continuation", () => {
  const budget = new Budget(10, 0.015);
  budget.beforeCall();
  budget.record(completion("a").usage);
  budget.beforeCall();
  budget.record(completion("b").usage);
  expect(budget.knownCostUsd).toBeCloseTo(0.02);
  expect(() => budget.beforeCall()).toThrow("Cost cutoff");
  expect(budget.cachedInputTokens).toBe(8);
  const unknown = new Budget(10, 1);
  unknown.beforeCall();
  unknown.record({ ...completion("a").usage, costUsd: null });
  expect(() => unknown.beforeCall()).toThrow("omitted cost");
});

test("config preserves the configured sidekick when only lead is overridden", async () => {
  const path = join(await tempRepo(), "config.json");
  await Bun.write(path, JSON.stringify({ lead: { provider: "openrouter", model: "lead" }, sidekick: { provider: "future", model: "worker" } }));
  const loaded = await loadConfig(path, { lead: "different-lead" });
  expect(loaded.lead.model).toBe("different-lead");
  expect(loaded.sidekick).toEqual({ provider: "future", model: "worker" });
  await expect(loadConfig(path, { maxCalls: NaN })).rejects.toThrow("maxCalls");
  await expect(loadConfig(path, { maxCalls: 1.5 })).rejects.toThrow("integer");
});
