import type { CredentialStore, OAuthCredential, ProviderId } from "./types.js";

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<ProviderId, OAuthCredential>();
  private readonly queues = new Map<ProviderId, Promise<void>>();

  async read(provider: ProviderId): Promise<OAuthCredential | null> {
    return this.values.get(provider) ?? null;
  }

  async listKeys(): Promise<string[]> {
    return [...this.values.keys()];
  }

  async modify(
    provider: ProviderId,
    update: (
      current: OAuthCredential | null,
    ) => OAuthCredential | null | Promise<OAuthCredential | null>,
  ): Promise<OAuthCredential | null> {
    const previous = this.queues.get(provider) ?? Promise.resolve();
    let result: OAuthCredential | null = null;
    const current = previous.then(async () => {
      result = await update(this.values.get(provider) ?? null);
      if (result) this.values.set(provider, result);
      else this.values.delete(provider);
    });
    const settled = current.catch(() => {});
    this.queues.set(provider, settled);
    try {
      await current;
    } finally {
      if (this.queues.get(provider) === settled) this.queues.delete(provider);
    }
    return result;
  }

  async delete(provider: ProviderId): Promise<void> {
    await this.modify(provider, () => null);
  }
}
