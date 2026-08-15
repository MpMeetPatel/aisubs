import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createSubscriptionAuth, SubscriptionAuth } from "./auth.js";
import { defaultAiSubsDataDir, FileCredentialStore, MemoryCredentialStore } from "./store.js";
import type { OAuthCredential, ProviderAdapter, ProviderLogin } from "./types.js";

const expired = (token = "old"): OAuthCredential => ({
  accessToken: token,
  refreshToken: "refresh",
  expiresAt: 1,
});

function adapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: "test",
    name: "Test",
    loginModes: ["device"],
    async startLogin(): Promise<ProviderLogin> {
      return {
        prompt: {
          mode: "device",
          verificationUri: "https://example.test/device",
          userCode: "ABCD",
          expiresAt: Date.now() + 60_000,
        },
        complete: Promise.resolve({ accessToken: "signed-in", expiresAt: Date.now() + 60_000 }),
      };
    },
    async refresh() {
      return { accessToken: "fresh", refreshToken: "rotated", expiresAt: Date.now() + 60_000 };
    },
    authorize(request, credential) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${credential.accessToken}`);
      return new Request(request, { headers });
    },
    ...overrides,
  };
}

describe("SubscriptionAuth", () => {
  test("uses the default file store when no store is provided", () => {
    const auth = createSubscriptionAuth({ providers: [adapter()] });

    expect(auth.store).toBeInstanceOf(FileCredentialStore);
    expect((auth.store as FileCredentialStore).file).toBe(
      join(defaultAiSubsDataDir(), "credentials.json"),
    );
  });

  test("signs in and returns a secret-free session", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [adapter()]);
    const attempt = await auth.signIn("test");
    expect(attempt.prompt.userCode).toBe("ABCD");
    await expect(attempt.wait()).resolves.toMatchObject({ provider: "test", authenticated: true });
    expect(await auth.status("test")).not.toHaveProperty("accessToken");
  });

  test("reports credential health without exposing either token", async () => {
    const store = new MemoryCredentialStore();
    await store.modify("test", () => ({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: Date.now() + 60_000,
      account: { id: "account-1", email: "person@example.com" },
    }));
    const auth = new SubscriptionAuth(store, [adapter()]);
    const summary = await auth.credentialSummary("test");
    expect(summary).toMatchObject({
      accessCredentialStored: true,
      refreshCredentialStored: true,
      automaticRefresh: true,
      account: { id: "account-1", email: "person@example.com" },
    });
    expect(JSON.stringify(summary)).not.toContain("access-secret");
    expect(JSON.stringify(summary)).not.toContain("refresh-secret");
  });

  test("normalizes account-scoped model results", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [
      adapter({ getModels: async () => [{ id: "model-1", contextWindow: 128_000 }] }),
    ]);
    await (await auth.account("test", "work").signIn()).wait();
    await expect(auth.account("test", "work").getModels()).resolves.toMatchObject({
      provider: "test",
      accountKey: "work",
      models: [{ id: "model-1", contextWindow: 128_000 }],
    });
  });

  test("caches private metadata briefly and clears it when the account changes", async () => {
    const getUsage = vi.fn(async () => ({ meters: [] }));
    const getModels = vi.fn(async () => [{ id: "model-1" }]);
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [
      adapter({ getUsage, getModels }),
    ]);
    await (await auth.signIn("test")).wait();

    await Promise.all([auth.getUsage("test"), auth.getUsage("test")]);
    await Promise.all([auth.getModels("test"), auth.getModels("test")]);
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getModels).toHaveBeenCalledTimes(1);

    await auth.getUsage("test");
    await auth.getModels("test");
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getModels).toHaveBeenCalledTimes(1);

    await auth.signOut("test");
    await (await auth.signIn("test")).wait();
    await auth.getModels("test");
    expect(getModels).toHaveBeenCalledTimes(2);
  });

  test("loads all safe account details through the account API", async () => {
    const getUsage = vi.fn(async () => ({ account: { email: "person@example.com" }, meters: [] }));
    const getModels = vi.fn(async () => [{ id: "model-1" }]);
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [
      adapter({ getUsage, getModels }),
    ]);
    const account = auth.account("test", "work");
    await (await account.signIn()).wait();

    const details = await account.details();
    expect(details).toMatchObject({
      session: { provider: "test", accountKey: "work", authenticated: true },
      credential: { provider: "test", accountKey: "work", accessCredentialStored: true },
      usage: { meters: [] },
      models: { models: [{ id: "model-1" }] },
    });
    expect(JSON.stringify(details)).not.toContain("signed-in");
    await account.details();
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getModels).toHaveBeenCalledTimes(1);
  });

  test("deduplicates concurrent refresh through the credential store", async () => {
    const store = new MemoryCredentialStore();
    await store.modify("test", () => expired());
    const refresh = vi.fn(async () => ({
      accessToken: "fresh",
      refreshToken: "rotated",
      expiresAt: Date.now() + 60_000,
    }));
    const auth = new SubscriptionAuth(store, [adapter({ refresh })]);
    await expect(
      Promise.all(Array.from({ length: 20 }, () => auth.getAccessToken("test"))),
    ).resolves.toEqual(Array(20).fill("fresh"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("refreshes and retries exactly once after a 401", async () => {
    const store = new MemoryCredentialStore();
    await store.modify("test", () => ({ accessToken: "old", expiresAt: Date.now() + 60_000 }));
    const refresh = vi.fn(async () => ({ accessToken: "fresh", expiresAt: Date.now() + 60_000 }));
    const auth = new SubscriptionAuth(store, [adapter({ refresh })]);
    const realFetch = globalThis.fetch;
    const calls: Array<{
      authorization: string;
      cacheControl: string | null;
      cache: RequestCache;
    }> = [];
    let rejected: Response | undefined;
    globalThis.fetch = vi.fn(async (request: Request) => {
      calls.push({
        authorization: request.headers.get("authorization") ?? "",
        cacheControl: request.headers.get("cache-control"),
        cache: request.cache,
      });
      const response = new Response(calls.length === 1 ? "expired" : null, {
        status: calls.length === 1 ? 401 : 200,
      });
      if (calls.length === 1) rejected = response;
      return response;
    }) as typeof fetch;
    try {
      expect((await auth.fetch("test", "https://example.test/models")).status).toBe(200);
      expect(calls).toEqual([
        { authorization: "Bearer old", cacheControl: "no-store", cache: "no-store" },
        { authorization: "Bearer fresh", cacheControl: "no-store", cache: "no-store" },
      ]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(rejected?.bodyUsed).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("maps a local account proxy path to its provider endpoint", async () => {
    const store = new MemoryCredentialStore();
    await store.modify("test", () => ({ accessToken: "secret", expiresAt: Date.now() + 60_000 }));
    const auth = new SubscriptionAuth(store, [
      adapter({ proxyBaseUrl: "https://example.test/v1" }),
    ]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (request: Request) =>
      Response.json({ url: request.url, authorization: request.headers.get("authorization") }),
    ) as typeof fetch;
    try {
      await expect(
        (await auth.account("test", "default").proxy("chat/completions")).json(),
      ).resolves.toEqual({
        url: "https://example.test/v1/chat/completions",
        authorization: "Bearer secret",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("retries a translated local proxy request without losing its body", async () => {
    const store = new MemoryCredentialStore();
    await store.modify("test", () => ({ accessToken: "old", expiresAt: Date.now() + 60_000 }));
    let calls = 0;
    let rejected: Response | undefined;
    const proxy = vi.fn(async (request: Request) => {
      const response = Response.json(
        { body: await request.text() },
        { status: calls++ === 0 ? 401 : 200 },
      );
      if (response.status === 401) rejected = response;
      return response;
    });
    const auth = new SubscriptionAuth(store, [
      adapter({
        proxy,
        refresh: async () => ({ accessToken: "fresh", expiresAt: Date.now() + 60_000 }),
      }),
    ]);

    await expect(
      (
        await auth.proxy("test", "default", "chat/completions", { method: "POST", body: "payload" })
      ).json(),
    ).resolves.toEqual({ body: "payload" });
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(rejected?.bodyUsed).toBe(true);
  });

  test("removes permanent refresh failures but preserves transient ones", async () => {
    const permanentStore = new MemoryCredentialStore();
    await permanentStore.modify("test", () => expired());
    const permanent = new Error("revoked");
    const permanentAuth = new SubscriptionAuth(permanentStore, [
      adapter({
        refresh: async () => Promise.reject(permanent),
        isPermanentRefreshError: (error) => error === permanent,
      }),
    ]);
    await expect(permanentAuth.getAccessToken("test")).rejects.toThrow(/sign in again/);
    expect((await permanentAuth.status("test")).authenticated).toBe(false);

    const transientStore = new MemoryCredentialStore();
    await transientStore.modify("test", () => expired());
    const transientAuth = new SubscriptionAuth(transientStore, [
      adapter({ refresh: async () => Promise.reject(new Error("offline")) }),
    ]);
    await expect(transientAuth.getAccessToken("test")).rejects.toThrow("offline");
    expect((await transientAuth.status("test")).authenticated).toBe(true);
  });

  test("logout wins over a login already in flight", async () => {
    let finish!: (credential: OAuthCredential) => void;
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [
      adapter({
        async startLogin() {
          return {
            prompt: {
              mode: "device",
              verificationUri: "https://example.test/device",
              userCode: "ABCD",
              expiresAt: Date.now() + 60_000,
            },
            complete: new Promise((resolve) => {
              finish = resolve;
            }),
          };
        },
      }),
    ]);
    const attempt = await auth.signIn("test");
    await auth.signOut("test");
    finish({ accessToken: "late", expiresAt: Date.now() + 60_000 });
    await expect(attempt.wait()).rejects.toThrow("Login cancelled");
    expect((await auth.status("test")).authenticated).toBe(false);
  });

  test("cancels a pending login by id", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [
      adapter({
        async startLogin(signal) {
          return {
            prompt: {
              mode: "device",
              verificationUri: "https://example.test/device",
              userCode: "ABCD",
              expiresAt: Date.now() + 60_000,
            },
            complete: new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
            }),
          };
        },
      }),
    ]);
    const attempt = await auth.signIn("test");
    expect(auth.cancelLoginAttempt(attempt.id)).toBe(true);
    await expect(attempt.wait()).rejects.toThrow("cancelled");
    expect(auth.cancelLoginAttempt(attempt.id)).toBe(false);
  });

  test("a stale login cannot delete a newer successful login", async () => {
    let finishFirst!: (credential: OAuthCredential) => void;
    let finishSecond!: (credential: OAuthCredential) => void;
    const completions = [
      new Promise<OAuthCredential>((resolve) => {
        finishFirst = resolve;
      }),
      new Promise<OAuthCredential>((resolve) => {
        finishSecond = resolve;
      }),
    ];
    let next = 0;
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [
      adapter({
        async startLogin() {
          return {
            prompt: {
              mode: "device",
              verificationUri: "https://example.test/device",
              userCode: "ABCD",
              expiresAt: Date.now() + 60_000,
            },
            complete: completions[next++]!,
          };
        },
      }),
    ]);
    const first = await auth.signIn("test");
    const second = await auth.signIn("test");
    finishSecond({ accessToken: "new", expiresAt: Date.now() + 60_000 });
    await second.wait();
    finishFirst({ accessToken: "stale", expiresAt: Date.now() + 60_000 });

    await expect(first.wait()).rejects.toThrow("Login cancelled");
    await expect(auth.getAccessToken("test")).resolves.toBe("new");
  });

  test("expires settled login attempts after the polling window", async () => {
    vi.useFakeTimers();
    try {
      const auth = new SubscriptionAuth(new MemoryCredentialStore(), [adapter()]);
      const attempt = await auth.signIn("test");
      await attempt.wait();
      expect(auth.getLoginAttempt(attempt.id)?.state).toBe("complete");

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(auth.getLoginAttempt(attempt.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds refresh duration and aborts refresh when signing out", async () => {
    const timeoutStore = new MemoryCredentialStore();
    await timeoutStore.modify("test", () => expired());
    const waitForAbort = (_credential: OAuthCredential, signal: AbortSignal) =>
      new Promise<OAuthCredential>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const timeoutAuth = new SubscriptionAuth(timeoutStore, [adapter({ refresh: waitForAbort })], {
      refreshTimeoutMs: 10,
    });
    await expect(timeoutAuth.getAccessToken("test")).rejects.toThrow();
    expect((await timeoutAuth.status("test")).authenticated).toBe(true);

    const logoutStore = new MemoryCredentialStore();
    await logoutStore.modify("test", () => expired());
    const logoutAuth = new SubscriptionAuth(logoutStore, [adapter({ refresh: waitForAbort })]);
    const refreshing = logoutAuth.getAccessToken("test");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await logoutAuth.signOut("test");
    await expect(refreshing).rejects.toThrow();
    expect((await logoutAuth.status("test")).authenticated).toBe(false);
  });

  test("isolates three accounts of one provider", async () => {
    const provider = adapter({
      async startLogin(_signal, options) {
        const token = String(options?.token);
        return {
          prompt: {
            mode: "device",
            verificationUri: "https://example.test/device",
            userCode: "ABCD",
            expiresAt: Date.now() + 60_000,
          },
          complete: Promise.resolve({ accessToken: token, expiresAt: Date.now() + 60_000 }),
        };
      },
      async getUsage({ credential }) {
        return {
          meters: [
            {
              id: "requests",
              label: "Requests",
              unit: "requests",
              used: credential.accessToken === "work-token" ? 10 : 20,
            },
          ],
        };
      },
    });
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    const work = auth.account("test", "work");
    const personal = auth.account("test", "personal");
    const third = auth.account("test", "account-3");
    await (await work.signIn({ token: "work-token" })).wait();
    await (await personal.signIn({ token: "personal-token" })).wait();
    await (await third.signIn({ token: "third-token" })).wait();

    await expect(work.getAccessToken()).resolves.toBe("work-token");
    await expect(personal.getAccessToken()).resolves.toBe("personal-token");
    await expect(third.getAccessToken()).resolves.toBe("third-token");
    await expect(work.getUsage()).resolves.toMatchObject({
      provider: "test",
      accountKey: "work",
      meters: [{ used: 10 }],
    });
    expect((await auth.listAccounts("test")).map((item) => item.accountKey).sort()).toEqual([
      "account-3",
      "personal",
      "work",
    ]);

    await work.signOut();
    expect((await work.status()).authenticated).toBe(false);
    expect((await personal.status()).authenticated).toBe(true);
  });

  test("can protect an existing account slot from accidental replacement", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [adapter()]);
    await (await auth.signIn("test")).wait();

    await expect(auth.signIn("test", { replace: false })).rejects.toThrow(
      "Account name default is already connected",
    );
    await expect(auth.getAccessToken("test")).resolves.toBe("signed-in");
  });

  test("preserves an account as reauthentication-required after permanent refresh failure", async () => {
    const store = new MemoryCredentialStore();
    await store.modify("test", () => ({
      accessToken: "old",
      refreshToken: "expired",
      expiresAt: 1,
      account: { label: "Personal" },
    }));
    const auth = new SubscriptionAuth(store, [
      adapter({
        async refresh() {
          throw new Error("invalid_grant");
        },
        isPermanentRefreshError: () => true,
      }),
    ]);

    await expect(auth.getAccessToken("test")).rejects.toThrow("Session expired");
    await expect(auth.status("test")).resolves.toMatchObject({
      authenticated: false,
      reauthRequired: true,
      account: { label: "Personal" },
    });
    await expect(auth.credentialSummary("test")).resolves.toMatchObject({
      accessCredentialStored: false,
      refreshCredentialStored: false,
      automaticRefresh: false,
      reauthRequired: true,
    });
    expect(await store.read("test")).toMatchObject({
      accessToken: "",
      metadata: { reauthRequired: true },
    });
    expect(await store.read("test")).not.toHaveProperty("refreshToken");
  });
});
