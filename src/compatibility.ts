import type { SubscriptionAuth } from "./auth.js";
import type { ProviderId, ProviderModel } from "./types.js";
import { isRecord, numberValue, stringValue } from "./utils.js";

export type WireProtocol = "responses" | "chat/completions" | "messages" | "google";

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image"; url: string; detail?: string };
type AudioPart = { type: "audio"; data: string; format?: string };
type FilePart = { type: "file"; fileId?: string; data?: string; filename?: string };
type ContentPart = TextPart | ImagePart | AudioPart | FilePart;

type ToolCall = { id: string; name: string; arguments: string };
type Message = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: ContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

type FunctionTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
};

type CompletionRequest = {
  model: string;
  stream: boolean;
  messages: Message[];
  tools?: FunctionTool[];
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: unknown;
  reasoningEffort?: string;
  responseFormat?: unknown;
  metadata?: unknown;
  user?: string;
};

type CompletionResult = {
  id: string;
  model: string;
  created: number;
  content: ContentPart[];
  toolCalls: ToolCall[];
  refusal?: string;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage?: { input: number; output: number; total: number; cached?: number; reasoning?: number };
};

export class CompatibilityError extends Error {
  constructor(
    message: string,
    readonly code = "invalid_request_error",
    readonly status = 400,
  ) {
    super(message);
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CompatibilityError(message);
  return value;
}

function json(body: Buffer): Record<string, unknown> {
  try {
    return record(JSON.parse(body.toString("utf8")), "Request body must be a JSON object");
  } catch (error) {
    if (error instanceof CompatibilityError) throw error;
    throw new CompatibilityError("Request body contains invalid JSON");
  }
}

function requiredModel(raw: Record<string, unknown>): string {
  const model = stringValue(raw.model);
  if (!model) throw new CompatibilityError("A non-empty model is required");
  return model;
}

function text(value: unknown): TextPart | null {
  if (typeof value === "string") return { type: "text", text: value };
  if (!isRecord(value)) return null;
  const content = stringValue(value.text);
  return content == null ? null : { type: "text", text: content };
}

function imageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isRecord(value) ? stringValue(value.url) : undefined;
}

function openAiParts(value: unknown): ContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new CompatibilityError("Message content must be text or parts");
  return value.map((item): ContentPart => {
    const part = record(item, "Message content parts must be objects");
    const type = stringValue(part.type);
    if (["text", "input_text", "output_text"].includes(type ?? "")) {
      const parsed = text(part);
      if (parsed) return parsed;
    }
    if (type === "image_url" || type === "input_image") {
      const url =
        imageUrl(part.image_url) ?? stringValue(part.image_url) ?? stringValue(part.file_id);
      if (!url) throw new CompatibilityError("Image content requires image_url or file_id");
      return { type: "image", url, detail: stringValue(part.detail) };
    }
    if (type === "input_audio") {
      const audio = record(part.input_audio, "input_audio requires audio data");
      const data = stringValue(audio.data);
      if (!data) throw new CompatibilityError("input_audio requires audio data");
      return { type: "audio", data, format: stringValue(audio.format) };
    }
    if (type === "file" || type === "input_file") {
      return {
        type: "file",
        fileId: stringValue(part.file_id),
        data: stringValue(part.file_data),
        filename: stringValue(part.filename),
      };
    }
    if (type === "refusal") return { type: "text", text: stringValue(part.refusal) ?? "" };
    throw new CompatibilityError(
      `Unsupported content part: ${type ?? "unknown"}`,
      "unsupported_feature",
    );
  });
}

function chatToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item, index) => {
    const call = record(item, "Tool calls must be objects");
    const fn = record(call.function, "Tool call requires a function");
    const name = stringValue(fn.name);
    if (!name) throw new CompatibilityError("Tool call requires a function name");
    return {
      id: stringValue(call.id) ?? `call_${index}_${crypto.randomUUID()}`,
      name,
      arguments:
        typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    };
  });
}

function chatTools(value: unknown): FunctionTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const tool = record(item, "Tools must be objects");
    if (tool.type !== "function") {
      throw new CompatibilityError(`Unsupported Chat Completions tool: ${String(tool.type)}`);
    }
    const fn = record(tool.function, "Function tool is missing function");
    const name = stringValue(fn.name);
    if (!name) throw new CompatibilityError("Function tool requires a name");
    return {
      name,
      description: stringValue(fn.description),
      parameters: fn.parameters,
      strict: typeof fn.strict === "boolean" ? fn.strict : undefined,
    };
  });
}

function parseChat(body: Buffer): CompletionRequest {
  const raw = json(body);
  if (!Array.isArray(raw.messages)) throw new CompatibilityError("messages must be an array");
  const messages = raw.messages.map((item): Message => {
    const message = record(item, "Messages must be objects");
    const role = stringValue(message.role);
    if (!role || !["system", "developer", "user", "assistant", "tool"].includes(role)) {
      throw new CompatibilityError(`Unsupported message role: ${role ?? "unknown"}`);
    }
    return {
      role: role as Message["role"],
      content: openAiParts(message.content),
      toolCallId: stringValue(message.tool_call_id),
      toolCalls: chatToolCalls(message.tool_calls),
    };
  });
  return {
    model: requiredModel(raw),
    stream: raw.stream === true,
    messages,
    tools: chatTools(raw.tools),
    toolChoice: raw.tool_choice,
    maxTokens: numberValue(raw.max_completion_tokens) ?? numberValue(raw.max_tokens),
    temperature: numberValue(raw.temperature),
    topP: numberValue(raw.top_p),
    stop: raw.stop,
    reasoningEffort: stringValue(raw.reasoning_effort),
    responseFormat: raw.response_format,
    metadata: raw.metadata,
    user: stringValue(raw.user),
  };
}

