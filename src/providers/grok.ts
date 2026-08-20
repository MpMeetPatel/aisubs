import type { OAuthCredential, ProviderAdapter, ProviderLogin, ProviderModel } from "../types.js";
import { parseGrokUsage } from "../usage.js";
import {
  abortableDelay,
  bearerRequest,
  isRecord,
  numberValue,
  requireAllowedHost,
  responseJson,
  stringValue,
} from "../utils.js";

const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const EXPIRY_SKEW_MS = 2 * 60_000;
const DEFAULT_COMPATIBILITY_VERSION = "1.0.3";

class GrokTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Grok token refresh failed (${code ?? status})`);
  }
}

function credentialFromTokens(
  raw: Record<string, unknown>,
  previous?: OAuthCredential,
): OAuthCredential {
  const accessToken = stringValue(raw.access_token);
  const refreshToken = stringValue(raw.refresh_token) ?? previous?.refreshToken;
  if (!accessToken || !refreshToken) throw new Error("Grok token response is incomplete");
  const lifetime = Math.max(60, numberValue(raw.expires_in) ?? 3600) * 1000;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(0, lifetime - EXPIRY_SKEW_MS),
  };
}

export interface GrokProviderOptions {
  clientId?: string;
  compatibilityVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export function grokProvider(options: GrokProviderOptions = {}): ProviderAdapter {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const compatibilityVersion = options.compatibilityVersion ?? DEFAULT_COMPATIBILITY_VERSION;
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    id: "grok",
    name: "Grok",
    description: "xAI Grok and linked X subscription access through device authorization.",
    homepage: "https://grok.com",
    allowedHosts: ["cli-chat-proxy.grok.com"],
    proxyBaseUrl: "https://cli-chat-proxy.grok.com/v1",
    loginModes: ["device"],
    async startLogin(signal): Promise<ProviderLogin> {
      const response = await fetcher(DEVICE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
        signal,
      });
      const raw = await responseJson(response, "Grok device login");
      const deviceCode = stringValue(raw.device_code);
      const userCode = stringValue(raw.user_code);
      const verificationUri =
        stringValue(raw.verification_uri_complete) ?? stringValue(raw.verification_uri);
      if (!deviceCode || !userCode || !verificationUri) {
        throw new Error("Grok device response is incomplete");
      }
      let interval = Math.max(1, numberValue(raw.interval) ?? 5) * 1000;
      const expiresIn = Math.max(60, numberValue(raw.expires_in) ?? 300);
      const complete = (async (): Promise<OAuthCredential> => {
        const deadline = Date.now() + expiresIn * 1000;
        while (Date.now() < deadline) {
          await abortableDelay(interval, signal);
          const tokenResponse = await fetcher(TOKEN_URL, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: DEVICE_GRANT,
              client_id: clientId,
              device_code: deviceCode,
            }),
            signal,
          });
          const token: unknown = await tokenResponse.json().catch(() => ({}));
          const tokenRecord = isRecord(token) ? token : {};
          if (tokenResponse.ok) return credentialFromTokens(tokenRecord);
          const error = stringValue(tokenRecord.error);
          if (error === "authorization_pending") continue;
          if (error === "slow_down") {
            interval += 5000;
            continue;
          }
          throw new Error(`Grok device authorization failed${error ? `: ${error}` : ""}`);
        }
        throw new Error("Grok device authorization timed out");
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
      if (!credential.refreshToken) throw new Error("Grok refresh token is missing");
      const response = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: clientId,
        }),
        signal,
      });
      if (!response.ok) {
        const raw: unknown = await response.json().catch(() => null);
        throw new GrokTokenError(
          response.status,
          isRecord(raw) ? stringValue(raw.error) : undefined,
        );
      }
      return credentialFromTokens(await responseJson(response, "Grok token refresh"), credential);
    },
    async authorize(request, credential) {
      requireAllowedHost(request, ["cli-chat-proxy.grok.com"]);
      const raw: unknown =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              .catch(() => null)
          : null;
      const authorized = bearerRequest(request, credential, {
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": compatibilityVersion,
        "x-grok-client-identifier": "grok-shell",
        "user-agent": "xai-grok-cli",
      });
      if (request.method !== "POST") return authorized;
      const model = isRecord(raw) ? stringValue(raw.model) : undefined;
      if (!model) return authorized;
      const headers = new Headers(authorized.headers);
      headers.set("x-grok-model-override", model);
      return new Request(authorized, { headers });
    },
    async getUsage({ fetch, signal }) {
      const headers = { accept: "application/json" };
      const user = await responseJson(await fetch(USER_URL, { headers, signal }), "Grok account");
      const identityHeaders = {
        ...headers,
        ...(stringValue(user.userId) ? { "x-userid": stringValue(user.userId)! } : {}),
        ...(stringValue(user.email) ? { "x-email": stringValue(user.email)! } : {}),
      };
      const [usageResponse, settingsResponse] = await Promise.all([
        fetch(USAGE_URL, { headers: identityHeaders, signal }),
        fetch(SETTINGS_URL, { headers: identityHeaders, signal }).catch(() => null),
      ]);
      const usage = await responseJson(usageResponse, "Grok usage");
      const settings = settingsResponse?.ok
        ? await settingsResponse.json().catch(() => null)
        : null;
      return parseGrokUsage(usage, user, settings);
    },
    async getModels({ fetch, signal }) {
      const response = await fetch(MODELS_URL, {
        headers: { accept: "application/json" },
        signal,
      });
      const raw = await responseJson(response, "Grok models");
      const models = Array.isArray(raw.data) ? raw.data : [];
      return models.flatMap((value): ProviderModel[] => {
        if (!isRecord(value)) return [];
        const id = stringValue(value.id) ?? stringValue(value.model);
        if (!id) return [];
        const efforts = Array.isArray(value.reasoning_efforts)
          ? value.reasoning_efforts.flatMap((effort) => {
              if (typeof effort === "string") return [effort];
              if (!isRecord(effort)) return [];
              const name = stringValue(effort.value) ?? stringValue(effort.id);
              return name ? [name] : [];
            })
          : undefined;
        const backend = stringValue(value.api_backend);
        return [
          {
            id,
            name: stringValue(value.name),
            description: stringValue(value.description),
            contextWindow: numberValue(value.context_window) ?? numberValue(value.contextWindow),
            maxOutputTokens:
              numberValue(value.max_output_tokens) ?? numberValue(value.max_completion_tokens),
            reasoningEfforts: efforts?.length ? efforts : undefined,
            endpoints: backend ? [backend] : undefined,
            available: true,
            selectable: true,
          },
        ];
      });
    },
    isPermanentRefreshError(error) {
      return (
        error instanceof GrokTokenError &&
        (error.status === 401 || error.status === 403 || error.code === "invalid_grant")
      );
    },
  };
}
