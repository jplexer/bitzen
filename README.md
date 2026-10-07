# Bitzen

<img src="assets/bitzen-logo.svg" alt="Bitzen logo" width="420">

A terminal AI coding harness built with Bun, TypeScript, and OpenTUI.

The **Captain** handles your task and reviews changes. In **Crew** mode, it can
ask a **Crewmate** to help with larger pieces of work. Delegation is optional;
simple questions and small changes can stay with the Captain. Each agent keeps
its own conversation history. **Single** mode uses only the Captain.

## Get started

Install [Bun](https://bun.sh/) and [ripgrep](https://github.com/BurntSushi/ripgrep),
then run from this repository:

```sh
bun install
bun run tui --cwd /path/to/your/project --allow-shell
```

1. Connect an account with `/login openrouter` or `/login openai`.
2. Choose your Captain and Crewmate models with `/model`.
3. Type a task and press Enter.

OpenRouter supports browser sign-in or API-key entry. OpenAI uses
**Continue with ChatGPT** for an eligible existing plan, without API-key billing.
You can use different providers for each agent. Login and model choices are saved
between launches; no `.env` is needed, and default launches ignore it.

For a scripted demo that makes no API calls:

```sh
bun run demo
```

## Using the TUI

Your task, messages, available reasoning, tool activity, and results appear in one
chat. Cost, model calls, and elapsed time appear below it.

Type `/` for command suggestions. Use Up/Down to select, Tab to complete, and
Enter to run. `/help` lists all commands.

| Command | Action |
| --- | --- |
| `/model` | Choose Captain or Crewmate models |
| `/mode crew` or `/mode single` | Switch modes |
| `/login [provider]`, `/logout [provider]` | Connect or disconnect an account |
| `/account`, `/account 2`, `/account new` | List, switch, or add ChatGPT accounts |
| `/usage` | Open ChatGPT usage settings |
| `/status`, `/cost` | Show session details or task cost |
| `/resume` | Select a saved run to continue |
| `/new`, `/cancel`, `/quit` | Start fresh, cancel a task, or exit |

- **Ctrl+P** opens the model picker; Tab switches roles inside it.
- **Ctrl+O** expands details; clicking an entry heading expands that entry.
- **Shift+Enter** or **Alt+Enter** inserts a newline.
- **Escape** closes a dialog or cancels a running task.
- **Mouse wheel** or **PageUp/PageDown** scrolls the chat.
- **Drag to select** text; releasing the mouse copies it. Forwarded **Cmd+C**
  and **Ctrl+Shift+C** also copy. **Ctrl+C** copies selected text or exits if
  nothing is selected.

Switch models and modes while idle. After successful `apply_patch` edits, the
Captain takes an extra review pass before finishing; questions and read-only
investigation skip that pass. Always check the resulting changes and tests.

## Command-line tasks

CLI runs use your saved login and models:

```sh
bun start run --cwd /path/to/project --task "Fix the failing parser test" --allow-shell
bun start run --cwd /path/to/project --task "Explain this code" --mode single
bun start tui --cwd /path/to/project --task-file TASK.md --allow-shell
```

A task file opens in the TUI ready to run; press Enter to start it.

Use `--captain MODEL` and `--crewmate MODEL` to override model IDs for a run.
For other settings, copy [bitzen.config.example.json](bitzen.config.example.json),
fill in your models, and pass `--config bitzen.config.json`. Explicit flags and
config override saved choices. Run `bun start --help` for all options.

The CLI prints costs and call counts when a task ends, including on failure.
OpenRouter costs use reported usage; missing costs stay unknown. ChatGPT calls
show plan usage rather than a dollar amount. There is no default cost cutoff.
See [configuration and costs](docs/configuration.md) for limits and overrides.

## Local files and permissions

Bitzen edits the selected project directly. Shell commands require `--allow-shell`
and run with your user permissions; they are not sandboxed. File tools stay within
the project and exclude credential files and internal directories. Use a disposable
checkout or container for untrusted tasks.

Credentials are stored as private, unencrypted JSON under `~/.config/bitzen/`
(or `$XDG_CONFIG_HOME/bitzen`), with file permissions `0600`.

Runs are saved in `<project>/.bitzen/runs/` with events, agent histories, and a
summary. These traces can contain source code and task output; add `.bitzen/` to
your project's ignore rules. `/resume` opens the saved-run picker. Select a run
with Up/Down and Enter, then type a continuation (such as “Continue”) and press
Enter. Agent histories are restored into a new run; the original stays intact.
Current models and shell permissions apply, with fresh cost/call limits. Pending
tool calls are marked interrupted rather than automatically rerun. Ctrl+N starts
fresh instead.

## Development

```sh
bun --no-env-file test
bun run typecheck
```

## Documentation

- [Accounts and model selection](docs/accounts.md)
- [Configuration, limits, and costs](docs/configuration.md)
- [Repair benchmarks and grading](docs/benchmarks.md)
- [Architecture, tools, and traces](docs/architecture.md)
- [Pixel logo and asset generation](docs/logo.md)
