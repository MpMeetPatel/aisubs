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

  test("provides an account-scoped OpenAI-compatible v1 surface without embeddings", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    await (await auth.account("test", "work").signIn()).wait();
    const proxy = vi.spyOn(auth, "proxy").mockResolvedValue(new Response(null, { status: 204 }));
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });
    const headers = { authorization: "Bearer secret" };

    const models = await fetch(`${running.url}/aisubs/test/work/v1/models`, { headers });
    await expect(models.json()).resolves.toEqual({
      object: "list",
      data: [{ id: "test-model", object: "model", owned_by: "test" }],
    });
    const response = await fetch(`${running.url}/aisubs/test/work/v1/chat/completions`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(204);
    expect(proxy).toHaveBeenCalledWith("test", "work", "chat/completions", expect.any(Object));
    const embeddings = await fetch(`${running.url}/aisubs/test/work/v1/embeddings`, {
      method: "POST",
      headers,
    });
    expect(embeddings.status).toBe(404);
  });

  test("adapts Handy-style Chat Completions to ChatGPT Responses", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    const proxy = vi
      .spyOn(auth, "proxy")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_text.delta","delta":"Polished "}',
            'data: {"type":"response.output_text.delta","delta":"transcript"}',
            'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-test","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
      );
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });

    const response = await fetch(`${running.url}/aisubs/chatgpt/work/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        reasoning_effort: "none",
        messages: [
          { role: "system", content: "Improve the transcription." },
          { role: "user", content: "raw transcript" },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "transcription_output", strict: true, schema: { type: "object" } },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "resp_1",
      model: "gpt-test",
      choices: [{ message: { role: "assistant", content: "Polished transcript" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
    expect(proxy).toHaveBeenCalledWith("chatgpt", "work", "responses", expect.any(Object));
    const upstream = JSON.parse(String(proxy.mock.calls[0]?.[3]?.body)) as Record<string, unknown>;
    expect(upstream).toMatchObject({
      model: "gpt-test",
      store: false,
      stream: true,
      instructions: "Improve the transcription.",
      input: [{ role: "user", content: [{ type: "input_text", text: "raw transcript" }] }],
      text: {
        format: {
          type: "json_schema",
          name: "transcription_output",
          strict: true,
          schema: { type: "object" },
        },
      },
    });
  });

  test("passes native ChatGPT Responses through unchanged", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    const proxy = vi.spyOn(auth, "proxy").mockResolvedValue(new Response(null, { status: 204 }));
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });
    const body = JSON.stringify({ model: "gpt-test", input: "hello", stream: true });

    const response = await fetch(`${running.url}/aisubs/chatgpt/work/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(204);
    expect(proxy).toHaveBeenCalledWith(
      "chatgpt",
      "work",
      "responses",
      expect.objectContaining({ body: Buffer.from(body) }),
    );
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
