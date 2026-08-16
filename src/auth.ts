import type {
  CredentialStore,
  CredentialSummary,
  LoginAttempt,
  LoginState,
  OAuthCredential,
  ProviderAdapter,
  ProviderId,
  ProviderLogin,
  ProviderModels,
  ProviderSummary,
  ProviderUsage,
  Session,
  SubscriptionAccountDetails,
} from "./types.js";
import { defaultAiSubsDataDir, FileCredentialStore } from "./store.js";
import { errorMessage } from "./utils.js";
import { join } from "node:path";

type AttemptRecord = {
  id: string;
  provider: ProviderId;
  accountKey: string;
  scope: string;
  state: LoginState;
  error: string | null;
  abort: AbortController;
  promise: Promise<Session>;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export interface SubscriptionAuthOptions {
  refreshTimeoutMs?: number;
  /** Successful usage snapshots stay in memory briefly; credentials never do. */
  usageCacheTtlMs?: number;
  /** Successful model catalogs stay in memory briefly; credentials never do. */
  modelsCacheTtlMs?: number;
}

export const DEFAULT_ACCOUNT = "default";
const ACCOUNT_STORAGE_PREFIX = "$subscription-account$";
const LOGIN_ATTEMPT_RETENTION_MS = 5 * 60_000;

function normalizeAccountKey(value: unknown): string {
  if (value == null) return DEFAULT_ACCOUNT;
  if (typeof value !== "string") throw new Error("account must be a string");
  const account = value.trim();
  const hasControlCharacter = [...account].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!account || account.length > 128 || hasControlCharacter) {
    throw new Error("account must be 1-128 characters without control characters");
  }
  return account;
}

function createRequest(input: string | URL | Request, init?: RequestInit): Request {
  return new Request(
    input,
    init?.body instanceof ReadableStream
      ? ({ ...init, duplex: "half" } as RequestInit & { duplex: "half" })
      : init,
  );
}

function credentialKey(provider: ProviderId, accountKey: string): ProviderId {
  if (accountKey === DEFAULT_ACCOUNT) return provider;
  return `${ACCOUNT_STORAGE_PREFIX}${Buffer.from(JSON.stringify([provider, accountKey])).toString("base64url")}`;
}

function accountFromCredentialKey(provider: ProviderId, key: string): string | null {
  if (key === provider) return DEFAULT_ACCOUNT;
  if (!key.startsWith(ACCOUNT_STORAGE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(key.slice(ACCOUNT_STORAGE_PREFIX.length), "base64url").toString("utf8"),
    );
    return Array.isArray(parsed) && parsed[0] === provider && typeof parsed[1] === "string"
      ? parsed[1]
      : null;
  } catch {
    return null;
  }
}

function session(
  provider: ProviderId,
  accountKey: string,
  credential: OAuthCredential | null,
): Session {
  return credential
    ? {
        provider,
        accountKey,
        authenticated: credential.metadata?.reauthRequired !== true,
        reauthRequired: credential.metadata?.reauthRequired === true,
        expiresAt: credential.expiresAt,
        needsRefresh: credential.expiresAt <= Date.now(),
        account: credential.account,
      }
    : { provider, accountKey, authenticated: false };
}

export interface SubscriptionAccount {
  readonly provider: ProviderId;
  readonly accountKey: string;
  signIn(options?: Record<string, unknown>): Promise<LoginAttempt>;
  status(options?: { validate?: boolean }): Promise<Session>;
  signOut(): Promise<void>;
  getAccessToken(): Promise<string>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  proxy(path: string, init?: RequestInit): Promise<Response>;
  getUsage(signal?: AbortSignal): Promise<ProviderUsage | null>;
  getModels(signal?: AbortSignal): Promise<ProviderModels | null>;
  credentialSummary(): Promise<CredentialSummary>;
  details(signal?: AbortSignal): Promise<SubscriptionAccountDetails>;
}

export class SubscriptionAuth {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly generations = new Map<ProviderId, number>();
  private readonly refreshes = new Map<ProviderId, Set<AbortController>>();
  private readonly usageCache = new Map<string, CacheEntry<ProviderUsage | null>>();
  private readonly modelsCache = new Map<string, CacheEntry<ProviderModels>>();
  private readonly usageInflight = new Map<string, Promise<ProviderUsage | null>>();
  private readonly modelsInflight = new Map<string, Promise<ProviderModels>>();
  private readonly metadataGenerations = new Map<string, number>();
  private readonly refreshTimeoutMs: number;
  private readonly usageCacheTtlMs: number;
  private readonly modelsCacheTtlMs: number;

