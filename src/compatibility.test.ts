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
