# Configuration and costs

Login and model choices normally come from the TUI. Explicit configuration files
are loaded only when passed with `--config`; default launches ignore `.env`.

Copy [bitzen.config.example.json](../bitzen.config.example.json) to
`bitzen.config.json`, replace the placeholder model IDs, and run:

```sh
bun start run --config bitzen.config.json --cwd /path/to/project --task "Fix the bug" --allow-shell
```

The internal keys `lead` and `sidekick` correspond to Captain and Crewmate:

```json
{
  "lead": { "provider": "openrouter", "model": "vendor/your-captain-model" },
  "sidekick": { "provider": "openrouter", "model": "vendor/your-crewmate-model" },
  "maxCalls": 40,
  "maxTurns": 20,
  "maxOutputTokens": 8192
}
```

Use `openai` as the provider for a model available through your connected ChatGPT
account. Both roles can use the same provider or different ones.

## Overrides and limits

CLI flags take precedence over explicit configuration, which takes precedence
over saved model choices. `--captain MODEL` and `--crewmate MODEL` override the
model ID without changing that role's provider.

| Setting | CLI flag | Default | Scope |
| --- | --- | --- | --- |
| `maxCalls` | `--max-calls` | 40 | Shared across both agents |
| `maxTurns` | Set in config | 20 | Each agent invocation, including delegated briefs |
| `maxOutputTokens` | `--max-output-tokens` | 8192 | Initial allowance per supported model call |
| `maxCostUsd` | `--max-cost` | None | Stops new requests after the reported-cost cutoff |

If a response ends because of its output limit, Bitzen discards incomplete tools
and retries at most twice with a doubled allowance, up to 65,536 tokens (or the
configured initial allowance if higher). Retries count toward the existing limits.
Incomplete tool calls never execute or enter the conversation history. Transport
errors are not retried automatically.

The ChatGPT-plan adapter omits the output-token parameter; this setting applies
only to providers that accept it. Split large edits into small patches rather
than relying on large responses.

## Usage and costs

The CLI prints combined and per-agent costs, call counts, and a trace path after
successful or failed tasks. The TUI updates usage as calls finish.

OpenRouter dollar costs come from reported usage, not price estimates. Missing
costs remain unknown; a mixture of priced and unpriced requests shows a partial
total. Token and cache totals sum reported values; individual events retain null
for missing usage fields.

ChatGPT calls show plan usage rather than a dollar amount. Mixed-provider tasks
report OpenRouter costs separately from ChatGPT-plan calls. `/usage` opens
ChatGPT's usage settings.

There is no default cost cutoff. Optional `--max-cost` stops new requests once
reported cost reaches the cutoff; an in-flight request can exceed it. If a request
has no dollar-cost data, a run with this cutoff cannot start another request.
This includes ChatGPT-plan calls. Failed or interrupted requests may still be
billed even when their cost is unknown.

Delegation and review add overhead. Compare correctness, cost, and elapsed time
on representative tasks using the [benchmarks](benchmarks.md).
