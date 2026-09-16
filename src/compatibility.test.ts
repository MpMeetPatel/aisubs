import { describe, expect, test, vi } from "vitest";
import type { SubscriptionAuth } from "./auth.js";
import { proxyCompatible } from "./compatibility.js";
import type { ProviderId, ProviderModel } from "./types.js";

function auth(models: ProviderModel[], response: unknown) {
  return {
    getModels: vi.fn().mockResolvedValue({ models }),
    proxy: vi.fn().mockResolvedValue(Response.json(response)),
  } as unknown as SubscriptionAuth;
}

function request(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body));
}

function sentBody(value: SubscriptionAuth): Record<string, unknown> {
  const call = vi.mocked(value.proxy).mock.calls[0];
  return JSON.parse(String(call?.[3]?.body)) as Record<string, unknown>;
}

describe("provider-neutral compatibility", () => {
  test("preserves Google function-call identity when translating tool history", async () => {
    const value = auth([{ id: "model", endpoints: ["chat/completions"] }], {
      choices: [{ message: { content: "Done" } }],
    });
    const response = await proxyCompatible(
      value,
      "copilot",
      "default",
      "models/model:generateContent",
      request({
        contents: [
          {
            role: "model",
            parts: [{ functionCall: { name: "weather", args: { city: "Paris" } } }],
          },
          {
            role: "user",
            parts: [{ functionResponse: { name: "weather", response: { temperature: 20 } } }],
          },
        ],
      }),
      new Headers(),
    );
    expect(response?.status).toBe(200);
    const body = sentBody(value) as {
      messages: Array<{ tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
    };
    expect(body.messages[1]?.tool_call_id).toBe(body.messages[0]?.tool_calls?.[0]?.id);
  });

  test("uses function names rather than call IDs for Google tool results", async () => {
    const value = auth([{ id: "model", endpoints: ["models/model:generateContent"] }], {
      candidates: [{ content: { parts: [{ text: "Done" }] } }],
    });
    await proxyCompatible(
      value,
      "test",
      "default",
      "chat/completions",
      request({
        model: "model",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "weather", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "20 degrees" },
        ],
      }),
      new Headers(),
    );
    expect(sentBody(value)).toMatchObject({
      contents: [
        { parts: [{ functionCall: { name: "weather" } }] },
        { parts: [{ functionResponse: { name: "weather" } }] },
      ],
    });
  });

  test.each(["responses", "messages"])(
    "translates explicit %s tool choice to Chat",
    async (protocol) => {
      const value = auth([{ id: "model", endpoints: ["chat/completions"] }], {
        choices: [{ message: { content: "Done" } }],
      });
      await proxyCompatible(
        value,
        "copilot",
        "default",
        protocol,
        request({
          model: "model",
          input: "hello",
          messages: [{ role: "user", content: "hello" }],
          tool_choice: { type: protocol === "responses" ? "function" : "tool", name: "weather" },
        }),
        new Headers(),
      );
      expect(sentBody(value)).toMatchObject({
        tool_choice: { type: "function", function: { name: "weather" } },
      });
    },
  );

  test("rejects unavailable stored Responses history instead of dropping it", async () => {
    const value = auth([{ id: "model", endpoints: ["chat/completions"] }], {});
    const response = await proxyCompatible(
      value,
      "copilot",
      "default",
      "responses",
      request({
        model: "model",
        input: "continue",
        previous_response_id: "previous",
      }),
      new Headers(),
    );
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain("unsupported_feature");
    expect(value.proxy).not.toHaveBeenCalled();
  });

  test.each([false, true])("rejects truncated Responses streams (stream=%s)", async (stream) => {
    const value = auth([{ id: "model", endpoints: ["responses"] }], {});
    vi.mocked(value.proxy).mockResolvedValue(
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
    );
    const response = await proxyCompatible(
      value,
      "chatgpt",
      "default",
      "chat/completions",
      request({
        model: "model",
        stream,
        messages: [{ role: "user", content: "hello" }],
      }),
      new Headers(),
    );
    if (stream) await expect(response!.text()).rejects.toThrow("terminal response event");
    else {
      expect(response?.status).toBe(502);
      expect(await response?.text()).toContain("terminal response event");
    }
  });

  test("stops reading upstream when the downstream consumer cancels", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const value = auth([{ id: "model", endpoints: ["responses"] }], {});
    vi.mocked(value.proxy).mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"next"}\n\n',
              ),
            );
          },
          cancel,
        }),
      ),
    );
    const response = await proxyCompatible(
      value,
      "chatgpt",
      "default",
      "chat/completions",
      request({
        model: "model",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      new Headers(),
    );
    const reader = response!.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(pulls).toBeLessThanOrEqual(3);
  });
  test("preserves explicit cache boundaries and TTL through Chat to Anthropic translation", async () => {
    const value = auth([{ id: "claude-test", endpoints: ["messages"] }], {
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const control = { type: "ephemeral", ttl: "1h" };
    await proxyCompatible(
      value,
      "claude",
      "default",
      "chat/completions",
      request({
        model: "claude-test",
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "stable", cache_control: control },
              { type: "text", text: "changing" },
            ],
          },
          { role: "user", content: [{ type: "text", text: "hello", cache_control: control }] },
          { role: "tool", tool_call_id: "call_1", content: "result", cache_control: control },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
            cache_control: control,
          },
        ],
      }),
      new Headers(),
    );
    expect(sentBody(value)).toMatchObject({
      system: [
        { type: "text", text: "stable", cache_control: control },
        { type: "text", text: "changing" },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello", cache_control: control }] },
        { role: "user", content: [{ type: "tool_result", cache_control: control }] },
      ],
      tools: [{ name: "lookup", cache_control: control }],
    });
    expect(JSON.stringify(sentBody(value)).match(/"cache_control"/g)).toHaveLength(4);
  });

  test("does not collapse marked text blocks when translating Anthropic to Chat", async () => {
    const value = auth([{ id: "claude-test", endpoints: ["chat/completions"] }], {
      choices: [{ message: { content: "OK" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    });
    const control = { type: "ephemeral" };
    await proxyCompatible(
      value,
      "copilot",
      "default",
      "messages",
      request({
        model: "claude-test",
        system: [
          { type: "text", text: "stable", cache_control: control },
          { type: "text", text: "changing" },
        ],
        messages: [{ role: "user", content: "hello" }],
      }),
      new Headers(),
    );
    expect(sentBody(value)).toMatchObject({
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "stable", cache_control: control },
            { type: "text", text: "changing" },
          ],
        },
        { role: "user", content: "hello" },
      ],
    });
  });

  test("preserves DeepSeek and Moonshot cache usage through JSON and SSE translation", async () => {
    for (const field of ["cached_tokens", "prompt_cache_hit_tokens"])
      for (const stream of [false, true]) {
        const value = auth([{ id: "model", endpoints: ["chat/completions"] }], {
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 5, [field]: 700 },
        });
        const response = await proxyCompatible(
          value,
          "opencode-go",
          "default",
          "responses",
          request({ model: "model", input: "hello", stream }),
        );
        const body = await response.text();
        expect(body).toContain('"cached_tokens":700');
      }
  });
  test("preserves cache accounting when translating Anthropic usage to OpenAI", async () => {
    const value = auth([{ id: "claude-test", endpoints: ["messages"] }], {
      id: "msg_cache",
      model: "claude-test",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 30,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        output_tokens: 5,
      },
    });
    const response = await proxyCompatible(
      value,
      "claude",
      "default",
      "chat/completions",
      request({ model: "claude-test", messages: [{ role: "user", content: "hello" }] }),
    );
    expect(await response.json()).toMatchObject({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 },
      },
    });
  });

  test("does not manufacture cache misses during Responses conversion and preserves routing", async () => {
    const value = auth([{ id: "model", endpoints: ["chat/completions"] }], {
      id: "chat_test",
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    });
    const response = await proxyCompatible(
      value,
      "copilot",
      "default",
      "responses",
      request({ model: "model", input: "hello", prompt_cache_key: "stable-chat" }),
    );
    const result = (await response.json()) as { usage: Record<string, unknown> };
    expect(result.usage.input_tokens_details).toBeUndefined();
    expect(sentBody(value).prompt_cache_key).toBe("stable-chat");
  });

  test("subtracts cache reads and writes from Anthropic base input in JSON and SSE", async () => {
    for (const stream of [false, true]) {
      const value = auth([{ id: "model", endpoints: ["chat/completions"] }], {
        id: "chat_test",
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 },
        },
      });
      const response = await proxyCompatible(
        value,
        "copilot",
        "default",
        "messages",
        request({
          model: "model",
          stream,
          max_tokens: 10,
          messages: [{ role: "user", content: "hello" }],
        }),
      );
      const body = await response.text();
      const result = stream
        ? JSON.parse(
            body
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6),
          ).message
        : JSON.parse(body);
      expect(result.usage).toMatchObject({
        input_tokens: 30,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
      });
    }
  });

  test("preserves multimodal messages, tool history, schema, and reasoning from Chat to Responses", async () => {
    const value = auth([{ id: "gpt-test", endpoints: ["responses"] }], {
      id: "resp_1",
      model: "gpt-test",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_next",
          name: "weather",
          arguments: '{"city":"Paris"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });

    const response = await proxyCompatible(
      value,
      "chatgpt",
      "default",
      "chat/completions",
      request({
        model: "gpt-test",
        messages: [
          { role: "developer", content: "Be concise" },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "https://example.test/image.png" } },
            ],
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_old",
                type: "function",
                function: { name: "weather", arguments: '{"city":"London"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_old", content: '{"temp":20}' },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              description: "Get weather",
              strict: true,
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "weather" } },
        reasoning_effort: "high",
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", strict: true, schema: { type: "object" } },
        },
      }),
      new Headers(),
    );

    expect(response?.status).toBe(200);
    const upstream = sentBody(value);
    expect(upstream).toMatchObject({
      model: "gpt-test",
      instructions: "Be concise",
      reasoning: { effort: "high" },
      tool_choice: { type: "function", name: "weather" },
      tools: [{ type: "function", name: "weather", strict: true }],
      text: { format: { type: "json_schema", name: "answer", strict: true } },
    });
    expect(upstream.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            { type: "input_text", text: "What is this?" },
            { type: "input_image", image_url: "https://example.test/image.png" },
          ]),
        }),
        expect.objectContaining({ type: "function_call", call_id: "call_old" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call_old" }),
      ]),
    );
    await expect(response?.json()).resolves.toMatchObject({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                id: "call_next",
                function: { name: "weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
    });
  });

  test("translates an OpenAI client to a Claude subscription including tool results", async () => {
    const value = auth([{ id: "claude-test", endpoints: ["messages"] }], {
      id: "msg_1",
      model: "claude-test",
      role: "assistant",
      content: [
        { type: "text", text: "Done" },
        { type: "tool_use", id: "call_2", name: "lookup", input: { q: "next" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 4 },
    });

    const response = await proxyCompatible(
      value,
      "claude",
      "default",
      "chat/completions",
      request({
        model: "claude-test",
        reasoning_effort: "medium",
        messages: [
          { role: "system", content: "Use tools" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"old"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "result" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      }),
      new Headers(),
    );

    expect(vi.mocked(value.proxy).mock.calls[0]?.slice(0, 3)).toEqual([
      "claude",
      "default",
      "messages",
    ]);
    expect(sentBody(value)).toMatchObject({
      system: [{ type: "text", text: "Use tools" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: [{ name: "lookup" }],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1" }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1" }],
        },
      ],
    });
    await expect(response?.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Done" }, finish_reason: "tool_calls" }],
    });
  });

  test("translates an OpenAI client to Google generateContent", async () => {
    const value = auth([{ id: "gemini-test", endpoints: ["models/gemini-test"] }], {
      responseId: "google_1",
      modelVersion: "gemini-test",
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello" }, { functionCall: { name: "search", args: { q: "x" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });

    const response = await proxyCompatible(
      value,
      "opencode-zen",
      "default",
      "chat/completions",
      request({
        model: "gemini-test",
        messages: [
          { role: "system", content: "Be helpful" },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,aGVsbG8=" },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: { name: "search", parameters: { type: "object" } },
          },
        ],
      }),
      new Headers(),
    );

    expect(vi.mocked(value.proxy).mock.calls[0]?.[2]).toBe("models/gemini-test:generateContent");
    expect(sentBody(value)).toMatchObject({
      systemInstruction: { parts: [{ text: "Be helpful" }] },
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: "search" }] }],
    });
    await expect(response?.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: "Hello",
            tool_calls: [{ function: { name: "search" } }],
          },
        },
      ],
    });
  });

  test("translates Responses clients to native Chat Completions models", async () => {
    const value = auth([{ id: "grok-test", endpoints: ["chat/completions"] }], {
      id: "chatcmpl_1",
      model: "grok-test",
      choices: [
        {
          message: { role: "assistant", content: "Hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });

    const response = await proxyCompatible(
      value,
      "grok",
      "default",
      "responses",
      request({
        model: "grok-test",
        instructions: "Be concise",
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      }),
      new Headers(),
    );

    expect(vi.mocked(value.proxy).mock.calls[0]?.[2]).toBe("chat/completions");
    expect(sentBody(value)).toMatchObject({
      messages: [
        { role: "developer", content: "Be concise" },
        { role: "user", content: "Hello" },
      ],
    });
    await expect(response?.json()).resolves.toMatchObject({
      object: "response",
      output_text: "Hi",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });

  test("keeps Google streamGenerateContent streaming across protocols", async () => {
    const value = auth([{ id: "grok-test", endpoints: ["chat/completions"] }], {
      id: "chatcmpl_google_stream",
      model: "grok-test",
      choices: [{ message: { role: "assistant", content: "streamed" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const response = await proxyCompatible(
      value,
      "grok",
      "default",
      "models/grok-test:streamGenerateContent?alt=sse",
      request({ contents: [{ role: "user", parts: [{ text: "Hello" }] }] }),
      new Headers(),
    );

    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    expect(await response?.text()).toContain('"candidates"');
    expect(vi.mocked(value.proxy).mock.calls[0]?.[2]).toBe("chat/completions");
  });

  test.each([
    {
      name: "Responses to Anthropic Messages",
      provider: "claude",
      sourcePath: "responses",
      sourceBody: { model: "model-test", input: "Hello" },
      targetEndpoint: "messages",
      targetPath: "messages",
      targetResponse: {
        id: "msg_matrix",
        type: "message",
        role: "assistant",
        model: "model-test",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      name: "Responses to Google generateContent",
      provider: "opencode-zen",
      sourcePath: "responses",
      sourceBody: { model: "model-test", input: "Hello" },
      targetEndpoint: "models/model-test",
      targetPath: "models/model-test:generateContent",
      targetResponse: {
        responseId: "google_matrix",
        modelVersion: "model-test",
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
      },
    },
    {
      name: "Anthropic Messages to Chat Completions",
      provider: "grok",
      sourcePath: "messages",
      sourceBody: {
        model: "model-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "Hello" }],
      },
      targetEndpoint: "chat/completions",
      targetPath: "chat/completions",
      targetResponse: {
        id: "chatcmpl_matrix",
        model: "model-test",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      },
    },
    {
      name: "Anthropic Messages to Google generateContent",
      provider: "opencode-zen",
      sourcePath: "messages",
      sourceBody: {
        model: "model-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "Hello" }],
      },
      targetEndpoint: "models/model-test",
      targetPath: "models/model-test:generateContent",
      targetResponse: {
        responseId: "google_matrix",
        modelVersion: "model-test",
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
      },
    },
    {
      name: "Google generateContent to Responses",
      provider: "chatgpt",
      sourcePath: "models/model-test:generateContent",
      sourceBody: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      targetEndpoint: "responses",
      targetPath: "responses",
      targetResponse: {
        id: "resp_matrix",
        model: "model-test",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        ],
      },
    },
    {
      name: "Google generateContent to Anthropic Messages",
      provider: "claude",
      sourcePath: "models/model-test:generateContent",
      sourceBody: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      targetEndpoint: "messages",
      targetPath: "messages",
      targetResponse: {
        id: "msg_matrix",
        type: "message",
        role: "assistant",
        model: "model-test",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ])("translates $name", async (fixture) => {
    const value = auth(
      [{ id: "model-test", endpoints: [fixture.targetEndpoint] }],
      fixture.targetResponse,
    );
    const response = await proxyCompatible(
      value,
      fixture.provider as ProviderId,
      "default",
      fixture.sourcePath,
      request(fixture.sourceBody),
      new Headers(),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).not.toHaveProperty("error");
    expect(vi.mocked(value.proxy).mock.calls[0]?.[2]).toBe(fixture.targetPath);
  });

  test("translates Anthropic clients to Responses subscriptions and preserves their response shape", async () => {
    const value = auth([{ id: "gpt-test", endpoints: ["responses"] }], {
      id: "resp_2",
      model: "gpt-test",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "From GPT" }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    });

    const response = await proxyCompatible(
      value,
      "chatgpt",
      "default",
      "messages",
      request({
        model: "gpt-test",
        max_tokens: 100,
        system: "Be useful",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
      }),
      new Headers(),
    );

    expect(vi.mocked(value.proxy).mock.calls[0]?.[2]).toBe("responses");
    expect(sentBody(value)).toMatchObject({
      model: "gpt-test",
      max_output_tokens: 100,
      instructions: "Be useful",
      input: [{ role: "user" }],
      tools: [{ type: "function", name: "lookup" }],
    });
    await expect(response?.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "From GPT" }],
      usage: { input_tokens: 4, output_tokens: 2 },
    });
  });

  test("returns source-protocol errors for features that cannot be translated", async () => {
    const value = auth([{ id: "claude-test", endpoints: ["messages"] }], {});
    const response = await proxyCompatible(
      value,
      "claude",
      "default",
      "responses",
      request({
        model: "claude-test",
        input: "Hello",
        tools: [{ type: "web_search_preview" }],
      }),
      new Headers(),
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "unsupported_feature", message: expect.stringContaining("native Responses") },
    });
    expect(value.proxy).not.toHaveBeenCalled();
  });

  test("streams Responses text and tool calls incrementally to Chat clients", async () => {
    const value = auth([{ id: "gpt-test", endpoints: ["responses"] }], {});
    vi.mocked(value.proxy).mockResolvedValue(
      new Response(
        [
          'data: {"type":"response.created","response":{"id":"resp_live","model":"gpt-test","created_at":123}}',
          'data: {"type":"response.output_text.delta","delta":"Hello"}',
          'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}',
          'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"q\\":\\"x\\"}"}',
          'data: {"type":"response.completed","response":{"id":"resp_live","model":"gpt-test","created_at":123,"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

    const response = await proxyCompatible(
      value,
      "chatgpt",
      "default",
      "chat/completions",
      request({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
      new Headers(),
    );

    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    const payload = await response!.text();
    expect(payload).toContain('"content":"Hello"');
    expect(payload).toContain('"name":"lookup"');
    expect(payload).toContain('"arguments":"{\\"q\\":\\"x\\"}"');
    expect(payload).toContain('"finish_reason":"tool_calls"');
    expect(payload).toContain("data: [DONE]");
  });

  test("keeps requests native when the selected model supports the caller protocol", async () => {
    const value = auth([{ id: "native", endpoints: ["chat/completions"] }], {});
    await expect(
      proxyCompatible(
        value,
        "copilot",
        "default",
        "chat/completions",
        request({ model: "native", messages: [{ role: "user", content: "Hello" }] }),
        new Headers(),
      ),
    ).resolves.toBeNull();
    expect(value.proxy).not.toHaveBeenCalled();
  });
});
