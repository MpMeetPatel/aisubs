import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
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
    expect(
      (
        await fetch(`${running.url}/v1/providers`, {
          headers: { "x-goog-api-key": "secret" },
        })
      ).status,
    ).toBe(200);
  });

  test("allows authenticated browser clients through CORS preflight", async () => {
    running = await createSubscriptionAuthServer({
      auth: new SubscriptionAuth(new MemoryCredentialStore(), [provider]),
      apiKey: "secret",
    });
    const response = await fetch(`${running.url}/aisubs/test/default/v1/chat/completions`, {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("tunnels authenticated Realtime WebSocket traffic to a native provider", async () => {
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => upstream.once("listening", resolve));
    const address = upstream.address();
    if (typeof address === "string") throw new Error("Expected a TCP WebSocket address");
    upstream.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer provider-secret");
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    vi.spyOn(auth, "authorizeProxyRequest").mockResolvedValue(
      new Request(`http://127.0.0.1:${address.port}/realtime`, {
        headers: { authorization: "Bearer provider-secret" },
      }),
    );
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });
    try {
      const socket = await running.app.injectWS(
        "/aisubs/test/default/v1/realtime?model=test-model",
        { headers: { authorization: "Bearer secret" } },
      );
      const echoed = new Promise<string>((resolve) =>
        socket.once("message", (data) => resolve(data.toString())),
      );
      socket.send("hello");
      await expect(echoed).resolves.toBe("hello");
      socket.terminate();
      expect(auth.authorizeProxyRequest).toHaveBeenCalledWith(
        "test",
        "default",
        "realtime?model=test-model",
        expect.any(Object),
      );
      const forwarded = new Headers(
        vi.mocked(auth.authorizeProxyRequest).mock.calls[0]?.[3]?.headers,
      );
      expect(forwarded.get("authorization")).toBeNull();
      expect(forwarded.get("x-api-key")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
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

    const google = await fetch(`${running.url}/aisubs/test/default/native?key=secret&alt=sse`, {
      headers: { "x-client-feature": "kept" },
    });
    expect(google.status).toBe(204);
    expect(proxy).toHaveBeenLastCalledWith("test", "default", "native?alt=sse", expect.any(Object));
  });

  test("provides account-scoped models and passes feature endpoints through", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    await (await auth.account("test", "work").signIn()).wait();
    const proxy = vi.spyOn(auth, "proxy").mockResolvedValue(new Response(null, { status: 204 }));
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });
    const headers = { authorization: "Bearer secret" };

    const models = await fetch(`${running.url}/aisubs/test/work/v1/models`, { headers });
    await expect(models.json()).resolves.toEqual({
      object: "list",
      data: [
        {
          id: "test-model",
          object: "model",
          owned_by: "test",
          capabilities: {
            endpoints: [],
            input_modalities: ["text"],
            reasoning_efforts: [],
            tools: false,
          },
        },
      ],
    });
    const model = await fetch(`${running.url}/aisubs/test/work/v1/models/test-model`, {
      headers,
    });
    await expect(model.json()).resolves.toMatchObject({
      id: "test-model",
      object: "model",
      owned_by: "test",
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
    expect(embeddings.status).toBe(204);
    expect(proxy).toHaveBeenCalledWith("test", "work", "embeddings", expect.any(Object));
  });

  test("shares the account model cache across discovery and compatible requests", async () => {
    const getModels = vi.fn(async () => [
      { id: "claude-test", endpoints: ["messages"], supportsToolCall: true },
    ]);
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [{ ...provider, getModels }]);
    await (await auth.account("test", "work").signIn()).wait();
    vi.spyOn(auth, "proxy").mockImplementation(async () =>
      Response.json({
        id: "msg_cache",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "cached catalog" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
    );
    running = await createSubscriptionAuthServer({ auth, apiKey: "secret" });
    const headers = {
      authorization: "Bearer secret",
      "content-type": "application/json",
    };

    expect(
      (
        await fetch(`${running.url}/aisubs/test/work/v1/models`, {
          headers,
        })
      ).status,
    ).toBe(200);
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${running.url}/aisubs/test/work/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-test",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      await expect(response.json()).resolves.toMatchObject({
        choices: [{ message: { content: "cached catalog" } }],
      });
    }
    expect(getModels).toHaveBeenCalledTimes(1);
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
        temperature: 0.7,
        top_p: 0.9,
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
    expect(proxy.mock.calls[0]?.[3]?.signal?.aborted).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      id: "chatcmpl_resp_1",
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
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "raw transcript" }],
        },
      ],
      reasoning: { effort: "none" },
      text: {
        format: {
          type: "json_schema",
          name: "transcription_output",
          strict: true,
          schema: { type: "object" },
        },
      },
    });
    expect(upstream).not.toHaveProperty("temperature");
    expect(upstream).not.toHaveProperty("top_p");
  });

  test("accepts text content parts from OpenAI-compatible clients", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    const proxy = vi
      .spyOn(auth, "proxy")
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"response.output_text.delta","delta":"Hello"}',
            'data: {"type":"response.completed","response":{"id":"resp_1"}}',
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
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(String(proxy.mock.calls[0]?.[3]?.body))).toMatchObject({
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    });
  });

  test("streams Chat Completions chunks for streaming clients", async () => {
    const auth = new SubscriptionAuth(new MemoryCredentialStore(), [provider]);
    vi.spyOn(auth, "proxy").mockResolvedValue(
      new Response(
        [
          'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-test","created_at":123}}',
          'data: {"type":"response.output_text.delta","delta":"Hello"}',
          'data: {"type":"response.output_text.delta","delta":" world"}',
          'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-test","created_at":123,"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
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
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const chunks = (await response.text()).split("\n\n").flatMap((event) => {
      const data = event.match(/^data: (.+)$/m)?.[1];
      return data && data !== "[DONE]" ? [JSON.parse(data) as Record<string, unknown>] : [];
    });
    expect(chunks).toMatchObject([
      {
        id: "chatcmpl_resp_1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      },
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]);
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

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringMatching(/too large/i) },
    });
  });
});
