import { afterEach, describe, expect, test, vi } from "vitest";
import { SubscriptionAuth } from "./auth.js";
import { createSubscriptionAuthServer, type SubscriptionAuthServer } from "./http.js";
import { MemoryCredentialStore } from "./store.js";
import type { ProviderAdapter } from "./types.js";

const provider: ProviderAdapter = {
  id: "test",
  name: "Test",
  loginModes: ["device"],
  async startLogin() {
    return {
      prompt: {
        mode: "device",
        verificationUri: "https://example.test/device",
        userCode: "ABCD",
        expiresAt: Date.now() + 60_000,
      },
      complete: Promise.resolve({ accessToken: "token", expiresAt: Date.now() + 60_000 }),
    };
  },
  async refresh(credential) {
    return credential;
  },
  authorize(request) {
    return request;
  },
  async getUsage() {
    return {
      meters: [{ id: "requests", label: "Requests", unit: "requests", used: 7 }],
    };
  },
  async getModels() {
    return [{ id: "test-model", name: "Test model" }];
  },
};

let running: SubscriptionAuthServer | undefined;
afterEach(async () => running?.close());

describe("subscription auth HTTP server", () => {
  test("requires its control API key", async () => {
    running = await createSubscriptionAuthServer({
      auth: new SubscriptionAuth(new MemoryCredentialStore(), [provider]),
      apiKey: "secret",
    });
    expect((await fetch(`${running.url}/v1/providers`)).status).toBe(401);
    const response = await fetch(`${running.url}/v1/providers`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(await response.json()).toEqual({
      providers: [
        {
          id: "test",
          name: "Test",
          loginModes: ["device"],
          supportsFetch: true,
          supportsModels: true,
          supportsProxy: false,
          supportsUsage: true,
        },
      ],
    });
    expect(
      (
        await fetch(`${running.url}/v1/providers`, {
          headers: { "x-api-key": "secret" },
        })
      ).status,
    ).toBe(200);
  });

  test("exposes account-scoped sessions and usage", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    await (await auth.account("test", "work").signIn()).wait();
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });
    const headers = { authorization: "Bearer secret" };

    const accounts = await fetch(`${running.url}/v1/auth/test/accounts`, { headers });
    expect(await accounts.json()).toMatchObject({
      accounts: [{ provider: "test", accountKey: "work", authenticated: true }],
    });
    const usage = await fetch(`${running.url}/v1/usage/test?account=work`, { headers });
    expect(await usage.json()).toMatchObject({
      provider: "test",
      accountKey: "work",
      meters: [{ id: "requests", used: 7 }],
    });
    const details = await fetch(`${running.url}/v1/auth/test/details?account=work`, { headers });
    expect(await details.json()).toMatchObject({
      provider: "test",
      accountKey: "work",
      accessCredentialStored: true,
    });
    const models = await fetch(`${running.url}/v1/models/test?account=work`, { headers });
    expect(await models.json()).toMatchObject({
      provider: "test",
      accountKey: "work",
      models: [{ id: "test-model" }],
    });
  });

  test("streams decoded upstream bodies without forwarding cache or cookie headers", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    auth.fetch = async () =>
      new Response("decoded", {
        headers: {
          "content-encoding": "gzip",
          "content-length": "123",
          "cache-control": "public, max-age=86400",
          "set-cookie": "provider-session=secret",
          "x-upstream": "kept",
        },
      });
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });

    const response = await fetch(`${running.url}/v1/fetch/test`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ url: "https://example.test" }),
    });
    expect(await response.text()).toBe("decoded");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream")).toBe("kept");
  });

  test("strips local and proxy credentials before an upstream request", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    const proxy = vi.spyOn(auth, "proxy").mockResolvedValue(new Response(null, { status: 204 }));
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });

    const response = await fetch(`${running.url}/aisubs/test/default/models`, {
      headers: {
        authorization: "Bearer secret",
        origin: "https://client.example",
        "proxy-authorization": "Basic local-secret",
        "x-api-key": "local-secret",
        "x-client-feature": "kept",
      },
    });

    expect(response.status).toBe(204);
    expect(proxy).toHaveBeenCalledWith("test", "default", "models", expect.any(Object));
    const headers = new Headers(proxy.mock.calls[0]?.[3]?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-client-feature")).toBe("kept");
  });

  test("lets standalone clients configure the buffered proxy body limit", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    vi.spyOn(auth, "proxy").mockResolvedValue(new Response(null, { status: 204 }));
    running = await createSubscriptionAuthServer({
      auth,
      apiKey: "secret",
      maxProxyBodyBytes: 3,
    });

    const response = await fetch(`${running.url}/aisubs/test/default/responses`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: "four",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large" });
  });
});
