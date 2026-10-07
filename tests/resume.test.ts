import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { runHarness } from "../src/harness.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountTui } from "../src/tui.ts";
import { commandSuggestions } from "../src/commands.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { completion, provider } from "./helpers.ts";

const config = { lead: { provider: "test", model: "lead" }, sidekick: { provider: "test", model: "worker" }, maxCalls: 5, maxOutputTokens: 1000 };

test("resume replaces runs in command suggestions", () => {
  expect(commandSuggestions("/res").map(item => item.value)).toEqual(["/resume"]);
  expect(commandSuggestions("/runs")).toEqual([]);
});

test("resume validates snapshots before requests or new traces and persists the initial task", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bitzen-resume-validation-")));
  let calls = 0;
  const providers = new ProviderRegistry().register(provider(async () => {
    calls++;
    const ids = await readdir(join(root, ".bitzen", "runs"));
    const sessions = await Bun.file(join(root, ".bitzen", "runs", ids[0]!, "sessions.json")).json();
    expect(sessions[0].messages.at(-1).content).toBe("Original task");
    return completion("Saved answer");
  }));
  const options = { cwd: root, task: "Original task", mode: "single" as const, allowShell: false, config, providers, signal: new AbortController().signal };
  try {
    const original = await runHarness(options);
    const before = await readdir(join(root, ".bitzen", "runs"));
    const eventsPath = join(original.traceDirectory, "events.jsonl");
    const events = await Bun.file(eventsPath).text();
    for (const resumeDirectory of ["", "   "]) {
      await expect(runHarness({ ...options, resumeDirectory })).rejects.toThrow("Resume directory must be a non-empty path.");
    }
    await Bun.write(join(original.traceDirectory, "sessions.json"), "[]");
    await expect(runHarness({ ...options, resumeDirectory: original.traceDirectory })).rejects.toThrow("Resume trace is missing the lead session.");
    await Bun.write(join(original.traceDirectory, "sessions.json"), JSON.stringify([{ agent: "lead", messages: [{ role: "assistant", content: null, toolCalls: null }] }]));
    await expect(runHarness({ ...options, resumeDirectory: original.traceDirectory })).rejects.toThrow("Resume trace contains invalid session data.");
    const start = JSON.parse(events.split("\n")[0]!);
    await Bun.write(eventsPath, JSON.stringify({ ...start, cwd: join(root, "different-workspace") }) + "\n");
    await expect(runHarness({ ...options, resumeDirectory: original.traceDirectory })).rejects.toThrow("Resume trace has invalid run metadata or belongs to a different workspace.");
    expect(calls).toBe(1);
    expect(await readdir(join(root, ".bitzen", "runs"))).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const savedCount of [1, 12]) test(`a long resumed chat opens at the bottom and preserves manual scrolling (${savedCount} saved runs)`, async () => {
  const root = await mkdtemp(join(tmpdir(), "bitzen-resume-bottom-"));
  const setup = await createTestRenderer({ exitOnCtrlC: false, width: 100, height: 32 });
  const providers = new ProviderRegistry().register(provider(async () => completion(
    Array.from({ length: 40 }, (_, index) => `Saved paragraph ${index}`).join("\n\n") + "\n\nLATEST SAVED REPLY",
  )));
  let app: ReturnType<typeof mountTui> | undefined;
  try {
    for (let index = 0; index < savedCount; index++) {
      await runHarness({ cwd: root, task: "Original long chat", mode: "single", allowShell: false, config, providers, signal: new AbortController().signal });
    }
    app = mountTui(setup.renderer, { cwd: root, config, providers, mode: "single", allowShell: false, signal: new AbortController().signal });
    await setup.mockInput.pasteBracketedText("/resume");
    setup.mockInput.pressEnter();
    await setup.waitFor(() => app!.state.runs.length === savedCount, { maxPasses: 10000 });
    await setup.flush();
    setup.mockInput.pressEnter();
    await setup.waitFor(() => app!.state.notice.startsWith("Saved run ready"), { maxPasses: 10000 });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("LATEST SAVED REPLY");
    expect(setup.captureCharFrame()).not.toContain("Saved paragraph 0");
    expect(app.view.feed.scrollTop).toBeGreaterThan(0);
    app.view.feed.scrollTo(25);
    await setup.flush();
    const readingPosition = app.view.feed.scrollTop;
    await setup.mockInput.pasteBracketedText("another test message");
    await setup.flush();
    expect(app.view.feed.scrollTop).toBe(readingPosition);
  } finally { app?.destroy(); setup.renderer.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("TUI resume selection restores history on the next submitted message", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitzen-resume-"));
  const setup = await createTestRenderer({ exitOnCtrlC: false, width: 100, height: 32 });
  let calls = 0;
  let releaseContinuation!: () => void;
  const continuationPending = new Promise<void>(resolve => { releaseContinuation = resolve; });
  const app = mountTui(setup.renderer, { cwd: root, config, mode: "single", allowShell: false, signal: new AbortController().signal, initialTask: "Original task", providers: new ProviderRegistry().register(provider(async request => {
    if (calls++ === 0) return completion("Original answer");
    expect(JSON.stringify(request.messages)).toContain("Original answer");
    if (calls === 2) {
      expect(request.messages.at(-1)?.content).toBe("Continue please");
      await continuationPending;
      return completion("Continued answer");
    }
    expect(JSON.stringify(request.messages)).toContain("Continued answer");
    expect(request.messages.at(-1)?.content).toBe("Continue again");
    return completion("Third answer");
  })) });
  try {
    setup.mockInput.pressEnter();
    await setup.waitFor(() => app.state.status === "Completed" && Boolean(app.state.traceDirectory), { maxPasses: 10000 });
    const original = app.state.traceDirectory;
    await setup.mockInput.pasteBracketedText("/resume");
    setup.mockInput.pressEnter();
    await setup.waitFor(() => app.state.runs.length === 1, { maxPasses: 10000 });
    setup.mockInput.pressEnter();
    await setup.waitFor(() => app.state.notice.startsWith("Saved run ready"), { maxPasses: 10000 });
    expect(app.state.entries.some(entry => entry.text === "Original answer")).toBe(true);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Original answer");
    expect(calls).toBe(1);
    await setup.mockInput.pasteBracketedText("Continue please");
    setup.mockInput.pressEnter();
    await setup.waitFor(() => calls === 2 && app.state.status === "Running", { maxPasses: 10000 });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Original answer");
    expect(setup.captureCharFrame()).toContain("Continue please");
    releaseContinuation();
    await setup.waitFor(() => calls === 2 && app.state.status === "Completed" && Boolean(app.state.traceDirectory), { maxPasses: 10000 });
    expect(app.state.traceDirectory).not.toBe(original);
    expect(app.state.entries.filter(entry => entry.kind === "user").map(entry => entry.text)).toEqual(["Original task", "Continue please"]);
    expect(app.state.entries.some(entry => entry.text === "Original answer")).toBe(true);
    expect(app.state.entries.some(entry => entry.text === "Continued answer")).toBe(true);
    expect(app.state.resumeDirectory).toBe(app.state.traceDirectory);
    expect(app.state.usage.calls).toBe(1);
    const continued = app.state.traceDirectory;
    await setup.mockInput.pasteBracketedText("Continue again");
    setup.mockInput.pressEnter();
    await setup.waitFor(() => calls === 3 && app.state.status === "Completed" && app.state.traceDirectory !== continued, { maxPasses: 10000 });
    expect(app.state.entries.filter(entry => entry.kind === "user").map(entry => entry.text)).toEqual(["Original task", "Continue please", "Continue again"]);
    expect(app.state.entries.some(entry => entry.text === "Original answer")).toBe(true);
    expect(app.state.entries.some(entry => entry.text === "Continued answer")).toBe(true);
    expect(app.state.entries.some(entry => entry.text === "Third answer")).toBe(true);
    expect(app.state.usage.calls).toBe(1);
    expect(await Bun.file(join(original, "sessions.json")).exists()).toBe(true);
    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.flush();
    expect(app.state.entries).toHaveLength(0);
    expect(app.state.resumeDirectory).toBeUndefined();
  } finally { releaseContinuation(); app.destroy(); setup.renderer.destroy(); await rm(root, { recursive: true, force: true }); }
});
