# Benchmarks

Bitzen includes two synthetic repair tasks. Each preparation creates fresh,
identical `crew` and `single` workspaces plus a shared task file, then prints
ready-to-run commands. Preparation makes no model requests.

| Task | Prepare | Acceptance checks |
| --- | --- | --- |
| Job queue | `bun start benchmark` | 53 |
| Build planner | `bun start benchmark --name build-planner` | 52 |

Both have four source modules and six visible starter tests. A separate acceptance
grader is kept outside the agent's workspace and has been checked against the
broken starter and a reference implementation.

## Job queue

The repair covers priority/FIFO ordering, delayed retries, lease recovery,
cancellation, ownership isolation, snapshot validation, and restart behavior.

Run `bun start benchmark` and use the printed `bench_root`:

```sh
bun start tui --cwd "$bench_root/crew" --task-file "$bench_root/TASK.md" --mode crew --allow-shell --max-calls 60
bun start tui --cwd "$bench_root/single" --task-file "$bench_root/TASK.md" --mode single --allow-shell --max-calls 60
bun start benchmark grade --cwd "$bench_root/crew"
bun start benchmark grade --cwd "$bench_root/single"
```

Each TUI opens with the task loaded. Press Enter to start. No cost cutoff is
applied by these commands; costs are reported when the task finishes.

## Build planner

The repair covers graph validation, dependency-first parallel layers, transitive
change propagation, target closure, cached prerequisites, and atomic graph
replacement. Acceptance checks include long dependency chains and seeded graphs
compared against an independent planning oracle.

Run `bun start benchmark --name build-planner`, then use its printed `bench_root`:

```sh
bun start tui --cwd "$bench_root/crew" --task-file "$bench_root/TASK.md" --mode crew --allow-shell --max-calls 60
bun start tui --cwd "$bench_root/single" --task-file "$bench_root/TASK.md" --mode single --allow-shell --max-calls 60
bun start benchmark grade --name build-planner --cwd "$bench_root/crew"
bun start benchmark grade --name build-planner --cwd "$bench_root/single"
```

Always pass `--name build-planner` when grading this task; the default grader
is the job queue.

## Comparing runs

Prepare fresh workspaces before each comparison so both agents start from the
same broken code. Grade correctness first, then compare reported costs, model
calls, and elapsed time. Use several representative runs before drawing
conclusions about savings; delegation can cost more on small tasks.

A completed agent run means the Captain returned a report, not that acceptance
checks passed. The grader is independent of edited tests, but unrestricted shell
access is not a security boundary. These are local benchmarks, not leaderboard
results.
