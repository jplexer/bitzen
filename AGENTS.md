# Bitzen development

Bitzen is a Bun/TypeScript coding harness with an OpenTUI terminal interface.
Use Bun for installation, scripts, and tests; there is no web frontend.

- `bun install` installs dependencies.
- `bun run tui` starts the terminal interface.
- `bun --no-env-file test` runs the offline suite, including local OAuth callback tests.
- `bun run typecheck` checks TypeScript.
- `bun run demo` runs the scripted offline edit/test/review demo.

Login happens in the TUI with `/login`; default launches deliberately ignore
`.env`. Preserve that behavior and keep credentials out of prompts and traces.
User-facing roles are Captain and Crewmate; modes are `crew` and `single`.
Internal `lead` and `sidekick` keys remain part of configuration and saved traces.

The agent loop and tools live in `src/`, provider adapters in `src/providers/`,
and tests in `tests/`. Benchmark `.fixture` files are used by the independent
grader and fixture preparation; keep them separate from ordinary tests.
The logo source is `src/logo.ts`; `scripts/generate-logo.ts` regenerates its
SVG and terminal exports. See `README.md` for usage and architecture.