function responseTools(value: unknown): FunctionTool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item): FunctionTool => {
    const tool = record(item, "Tools must be objects");
    if (tool.type !== "function") {
      throw new CompatibilityError(
        `${String(tool.type)} requires native Responses support`,
        "unsupported_feature",
      );
    }
    const name = stringValue(tool.name);
    if (!name) throw new CompatibilityError("Function tool requires a name");
    return {
      name,
      description: stringValue(tool.description),
      parameters: tool.parameters,
      strict: tool.strict === true,
    };
  });
}

function parseResponses(body: Buffer): CompletionRequest {
  const raw = json(body);
  const messages: Message[] = [];
  if (typeof raw.instructions === "string") {
    messages.push({ role: "developer", content: [{ type: "text", text: raw.instructions }] });
  }
  const input = raw.input;
  if (typeof input === "string")
    messages.push({ role: "user", content: [{ type: "text", text: input }] });
  else if (Array.isArray(input)) {
    for (const item of input) {
      const value = record(item, "Responses input items must be objects");
      if (value.type === "function_call") {
        messages.push({
          role: "assistant",
          content: [],
          toolCalls: [
            {
              id:
                stringValue(value.call_id) ??
                stringValue(value.id) ??
                `call_${crypto.randomUUID()}`,
              name: stringValue(value.name) ?? "function",
              arguments:
                typeof value.arguments === "string"
                  ? value.arguments
                  : JSON.stringify(value.arguments ?? {}),
            },
          ],
        });
      } else if (value.type === "function_call_output") {
        messages.push({
          role: "tool",
          toolCallId: stringValue(value.call_id),
          content: [
            {
              type: "text",
              text:
                typeof value.output === "string"
                  ? value.output
                  : JSON.stringify(value.output ?? ""),
            },
          ],
        });
      } else if (value.type === "item_reference") {
        throw new CompatibilityError(
          "item_reference requires native Responses support",
          "unsupported_feature",
        );
      } else {
        const role = stringValue(value.role) ?? "user";
        if (!["system", "developer", "user", "assistant"].includes(role)) {
          throw new CompatibilityError(`Unsupported Responses role: ${role}`);
        }
        messages.push({ role: role as Message["role"], content: openAiParts(value.content) });
      }
    }
  } else if (input != null)
    throw new CompatibilityError("Responses input must be text or an array");
  const responseFormat = isRecord(raw.text) ? raw.text.format : undefined;
  const reasoning = isRecord(raw.reasoning) ? raw.reasoning : undefined;
  return {
    model: requiredModel(raw),
    stream: raw.stream === true,
    messages,
    tools: responseTools(raw.tools),
    toolChoice: raw.tool_choice,
    maxTokens: numberValue(raw.max_output_tokens),
    temperature: numberValue(raw.temperature),
    topP: numberValue(raw.top_p),
    reasoningEffort: stringValue(reasoning?.effort),
    responseFormat,
    metadata: raw.metadata,
    user: stringValue(raw.user),
  };
}

function anthropicParts(value: unknown): { content: ContentPart[]; toolCalls?: ToolCall[] } {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (!Array.isArray(value)) return { content: [] };
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of value) {
    const part = record(item, "Anthropic content blocks must be objects");
    if (part.type === "text") content.push({ type: "text", text: stringValue(part.text) ?? "" });
    else if (part.type === "image") {
      const source = record(part.source, "Anthropic image requires source");
      if (source.type === "url")
        content.push({ type: "image", url: stringValue(source.url) ?? "" });
      else
        content.push({
          type: "image",
          url: `data:${stringValue(source.media_type) ?? "image/png"};base64,${stringValue(source.data) ?? ""}`,
        });
    } else if (part.type === "tool_use") {
      toolCalls.push({
        id: stringValue(part.id) ?? `call_${crypto.randomUUID()}`,
        name: stringValue(part.name) ?? "function",
        arguments: JSON.stringify(part.input ?? {}),
      });
    } else if (part.type !== "thinking" && part.type !== "redacted_thinking") {
      throw new CompatibilityError(`Unsupported Anthropic content block: ${String(part.type)}`);
    }
  }
  return { content, toolCalls: toolCalls.length ? toolCalls : undefined };
}

function parseAnthropic(body: Buffer): CompletionRequest {
  const raw = json(body);
  const messages: Message[] = [];
  if (raw.system != null) {
    const system = anthropicParts(raw.system);
    messages.push({ role: "system", content: system.content });
  }
  if (!Array.isArray(raw.messages)) throw new CompatibilityError("messages must be an array");
  for (const item of raw.messages) {
    const value = record(item, "Messages must be objects");
    const role = value.role === "assistant" ? "assistant" : "user";
    if (Array.isArray(value.content)) {
      const normal: unknown[] = [];
      for (const part of value.content) {
        if (isRecord(part) && part.type === "tool_result") {
          messages.push({
            role: "tool",
            toolCallId: stringValue(part.tool_use_id),
            content: anthropicParts(part.content).content,
          });
        } else normal.push(part);
      }
      const parsed = anthropicParts(normal);
      if (parsed.content.length || parsed.toolCalls?.length) messages.push({ role, ...parsed });
    } else messages.push({ role, ...anthropicParts(value.content) });
  }
  const tools = Array.isArray(raw.tools)
    ? raw.tools.map((item): FunctionTool => {
        const tool = record(item, "Tools must be objects");
        const name = stringValue(tool.name);
        if (!name) throw new CompatibilityError("Tool requires a name");
        return { name, description: stringValue(tool.description), parameters: tool.input_schema };
      })
    : undefined;
  return {
    model: requiredModel(raw),
    stream: raw.stream === true,
    messages,
    tools,
    toolChoice: raw.tool_choice,
    maxTokens: numberValue(raw.max_tokens),
    temperature: numberValue(raw.temperature),
    topP: numberValue(raw.top_p),
    stop: raw.stop_sequences,
    metadata: raw.metadata,
  };
}

