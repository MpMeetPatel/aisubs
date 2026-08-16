import type { OAuthCredential, ProviderAdapter, ProviderLogin, ProviderModel } from "../types.js";
import { copilotPlanName, parseCopilotUsage } from "../usage.js";
import {
  abortableDelay,
  bearerRequest,
  isRecord,
  numberValue,
  requireAllowedHost,
  responseJson,
  stringArray,
  stringValue,
} from "../utils.js";

const DEFAULT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const EXPIRY_SKEW_MS = 5 * 60_000;
const AUTO_API_VERSION = "2025-10-01";
const HEADERS = {
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
  "x-github-api-version": "2026-06-01",
};

class CopilotTokenError extends Error {
  constructor(readonly status: number) {
    super(`Copilot token exchange failed (${status})`);
  }
}

type AutoSession = {
  token: string;
  availableModels: string[];
  selectedModel: string;
  previousModel: string | null;
  turnNumber: number;
  expiresAt?: number;
};

function isAutoModel(id: string): boolean {
  return id === "auto" || id.endsWith("-free-auto");
}

function promptText(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) promptText(item.text ?? item.content ?? item.input, out);
    }
  }
}

function normalizeResponsesStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const ids = new Map<number, string>();
  let currentTextId: string | undefined;
  let currentReasoningId: string | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  const normalize = (frame: string) =>
    frame.replace(/^(\s*data:\s*)(.+)$/gm, (line, prefix, data) => {
      if (data.trim() === "[DONE]") return line;
      try {
        const value: unknown = JSON.parse(data);
        if (!isRecord(value)) return line;
        const outputIndex = numberValue(value.output_index);
        const item = isRecord(value.item) ? value.item : undefined;
        if (
          value.type === "response.output_item.added" &&
          outputIndex != null &&
          typeof item?.id === "string"
        ) {
          ids.set(outputIndex, item.id);
          if (item.type === "message") currentTextId = item.id;
          if (item.type === "reasoning") currentReasoningId = item.id;
        }
        const type = stringValue(value.type) ?? "";
        const canonicalId =
          (outputIndex == null ? undefined : ids.get(outputIndex)) ??
          (type.startsWith("response.reasoning_summary_")
            ? currentReasoningId
            : type.startsWith("response.output_text.") ||
                type.startsWith("response.content_part.") ||
                type.startsWith("response.refusal.")
              ? currentTextId
              : undefined);
        if (canonicalId && typeof value.item_id === "string") value.item_id = canonicalId;
        if (
          canonicalId &&
          value.type === "response.output_item.done" &&
          item &&
          typeof item.id === "string"
        ) {
          item.id = canonicalId;
        }
        return `${prefix}${JSON.stringify(value)}`;
      } catch {
        return line;
      }
    });
  return body
    .pipeThrough(
      new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
          controller.enqueue(decoder.decode(chunk, { stream: true }));
        },
        flush(controller) {
          const rest = decoder.decode();
          if (rest) controller.enqueue(rest);
        },
      }),
    )
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          buffer += chunk;
          let match = buffer.match(/\r?\n\r?\n/);
          while (match?.index != null) {
            const end = match.index + match[0].length;
            controller.enqueue(normalize(buffer.slice(0, end)));
            buffer = buffer.slice(end);
            match = buffer.match(/\r?\n\r?\n/);
          }
        },
        flush(controller) {
          if (buffer) controller.enqueue(normalize(buffer));
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
}

