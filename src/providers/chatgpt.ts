import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredential, ProviderAdapter, ProviderLogin, ProviderModel } from "../types.js";
import { parseChatGptUsage } from "../usage.js";
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

const ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const VERIFICATION_URL = `${ISSUER}/codex/device`;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const EXPIRY_SKEW_MS = 5 * 60_000;
const BROWSER_LOGIN_TIMEOUT_MS = 10 * 60_000;
const BROWSER_CALLBACK_PORTS = [1455, 1457] as const;

class ChatGptTokenError extends Error {
  constructor(
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(`ChatGPT token refresh failed (${code ?? status})`);
  }
}

function decodeJwt(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function authClaims(token: string | undefined): Record<string, unknown> {
  const value = decodeJwt(token)["https://api.openai.com/auth"];
  return isRecord(value) ? value : {};
}

function expiry(accessToken: string): number {
  const exp = numberValue(decodeJwt(accessToken).exp);
  return exp ? exp * 1000 - EXPIRY_SKEW_MS : Date.now() + 50 * 60_000;
}

function credentialFromTokens(
  raw: Record<string, unknown>,
  previous?: OAuthCredential,
): OAuthCredential {
  const accessToken = stringValue(raw.access_token);
  const refreshToken = stringValue(raw.refresh_token) ?? previous?.refreshToken;
  const idToken = stringValue(raw.id_token);
  const accountId =
    stringValue(authClaims(idToken).chatgpt_account_id) ??
    stringValue(authClaims(accessToken).chatgpt_account_id) ??
    previous?.account?.id;
  if (!accessToken || !refreshToken || !accountId) {
    throw new Error("ChatGPT token response is missing access, refresh, or account information");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: expiry(accessToken),
    account: {
      id: accountId,
      label:
        stringValue(decodeJwt(idToken).email) ??
        previous?.account?.label ??
        previous?.account?.email,
      email: stringValue(decodeJwt(idToken).email) ?? previous?.account?.email,
      plan: stringValue(authClaims(idToken).chatgpt_plan_type) ?? previous?.account?.plan,
    },
  };
}

function normalizeModel(value: unknown): (ProviderModel & { priority: number }) | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.slug) ?? stringValue(value.id);
  if (!id) return null;
  const levels = Array.isArray(value.supported_reasoning_levels)
    ? value.supported_reasoning_levels.flatMap((level) => {
        if (typeof level === "string") return [level];
        return isRecord(level) && stringValue(level.effort) ? [stringValue(level.effort)!] : [];
      })
    : [];
  const visibility = stringValue(value.visibility);
  return {
    id,
    name: stringValue(value.display_name) ?? stringValue(value.name),
    description: stringValue(value.description),
    contextWindow: numberValue(value.context_window) ?? numberValue(value.max_context_window),
    maxOutputTokens: numberValue(value.max_output_tokens),
    reasoningEfforts: levels.length ? levels : stringArray(value.supported_reasoning_efforts),
    inputModalities: stringArray(value.input_modalities),
    endpoints: ["responses"],
    supportsToolCall:
      value.supports_tool_calls === false || value.supports_tools === false ? false : true,
    available: visibility !== "hide" && value.supported_in_api !== false,
    priority: numberValue(value.priority) ?? Number.MAX_SAFE_INTEGER,
  };
}