function parseGoogle(body: Buffer, model: string, stream = false): CompletionRequest {
  const raw = json(body);
  const messages: Message[] = [];
  if (isRecord(raw.systemInstruction)) {
    const parts = Array.isArray(raw.systemInstruction.parts) ? raw.systemInstruction.parts : [];
    messages.push({
      role: "system",
      content: parts.flatMap((part) => {
        const parsed = text(part);
        return parsed ? [parsed] : [];
      }),
    });
  }
  if (!Array.isArray(raw.contents)) throw new CompatibilityError("contents must be an array");
  for (const item of raw.contents) {
    const value = record(item, "Google contents must be objects");
    const role: Message["role"] = value.role === "model" ? "assistant" : "user";
    const content: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    for (const itemPart of Array.isArray(value.parts) ? value.parts : []) {
      const part = record(itemPart, "Google parts must be objects");
      const parsedText = text(part);
      if (parsedText) content.push(parsedText);
      else if (isRecord(part.inlineData)) {
        content.push({
          type: "image",
          url: `data:${stringValue(part.inlineData.mimeType) ?? "image/png"};base64,${stringValue(part.inlineData.data) ?? ""}`,
        });
      } else if (isRecord(part.fileData)) {
        content.push({ type: "image", url: stringValue(part.fileData.fileUri) ?? "" });
      } else if (isRecord(part.functionCall)) {
        toolCalls.push({
          id: `call_${crypto.randomUUID()}`,
          name: stringValue(part.functionCall.name) ?? "function",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      } else if (isRecord(part.functionResponse)) {
        messages.push({
          role: "tool",
          toolCallId: stringValue(part.functionResponse.name),
          content: [{ type: "text", text: JSON.stringify(part.functionResponse.response ?? {}) }],
        });
      }
    }
    if (content.length || toolCalls.length)
      messages.push({ role, content, toolCalls: toolCalls.length ? toolCalls : undefined });
  }
  const generation = isRecord(raw.generationConfig) ? raw.generationConfig : {};
  const declarations = Array.isArray(raw.tools)
    ? raw.tools.flatMap((item) =>
        isRecord(item) && Array.isArray(item.functionDeclarations) ? item.functionDeclarations : [],
      )
    : [];
  return {
    model,
    stream,
    messages,
    tools: declarations.map((item): FunctionTool => {
      const tool = record(item, "Function declarations must be objects");
      return {
        name: stringValue(tool.name) ?? "function",
        description: stringValue(tool.description),
        parameters: tool.parameters,
      };
    }),
    maxTokens: numberValue(generation.maxOutputTokens),
    temperature: numberValue(generation.temperature),
    topP: numberValue(generation.topP),
    stop: generation.stopSequences,
    responseFormat: generation.responseSchema
      ? {
          type: "json_schema",
          json_schema: { name: "response", schema: generation.responseSchema },
        }
      : undefined,
  };
}

function dataUri(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  return match?.[1] && match[2] ? { mediaType: match[1], data: match[2] } : null;
}

function chatContent(parts: ContentPart[]): unknown {
  if (parts.every((part) => part.type === "text"))
    return parts.map((part) => (part as TextPart).text).join("");
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image")
      return {
        type: "image_url",
        image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
      };
    if (part.type === "audio")
      return {
        type: "input_audio",
        input_audio: { data: part.data, format: part.format ?? "wav" },
      };
    return {
      type: "file",
      ...(part.fileId ? { file_id: part.fileId } : {}),
      ...(part.data ? { file_data: part.data } : {}),
      ...(part.filename ? { filename: part.filename } : {}),
    };
  });
}

function toChat(request: CompletionRequest): Record<string, unknown> {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: chatContent(message.content),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  }));
  return {
    model: request.model,
    messages,
    stream: false,
    ...(request.tools
      ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) }
      : {}),
    ...(request.toolChoice != null ? { tool_choice: request.toolChoice } : {}),
    ...(request.maxTokens != null ? { max_completion_tokens: request.maxTokens } : {}),
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
    ...(request.topP != null ? { top_p: request.topP } : {}),
    ...(request.stop != null ? { stop: request.stop } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.responseFormat != null ? { response_format: request.responseFormat } : {}),
    ...(request.metadata != null ? { metadata: request.metadata } : {}),
    ...(request.user ? { user: request.user } : {}),
  };
}

function responseContent(part: ContentPart, role: Message["role"]): Record<string, unknown> {
  if (part.type === "text")
    return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
  if (part.type === "image")
    return {
      type: "input_image",
      image_url: part.url,
      ...(part.detail ? { detail: part.detail } : {}),
    };
  if (part.type === "audio")
    return { type: "input_audio", input_audio: { data: part.data, format: part.format ?? "wav" } };
  return {
    type: "input_file",
    ...(part.fileId ? { file_id: part.fileId } : {}),
    ...(part.data ? { file_data: part.data } : {}),
    ...(part.filename ? { filename: part.filename } : {}),
  };
}

