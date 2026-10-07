# Architecture

Bitzen runs hosted models through a provider-independent agent loop. The OpenTUI
interface shows messages, exposed reasoning, tool activity, and results in one
chronological chat. CLI runs use the same harness.

## Captain and Crewmate

In `crew` mode, the Captain owns planning, review, and the final answer. It can
delegate a bounded objective with constraints and acceptance criteria to the
Crewmate. Each agent keeps a separate history throughout the task, exchanging
briefs and reports rather than copying full conversations.

Delegation is optional. The Captain can answer questions and make small changes
itself. Follow-up briefs should target a concrete gap or failed check. An unused
Crewmate makes no model calls. In `single` mode, only the Captain is created.

After a successful `apply_patch`, the first proposed final answer becomes a draft.
The Captain receives one focused contract-review prompt to inspect requirements,
edge cases, exact output wording, and verification evidence. It can correct gaps
before finishing. Read-only tasks skip this pass. Review uses the same call, turn,
and cost limits and costs at least one additional Captain call.

The review is a prompt-driven check, not an independent correctness verdict.
Shell-only edits do not trigger the automatic `apply_patch` review.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_files`, `search` | Discover files and search code with `rg` |
| `read_file` | Read bounded UTF-8 contents |
| `apply_patch` | Replace an exact, unique string or create a file |
| `run_command` | Run a shell command with a 30-second timeout and bounded output |
| `delegate` | Give the Crewmate a bounded brief; available only to the Captain |

`apply_patch` does not parse unified diffs. Parent directories must already exist.
File tools reject traversal and symlink escapes and exclude `.env*`, credential
JSON, `.git`, `.bitzen`, `.aws`, `.codex`, and `.agents`. Shell commands require
`--allow-shell` and run with your user permissions; they are not an OS sandbox.
Process-group cancellation targets macOS/Linux.

## Providers and authentication

[Provider](../src/providers/types.ts) defines `complete()` with normalized
messages, tools, usage, finish reasons, and optional text/reasoning progress.
Adapters own transport and preserve opaque provider state needed for later turns.
Encrypted reasoning is replayed to the provider but never displayed.

Register adapters in [ProviderRegistry](../src/providers/registry.ts). Each role
can use a different provider. Optional `listModels()` powers the model picker;
exact model-ID entry remains available without a catalogue.

Authentication is separate: `CredentialSource.getToken(signal)` resolves a token
for each request. Login adapters manage sign-in, while `AccountManager` and
`ProfileStore` retain accounts and model choices. See [accounts](accounts.md).

## Traces

Every task writes `<project>/.bitzen/runs/<id>/`:

- `events.jsonl`: model/tool events, usage, timings, and results.
- `sessions.json`: separate Captain (`lead`) and Crewmate (`sidekick`) histories.
- `summary.json`: status, final report, elapsed time, delegation count, and usage.

`/runs` can replay saved traces for viewing; resuming a task is not implemented.
Traces can contain source code, task text, model responses, and command output.
Add `.bitzen/` to target projects' ignore rules. Login secrets are kept out of
prompts and traces, but source and command output can contain other sensitive data.

Separate histories enable caching where providers support it. Bitzen records
reported cache usage but does not implement explicit provider-specific cache
policies. See [configuration and costs](configuration.md).
