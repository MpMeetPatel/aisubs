import { describe, expect, test, vi } from "vitest";
import { createServer } from "node:net";
import type { OAuthCredential } from "../types.js";
import { chatGptProvider } from "./chatgpt.js";
import { claudeProvider } from "./claude.js";
import { copilotProvider } from "./copilot.js";
import { grokProvider } from "./grok.js";
import { openCodeGoProvider, openCodeZenProvider, parseOpenCodeGoUsage } from "./opencode.js";

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

describe("built-in subscription providers", () => {
  test("OpenCode Go and Zen accept API keys and expose their separate model catalogs", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) {
        return Response.json({ tag_name: "v1.18.31" });
      }
      expect(String(input)).toMatch(/https:\/\/opencode\.ai\/zen\/(go\/)?v1\/models/);
      return Response.json({ data: [{ id: "kimi-k3", name: "Kimi K3" }] });
    });
    for (const [provider, url] of [
      [openCodeGoProvider({ fetch: fetcher }), "https://opencode.ai/zen/go/v1/models"],
      [openCodeZenProvider({ fetch: fetcher }), "https://opencode.ai/zen/v1/models"],
    ] as const) {
      const login = await provider.startLogin(new AbortController().signal, { apiKey: "key" });
      await expect(login.complete).resolves.toMatchObject({ accessToken: "key" });
      await expect(
        provider.getModels!({
          credential: { accessToken: "key", expiresAt: Date.now() + 60_000 },
          signal: new AbortController().signal,
          fetch: fetcher as typeof fetch,
        }),
      ).resolves.toEqual([
        {
          id: "kimi-k3",
          name: "Kimi K3",
          description: undefined,
          endpoints: undefined,
          available: true,
          selectable: true,
        },
      ]);
      const authorize = () =>
        provider.authorize(
          new Request(url, {
            headers: {
              "x-opencode-client": "core-loop",
              "x-opencode-session": "conversation-1",
              "x-opencode-request": "execution-1",
            },
          }),
          { accessToken: "key", expiresAt: Date.now() + 60_000 },
        );
      const authorized = await authorize();
      expect(authorized.headers.get("authorization")).toBe("Bearer key");
      expect(authorized.headers.get("user-agent")).toBe("opencode/latest/1.18.31/core-loop");
      expect(authorized.headers.get("x-opencode-session")).toMatch(
        /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
      );
      expect(authorized.headers.get("x-opencode-request")).toMatch(
        /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
      );
      expect((await authorize()).headers.get("x-opencode-session")).toBe(
        authorized.headers.get("x-opencode-session"),
      );
      expect((await authorize()).headers.get("x-opencode-request")).toBe(
        authorized.headers.get("x-opencode-request"),
      );
    }
  });

  test("OpenCode Go exposes provider-reported rolling, weekly, and monthly usage", async () => {
    const raw = {
      usage: {
        rolling: { status: "ok", percent: 25, resetsAt: "2026-08-14T12:00:00.000Z" },
        weekly: { status: "ok", percent: 40, resetsAt: "2026-08-17T00:00:00.000Z" },
        monthly: { status: "ok", percent: 10, resetsAt: "2026-09-01T00:00:00.000Z" },
      },
    };
    expect(parseOpenCodeGoUsage(raw)).toMatchObject({
      plan: "OpenCode Go",
      meters: [
        { id: "rolling", label: "5-hour limit", percentUsed: 25 },
        { id: "weekly", label: "Weekly limit", percentUsed: 40 },
        { id: "monthly", label: "Monthly limit", percentUsed: 10 },
      ],
    });
    const fetcher = vi.fn(async () => Response.json(raw));
    await expect(
      openCodeGoProvider().getUsage!({
        credential: { accessToken: "key", expiresAt: Date.now() + 60_000 },
        signal: new AbortController().signal,
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toMatchObject({ plan: "OpenCode Go" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://opencode.ai/zen/go/v1/usage");
  });

  test("OpenCode derives its compatibility user-agent from the current official release", async () => {
    let version = "v9.8.7";
    const fetcher = vi.fn(async () => Response.json({ tag_name: version }));
    const provider = openCodeZenProvider({
      fetch: fetcher,
    });
    const authorize = () =>
      provider.authorize(
        new Request("https://opencode.ai/zen/v1/responses", {
          headers: { "x-opencode-client": "core-loop" },
        }),
        { accessToken: "key", expiresAt: Date.now() + 60_000 },
      );
    expect((await authorize()).headers.get("user-agent")).toBe("opencode/latest/9.8.7/core-loop");
    version = "v9.8.8";
    expect((await authorize()).headers.get("user-agent")).toBe("opencode/latest/9.8.8/core-loop");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("OpenCode authorization fails instead of using a stale fallback version", async () => {
    const provider = openCodeZenProvider({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    });
    await expect(
      provider.authorize(new Request("https://opencode.ai/zen/v1/responses"), {
        accessToken: "key",
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow("OpenCode version lookup failed: 503");
  });

  test("OpenCode Zen explicitly reports that balance usage is console-only", async () => {
    await expect(
      openCodeZenProvider().getUsage!({
        credential: { accessToken: "key", expiresAt: Date.now() + 60_000 },
        signal: new AbortController().signal,
        fetch: vi.fn() as typeof fetch,
      }),
    ).resolves.toMatchObject({
      plan: "Pay as you go",
      note: expect.stringContaining("does not expose Zen balance"),
    });
  });

  test("OpenCode catalogs preserve declared wire protocols without guessing from model ids", async () => {
    const models = async (
      provider: ReturnType<typeof openCodeGoProvider>,
      rows: Record<string, unknown>[],
    ) =>
      provider.getModels!({
        credential: { accessToken: "key", expiresAt: Date.now() + 60_000 },
        signal: new AbortController().signal,
        fetch: async () => Response.json({ data: rows }),
      });
    await expect(
      models(openCodeGoProvider(), [
        { id: "declared", supported_endpoints: ["responses"] },
        { id: "undeclared" },
      ]),
    ).resolves.toMatchObject([
      { id: "declared", endpoints: ["responses"] },
      { id: "undeclared", endpoints: undefined },
    ]);
  });

  test("ChatGPT defaults to browser OAuth with PKCE and completes on the local callback", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/oauth/token");
      return Response.json({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-token",
        id_token: jwt({
          email: "person@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
            chatgpt_plan_type: "plus",
          },
        }),
      });
    });
    const provider = chatGptProvider({ fetch: fetcher as typeof fetch });
    expect(provider.loginModes).toEqual(["browser", "device"]);
    const login = await provider.startLogin(new AbortController().signal, { mode: "browser" });
    expect(login.prompt.mode).toBe("browser");
    if (login.prompt.mode !== "browser") throw new Error("Expected browser login");
    const authorization = new URL(login.prompt.authorizationUri);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    expect(["1455", "1457"]).toContain(callback.port);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    expect((await fetch(callback)).status).toBe(200);
    await expect(login.complete).resolves.toMatchObject({
      refreshToken: "refresh-token",
      account: {
        id: "acct-1",
        email: "person@example.com",
        label: "person@example.com",
        plan: "plus",
      },
    });
  });

  test("ChatGPT browser OAuth falls back to its second registered callback port", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "EADDRINUSE" ? resolve() : reject(error),
      );
      blocker.listen(1455, "127.0.0.1", resolve);
    });
    const controller = new AbortController();
    try {
      const login = await chatGptProvider().startLogin(controller.signal, { mode: "browser" });
      if (login.prompt.mode !== "browser") throw new Error("Expected browser login");
      const authorization = new URL(login.prompt.authorizationUri);
      expect(new URL(authorization.searchParams.get("redirect_uri")!).port).toBe("1457");
      controller.abort();
      await expect(login.complete).rejects.toThrow(/cancelled/);
    } finally {
      if (blocker.listening) blocker.close();
    }
  });

  test("ChatGPT maps the account model catalog to safe common fields", async () => {
    const provider = chatGptProvider({
      fetch: async () => new Response("", { status: 404 }),
    });
    const models = await provider.getModels!({
      credential: { accessToken: "secret", expiresAt: Date.now() + 60_000 },
      signal: new AbortController().signal,
      fetch: async (input) => {
        expect(new URL(String(input)).searchParams.get("client_version")).toBe("0.154.0");
        return Response.json({
          models: [
            {
              slug: "gpt-test",
              display_name: "GPT Test",
              description: "Test model",
              context_window: 128000,
              priority: 1,
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
              input_modalities: ["text", "image"],
              visibility: "list",
              supported_in_api: true,
            },
          ],
        });
      },
    });
    expect(models).toEqual([
      {
        id: "gpt-test",
        name: "GPT Test",
        description: "Test model",
        contextWindow: 128000,
        maxOutputTokens: undefined,
        reasoningEfforts: ["low", "high"],
        inputModalities: ["text", "image"],
        outputModalities: undefined,
        endpoints: ["responses"],
        supportsToolCall: true,
        available: true,
      },
    ]);
  });

  test("ChatGPT adds current image models from OpenAI's live model index", async () => {
    const provider = chatGptProvider({
      fetch: async () =>
        new Response(`
          <a href="/api/docs/models/gpt-image-2.5-sunburst">Sunburst</a>
          <a href="https://developers.openai.com/api/docs/models/gpt-image-2.5-flare">Flare</a>
        `),
    });
    const models = await provider.getModels!({
      credential: { accessToken: "secret", expiresAt: Date.now() + 60_000 },
      signal: new AbortController().signal,
      fetch: async () => Response.json({ models: [] }),
    });
    expect(models).toEqual([
      {
        id: "gpt-image-2.5-sunburst",
        name: "GPT Image 2.5 Sunburst",
        inputModalities: ["text", "image"],
        outputModalities: ["image"],
        endpoints: ["images/generations", "images/edits"],
        supportsToolCall: false,
        available: true,
        selectable: true,
      },
      {
        id: "gpt-image-2.5-flare",
        name: "GPT Image 2.5 Flare",
        inputModalities: ["text", "image"],
        outputModalities: ["image"],
        endpoints: ["images/generations", "images/edits"],
        supportsToolCall: false,
        available: true,
        selectable: true,
      },
    ]);
  });
  test("ChatGPT preserves account metadata and stores a rotated refresh token", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "rotated",
      }),
    );
    const provider = chatGptProvider({ fetch: fetcher as typeof fetch });
    const refreshed = await provider.refresh(
      {
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: 1,
        account: { id: "acct-1", plan: "pro" },
      },
      new AbortController().signal,
    );
    expect(refreshed).toMatchObject({
      refreshToken: "rotated",
      account: { id: "acct-1", plan: "pro" },
    });
  });

  test("ChatGPT removes unsupported Responses controls", async () => {
    const provider = chatGptProvider();
    const normalized = await provider.normalizeRequest!(
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          max_output_tokens: 128_000,
          prompt_cache_key: "conversation-1",
          prompt_cache_options: { mode: "explicit", ttl: "30m" },
          prompt_cache_retention: "24h",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Hello",
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
              prompt_cache_breakpoint: { mode: "explicit" },
            },
            {
              type: "function_call_output",
              call_id: "call_1",
              output: [
                {
                  type: "input_text",
                  text: "result",
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
            },
          ],
          tools: [
            {
              type: "function",
              name: "search",
              parameters: {
                type: "object",
                properties: { prompt_cache_breakpoint: { type: "string" } },
              },
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        }),
      }),
    );
    const request = await provider.authorize(normalized, {
      accessToken: "secret",
      expiresAt: Date.now() + 60_000,
      account: { id: "acct-1" },
    });

    expect(request.headers.get("session-id")).toBe("conversation-1");

    await expect(request.json()).resolves.toEqual({
      model: "gpt-5.6-luna",
      prompt_cache_key: "conversation-1",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_text", text: "result" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "search",
          parameters: {
            type: "object",
            properties: { prompt_cache_breakpoint: { type: "string" } },
          },
        },
      ],
    });
  });

  test("ChatGPT preserves top-level instructions and the exact input prefix", async () => {
    const provider = chatGptProvider();
    const normalized = await provider.normalizeRequest!(
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          instructions: "Stable system prompt",
          input: [{ type: "message", role: "user", content: "Hello" }],
          prompt_cache_key: "conversation-1",
        }),
      }),
    );

    await expect(normalized.json()).resolves.toEqual({
      model: "gpt-5.6-luna",
      instructions: "Stable system prompt",
      prompt_cache_key: "conversation-1",
      input: [{ type: "message", role: "user", content: "Hello" }],
    });
  });

  test("replays ChatGPT routing state only within the same account, session, and turn", async () => {
    const provider = chatGptProvider();
    const make = async (accountId = "account-a", session = "session-a", turn = "turn-a") => {
      const normalized = await provider.normalizeRequest!(
        new Request("https://chatgpt.com/backend-api/codex/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-turn-metadata": JSON.stringify({ turn_id: turn }),
          },
          body: JSON.stringify({ input: [], prompt_cache_key: session }),
        }),
      );
      return provider.authorize(normalized, {
        accessToken: "secret",
        expiresAt: Date.now() + 60000,
        account: { id: accountId },
      });
    };
    const first = await make();
    expect(first.headers.get("x-codex-turn-state")).toBeNull();
    await provider.normalizeResponse!(
      first,
      new Response("OK", { headers: { "x-codex-turn-state": "routing-token" } }),
    );
    expect((await make()).headers.get("x-codex-turn-state")).toBe("routing-token");
    for (const args of [
      ["account-b"],
      ["account-a", "session-b"],
      ["account-a", "session-a", "turn-b"],
    ])
      expect((await make(...args)).headers.get("x-codex-turn-state")).toBeNull();
  });

  test("ChatGPT exposes reset-credit expiry", async () => {
    const provider = chatGptProvider();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/rate-limit-reset-credits")) {
        return Response.json({
          available_count: 1,
          credits: [{ id: "reset-1", expires_at: "2026-09-01T00:00:00Z" }],
        });
      }
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 50, reset_after_seconds: 60 },
        },
      });
    });
    const context = {
      credential: { accessToken: "secret", expiresAt: Date.now() + 60_000 },
      signal: new AbortController().signal,
      fetch: fetcher as typeof fetch,
    };

    await expect(provider.getUsage!(context)).resolves.toMatchObject({
      resetCredits: {
        availableCount: 1,
        credits: [{ id: "reset-1", expiresAt: Date.parse("2026-09-01T00:00:00Z") }],
      },
    });
  });

  test("Copilot preserves enterprise configuration during refresh", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/copilot_internal/user")
        ? Response.json({
            login: "octocat",
            copilot_plan: "enterprise",
            access_type_sku: "copilot_enterprise_seat_quota",
          })
        : Response.json({
            token: "copilot-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
    );
    const provider = copilotProvider({ fetch: fetcher as typeof fetch });
    const refreshed = await provider.refresh(
      {
        accessToken: "old",
        refreshToken: "github-token",
        expiresAt: 1,
        metadata: { enterpriseDomain: "acme.ghe.com" },
      },
      new AbortController().signal,
    );
    expect(refreshed.metadata).toMatchObject({
      enterpriseDomain: "acme.ghe.com",
      baseUrl: "https://copilot-api.acme.ghe.com",
    });
    expect(refreshed.account).toEqual({
      id: "octocat",
      label: "octocat",
      plan: "Enterprise",
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("api.acme.ghe.com");
  });

  test("Copilot keeps the normal sign-in simple and rejects unsupported GitHub hosts", async () => {
    const provider = copilotProvider();
    expect(provider.loginFields).toBeUndefined();
    await expect(
      provider.startLogin(new AbortController().signal, {
        enterpriseDomain: "github.example.com",
      }),
    ).rejects.toThrow(/ghe\.com/);
  });

  test("Copilot includes usable account models even when its picker flag is false", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        data: [
          {
            id: "gpt-test",
            name: "GPT Test",
            model_picker_enabled: false,
            policy: { state: "enabled" },
            supported_endpoints: ["/responses"],
            capabilities: {
              limits: { max_prompt_tokens: 128000, max_output_tokens: 32000 },
              supports: { reasoning_effort: ["low", "high"], vision: true, tool_calls: true },
            },
          },
          {
            id: "disabled-model",
            name: "Disabled",
            model_picker_enabled: false,
            policy: { state: "disabled" },
            capabilities: {},
          },
          {
            id: "gpt-free-auto",
            name: "GPT Auto",
            model_picker_enabled: false,
            capabilities: {},
          },
          {
            id: "legacy-internal",
            name: "Legacy internal",
            model_picker_enabled: false,
            capabilities: {},
          },
        ],
      }),
    );
    const provider = copilotProvider({ fetch: fetcher as typeof fetch });
    const models = await provider.getModels!({
      credential: {
        accessToken: "copilot-token",
        refreshToken: "github-token",
        expiresAt: Date.now() + 60_000,
        metadata: {
          enterpriseDomain: "github.com",
          baseUrl: "https://api.individual.githubcopilot.com",
        },
      },
      signal: new AbortController().signal,
      fetch: fetcher as typeof fetch,
    });
    expect(models).toEqual([
      {
        id: "gpt-test",
        name: "GPT Test",
        contextWindow: 128000,
        maxOutputTokens: 32000,
        reasoningEfforts: ["low", "high"],
        inputModalities: ["text", "image"],
        endpoints: ["responses"],
        supportsToolCall: true,
        available: true,
        selectable: false,
      },
      {
        id: "gpt-free-auto",
        name: "Auto",
        contextWindow: undefined,
        maxOutputTokens: undefined,
        reasoningEfforts: undefined,
        inputModalities: ["text"],
        endpoints: undefined,
        supportsToolCall: true,
        available: true,
        selectable: true,
      },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.individual.githubcopilot.com/models",
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-github-api-version": "2026-06-01",
    });
    const request = await provider.authorize(
      new Request("https://api.individual.githubcopilot.com/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          input: [{ role: "assistant", content: [] }],
        }),
      }),
      {
        accessToken: "copilot-token",
        expiresAt: Date.now() + 60_000,
        metadata: { baseUrl: "https://api.individual.githubcopilot.com" },
      },
    );
    expect(request.headers.get("copilot-integration-id")).toBe("vscode-chat");
    expect(request.headers.get("x-initiator")).toBe("agent");
    expect(request.headers.get("openai-intent")).toBe("conversation-edits");
  });

  test("Copilot routes account Auto models through a reusable server-side session", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models/session")) {
        expect(JSON.parse(String(init?.body))).toEqual({ auto_mode: { model_hints: ["auto"] } });
        return Response.json({
          available_models: ["gpt-selected"],
          selected_model: "gpt-selected",
          session_token: "session-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      expect(url).toMatch(/\/models\/session\/intent$/);
      expect(new Headers(init?.headers).get("copilot-session-token")).toBe("session-token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        prompt: "Hi",
        available_models: ["gpt-selected"],
        previous_model: null,
        turn_number: 1,
      });
      return Response.json({ chosen_model: "gpt-selected" });
    });
    const provider = copilotProvider({ fetch: fetcher as typeof fetch });
    const request = await provider.authorize(
      new Request("https://api.individual.githubcopilot.com/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4-mini-free-auto",
          input: [
            { id: "rotating-id", role: "user", content: [{ type: "input_text", text: "Hi" }] },
            { type: "item_reference", id: "unusable-reference" },
          ],
        }),
      }),
      {
        accessToken: "copilot-token",
        expiresAt: Date.now() + 60_000,
        account: { id: "octocat" },
        metadata: { baseUrl: "https://api.individual.githubcopilot.com" },
      },
    );
    expect(new Headers(request.headers).get("copilot-session-token")).toBe("session-token");
    expect(JSON.parse(await request.text())).toMatchObject({
      model: "gpt-selected",
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
    });
  });

  test("Copilot keeps rotating Responses stream item IDs stable", async () => {
    const provider = copilotProvider();
    const response = await provider.normalizeResponse!(
      new Request("https://api.individual.githubcopilot.com/responses"),
      new Response(
        [
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"reasoning-start"}}',
          "",
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"rotated-delta","summary_index":0,"delta":"Thinking"}',
          "",
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rotated-done"}}',
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events[1].item_id).toBe("reasoning-start");
    expect(events[2].item.id).toBe("reasoning-start");
  });

  test("Grok preserves the prior refresh token when rotation is omitted", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ access_token: "fresh", expires_in: 3600, scope: "offline_access" }),
    );
    const provider = grokProvider({ fetch: fetcher as typeof fetch });
    const refreshed = await provider.refresh(
      { accessToken: "old", refreshToken: "refresh", expiresAt: 1 },
      new AbortController().signal,
    );
    expect(refreshed).toMatchObject({ accessToken: "fresh", refreshToken: "refresh" });
  });

  test("Grok maps the live account model catalog and sends proxy identity headers", async () => {
    const provider = grokProvider();
    const request = await provider.authorize(
      new Request("https://cli-chat-proxy.grok.com/v1/models"),
      { accessToken: "session-token", expiresAt: Date.now() + 60_000 },
    );
    expect(request.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(request.headers.get("x-grok-client-version")).toBe("1.0.3");
    expect(request.headers.get("x-grok-client-identifier")).toBe("grok-shell");
    expect(request.headers.get("user-agent")).toBe("xai-grok-cli");
    expect(request.headers.get("x-grok-client-mode")).toBeNull();
    const completion = await provider.authorize(
      new Request("https://cli-chat-proxy.grok.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.5", stream: true, messages: [] }),
      }),
      { accessToken: "session-token", expiresAt: Date.now() + 60_000 },
    );
    expect(completion.headers.get("x-grok-model-override")).toBe("grok-4.5");

    const models = await provider.getModels!({
      credential: { accessToken: "session-token", expiresAt: Date.now() + 60_000 },
      signal: new AbortController().signal,
      fetch: async () =>
        Response.json({
          data: [
            {
              id: "grok-4.5",
              name: "Grok 4.5",
              description: "Frontier model",
              context_window: 500000,
              api_backend: "responses",
              reasoning_efforts: [{ id: "high", value: "high" }, { id: "low" }],
            },
          ],
        }),
    });
    expect(models).toEqual([
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        description: "Frontier model",
        contextWindow: 500000,
        maxOutputTokens: undefined,
        reasoningEfforts: ["high", "low"],
        endpoints: ["responses"],
        available: true,
        selectable: true,
      },
    ]);
  });

  test("Grok resolves identity before billing and prefers the live display plan", async () => {
    const provider = grokProvider();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/user?")) {
        return Response.json({ userId: "user-1", email: "ada@example.com" });
      }
      expect(new Headers(init?.headers).get("x-userid")).toBe("user-1");
      if (url.endsWith("/settings")) {
        return Response.json({ subscription_tier_display: "Free", allow_access: true });
      }
      return Response.json({ config: {} });
    });

    await expect(
      provider.getUsage!({
        credential: { accessToken: "session-token", expiresAt: Date.now() + 60_000 },
        signal: new AbortController().signal,
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toMatchObject({
      plan: "Free",
      account: { id: "user-1", email: "ada@example.com", plan: "Free" },
    });
    expect(fetcher.mock.calls[0]?.[0]).toContain("/user?include=subscription");
  });

  test("Claude completes browser OAuth, refreshes rotating credentials, and discovers models", async () => {
    let exchangeSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: "returned-by-anthropic", display_name: "From API" }] });
      }
      if (url.endsWith("/oauth/token")) exchangeSignal = init?.signal;
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        organization: { uuid: "org-1", name: "Research" },
        subscription_type: "max",
      });
    });
    const provider = claudeProvider({ fetch: fetcher as typeof fetch });
    const login = await provider.startLogin(new AbortController().signal);
    expect(login.prompt.mode).toBe("browser");
    if (login.prompt.mode !== "browser") throw new Error("Expected browser login");
    const authorization = new URL(login.prompt.authorizationUri);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    expect((await fetch(callback)).status).toBe(200);
    await expect(login.complete).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      account: { id: "org-1", label: "Research", plan: "Max" },
    });
    expect(exchangeSignal).toBeInstanceOf(AbortSignal);
    await expect(
      provider.refresh(
        { accessToken: "expired", refreshToken: "refresh-token", expiresAt: 1 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ accessToken: "access-token", refreshToken: "refresh-token" });
    await expect(
      provider.getModels!({
        credential: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 60_000,
        },
        signal: new AbortController().signal,
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toEqual([
      {
        id: "returned-by-anthropic",
        name: "From API",
        description: undefined,
        contextWindow: undefined,
        maxOutputTokens: undefined,
        inputModalities: ["text", "image", "document"],
        endpoints: ["messages"],
        supportsToolCall: true,
        available: true,
        selectable: true,
      },
    ]);
    const request = await provider.authorize(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      }),
      { accessToken: "access-token", expiresAt: Date.now() + 60_000 },
    );
    expect(request.headers.get("authorization")).toBe("Bearer access-token");
    expect(request.headers.get("anthropic-beta")).toBe(
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    );
    await expect(request.json()).resolves.toMatchObject({
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    });
  });

  test("never authorizes a provider token for an unrelated host", () => {
    const credential: OAuthCredential = {
      accessToken: "secret",
      expiresAt: Date.now() + 60_000,
      account: { id: "acct-1" },
    };
    expect(() =>
      chatGptProvider().authorize(new Request("https://attacker.example/collect"), credential),
    ).toThrow(/refusing/i);
  });

  test("never sends a provider token over plaintext HTTP", () => {
    const credential: OAuthCredential = {
      accessToken: "secret",
      expiresAt: Date.now() + 60_000,
      account: { id: "acct-1" },
    };
    expect(() =>
      chatGptProvider().authorize(
        new Request("http://chatgpt.com/backend-api/codex/models"),
        credential,
      ),
    ).toThrow(/over http:/i);
  });
});