function normalizeModel(value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!id) return null;
  const isAuto = id.endsWith("-free-auto");
  const policy = isRecord(value.policy) ? value.policy : {};
  if (policy.state === "disabled") return null;
  const selectable = value.model_picker_enabled === true || isAuto;
  if (policy.state !== "enabled" && !selectable) return null;
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const limits = isRecord(capabilities.limits) ? capabilities.limits : {};
  const supports = isRecord(capabilities.supports) ? capabilities.supports : {};
  const modalities = ["text"];
  if (supports.vision === true || isRecord(limits.vision)) modalities.push("image");
  return {
    id,
    name: isAuto ? "Auto" : stringValue(value.name),
    contextWindow:
      numberValue(limits.max_context_window_tokens) ?? numberValue(limits.max_prompt_tokens),
    maxOutputTokens: numberValue(limits.max_output_tokens),
    reasoningEfforts: stringArray(supports.reasoning_effort),
    inputModalities: modalities,
    endpoints: stringArray(value.supported_endpoints)?.map((endpoint) =>
      endpoint.replace(/^\//, ""),
    ),
    ...(supports.tool_calls === true || isAuto ? { supportsToolCall: true } : {}),
    available: true,
    selectable,
  };
}

function normalizeDomain(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) return "github.com";
  let hostname: string;
  try {
    hostname = new URL(input.includes("://") ? input : `https://${input}`).hostname;
  } catch {
    throw new Error("Invalid GitHub Enterprise domain");
  }
  if (hostname !== "github.com" && !hostname.endsWith(".ghe.com")) {
    throw new Error(
      "Only github.com and GitHub Enterprise Cloud data-residency hosts (*.ghe.com) are supported",
    );
  }
  return hostname;
}

function endpoints(domain: string) {
  return {
    deviceCode: `https://${domain}/login/device/code`,
    accessToken: `https://${domain}/login/oauth/access_token`,
    copilotToken: `https://api.${domain}/copilot_internal/v2/token`,
    user: `https://api.${domain}/copilot_internal/user`,
  };
}

function baseUrlFromToken(token: string, enterpriseDomain?: string): string {
  const proxyHost = token.match(/proxy-ep=([^;]+)/)?.[1];
  if (proxyHost) return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
  if (enterpriseDomain && enterpriseDomain !== "github.com") {
    return `https://copilot-api.${enterpriseDomain}`;
  }
  return "https://api.individual.githubcopilot.com";
}

export interface CopilotProviderOptions {
  clientId?: string;
  fetch?: typeof globalThis.fetch;
}