function toResponses(request: CompletionRequest): Record<string, unknown> {
  const input: unknown[] = [];
  const instructions = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) =>
      message.content
        .map((part) => {
          if (part.type !== "text") {
            throw new CompatibilityError("Responses instructions only support text content");
          }
          return part.text;
        })
        .join(""),
    )
    .filter(Boolean)
    .join("\n\n");
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content
          .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
          .join(""),
      });
      continue;
    }
    if (message.content.length)
      input.push({
        type: "message",
        role: message.role,
        content: message.content.map((part) => responseContent(part, message.role)),
      });
    for (const call of message.toolCalls ?? [])
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
  }
  let toolChoice = request.toolChoice;
  if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function)) {
    toolChoice = { type: "function", name: toolChoice.function.name };
  }
  let format = request.responseFormat;
  if (isRecord(format) && format.type === "json_schema" && isRecord(format.json_schema))
    format = { type: "json_schema", ...format.json_schema };
  return {
    model: request.model,
    input,
    ...(instructions ? { instructions } : {}),
    stream: false,
    store: false,
    ...(request.tools
      ? { tools: request.tools.map((tool) => ({ type: "function", ...tool })) }
      : {}),
    ...(toolChoice != null ? { tool_choice: toolChoice } : {}),
    ...(request.maxTokens != null ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
    ...(request.topP != null ? { top_p: request.topP } : {}),
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...(format != null ? { text: { format } } : {}),
    ...(request.metadata != null ? { metadata: request.metadata } : {}),
    ...(request.user ? { user: request.user } : {}),
  };
}

function anthropicContent(message: Message): unknown[] {
  const parts: unknown[] = message.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      const data = dataUri(part.url);
      return data
        ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } }
        : { type: "image", source: { type: "url", url: part.url } };
    }
    if (part.type === "file")
      return {
        type: "document",
        source: part.fileId
          ? { type: "file", file_id: part.fileId }
          : { type: "base64", media_type: "application/octet-stream", data: part.data ?? "" },
        ...(part.filename ? { title: part.filename } : {}),
      };
    throw new CompatibilityError(
      "Anthropic Messages does not support OpenAI input_audio",
      "unsupported_feature",
    );
  });
  for (const call of message.toolCalls ?? [])
    parts.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: JSON.parse(call.arguments || "{}"),
    });
  return parts;
}

function toAnthropic(request: CompletionRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap(anthropicContent);
  const messages = request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) =>
      message.role === "tool"
        ? {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: message.toolCallId,
                content: anthropicContent(message),
              },
            ],
          }
        : { role: message.role, content: anthropicContent(message) },
    );
  let toolChoice = request.toolChoice;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required")
    toolChoice = toolChoice === "required" ? { type: "any" } : { type: toolChoice };
  else if (isRecord(toolChoice) && isRecord(toolChoice.function))
    toolChoice = { type: "tool", name: toolChoice.function.name };
  return {
    model: request.model,
    messages,
    max_tokens: request.maxTokens ?? 4096,
    stream: false,
    ...(system.length ? { system } : {}),
    ...(request.tools
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters ?? { type: "object", properties: {} },
          })),
        }
      : {}),
    ...(toolChoice != null ? { tool_choice: toolChoice } : {}),
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
    ...(request.topP != null ? { top_p: request.topP } : {}),
    ...(request.stop != null
      ? { stop_sequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
      : {}),
    ...(request.reasoningEffort
      ? { thinking: { type: "adaptive" }, output_config: { effort: request.reasoningEffort } }
      : {}),
  };
}

function googlePart(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") return { text: part.text };
  if (part.type === "image") {
    const data = dataUri(part.url);
    return data
      ? { inlineData: { mimeType: data.mediaType, data: data.data } }
      : { fileData: { fileUri: part.url } };
  }
  if (part.type === "audio")
    return { inlineData: { mimeType: `audio/${part.format ?? "wav"}`, data: part.data } };
  return part.fileId
    ? { fileData: { fileUri: part.fileId } }
    : { inlineData: { mimeType: "application/octet-stream", data: part.data ?? "" } };
}

function toGoogle(request: CompletionRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => message.content.map(googlePart));
  const contents = request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => {
      const parts = message.role === "tool" ? [] : message.content.map(googlePart);
      for (const call of message.toolCalls ?? [])
        parts.push({ functionCall: { name: call.name, args: JSON.parse(call.arguments || "{}") } });
      if (message.role === "tool")
        parts.push({
          functionResponse: {
            name: message.toolCallId ?? "function",
            response: {
              result: message.content.map((part) => (part.type === "text" ? part.text : part)),
            },
          },
        });
      return { role: message.role === "assistant" ? "model" : "user", parts };
    });
  const schema =
    isRecord(request.responseFormat) && isRecord(request.responseFormat.json_schema)
      ? request.responseFormat.json_schema.schema
      : undefined;
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: system } } : {}),
    ...(request.tools
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          ],
        }
      : {}),
    generationConfig: {
      ...(request.maxTokens != null ? { maxOutputTokens: request.maxTokens } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.topP != null ? { topP: request.topP } : {}),
      ...(request.stop != null
        ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
        : {}),
      ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
    },
  };
}

function usage(
  input?: number,
  output?: number,
  cached?: number,
  reasoning?: number,
): CompletionResult["usage"] {
  if (input == null && output == null) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    total: (input ?? 0) + (output ?? 0),
    ...(cached != null ? { cached } : {}),
    ...(reasoning != null ? { reasoning } : {}),
  };
}

function parseChatResult(raw: Record<string, unknown>, model: string): CompletionResult {
  const choice = Array.isArray(raw.choices) && isRecord(raw.choices[0]) ? raw.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const details = isRecord(raw.usage) ? raw.usage : undefined;
  const promptDetails = isRecord(details?.prompt_tokens_details)
    ? details.prompt_tokens_details
    : undefined;
  const completionDetails = isRecord(details?.completion_tokens_details)
    ? details.completion_tokens_details
    : undefined;
  const finish = stringValue(choice.finish_reason);
  return {
    id: stringValue(raw.id) ?? `chatcmpl_${crypto.randomUUID()}`,
    model: stringValue(raw.model) ?? model,
    created: numberValue(raw.created) ?? Math.floor(Date.now() / 1000),
    content: openAiParts(message.content),
    toolCalls: chatToolCalls(message.tool_calls) ?? [],
    refusal: stringValue(message.refusal),
    finishReason:
      finish === "length" || finish === "tool_calls" || finish === "content_filter"
        ? finish
        : "stop",
    usage: usage(
      numberValue(details?.prompt_tokens),
      numberValue(details?.completion_tokens),
      numberValue(promptDetails?.cached_tokens),
      numberValue(completionDetails?.reasoning_tokens),
    ),
  };
}