  constructor(
    readonly store: CredentialStore,
    providers: readonly ProviderAdapter[],
    options: SubscriptionAuthOptions = {},
  ) {
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 30_000;
    this.usageCacheTtlMs = options.usageCacheTtlMs ?? 15_000;
    this.modelsCacheTtlMs = options.modelsCacheTtlMs ?? 5 * 60_000;
    for (const [name, value] of Object.entries({
      refreshTimeoutMs: this.refreshTimeoutMs,
      usageCacheTtlMs: this.usageCacheTtlMs,
      modelsCacheTtlMs: this.modelsCacheTtlMs,
    })) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${name} must be greater than zero`);
    }
    for (const provider of providers) {
      if (this.adapters.has(provider.id)) throw new Error(`Duplicate provider: ${provider.id}`);
      this.adapters.set(provider.id, provider);
    }
  }

  listProviders(): ProviderSummary[] {
    return [...this.adapters.values()].map(
      ({
        id,
        name,
        loginModes,
        description,
        homepage,
        allowedHosts,
        loginFields,
        supportsFetch,
        proxyBaseUrl,
        proxy,
        getUsage,
        getModels,
      }) => ({
        id,
        name,
        loginModes,
        description,
        homepage,
        allowedHosts,
        loginFields,
        supportsFetch: supportsFetch !== false,
        supportsProxy: Boolean(proxyBaseUrl || proxy),
        supportsUsage: Boolean(getUsage),
        supportsModels: Boolean(getModels),
      }),
    );
  }

  private adapter(provider: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Unknown subscription provider: ${provider}`);
    return adapter;
  }

  private generation(scope: string): number {
    return this.generations.get(scope) ?? 0;
  }

  private advance(scope: string): number {
    const next = this.generation(scope) + 1;
    this.generations.set(scope, next);
    return next;
  }

  private clearMetadata(scope: string): void {
    this.usageCache.delete(scope);
    this.modelsCache.delete(scope);
    this.usageInflight.delete(scope);
    this.modelsInflight.delete(scope);
    this.metadataGenerations.set(scope, (this.metadataGenerations.get(scope) ?? 0) + 1);
  }

  private cachedMetadata<T>(
    cache: Map<string, CacheEntry<T>>,
    inflight: Map<string, Promise<T>>,
    scope: string,
    ttlMs: number,
    callerSignal: AbortSignal | undefined,
    load: () => Promise<T>,
  ): Promise<T> {
    const cached = cache.get(scope);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    if (!callerSignal) {
      const pending = inflight.get(scope);
      if (pending) return pending;
    }
    const generation = this.metadataGenerations.get(scope) ?? 0;
    let request!: Promise<T>;
    request = load()
      .then((value) => {
        if ((this.metadataGenerations.get(scope) ?? 0) === generation) {
          cache.set(scope, { value, expiresAt: Date.now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
        if (inflight.get(scope) === request) inflight.delete(scope);
      });
    if (!callerSignal) inflight.set(scope, request);
    return request;
  }

  async signIn(provider: ProviderId, options?: Record<string, unknown>): Promise<LoginAttempt> {
    const adapter = this.adapter(provider);
    const accountKey = normalizeAccountKey(options?.account);
    const scope = credentialKey(provider, accountKey);
    const replace = options?.replace !== false;
    if (!replace && (await this.store.read(scope))) {
      throw new Error(`Account name ${accountKey} is already connected for ${provider}`);
    }
    const epoch = this.advance(scope);
    for (const attempt of this.attempts.values()) {
      if (attempt.scope === scope && attempt.state === "pending") attempt.abort.abort();
    }
    const abort = new AbortController();
    const providerOptions = { ...options };
    delete providerOptions.account;
    delete providerOptions.replace;
    const login: ProviderLogin = await adapter.startLogin(abort.signal, providerOptions);
    const id = crypto.randomUUID();
    const record = {} as AttemptRecord;
    const promise = login.complete
      .then(async (credential) => {
        const saved = await this.store.modify(scope, (current) => {
          if (this.generation(scope) !== epoch) return current;
          if (current && !replace) {
            throw new Error(`Account name ${accountKey} is already connected for ${provider}`);
          }
          return credential;
        });
        if (this.generation(scope) !== epoch || !saved) throw new Error("Login cancelled");
        this.clearMetadata(scope);
        record.state = "complete";
        return session(provider, accountKey, saved);
      })
      .catch((error) => {
        record.state = abort.signal.aborted ? "cancelled" : "failed";
        record.error = errorMessage(error);
        throw error;
      });
    void promise.catch(() => {});
    Object.assign(record, {
      id,
      provider,
      accountKey,
      scope,
      state: "pending" satisfies LoginState,
      error: null,
      abort,
      promise,
    });
    this.attempts.set(id, record);
    void promise.then(
      () => this.expireLoginAttempt(id),
      () => this.expireLoginAttempt(id),
    );
    return {
      id,
      provider,
      accountKey,
      prompt: login.prompt,
      get state() {
        return record.state;
      },
      get error() {
        return record.error;
      },
      wait: () => record.promise,
      cancel: () => {
        this.advance(scope);
        abort.abort();
      },
    };
  }

  private expireLoginAttempt(id: string): void {
    const timer = setTimeout(() => this.attempts.delete(id), LOGIN_ATTEMPT_RETENTION_MS);
    timer.unref();
  }

  getLoginAttempt(
    id: string,
  ): { provider: ProviderId; accountKey: string; state: LoginState; error: string | null } | null {
    const attempt = this.attempts.get(id);
    return attempt
      ? {
          provider: attempt.provider,
          accountKey: attempt.accountKey,
          state: attempt.state,
          error: attempt.error,
        }
      : null;
  }

  cancelLoginAttempt(id: string): boolean {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.state !== "pending") return false;
    this.advance(attempt.scope);
    attempt.abort.abort();
    return true;
  }

  async status(
    provider: ProviderId,
    options: { validate?: boolean; account?: string } = {},
  ): Promise<Session> {
    const accountKey = normalizeAccountKey(options.account);
    if (options.validate) await this.getAccessToken(provider, accountKey).catch(() => null);
    return session(
      provider,
      accountKey,
      await this.store.read(credentialKey(provider, accountKey)),
    );
  }

  async statuses(): Promise<Session[]> {
    const sessions = await Promise.all(
      [...this.adapters.keys()].map(async (provider) => {
        const accounts = await this.listAccounts(provider);
        return accounts.length ? accounts : [await this.status(provider)];
      }),
    );
    return sessions.flat();
  }

  async listAccounts(provider: ProviderId): Promise<Session[]> {
    this.adapter(provider);
    const keys = this.store.listKeys ? await this.store.listKeys() : [provider];
    const accounts = keys.flatMap((key) => {
      const account = accountFromCredentialKey(provider, key);
      return account == null ? [] : [account];
    });
    return Promise.all([...new Set(accounts)].map((account) => this.status(provider, { account })));
  }

  async signOut(provider: ProviderId, account = DEFAULT_ACCOUNT): Promise<void> {
    const accountKey = normalizeAccountKey(account);
    const scope = credentialKey(provider, accountKey);
    this.advance(scope);
    this.clearMetadata(scope);
    for (const refresh of this.refreshes.get(scope) ?? []) refresh.abort();
    for (const attempt of this.attempts.values()) {
      if (attempt.scope === scope && attempt.state === "pending") attempt.abort.abort();
    }
    await this.store.delete(scope);
  }

  private async credential(
    provider: ProviderId,
    account: string,
    forceRefresh = false,
  ): Promise<OAuthCredential> {
    const adapter = this.adapter(provider);
    const accountKey = normalizeAccountKey(account);
    const scope = credentialKey(provider, accountKey);
    const observed = await this.store.read(scope);
    if (!observed) throw new Error(`Not authenticated with ${provider} account ${accountKey}`);
    if (observed.metadata?.reauthRequired === true) {
      throw new Error(`Session expired for ${provider} account ${accountKey}; sign in again`);
    }
    if (!forceRefresh && observed.expiresAt > Date.now()) return observed;
    const epoch = this.generation(scope);
    const refreshed = await this.store.modify(scope, async (current) => {
      if (!current) throw new Error(`Not authenticated with ${provider} account ${accountKey}`);
      if (this.generation(scope) !== epoch) return current;
      if (current.accessToken !== observed.accessToken && current.expiresAt > Date.now()) {
        return current;
      }
      const abort = new AbortController();
      const active = this.refreshes.get(scope) ?? new Set<AbortController>();
      active.add(abort);
      this.refreshes.set(scope, active);
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.refreshTimeoutMs)]);
        const next = await adapter.refresh(current, signal);
        return this.generation(scope) === epoch ? next : current;
      } catch (error) {
        if (adapter.isPermanentRefreshError?.(error)) {
          return {
            accessToken: "",
            expiresAt: 0,
            account: current.account,
            metadata: { ...current.metadata, reauthRequired: true },
          };
        }
        throw error;
      } finally {
        active.delete(abort);
        if (active.size === 0) this.refreshes.delete(scope);
      }
    });
    if (this.generation(scope) !== epoch) {
      throw new Error(`Session changed while refreshing ${provider} account ${accountKey}`);
    }
    if (!refreshed || refreshed.metadata?.reauthRequired === true) {
      this.clearMetadata(scope);
      throw new Error(`Session expired for ${provider} account ${accountKey}; sign in again`);
    }
    this.clearMetadata(scope);
    return refreshed;
  }

  async getAccessToken(provider: ProviderId, account = DEFAULT_ACCOUNT): Promise<string> {
    const credential = await this.credential(provider, account);
    if (credential.metadata?.delegatedCli === true) {
      throw new Error(`${provider} authentication is delegated to its official CLI`);
    }
    return credential.accessToken;
  }

  async credentialSummary(
    provider: ProviderId,
    account = DEFAULT_ACCOUNT,
  ): Promise<CredentialSummary> {
    const adapter = this.adapter(provider);
    const accountKey = normalizeAccountKey(account);
    const credential = await this.store.read(credentialKey(provider, accountKey));
    if (!credential) throw new Error(`Not authenticated with ${provider} account ${accountKey}`);
    return {
      provider,
      accountKey,
      accessCredentialStored:
        Boolean(credential.accessToken) && credential.metadata?.delegatedCli !== true,
      refreshCredentialStored: Boolean(credential.refreshToken),
      automaticRefresh:
        Boolean(credential.refreshToken) || credential.metadata?.delegatedCli === true,
      expiresAt: credential.expiresAt,
      needsRefresh: credential.expiresAt <= Date.now(),
      externallyManaged: credential.metadata?.delegatedCli === true,
      reauthRequired: credential.metadata?.reauthRequired === true,
      endpoint:
        typeof adapter.proxyBaseUrl === "function"
          ? adapter.proxyBaseUrl(credential)
          : adapter.proxyBaseUrl,
      account: credential.account,
    };
  }

  async details(
    provider: ProviderId,
    account = DEFAULT_ACCOUNT,
    signal?: AbortSignal,
  ): Promise<SubscriptionAccountDetails> {
    const accountKey = normalizeAccountKey(account);
    const [session, credential, usage, models] = await Promise.all([
      this.status(provider, { account: accountKey }),
      this.credentialSummary(provider, accountKey),
      this.getUsage(provider, accountKey, signal),
      this.getModels(provider, accountKey, signal),
    ]);
    return { session, credential, usage, models };
  }

  async fetch(
    provider: ProviderId,
    input: string | URL | Request,
    init?: RequestInit,
    account = DEFAULT_ACCOUNT,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    const original = createRequest(input, init);
    const accountKey = normalizeAccountKey(account);
    const send = async (credential: OAuthCredential) => {
      const authorized = await adapter.authorize(original.clone(), credential);
      const headers = new Headers(authorized.headers);
      headers.set("cache-control", "no-store");
      const request = new Request(authorized, { cache: "no-store", headers });
      const response = await globalThis.fetch(request);
      return adapter.normalizeResponse?.(request, response) ?? response;
    };
    if (adapter.supportsFetch === false) {
      throw new Error(`${provider} does not expose credentials for direct provider requests`);
    }
    let response = await send(await this.credential(provider, accountKey));
    if (response.status === 401) {
      await response.body?.cancel();
      response = await send(await this.credential(provider, accountKey, true));
    }
    return response;
  }

  async proxy(
    provider: ProviderId,
    account: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    const accountKey = normalizeAccountKey(account);
    const credential = await this.credential(provider, accountKey);
    if (adapter.proxy) {
      const local = createRequest(`http://aisubs.local/${path.replace(/^\//, "")}`, init);
      let response = await adapter.proxy(local.clone(), credential);
      if (response.status === 401) {
        await response.body?.cancel();
        response = await adapter.proxy(
          local.clone(),
          await this.credential(provider, accountKey, true),
        );
      }
      return response;
    }
    const baseUrl =
      typeof adapter.proxyBaseUrl === "function"
        ? adapter.proxyBaseUrl(credential)
        : adapter.proxyBaseUrl;
    if (!baseUrl) throw new Error(`${provider} does not expose a direct API endpoint`);
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return this.fetch(provider, new URL(path, base), init, accountKey);
  }

  /** Build an authorized direct-provider request for transports such as WebSocket. */
  async authorizeProxyRequest(
    provider: ProviderId,
    account: string,
    path: string,
    init?: RequestInit,
  ): Promise<Request> {
    const adapter = this.adapter(provider);
    const accountKey = normalizeAccountKey(account);
    if (adapter.proxy) {
      throw new Error(`${provider} does not expose a direct transport endpoint`);
    }
    const credential = await this.credential(provider, accountKey);
    const baseUrl =
      typeof adapter.proxyBaseUrl === "function"
        ? adapter.proxyBaseUrl(credential)
        : adapter.proxyBaseUrl;
    if (!baseUrl) throw new Error(`${provider} does not expose a direct API endpoint`);
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return adapter.authorize(createRequest(new URL(path, base), init), credential);
  }

  async getUsage(
    provider: ProviderId,
    account = DEFAULT_ACCOUNT,
    callerSignal?: AbortSignal,
  ): Promise<ProviderUsage | null> {
    const adapter = this.adapter(provider);
    if (!adapter.getUsage) return null;
    const accountKey = normalizeAccountKey(account);
    const scope = credentialKey(provider, accountKey);
    return this.cachedMetadata(
      this.usageCache,
      this.usageInflight,
      scope,
      this.usageCacheTtlMs,
      callerSignal,
      async () => {
        const credential = await this.credential(provider, accountKey);
        const timeout = AbortSignal.timeout(this.refreshTimeoutMs);
        const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
        const data = await adapter.getUsage!({
          credential,
          signal,
          fetch: (input, init) => this.fetch(provider, input, init, accountKey),
        });
        return data ? { provider, accountKey, asOf: Date.now(), ...data } : null;
      },
    );
  }

  async getModels(
    provider: ProviderId,
    account = DEFAULT_ACCOUNT,
    callerSignal?: AbortSignal,
  ): Promise<ProviderModels | null> {
    const adapter = this.adapter(provider);
    if (!adapter.getModels) return null;
    const accountKey = normalizeAccountKey(account);
    const scope = credentialKey(provider, accountKey);
    return this.cachedMetadata(
      this.modelsCache,
      this.modelsInflight,
      scope,
      this.modelsCacheTtlMs,
      callerSignal,
      async () => {
        const credential = await this.credential(provider, accountKey);
        const timeout = AbortSignal.timeout(this.refreshTimeoutMs);
        const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
        const models = await adapter.getModels!({
          credential,
          signal,
          fetch: (input, init) => this.fetch(provider, input, init, accountKey),
        });
        return { provider, accountKey, asOf: Date.now(), models };
      },
    );
  }

  account(provider: ProviderId, account: string): SubscriptionAccount {
    const accountKey = normalizeAccountKey(account);
    this.adapter(provider);
    return {
      provider,
      accountKey,
      signIn: (options) => this.signIn(provider, { ...options, account: accountKey }),
      status: (options) => this.status(provider, { ...options, account: accountKey }),
      signOut: () => this.signOut(provider, accountKey),
      getAccessToken: () => this.getAccessToken(provider, accountKey),
      fetch: (input, init) => this.fetch(provider, input, init, accountKey),
      proxy: (path, init) => this.proxy(provider, accountKey, path, init),
      getUsage: (signal) => this.getUsage(provider, accountKey, signal),
      getModels: (signal) => this.getModels(provider, accountKey, signal),
      credentialSummary: () => this.credentialSummary(provider, accountKey),
      details: (signal) => this.details(provider, accountKey, signal),
    };
  }
}

export function createSubscriptionAuth(
  options: {
    store?: CredentialStore;
    providers: readonly ProviderAdapter[];
  } & SubscriptionAuthOptions,
): SubscriptionAuth {
  const store =
    options.store ?? new FileCredentialStore(join(defaultAiSubsDataDir(), "credentials.json"));
  return new SubscriptionAuth(store, options.providers, options);
}