export interface ChatGptProviderOptions {
  clientId?: string;
  compatibilityVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export function chatGptProvider(options: ChatGptProviderOptions = {}): ProviderAdapter {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const compatibilityVersion = options.compatibilityVersion ?? "0.144.2";
  const fetcher = options.fetch ?? globalThis.fetch;

  async function startDeviceLogin(signal: AbortSignal): Promise<ProviderLogin> {
    const response = await fetcher(DEVICE_CODE_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
      signal,
    });
    const raw = await responseJson(response, "ChatGPT device login");
    const deviceAuthId = stringValue(raw.device_auth_id);
    const userCode = stringValue(raw.user_code) ?? stringValue(raw.usercode);
    if (!deviceAuthId || !userCode) throw new Error("ChatGPT device response is incomplete");
    const interval = numberValue(raw.interval) ?? 5;
    const expiresIn = numberValue(raw.expires_in) ?? 900;
    const verificationUri =
      stringValue(raw.verification_uri_complete) ??
      stringValue(raw.verification_uri) ??
      VERIFICATION_URL;

    const complete = (async (): Promise<OAuthCredential> => {
      const deadline = Date.now() + expiresIn * 1000;
      while (Date.now() < deadline) {
        await abortableDelay(Math.max(1, interval) * 1000, signal);
        const pollResponse = await fetcher(DEVICE_TOKEN_URL, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
          signal,
        });
        if (pollResponse.status === 403 || pollResponse.status === 404) continue;
        const poll = await responseJson(pollResponse, "ChatGPT device authorization");
        const code = stringValue(poll.authorization_code);
        const verifier = stringValue(poll.code_verifier);
        if (!code || !verifier) continue;
        const tokenResponse = await fetcher(TOKEN_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: DEVICE_REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
          }),
          signal,
        });
        return credentialFromTokens(await responseJson(tokenResponse, "ChatGPT token exchange"));
      }
      throw new Error("ChatGPT device authorization timed out");
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
  }

  async function startBrowserLogin(signal: AbortSignal): Promise<ProviderLogin> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    let resolveComplete!: (credential: OAuthCredential) => void;
    let rejectComplete!: (error: unknown) => void;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const complete = new Promise<OAuthCredential>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    void complete.catch(() => undefined);

    const server = createServer(async (request, response) => {
      const callbackUrl = new URL(request.url ?? "/", "http://localhost");
      if (callbackUrl.pathname !== "/auth/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const fail = (message: string): void => {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(`ChatGPT sign-in failed: ${message}`);
        finish(new Error(message));
      };
      if (callbackUrl.searchParams.get("state") !== state) return fail("OAuth state did not match");
      const providerError = callbackUrl.searchParams.get("error");
      if (providerError) return fail(providerError);
      const code = callbackUrl.searchParams.get("code");
      if (!code) return fail("Authorization code is missing");
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Callback server is unavailable");
        const redirectUri = `http://localhost:${address.port}/auth/callback`;
        const tokenResponse = await fetcher(TOKEN_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
          }),
          signal,
        });
        const credential = credentialFromTokens(
          await responseJson(tokenResponse, "ChatGPT token exchange"),
        );
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("ChatGPT connected. You can close this tab and return to AI Subs.");
        finish(undefined, credential);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });

    const finish = (error?: unknown, credential?: OAuthCredential): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (server.listening) server.close();
      if (error) rejectComplete(error);
      else resolveComplete(credential!);
    };
    const onAbort = (): void => finish(new Error("ChatGPT browser authorization cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    let listening = false;
    for (const port of BROWSER_CALLBACK_PORTS) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, "127.0.0.1");
        });
        listening = true;
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
          finish(error);
          throw error;
        }
      }
    }
    if (!listening) {
      const error = new Error(
        "ChatGPT browser sign-in requires local callback port 1455 or 1457, but both are in use. Close the process using one of those ports or use device-code sign-in.",
      );
      finish(error);
      throw error;
    }
    server.on("error", finish);
    const address = server.address();
    if (!address || typeof address === "string") {
      finish(new Error("Unable to start ChatGPT browser callback"));
      throw new Error("Unable to start ChatGPT browser callback");
    }
    timer = setTimeout(
      () => finish(new Error("ChatGPT browser authorization timed out")),
      BROWSER_LOGIN_TIMEOUT_MS,
    );
    timer.unref();
    const redirectUri = `http://localhost:${address.port}/auth/callback`;
    const authorization = new URL(`${ISSUER}/oauth/authorize`);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "aisubs",
    }).toString();
    return {
      prompt: {
        mode: "browser",
        authorizationUri: authorization.toString(),
        expiresAt: Date.now() + BROWSER_LOGIN_TIMEOUT_MS,
      },
      complete,
    };
  }

  return {
    id: "chatgpt",
    name: "ChatGPT",
    description: "OpenAI subscription access with browser sign-in and automatic token refresh.",
    homepage: "https://chatgpt.com",
    allowedHosts: ["chatgpt.com"],
    proxyBaseUrl: "https://chatgpt.com/backend-api/codex",
    loginModes: ["browser", "device"],
    startLogin: (signal, loginOptions) =>
      loginOptions?.mode === "device" ? startDeviceLogin(signal) : startBrowserLogin(signal),
    async refresh(credential, signal) {
      if (!credential.refreshToken) throw new Error("ChatGPT refresh token is missing");
      const response = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
        }),
        signal,
      });
      if (!response.ok) {
        const raw: unknown = await response.json().catch(() => null);
        const code = isRecord(raw)
          ? (stringValue(raw.code) ??
            stringValue(raw.error) ??
            (isRecord(raw.error) ? stringValue(raw.error.code) : undefined))
          : undefined;
        throw new ChatGptTokenError(code, response.status);
      }
      const raw: unknown = await response.json();
      if (!isRecord(raw)) throw new Error("ChatGPT refresh returned invalid JSON");
      return credentialFromTokens(raw, credential);
    },
    authorize(request, credential) {
      requireAllowedHost(request, ["chatgpt.com"]);
      const accountId = credential.account?.id;
      if (!accountId) throw new Error("ChatGPT account id is missing");
      return bearerRequest(request, credential, {
        "chatgpt-account-id": accountId,
        originator: "aisubs",
        "user-agent": `aisubs/${compatibilityVersion}`,
      });
    },
    async getUsage({ fetch, signal }) {
      const response = await fetch(USAGE_URL, { headers: { accept: "application/json" }, signal });
      const raw = await responseJson(response, "ChatGPT usage");
      let resetCredits: unknown;
      try {
        const credits = await fetch(RESET_CREDITS_URL, {
          headers: { accept: "application/json" },
          signal,
        });
        if (credits.ok) resetCredits = await credits.json();
      } catch {}
      return parseChatGptUsage(raw, resetCredits);
    },
    async getModels({ fetch, signal }) {
      const url = new URL(MODELS_URL);
      url.searchParams.set("client_version", compatibilityVersion);
      const response = await fetch(url, { headers: { accept: "application/json" }, signal });
      const raw = await responseJson(response, "ChatGPT models");
      const models = Array.isArray(raw.models) ? raw.models : [];
      return models
        .map(normalizeModel)
        .filter((model): model is ProviderModel & { priority: number } => Boolean(model))
        .filter((model) => model.available !== false)
        .sort((left, right) => left.priority - right.priority)
        .map(({ priority: _priority, ...model }) => model);
    },
    isPermanentRefreshError(error) {
      return (
        error instanceof ChatGptTokenError &&
        (error.status === 401 ||
          error.status === 403 ||
          [
            "invalid_grant",
            "refresh_token_expired",
            "refresh_token_reused",
            "refresh_token_invalidated",
          ].includes(error.code ?? ""))
      );
    },
  };
}
