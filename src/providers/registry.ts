import type { AccountManager } from "../login.ts";
import { defaultAccounts } from "../login.ts";
import { OpenRouter } from "./openrouter.ts";
import { OpenAI } from "./openai.ts";
import type { Provider } from "./types.ts";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): this {
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): Provider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}. Registered: ${[...this.providers.keys()].join(", ")}`);
    return provider;
  }

  list(): Provider[] { return [...this.providers.values()]; }
}

export function defaultProviders(accounts: AccountManager = defaultAccounts()): ProviderRegistry {
  return new ProviderRegistry().register(new OpenRouter(accounts.credentials("openrouter"))).register(new OpenAI(accounts.credentials("openai")));
}
