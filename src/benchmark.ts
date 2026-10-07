import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "./tools.ts";

const benchmarks = {
  "job-queue": { title: "Job-queue repair benchmark", description: "Four source modules, six starter tests, and a separate acceptance grader." },
  "build-planner": { title: "Build-planner repair benchmark", description: "Repair dependency ordering, parallel layers, cycles, and incremental rebuilds across four modules." },
};

export function benchmarkDetails(name = "job-queue") {
  if (!Object.hasOwn(benchmarks, name)) throw new Error(`Unknown benchmark: ${name}. Choose ${Object.keys(benchmarks).join(" or ")}.`);
  return { name, ...benchmarks[name as keyof typeof benchmarks], source: resolve(import.meta.dir, "../benchmarks", name) };
}

async function copyTemplates(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTemplates(join(from, entry.name), join(to, entry.name));
    else if (entry.name.endsWith(".fixture")) await Bun.write(join(to, entry.name.slice(0, -8)), await Bun.file(join(from, entry.name)).text());
  }
}

export async function prepareBenchmark(name = "job-queue") {
  const { source } = benchmarkDetails(name);
  const root = await mkdtemp(join(tmpdir(), `bitzen-${name}-`));
  for (const mode of ["crew", "single"]) await copyTemplates(join(source, "starter"), join(root, mode));
  await Bun.write(join(root, "TASK.md"), await Bun.file(join(source, "TASK.md")).text());
  return { name, root, crew: join(root, "crew"), single: join(root, "single"), taskFile: join(root, "TASK.md") };
}

export async function prepareReference(name = "job-queue") {
  const { source } = benchmarkDetails(name);
  const root = await mkdtemp(join(tmpdir(), `bitzen-${name}-reference-`));
  await copyTemplates(join(source, "reference"), root);
  await Bun.write(join(root, "src/types.ts"), await Bun.file(join(source, "starter/src/types.ts.fixture")).text());
  await copyTemplates(join(source, "starter/tests"), join(root, "tests"));
  return root;
}

export async function gradeBenchmark(target: string, signal: AbortSignal, name = "job-queue") {
  const { source } = benchmarkDetails(name);
  const grading = await mkdtemp(join(tmpdir(), `bitzen-${name}-grade-`));
  const tests = await Bun.file(join(source, "acceptance.test.ts.fixture")).text();
  // Embed only the target path, not credentials or solution text. The grader is
  // outside the agent workspace and untouched by its file-edit tools.
  await Bun.write(join(grading, "acceptance.test.ts"), tests.replace("process.env.BITZEN_BENCH_TARGET!", JSON.stringify(resolve(target))));
  const result = await runProcess([process.execPath, "test"], grading, signal);
  return { ...result, gradingDirectory: grading };
}

export function benchmarkCommands(root: string, name = "job-queue"): string {
  benchmarkDetails(name);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const selection = name === "job-queue" ? "" : ` --name ${name}`;
  return `bench_root=${quote(root)}\n\n# Each TUI opens with the task loaded; press Enter to run it.\nbun start tui --cwd "$bench_root/crew" --task-file "$bench_root/TASK.md" --mode crew --allow-shell --max-calls 60\nbun start tui --cwd "$bench_root/single" --task-file "$bench_root/TASK.md" --mode single --allow-shell --max-calls 60\nbun start benchmark grade${selection} --cwd "$bench_root/crew"\nbun start benchmark grade${selection} --cwd "$bench_root/single"`;
}