export function copilotProvider(options: CopilotProviderOptions = {}): ProviderAdapter {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const fetcher = options.fetch ?? globalThis.fetch;
  const autoSessions = new Map<string, AutoSession>();

  async function routeAuto(
    body: Record<string, unknown>,
    credential: OAuthCredential,
    signal: AbortSignal,
  ): Promise<AutoSession> {
    const baseUrl = stringValue(credential.metadata?.baseUrl);
    if (!baseUrl) throw new Error("Copilot API base URL is missing");
    const key = `${baseUrl}:${credential.account?.id ?? credential.account?.label ?? "default"}`;
    let session = autoSessions.get(key);
    if (
      !session ||
      (session.expiresAt != null && Date.now() >= session.expiresAt * 1000 - 60_000)
    ) {
      const raw = await responseJson(
        await fetcher(`${baseUrl}/models/session`, {
          method: "POST",
          headers: {
            ...HEADERS,
            authorization: `Bearer ${credential.accessToken}`,
            "content-type": "application/json",
            "x-github-api-version": AUTO_API_VERSION,
          },
          body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
          signal,
        }),
        "Copilot Auto session setup",
      );
      const token = stringValue(raw.session_token);
      const selectedModel = stringValue(raw.selected_model);
      if (!token || !selectedModel) throw new Error("Copilot Auto session response is incomplete");
      session = {
        token,
        selectedModel,
        availableModels: stringArray(raw.available_models) ?? [],
        previousModel: null,
        turnNumber: 0,
        expiresAt: numberValue(raw.expires_at),
      };
    }
    const prompt: string[] = [];
    promptText(body.instructions, prompt);
    promptText(body.input ?? body.messages, prompt);
    const intentResponse = await fetcher(`${baseUrl}/models/session/intent`, {
      method: "POST",
      headers: {
        ...HEADERS,
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": "application/json",
        "copilot-session-token": session.token,
        "x-github-api-version": AUTO_API_VERSION,
      },
      body: JSON.stringify({
        prompt: prompt.join("\n"),
        available_models: session.availableModels,
        turn_number: session.turnNumber + 1,
        previous_model: session.previousModel,
        reference_count: 0,
        prompt_char_count: prompt.join("\n").length,
      }),
      signal,
    });
    let selectedModel = session.selectedModel;
    if (intentResponse.ok) {
      const intent = await responseJson(intentResponse, "Copilot Auto intent");
      selectedModel =
        stringValue(intent.chosen_model) ??
        stringValue(intent.selected_model) ??
        stringValue(intent.model) ??
        selectedModel;
    }
    session = {
      ...session,
      selectedModel,
      previousModel: selectedModel,
      turnNumber: session.turnNumber + 1,
    };
    autoSessions.set(key, session);
    body.model = selectedModel;
    return session;
  }

  async function exchange(
    githubToken: string,
    domain: string,
    signal: AbortSignal,
  ): Promise<OAuthCredential> {
    const response = await fetcher(endpoints(domain).copilotToken, {
      headers: { accept: "application/json", authorization: `Bearer ${githubToken}`, ...HEADERS },
      signal,
    });
    if (!response.ok) throw new CopilotTokenError(response.status);
    const raw = await responseJson(response, "Copilot token exchange");
    const accessToken = stringValue(raw.token);
    const expiresAt = numberValue(raw.expires_at);
    if (!accessToken || !expiresAt) throw new Error("Copilot token response is incomplete");
    let user: Record<string, unknown> | null = null;
    try {
      const userResponse = await fetcher(endpoints(domain).user, {
        headers: { accept: "application/json", authorization: `token ${githubToken}`, ...HEADERS },
        signal,
      });
      if (userResponse.ok) user = await responseJson(userResponse, "Copilot account details");
    } catch (error) {
      if (signal.aborted) throw error;
    }
    const login = stringValue(user?.login);
    const plan = copilotPlanName(user);
    return {
      accessToken,
      refreshToken: githubToken,
      expiresAt: expiresAt * 1000 - EXPIRY_SKEW_MS,
      account: login || plan ? { id: login, label: login, plan } : undefined,
      metadata: {
        enterpriseDomain: domain,
        baseUrl: baseUrlFromToken(accessToken, domain),
      },
    };
  }

  return {
    id: "copilot",
    name: "GitHub Copilot",
    description: "GitHub Copilot access with automatic plan and organization detection.",
    homepage: "https://github.com/features/copilot",
    allowedHosts: ["api.github.com", "*.githubcopilot.com", "*.ghe.com"],
    proxyBaseUrl: (credential) => stringValue(credential.metadata?.baseUrl),
    loginModes: ["device"],
    async startLogin(signal, options): Promise<ProviderLogin> {
      const domain = normalizeDomain(options?.enterpriseDomain);
      const response = await fetcher(endpoints(domain).deviceCode, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          ...HEADERS,
        },
        body: new URLSearchParams({ client_id: clientId, scope: "read:user" }),
        signal,
      });
      const raw = await responseJson(response, "Copilot device login");
      const deviceCode = stringValue(raw.device_code);
      const userCode = stringValue(raw.user_code);
      const verificationUri = stringValue(raw.verification_uri);
      if (!deviceCode || !userCode || !verificationUri) {
        throw new Error("Copilot device response is incomplete");
      }
      let interval = Math.max(1, numberValue(raw.interval) ?? 5) * 1000;
      const expiresIn = numberValue(raw.expires_in) ?? 900;
      const complete = (async (): Promise<OAuthCredential> => {
        const deadline = Date.now() + expiresIn * 1000;
        while (Date.now() < deadline) {
          await abortableDelay(interval, signal);
          const tokenResponse = await fetcher(endpoints(domain).accessToken, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
              ...HEADERS,
            },
            body: new URLSearchParams({
              client_id: clientId,
              device_code: deviceCode,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
            signal,
          });
          const token = await responseJson(tokenResponse, "Copilot device authorization");
          const githubToken = stringValue(token.access_token);
          if (githubToken) return exchange(githubToken, domain, signal);
          const error = stringValue(token.error);
          if (error === "authorization_pending") continue;
          if (error === "slow_down") {
            interval += 5000;
            continue;
          }
          throw new Error(`Copilot device authorization failed${error ? `: ${error}` : ""}`);
        }
        throw new Error("Copilot device authorization timed out");
      })();
      return {
        prompt: {
          mode: "device",
          verificationUri,
          userCode,
          expiresAt: Date.now() + expiresIn * 1000,
        },
        complete,
      };
    },
    async refresh(credential, signal) {
      if (!credential.refreshToken) throw new Error("GitHub token is missing");
      const domain = normalizeDomain(credential.metadata?.enterpriseDomain);
      return exchange(credential.refreshToken, domain, signal);
    },
    async authorize(request, credential) {
      const baseUrl = stringValue(credential.metadata?.baseUrl);
      if (!baseUrl) throw new Error("Copilot API base URL is missing");
      requireAllowedHost(request, [new URL(baseUrl).hostname]);
      const raw: unknown =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              .catch(() => null)
          : null;
      const authorized = bearerRequest(request, credential, HEADERS);
      if (!isRecord(raw)) return authorized;
      const pathname = new URL(request.url).pathname;
      const isResponses = pathname.endsWith("/responses");
      const auto = typeof raw.model === "string" && isAutoModel(raw.model);
      const session = auto ? await routeAuto(raw, credential, request.signal) : null;
      if (isResponses && raw.store === undefined) raw.store = false;
      if (isResponses && raw.store !== true && Array.isArray(raw.input)) {
        raw.input = raw.input.flatMap((item) => {
          if (!isRecord(item)) return [item];
          if (item.type === "item_reference") return [];
          const { id: _id, ...withoutId } = item;
          return [withoutId];
        });
      }
      const entries = Array.isArray(raw.messages)
        ? raw.messages
        : Array.isArray(raw.input)
          ? raw.input
          : [];
      const last = entries.at(-1);
      const headers = new Headers(authorized.headers);
      headers.set("x-initiator", isRecord(last) && last.role !== "user" ? "agent" : "user");
      headers.set("openai-intent", "conversation-edits");
      if (session) {
        headers.set("copilot-session-token", session.token);
        headers.set("x-github-api-version", AUTO_API_VERSION);
      }
      if (/"(?:image_url|input_image|image)"/.test(JSON.stringify(raw))) {
        headers.set("copilot-vision-request", "true");
      }
      if (pathname.endsWith("/messages") && !headers.has("anthropic-beta")) {
        headers.set("anthropic-beta", "interleaved-thinking-2025-05-14");
      }
      return new Request(authorized, { method: "POST", headers, body: JSON.stringify(raw) });
    },
    normalizeResponse(request, response) {
      if (
        !new URL(request.url).pathname.endsWith("/responses") ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(normalizeResponsesStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    async getUsage({ credential, signal }) {
      if (!credential.refreshToken) throw new Error("GitHub token is missing");
      const domain = normalizeDomain(credential.metadata?.enterpriseDomain);
      const response = await fetcher(endpoints(domain).user, {
        headers: {
          accept: "application/json",
          authorization: `token ${credential.refreshToken}`,
          ...HEADERS,
        },
        signal,
      });
      return parseCopilotUsage(await responseJson(response, "Copilot usage"));
    },
    async getModels({ credential, fetch, signal }) {
      const baseUrl = stringValue(credential.metadata?.baseUrl);
      if (!baseUrl) throw new Error("Copilot API base URL is missing");
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          accept: "application/json",
          "x-github-api-version": "2026-06-01",
        },
        signal,
      });
      const raw = await responseJson(response, "Copilot models");
      const values = Array.isArray(raw.data) ? raw.data : [];
      return values.map(normalizeModel).filter((model): model is ProviderModel => Boolean(model));
    },
    isPermanentRefreshError(error) {
      return error instanceof CopilotTokenError && (error.status === 401 || error.status === 403);
    },
  };
}
