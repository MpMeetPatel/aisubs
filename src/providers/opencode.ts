import type {
  OAuthCredential,
  ProviderAdapter,
  ProviderLogin,
  ProviderModel,
  ProviderUsageData,
  UsageMeter,
} from "../types.js";
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

function documentedEndpoints(provider: OpenCodeProviderConfig["id"], model: string): string[] {
  if (/^(gpt-|grok-)/.test(model)) return ["responses"];
  if (provider === "opencode-go" && /^(minimax-|qwen)/.test(model)) return ["messages"];
  if (provider === "opencode-zen" && /^(claude-|qwen)/.test(model)) return ["messages"];
  if (provider === "opencode-zen" && model.startsWith("gemini-")) return [`models/${model}`];
  return ["chat/completions"];
}

function openCodeProvider(config: OpenCodeProviderConfig): ProviderAdapter {
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
    authorize(request, current) {
      requireAllowedHost(request, [API_HOST]);
      return bearerRequest(request, current);
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
                endpoints:
                  stringArray(value.supported_endpoints) ??
                  stringArray(value.endpoints) ??
                  documentedEndpoints(config.id, id),
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

export function openCodeGoProvider(): ProviderAdapter {
  return openCodeProvider({
    id: "opencode-go",
    name: "OpenCode Go",
    description: "OpenCode Go subscription access with an OpenCode API key.",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
}

export function openCodeZenProvider(): ProviderAdapter {
  return openCodeProvider({
    id: "opencode-zen",
    name: "OpenCode Zen",
    description: "OpenCode Zen pay-as-you-go access with an OpenCode API key.",
    baseUrl: "https://opencode.ai/zen/v1",
  });
}