function parseResponsesResult(raw: Record<string, unknown>, model: string): CompletionResult {
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  let refusal: string | undefined;
  for (const item of Array.isArray(raw.output) ? raw.output : []) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call")
      toolCalls.push({
        id: stringValue(item.call_id) ?? stringValue(item.id) ?? `call_${crypto.randomUUID()}`,
        name: stringValue(item.name) ?? "function",
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
      });
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (!isRecord(part)) continue;
      if (part.type === "output_text")
        content.push({ type: "text", text: stringValue(part.text) ?? "" });
      if (part.type === "refusal") refusal = stringValue(part.refusal);
    }
  }
  if (!content.length && typeof raw.output_text === "string")
    content.push({ type: "text", text: raw.output_text });
  const details = isRecord(raw.usage) ? raw.usage : undefined;
  const inputDetails = isRecord(details?.input_tokens_details)
    ? details.input_tokens_details
    : undefined;
  const outputDetails = isRecord(details?.output_tokens_details)
    ? details.output_tokens_details
    : undefined;
  return {
    id: stringValue(raw.id) ?? `resp_${crypto.randomUUID()}`,
    model: stringValue(raw.model) ?? model,
    created: numberValue(raw.created_at) ?? Math.floor(Date.now() / 1000),
    content,
    toolCalls,
    refusal,
    finishReason: toolCalls.length
      ? "tool_calls"
      : raw.status === "incomplete"
        ? "length"
        : raw.status === "failed"
          ? "error"
          : "stop",
    usage: usage(
      numberValue(details?.input_tokens),
      numberValue(details?.output_tokens),
      numberValue(inputDetails?.cached_tokens),
      numberValue(outputDetails?.reasoning_tokens),
    ),
  };
}

function parseAnthropicResult(raw: Record<string, unknown>, model: string): CompletionResult {
  const parsed = anthropicParts(raw.content);
  const rawUsage = isRecord(raw.usage) ? raw.usage : undefined;
  const stop = stringValue(raw.stop_reason);
  return {
    id: stringValue(raw.id) ?? `msg_${crypto.randomUUID()}`,
    model: stringValue(raw.model) ?? model,
    created: Math.floor(Date.now() / 1000),
    content: parsed.content,
    toolCalls: parsed.toolCalls ?? [],
    finishReason:
      stop === "max_tokens"
        ? "length"
        : stop === "tool_use"
          ? "tool_calls"
          : stop === "refusal"
            ? "content_filter"
            : "stop",
    usage: usage(
      numberValue(rawUsage?.input_tokens),
      numberValue(rawUsage?.output_tokens),
      numberValue(rawUsage?.cache_read_input_tokens),
    ),
  };
}

function parseGoogleResult(raw: Record<string, unknown>, model: string): CompletionResult {
  const candidate =
    Array.isArray(raw.candidates) && isRecord(raw.candidates[0]) ? raw.candidates[0] : {};
  const resultContent = isRecord(candidate.content) ? candidate.content : {};
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of Array.isArray(resultContent.parts) ? resultContent.parts : []) {
    if (!isRecord(item)) continue;
    if (typeof item.text === "string") content.push({ type: "text", text: item.text });
    if (isRecord(item.functionCall))
      toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name: stringValue(item.functionCall.name) ?? "function",
        arguments: JSON.stringify(item.functionCall.args ?? {}),
      });
  }
  const rawUsage = isRecord(raw.usageMetadata) ? raw.usageMetadata : undefined;
  const finish = stringValue(candidate.finishReason);
  return {
    id: stringValue(raw.responseId) ?? `gemini_${crypto.randomUUID()}`,
    model: stringValue(raw.modelVersion) ?? model,
    created: Math.floor(Date.now() / 1000),
    content,
    toolCalls,
    finishReason: toolCalls.length
      ? "tool_calls"
      : finish === "MAX_TOKENS"
        ? "length"
        : finish === "SAFETY" || finish === "BLOCKLIST"
          ? "content_filter"
          : "stop",
    usage: usage(
      numberValue(rawUsage?.promptTokenCount),
      numberValue(rawUsage?.candidatesTokenCount),
      numberValue(rawUsage?.cachedContentTokenCount),
      numberValue(rawUsage?.thoughtsTokenCount),
    ),
  };
}

function resultToChat(result: CompletionResult): Record<string, unknown> {
  return {
    id: result.id.startsWith("chatcmpl_") ? result.id : `chatcmpl_${result.id}`,
    object: "chat.completion",
    created: result.created,
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            result.content
              .filter((part) => part.type === "text")
              .map((part) => (part as TextPart).text)
              .join("") || null,
          ...(result.refusal ? { refusal: result.refusal } : {}),
          ...(result.toolCalls.length
            ? {
                tool_calls: result.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: result.finishReason,
      },
    ],
    ...(result.usage
      ? {
          usage: {
            prompt_tokens: result.usage.input,
            completion_tokens: result.usage.output,
            total_tokens: result.usage.total,
            ...(result.usage.cached != null
              ? { prompt_tokens_details: { cached_tokens: result.usage.cached } }
              : {}),
            ...(result.usage.reasoning != null
              ? { completion_tokens_details: { reasoning_tokens: result.usage.reasoning } }
              : {}),
          },
        }
      : {}),
  };
}

