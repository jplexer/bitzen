# Accounts and models

Start `bun run tui` and use `/login`. New installations open the login picker
automatically. After connecting, `/model` selects Captain and Crewmate models;
first-time setup walks through both roles.

## OpenRouter

Use `/login openrouter` for browser sign-in or masked API-key entry. Browser login
uses [OpenRouter's PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth).

`/logout openrouter` removes the local credential. It does not revoke the key at
OpenRouter; revoke it there if needed.

## ChatGPT

Use `/login openai` and choose **Continue with ChatGPT**. Approve Bitzen and plan
usage in the browser, then choose models available to that account. Availability
depends on the plan and workspace. Bitzen does not fall back to API-key billing.

| Command | Action |
| --- | --- |
| `/account` | List saved ChatGPT accounts with stable numbers |
| `/account 2` | Select a saved account |
| `/account new` | Connect another account or workspace |
| `/usage` | Open [ChatGPT usage settings](https://chatgpt.com/settings/usage) |
| `/logout openai` | Clear the selected session and attempt remote revocation |

Logout retains the account registration and host ID for later sign-in; other
saved accounts remain connected. If remote revocation cannot be confirmed,
disconnect Bitzen in ChatGPT settings.

The adapter uses OpenAI's [public Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source)
with dynamic registration, PKCE, verified identity, and automatic token renewal.
Refreshes are serialized across agents and Bitzen processes to protect rotating
tokens. The adapter streams Responses with client-managed history, retaining
opaque reasoning and waiting for final success before executing tool calls.

## Model picker

Ctrl+P or `/model` opens the picker. Tab switches roles; Up/Down and Enter select
a model. Ctrl+R refreshes the catalogue. Escape preserves your task draft.
Only connected providers are queried. You can enter an exact model ID if a
catalogue is unavailable.

OpenRouter lists text models that advertise tool calling and displays context
size and prices when available. ChatGPT lists models available to the selected
account. Model choices are saved for future tasks and launches.

For direct changes, use `/model captain vendor/model` or
`/model crewmate vendor/model`. Switch accounts, models, and modes while idle;
finish or cancel the active task first. See [configuration](configuration.md)
for launch-time overrides.

## Local profile

The profile lives under `~/.config/bitzen/` or `$XDG_CONFIG_HOME/bitzen`:

- `credentials.json`: provider keys, ChatGPT tokens, and account registrations.
- `settings.json`: model choices.

The directory uses permissions `0700`; files use `0600`. Credentials are private
but stored as unencrypted JSON. Login secrets do not enter chat messages, model
prompts, or run traces. Default launches ignore `.env` credentials and models.
