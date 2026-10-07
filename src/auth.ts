// OAuth implementations can refresh their tokens here without changing agents.
export interface CredentialSource {
  readonly kind: "api-key" | "oauth";
  getToken(signal: AbortSignal): Promise<string>;
}

export class EnvironmentApiKey implements CredentialSource {
  readonly kind = "api-key";
  constructor(private readonly variable: string) {}

  async getToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const token = process.env[this.variable]?.trim();
    if (!token) throw new Error(`Set ${this.variable} to use this provider.`);
    return token;
  }
}