function resultToResponses(result: CompletionResult): Record<string, unknown> {
  const output: unknown[] = [];
  const textParts = result.content
    .filter((part) => part.type === "text")
    .map((part) => ({ type: "output_text", text: (part as TextPart).text, annotations: [] }));
  if (result.refusal) textParts.push({ type: "refusal", refusal: result.refusal } as never);
  if (textParts.length)
    output.push({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: textParts,
    });
  for (const call of result.toolCalls)
    output.push({
      id: `fc_${crypto.randomUUID()}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  return {
    id: result.id.startsWith("resp_") ? result.id : `resp_${result.id}`,
    object: "response",
    created_at: result.created,
    status:
      result.finishReason === "error"
        ? "failed"
        : result.finishReason === "length"
          ? "incomplete"
          : "completed",
    model: result.model,
    output,
    output_text: result.content
      .filter((part) => part.type === "text")
      .map((part) => (part as TextPart).text)
      .join(""),
    ...(result.usage
      ? {
          usage: {
            input_tokens: result.usage.input,
            output_tokens: result.usage.output,
            total_tokens: result.usage.total,
            input_tokens_details: { cached_tokens: result.usage.cached ?? 0 },
            output_tokens_details: { reasoning_tokens: result.usage.reasoning ?? 0 },
          },
        }
      : {}),
  };
}

function resultToAnthropic(result: CompletionResult): Record<string, unknown> {
  const content: unknown[] = result.content
    .filter((part) => part.type === "text")
    .map((part) => ({ type: "text", text: (part as TextPart).text }));
  for (const call of result.toolCalls)
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: JSON.parse(call.arguments || "{}"),
    });
  return {
    id: result.id.startsWith("msg_") ? result.id : `msg_${result.id}`,
    type: "message",
    role: "assistant",
    model: result.model,
    content,
    stop_reason:
      result.finishReason === "length"
        ? "max_tokens"
        : result.toolCalls.length
          ? "tool_use"
          : "end_turn",
    stop_sequence: null,
    ...(result.usage
      ? {
          usage: {
            input_tokens: result.usage.input,
            output_tokens: result.usage.output,
            ...(result.usage.cached != null
              ? { cache_read_input_tokens: result.usage.cached }
              : {}),
          },
        }
      : {}),
  };
}

function resultToGoogle(result: CompletionResult): Record<string, unknown> {
  return {
    responseId: result.id,
    modelVersion: result.model,
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            ...result.content
              .filter((part) => part.type === "text")
              .map((part) => ({ text: (part as TextPart).text })),
            ...result.toolCalls.map((call) => ({
              functionCall: { name: call.name, args: JSON.parse(call.arguments || "{}") },
            })),
          ],
        },
        finishReason:
          result.finishReason === "length"
            ? "MAX_TOKENS"
            : result.finishReason === "content_filter"
              ? "SAFETY"
              : "STOP",
        index: 0,
      },
    ],
    ...(result.usage
      ? {
          usageMetadata: {
            promptTokenCount: result.usage.input,
            candidatesTokenCount: result.usage.output,
            totalTokenCount: result.usage.total,
            ...(result.usage.cached != null
              ? { cachedContentTokenCount: result.usage.cached }
              : {}),
            ...(result.usage.reasoning != null
              ? { thoughtsTokenCount: result.usage.reasoning }
              : {}),
          },
        }
      : {}),
  };
}

function sse(frames: unknown[]): Response {
  return new Response(
    frames
      .map((frame) => (typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`))
      .join(""),
    {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

function streamChat(result: CompletionResult): Response {
  const base = resultToChat(result);
  const choice = (base.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  const chunk = (delta: unknown, finish: unknown = null, includeUsage = false) => ({
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(includeUsage && base.usage ? { usage: base.usage } : {}),
  });
  const frames: unknown[] = [chunk({ role: "assistant", content: "" })];
  if (typeof message.content === "string" && message.content)
    frames.push(chunk({ content: message.content }));
  for (const [index, call] of (Array.isArray(message.tool_calls)
    ? message.tool_calls
    : []
  ).entries())
    frames.push(chunk({ tool_calls: [{ index, ...call }] }));
  frames.push(chunk({}, choice.finish_reason, true), "data: [DONE]\n\n");
  return sse(frames);
}

function responsesToChatStream(upstream: Response, model: string): Response {
  if (!upstream.body) return upstream;
  const encoder = new TextEncoder();
  let response: Record<string, unknown> = {
    id: `resp_${crypto.randomUUID()}`,
    model,
    created_at: Math.floor(Date.now() / 1000),
  };
  let started = false;
  let finished = false;
  let hasToolCalls = false;
  const toolIndexes = new Map<number, number>();
  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    rawUsage?: Record<string, unknown>,
  ): void => {
    const usage = rawUsage
      ? {
          prompt_tokens: rawUsage.input_tokens,
          completion_tokens: rawUsage.output_tokens,
          total_tokens: rawUsage.total_tokens,
        }
      : undefined;
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          id: `chatcmpl_${stringValue(response.id) ?? crypto.randomUUID()}`,
          object: "chat.completion.chunk",
          created: numberValue(response.created_at) ?? Math.floor(Date.now() / 1000),
          model: stringValue(response.model) ?? model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      ),
    );
  };
  const start = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (started) return;
    started = true;
    emit(controller, { role: "assistant", content: "" });
  };
  const finish = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    completed?: Record<string, unknown>,
  ): void => {
    if (finished) return;
    if (completed) response = completed;
    start(controller);
    finished = true;
    const incomplete = response.status === "incomplete";
    emit(
      controller,
      {},
      hasToolCalls ? "tool_calls" : incomplete ? "length" : "stop",
      isRecord(response.usage) ? response.usage : undefined,
    );
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      const handle = (raw: string): void => {
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") return;
        const event: unknown = JSON.parse(data);
        if (!isRecord(event)) return;
        const completed = isRecord(event.response) ? event.response : undefined;
        if (event.type === "response.created" && completed) response = completed;
        if (event.type === "response.output_text.delta") {
          start(controller);
          emit(controller, { content: stringValue(event.delta) ?? "" });
        }
        if (event.type === "response.refusal.delta") {
          start(controller);
          emit(controller, { refusal: stringValue(event.delta) ?? "" });
        }
        const outputIndex = numberValue(event.output_index) ?? toolIndexes.size;
        if (
          event.type === "response.output_item.added" &&
          isRecord(event.item) &&
          event.item.type === "function_call"
        ) {
          start(controller);
          hasToolCalls = true;
          const index = toolIndexes.size;
          toolIndexes.set(outputIndex, index);
          emit(controller, {
            tool_calls: [
              {
                index,
                id:
                  stringValue(event.item.call_id) ??
                  stringValue(event.item.id) ??
                  `call_${crypto.randomUUID()}`,
                type: "function",
                function: {
                  name: stringValue(event.item.name) ?? "function",
                  arguments: stringValue(event.item.arguments) ?? "",
                },
              },
            ],
          });
        }
        if (event.type === "response.function_call_arguments.delta") {
          start(controller);
          hasToolCalls = true;
          emit(controller, {
            tool_calls: [
              {
                index: toolIndexes.get(outputIndex) ?? 0,
                function: { arguments: stringValue(event.delta) ?? "" },
              },
            ],
          });
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          finish(controller, completed);
        }
        if (event.type === "response.failed" || event.type === "error") {
          const detail = isRecord(event.error)
            ? stringValue(event.error.message)
            : "Provider stream failed";
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: {
                  message: detail ?? "Provider stream failed",
                  type: "provider_error",
                  code: "provider_error",
                },
              })}\n\n`,
            ),
          );
          finished = true;
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          for (
            let end = buffer.search(/\r?\n\r?\n/);
            end !== -1;
            end = buffer.search(/\r?\n\r?\n/)
          ) {
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
            handle(raw);
          }
          if (done) break;
        }
        if (buffer) handle(buffer);
        finish(controller);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
        upstreamReader = undefined;
      }
    },
    cancel(reason) {
      return upstreamReader?.cancel(reason);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function streamResponses(result: CompletionResult): Response {
  const response = resultToResponses(result);
  const frames: unknown[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
  ];
  for (const [outputIndex, item] of (response.output as Array<Record<string, unknown>>).entries()) {
    frames.push({ type: "response.output_item.added", output_index: outputIndex, item });
    if (item.type === "message") {
      for (const [contentIndex, part] of (
        item.content as Array<Record<string, unknown>>
      ).entries()) {
        frames.push({
          type: "response.content_part.added",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
        if (part.type === "output_text")
          frames.push({
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
          });
        frames.push({
          type: "response.content_part.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      }
    } else if (item.type === "function_call") {
      frames.push({
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      frames.push({
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }
    frames.push({ type: "response.output_item.done", output_index: outputIndex, item });
  }
  frames.push({ type: "response.completed", response }, "data: [DONE]\n\n");
  return sse(frames);
}

function streamAnthropic(result: CompletionResult): Response {
  const message = resultToAnthropic(result);
  const frames: string[] = [];
  const event = (name: string, data: unknown) =>
    frames.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event("message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: result.usage?.input ?? 0, output_tokens: 0 },
    },
  });
  for (const [index, block] of (message.content as Array<Record<string, unknown>>).entries()) {
    event("content_block_start", {
      type: "content_block_start",
      index,
      content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index,
      delta:
        block.type === "text"
          ? { type: "text_delta", text: block.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    });
    event("content_block_stop", { type: "content_block_stop", index });
  }
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: result.usage?.output ?? 0 },
  });
  event("message_stop", { type: "message_stop" });
  return new Response(frames.join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  });
}

const DEFAULT_PROTOCOL: Record<string, WireProtocol> = {
  chatgpt: "responses",
  claude: "messages",
  copilot: "chat/completions",
  grok: "chat/completions",
  "opencode-go": "chat/completions",
  "opencode-zen": "chat/completions",
};

function endpointProtocol(endpoint: string): WireProtocol | null {
  const normalized = endpoint.replace(/^\//, "");
  if (normalized.includes("responses")) return "responses";
  if (normalized.includes("chat/completions")) return "chat/completions";
  if (normalized.includes("messages")) return "messages";
  if (normalized.startsWith("models/")) return "google";
  return null;
}

function nativeProtocol(
  provider: ProviderId,
  model: ProviderModel | undefined,
  requested: WireProtocol,
): WireProtocol {
  const protocols = (model?.endpoints ?? []).flatMap(
    (endpoint) => endpointProtocol(endpoint) ?? [],
  );
  if (protocols.includes(requested)) return requested;
  return protocols[0] ?? DEFAULT_PROTOCOL[provider] ?? requested;
}

function targetBody(protocol: WireProtocol, request: CompletionRequest): Record<string, unknown> {
  if (protocol === "responses") return toResponses(request);
  if (protocol === "messages") return toAnthropic(request);
  if (protocol === "google") return toGoogle(request);
  return toChat(request);
}

function targetPath(protocol: WireProtocol, model: string): string {
  return protocol === "google" ? `models/${encodeURIComponent(model)}:generateContent` : protocol;
}

async function upstreamResult(
  response: Response,
  protocol: WireProtocol,
  model: string,
): Promise<CompletionResult> {
  const body = await response.text();
  let raw: unknown;
  if (protocol === "responses" && /(^|\n)data:/.test(body)) {
    let completed: Record<string, unknown> = {};
    let outputText = "";
    const calls = new Map<number, ToolCall>();
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event: unknown = JSON.parse(data);
      if (!isRecord(event)) continue;
      if (event.type === "response.output_text.delta") outputText += stringValue(event.delta) ?? "";
      const index = numberValue(event.output_index) ?? calls.size;
      if (
        event.type === "response.output_item.added" &&
        isRecord(event.item) &&
        event.item.type === "function_call"
      ) {
        calls.set(index, {
          id:
            stringValue(event.item.call_id) ??
            stringValue(event.item.id) ??
            `call_${crypto.randomUUID()}`,
          name: stringValue(event.item.name) ?? "function",
          arguments: stringValue(event.item.arguments) ?? "",
        });
      }
      if (event.type === "response.function_call_arguments.delta") {
        const call = calls.get(index);
        if (call) call.arguments += stringValue(event.delta) ?? "";
      }
      if (event.type === "response.completed" && isRecord(event.response))
        completed = event.response;
      if ((event.type === "response.failed" || event.type === "error") && isRecord(event.response))
        completed = event.response;
    }
    const output = Array.isArray(completed.output) ? [...completed.output] : [];
    if (outputText && !output.some((item) => isRecord(item) && item.type === "message")) {
      output.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }],
      });
    }
    if (calls.size && !output.some((item) => isRecord(item) && item.type === "function_call")) {
      output.push(
        ...[...calls.values()].map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      );
    }
    raw = { ...completed, output };
  } else raw = JSON.parse(body);
  const value = record(raw, "Provider returned an invalid compatibility response");
  if (protocol === "responses") return parseResponsesResult(value, model);
  if (protocol === "messages") return parseAnthropicResult(value, model);
  if (protocol === "google") return parseGoogleResult(value, model);
  return parseChatResult(value, model);
}

function renderResult(result: CompletionResult, protocol: WireProtocol, stream: boolean): Response {
  if (stream) {
    if (protocol === "responses") return streamResponses(result);
    if (protocol === "messages") return streamAnthropic(result);
    if (protocol === "google") return sse([resultToGoogle(result)]);
    return streamChat(result);
  }
  const body =
    protocol === "responses"
      ? resultToResponses(result)
      : protocol === "messages"
        ? resultToAnthropic(result)
        : protocol === "google"
          ? resultToGoogle(result)
          : resultToChat(result);
  return Response.json(body);
}

function errorResponse(error: unknown, protocol: WireProtocol, status = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CompatibilityError ? error.code : "provider_error";
  const body =
    protocol === "messages"
      ? { type: "error", error: { type: code, message } }
      : protocol === "google"
        ? { error: { code: status, status: code.toUpperCase(), message } }
        : { error: { message, type: code, code } };
  return Response.json(body, {
    status: error instanceof CompatibilityError ? error.status : status,
  });
}

export function requestProtocol(
  path: string,
): { protocol: WireProtocol; model?: string; stream?: boolean } | null {
  const clean = path.replace(/^\//, "").split("?")[0] ?? "";
  if (clean === "responses") return { protocol: "responses" };
  if (clean === "chat/completions") return { protocol: "chat/completions" };
  if (clean === "messages") return { protocol: "messages" };
  const google = clean.match(/^models\/([^/:]+):(streamGenerateContent|generateContent)$/);
  return google?.[1]
    ? {
        protocol: "google",
        model: decodeURIComponent(google[1]),
        stream: google[2] === "streamGenerateContent",
      }
    : null;
}

export async function proxyCompatible(
  auth: SubscriptionAuth,
  provider: ProviderId,
  account: string,
  path: string,
  body: Buffer,
  headers: Headers,
  signal?: AbortSignal,
): Promise<Response | null> {
  const route = requestProtocol(path);
  if (!route) return null;
  try {
    if (!body.length && (DEFAULT_PROTOCOL[provider] ?? route.protocol) === route.protocol)
      return null;
    const raw = json(body);
    const modelHint = stringValue(raw.model) ?? route.model;
    if (!modelHint && (DEFAULT_PROTOCOL[provider] ?? route.protocol) === route.protocol)
      return null;
    const catalog = modelHint
      ? await auth.getModels(provider, account, signal).catch(() => null)
      : null;
    const model = catalog?.models.find((candidate) => candidate.id === modelHint);
    const target = nativeProtocol(provider, model, route.protocol);
    if (target === route.protocol) return null;
    const request =
      route.protocol === "chat/completions"
        ? parseChat(body)
        : route.protocol === "responses"
          ? parseResponses(body)
          : route.protocol === "messages"
            ? parseAnthropic(body)
            : parseGoogle(body, route.model ?? "", route.stream);
    const upstreamHeaders = new Headers(headers);
    upstreamHeaders.set("content-type", "application/json");
    upstreamHeaders.set("accept", "application/json");
    const outgoing = targetBody(target, request);
    if (provider === "chatgpt" && target === "responses") {
      delete outgoing.temperature;
      delete outgoing.top_p;
    }
    if (
      target === "responses" &&
      (provider === "chatgpt" || (request.stream && route.protocol === "chat/completions"))
    ) {
      outgoing.stream = true;
    }
    const upstream = await auth.proxy(provider, account, targetPath(target, request.model), {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(outgoing),
      signal,
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      return errorResponse(
        new Error(detail || `Provider request failed (${upstream.status})`),
        route.protocol,
        upstream.status,
      );
    }
    if (
      request.stream &&
      route.protocol === "chat/completions" &&
      target === "responses" &&
      upstream.body
    ) {
      return responsesToChatStream(upstream, request.model);
    }
    return renderResult(
      await upstreamResult(upstream, target, request.model),
      route.protocol,
      request.stream,
    );
  } catch (error) {
    return errorResponse(error, route.protocol);
  }
}
