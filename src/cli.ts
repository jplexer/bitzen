import { resolve } from "node:path";
import { defaultAccounts } from "./login.ts";
import { loadConfig } from "./config.ts";
import { runDemo } from "./demo.ts";
import { HarnessRunError, runHarness } from "./harness.ts";
import { defaultProviders } from "./providers/registry.ts";
import { formatRunSummary } from "./report.ts";
import { benchmarkCommands, benchmarkDetails, gradeBenchmark, prepareBenchmark } from "./benchmark.ts";
import { roleLabel } from "./models.ts";
import { startTui } from "./tui.ts";

const help = `Bitzen — a small captain/crewmate coding harness

  bun start run --task "Fix the bug" --cwd ./repo --captain vendor/model --crewmate vendor/model
  bun start run --config bitzen.config.json --task "Fix the bug" --cwd ./repo
  bun start demo
  bun start benchmark
  bun start benchmark --name build-planner
  bun start benchmark grade --cwd /path/to/fixture
  bun start tui --cwd /path/to/repo --allow-shell

Options:
  --mode single|crew   Single-agent baseline or delegation (default: crew)
  --captain MODEL        OpenRouter model ID for the captain
  --crewmate MODEL       OpenRouter model ID for the crewmate
  --config FILE          Provider/model settings and limits
  --max-calls N          Shared model call limit (default: 40)
  --max-output-tokens N  Initial output allowance per call (default: 8192)
  --max-cost USD         Stop new requests after reported cost reaches this amount
  --allow-shell          Enable local commands; runs with your user permissions
  --cwd DIRECTORY       Repository to operate on (default: current directory)
  --task-file FILE       Read the task from a UTF-8 file (instead of --task)

Start the TUI and use /login to connect OpenRouter, then /model to choose models.
Login and model choices are saved in your user profile. Model flags/config override
saved choices. The default launch does not use .env credentials or models.
--max-cost is a cutoff, not a hard spending cap: an in-flight request can exceed it.
Traces are saved under <cwd>/.bitzen/runs/.
Demo uses scripted responses and a temporary repository, with no API calls.`;

export async function main(argv: string[]): Promise<void> {
  if (!argv.length && process.stdin.isTTY && process.stdout.isTTY) argv = ["tui"];
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted."));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (!argv.length || argv.includes("--help") || argv[0] === "help") {
      console.log(help);
      return;
    }
    if (argv[0] === "demo") {
      if (argv.length !== 1) throw new Error("demo does not accept options.");
      const result = await runDemo(controller.signal);
      console.log(`Offline scripted demo\n\n${result.report}\n\nRepository: ${result.cwd}\n${formatRunSummary(result)}`);
      return;
    }
    if (argv[0] === "benchmark") {
      if (argv[1] === "grade") {
        const flags = commandFlags(argv.slice(2), ["--cwd", "--name"]);
        if (!flags.get("--cwd")) throw new Error("benchmark grade requires --cwd.");
        const result = await gradeBenchmark(flags.get("--cwd")!, controller.signal, flags.get("--name"));
        console.log(result.stdout + result.stderr);
        console.log(`Independent grader: ${result.exitCode === 0 ? "PASS" : "FAIL"}\nGrader directory: ${result.gradingDirectory}`);
        if (result.exitCode !== 0) process.exitCode = 1;
        return;
      }
      const flags = commandFlags(argv.slice(argv[1] === "prepare" ? 2 : 1), ["--name"]);
      const details = benchmarkDetails(flags.get("--name"));
      const benchmark = await prepareBenchmark(details.name);
      console.log(`${details.title}\n${details.description}\nBoth modes start from identical broken code. No API calls have been made.\n\n${benchmarkCommands(benchmark.root, details.name)}`);
      return;
    }
    if (argv[0] !== "run" && argv[0] !== "tui") throw new Error(`Unknown command: ${argv[0]}. Use --help.`);
    const flags = new Map<string, string>();
    let allowShell = false;
    const known = ["--task", "--task-file", "--cwd", "--config", "--mode", "--lead", "--sidekick", "--max-calls", "--max-cost", "--max-output-tokens"];
    for (let i = 1; i < argv.length; i++) {
      const inputFlag = argv[i]!;
      const flag = inputFlag === "--captain" ? "--lead" : inputFlag === "--crewmate" ? "--sidekick" : inputFlag;
      if (flag === "--allow-shell") {
        if (allowShell) throw new Error("Duplicate --allow-shell.");
        allowShell = true;
        continue;
      }
      if (!known.includes(flag)) throw new Error(`Unknown option: ${flag}`);
      if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      flags.set(flag, value);
    }
    if (flags.has("--task") && flags.has("--task-file")) throw new Error("Use either --task or --task-file, not both.");
    const task = flags.has("--task-file") ? await Bun.file(flags.get("--task-file")!).text() : flags.get("--task");
    if (task !== undefined && !task.trim()) throw new Error("The supplied task is empty. Provide a non-empty coding task.");
    if (argv[0] === "run" && !task?.trim()) throw new Error("Provide --task or --task-file with a coding task.");
    const mode = flags.get("--mode") ?? "crew";
    if (mode !== "single" && mode !== "crew") throw new Error("--mode must be single or crew.");
    const accounts = defaultAccounts();
    const config = await loadConfig(flags.get("--config"), {
      lead: flags.get("--lead"), sidekick: flags.get("--sidekick"),
      maxCalls: flags.has("--max-calls") ? Number(flags.get("--max-calls")) : undefined,
      maxOutputTokens: flags.has("--max-output-tokens") ? Number(flags.get("--max-output-tokens")) : undefined,
      maxCostUsd: flags.has("--max-cost") ? Number(flags.get("--max-cost")) : undefined,
    }, {selections:await accounts.store.selections(),allowUnconfigured:true});
    if (argv[0] === "run") for(const selection of [config.lead,...(mode === "crew" ? [config.sidekick] : [])]) {
      if(!selection.model)throw new Error(`Choose a ${selection===config.lead?"Captain":"Crewmate"} model with /model in the TUI, or pass a model flag.`);
      if(!await accounts.connected(selection.provider))throw new Error(`Sign in to ${selection.provider} with /login in the TUI first.`);
    }
    if (argv[0] === "tui") {
      await startTui({ cwd: resolve(flags.get("--cwd") ?? "."), mode, allowShell, config, accounts, providers: defaultProviders(accounts), signal: controller.signal, initialTask: task, taskFile: flags.has("--task-file") ? resolve(flags.get("--task-file")!) : undefined });
      return;
    }
    const result = await runHarness({
      cwd: resolve(flags.get("--cwd") ?? "."), task: task!, mode, allowShell, config,
      providers: defaultProviders(accounts), signal: controller.signal,
      onEvent: event => {
        if (event.type === "model_start") console.error(`[${event.agent === "lead" || event.agent === "sidekick" ? roleLabel(event.agent).toLowerCase() : "agent"}] model call`);
        if (event.type === "tool_start") console.error(`[${event.agent === "lead" || event.agent === "sidekick" ? roleLabel(event.agent).toLowerCase() : "agent"}] tool: ${(event.call as { name: string }).name}`);
      },
    });
    console.log(result.report);
    console.log(`\n${formatRunSummary(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Bitzen failed.");
    if (error instanceof HarnessRunError) console.error(formatRunSummary(error));
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

function commandFlags(argv: string[], known: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i=0;i<argv.length;i++) {
    const flag=argv[i]!;
    if (!known.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    const value=argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    flags.set(flag,value);
  }
  return flags;
}
