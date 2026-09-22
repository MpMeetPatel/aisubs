import type {
  OAuthCredential,
  ProviderAdapter,
  ProviderLogin,
  ProviderModel,
  ProviderUsageData,
  UsageMeter,
} from "../types.js";
import { randomBytes } from "node:crypto";
import {
  bearerRequest,
  isRecord,
  numberValue,
  requireAllowedHost,
  responseJson,
  stringArray,
  stringValue,
} from "../utils.js";

const API_HOST = "opencode.ai";
const API_KEY_LIFETIME_MS = 365 * 24 * 60 * 60_000;
const ID_PATTERN = /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface OpenCodeProviderOptions {
  fetch?: typeof globalThis.fetch;
}

interface OpenCodeProviderConfig {
  id: "opencode-go" | "opencode-zen";
  name: string;
  description: string;
  baseUrl: string;
}

function openCodeUsageMeter(id: string, label: string, raw: unknown): UsageMeter | null {
  if (!isRecord(raw)) return null;
  const percentUsed = numberValue(raw.percent);
  const resetsAt = stringValue(raw.resetsAt);
  if (percentUsed == null) return null;
  const resetAt = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return {
    id,
    label,
    unit: "percent",
    percentUsed: Math.min(100, Math.max(0, percentUsed)),
    resetAt: Number.isNaN(resetAt) ? undefined : resetAt,
  };
}

export function parseOpenCodeGoUsage(raw: unknown): ProviderUsageData | null {
  if (!isRecord(raw) || !isRecord(raw.usage)) return null;
  const meters = [
    openCodeUsageMeter("rolling", "5-hour limit", raw.usage.rolling),
    openCodeUsageMeter("weekly", "Weekly limit", raw.usage.weekly),
    openCodeUsageMeter("monthly", "Monthly limit", raw.usage.monthly),
  ].filter((meter): meter is UsageMeter => meter !== null);
  if (!meters.length) return null;
  return {
    plan: "OpenCode Go",
    meters,
    note: "Provider-reported quota usage. API-equivalent costs shown in chats are estimates, not charges.",
  };
}

function openCodeProvider(
  config: OpenCodeProviderConfig,
  options: OpenCodeProviderOptions = {},
): ProviderAdapter {
  const fetcher = options.fetch ?? globalThis.fetch;
  const compatibilityVersion = async () => {
    const response = await fetcher(
      "https://api.github.com/repos/anomalyco/opencode/releases/latest",
      { headers: { accept: "application/vnd.github+json", "user-agent": "aisubs" } },
    );
    if (!response.ok) throw new Error(`OpenCode version lookup failed: ${response.status}`);
    const raw: unknown = await response.json();
    const version = isRecord(raw) ? stringValue(raw.tag_name)?.replace(/^v/, "") : undefined;
    if (!version) throw new Error("OpenCode version lookup returned no release version");
    return version;
  };
  const routingIds = new Map<string, string>();
  let lastTimestamp = 0;
  let counter = 0;
  const identifier = (prefix: "ses" | "msg", source: string | null): string => {
    if (source && ID_PATTERN.test(source) && source.startsWith(`${prefix}_`)) return source;
    const key = source ? `${prefix}:${source}` : undefined;
    const cached = key ? routingIds.get(key) : undefined;
    if (cached) return cached;
    const timestamp = Date.now();
    counter = timestamp === lastTimestamp ? counter + 1 : 1;
    lastTimestamp = timestamp;
    const encoded = BigInt(timestamp) * 0x1000n + BigInt(counter);
    const time = Buffer.alloc(6);
    for (let index = 0; index < time.length; index += 1) {
      time[index] = Number((encoded >> BigInt(40 - 8 * index)) & 0xffn);
    }
    const random = [...randomBytes(14)].map((byte) => ID_CHARS[byte % ID_CHARS.length]).join("");
    const value = `${prefix}_${time.toString("hex")}${random}`;
    if (key) routingIds.set(key, value);
    return value;
  };
  const credential = (apiKey: string): OAuthCredential => ({
    accessToken: apiKey,
    expiresAt: Date.now() + API_KEY_LIFETIME_MS,
    account: { label: config.name },
  });

  return {
    id: config.id,
    name: config.name,
    description: config.description,
    homepage: "https://opencode.ai/auth",
    allowedHosts: [API_HOST],
    proxyBaseUrl: config.baseUrl,
    loginModes: ["api-key"],
    loginFields: [
      {
        name: "apiKey",
        label: "API key",
        description: "Create an API key at opencode.ai/auth.",
        type: "password",
        required: true,
      },
    ],
    async startLogin(_signal, options): Promise<ProviderLogin> {
      const apiKey = stringValue(options?.apiKey);
      if (!apiKey) throw new Error(`${config.name} API key is required`);
      return {
        prompt: { mode: "api-key", expiresAt: Date.now() + 60_000 },
        complete: Promise.resolve(credential(apiKey)),
      };
    },
    async refresh(current) {
      return { ...current, expiresAt: Date.now() + API_KEY_LIFETIME_MS };
    },
    async authorize(request, current) {
      requireAllowedHost(request, [API_HOST]);
      const client = request.headers.get("x-opencode-client")?.trim() || "aisubs";
      return bearerRequest(request, current, {
        "user-agent": `opencode/latest/${await compatibilityVersion()}/${client}`,
        "x-opencode-client": client,
        "x-opencode-session": identifier("ses", request.headers.get("x-opencode-session")),
        "x-opencode-request": identifier("msg", request.headers.get("x-opencode-request")),
      });
    },
    async getModels({ fetch, signal }) {
      const raw = await responseJson(
        await fetch(`${config.baseUrl}/models`, {
          headers: { accept: "application/json" },
          signal,
        }),
        `${config.name} models`,
      );
      const values = Array.isArray(raw.data)
        ? raw.data
        : Array.isArray(raw.models)
          ? raw.models
          : [];
      return values.flatMap((value): ProviderModel[] => {
        if (!isRecord(value)) return [];
        const id = stringValue(value.id);
        return id
          ? [
              {
                id,
                name: stringValue(value.name),
                description: stringValue(value.description),
                endpoints: stringArray(value.supported_endpoints) ?? stringArray(value.endpoints),
                available: true,
                selectable: true,
              },
            ]
          : [];
      });
    },
    async getUsage({ fetch, signal }) {
      if (config.id === "opencode-zen") {
        return {
          plan: "Pay as you go",
          facts: [{ label: "Billing", value: "Metered balance" }],
          note: "OpenCode does not expose Zen balance or spend through its API. Check the OpenCode console for the charged amount; chat costs are calculated from public Zen rates.",
        };
      }
      const raw = await responseJson(
        await fetch(`${config.baseUrl}/usage`, {
          headers: { accept: "application/json" },
          signal,
        }),
        "OpenCode Go usage",
      );
      return parseOpenCodeGoUsage(raw);
    },
  };
}

export function openCodeGoProvider(options: OpenCodeProviderOptions = {}): ProviderAdapter {
  return openCodeProvider(
    {
      id: "opencode-go",
      name: "OpenCode Go",
      description: "OpenCode Go subscription access with an OpenCode API key.",
      baseUrl: "https://opencode.ai/zen/go/v1",
    },
    options,
  );
}

export function openCodeZenProvider(options: OpenCodeProviderOptions = {}): ProviderAdapter {
  return openCodeProvider(
    {
      id: "opencode-zen",
      name: "OpenCode Zen",
      description: "OpenCode Zen pay-as-you-go access with an OpenCode API key.",
      baseUrl: "https://opencode.ai/zen/v1",
    },
    options,
  );
}
