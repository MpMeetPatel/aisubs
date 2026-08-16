import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredential, ProviderAdapter, ProviderLogin, ProviderModel } from "../types.js";
import {
  bearerRequest,
  isRecord,
  numberValue,
  requireAllowedHost,
  responseJson,
  stringValue,
} from "../utils.js";

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPE =
  "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload";
const EXPIRY_SKEW_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

class ClaudeTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Claude token exchange failed (${code ?? status})`);
  }
}

function planLabel(value: unknown): string | undefined {
  const plan = stringValue(value);
  return plan
    ?.split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function credentialFromTokens(
  raw: Record<string, unknown>,
  previous?: OAuthCredential,
): OAuthCredential {
  const accessToken = stringValue(raw.access_token);
  const refreshToken = stringValue(raw.refresh_token) ?? previous?.refreshToken;
  if (!accessToken || !refreshToken) throw new Error("Claude token response is incomplete");
  const organization = isRecord(raw.organization) ? raw.organization : {};
  const expiresAt = numberValue(raw.expires_at);
  const expiresIn = numberValue(raw.expires_in);
  return {
    accessToken,
    refreshToken,
    expiresAt:
      expiresAt && expiresAt > Date.now()
        ? expiresAt - EXPIRY_SKEW_MS
        : Date.now() + Math.max(60, expiresIn ?? 8 * 60 * 60) * 1000 - EXPIRY_SKEW_MS,
    account: {
      id: stringValue(organization.uuid) ?? stringValue(organization.id) ?? previous?.account?.id,
      label: stringValue(organization.name) ?? previous?.account?.label,
      email: stringValue(raw.email) ?? previous?.account?.email,
      plan: planLabel(raw.subscription_type) ?? previous?.account?.plan,
    },
  };
}

export interface ClaudeProviderOptions {
  clientId?: string;
  compatibilityVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export function claudeProvider(options: ClaudeProviderOptions = {}): ProviderAdapter {
  const clientId = options.clientId ?? CLIENT_ID;
  const compatibilityVersion = options.compatibilityVersion ?? "2.1.231";
  const fetcher = options.fetch ?? globalThis.fetch;

  async function exchange(
    code: string,
    verifier: string,
    redirectUri: string,
    state: string,
    signal: AbortSignal,
  ) {
    const response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        state,
      }),
      signal,
    });
    if (!response.ok) {
      const raw = await response.json().catch(() => null);
      const record = isRecord(raw) ? raw : {};
      throw new ClaudeTokenError(response.status, stringValue(record.error));
    }
    return credentialFromTokens(await responseJson(response, "Claude token exchange"));
  }

  return {
    id: "claude",
    name: "Claude",
    description: "Claude Pro, Max, Team, or Enterprise subscription access with browser sign-in.",
    homepage: "https://claude.ai",
    allowedHosts: ["api.anthropic.com"],
    proxyBaseUrl: "https://api.anthropic.com/v1",
    loginModes: ["browser"],
    async startLogin(signal): Promise<ProviderLogin> {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(32).toString("base64url");
      let finish!: (error?: unknown, credential?: OAuthCredential) => void;
      let timer: NodeJS.Timeout | undefined;
      const server = createServer(async (request, response) => {
        const callback = new URL(request.url ?? "/", "http://localhost");
        if (callback.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        if (callback.searchParams.get("state") !== state) {
          response.writeHead(400, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("Claude sign-in failed. You can close this tab and return to AI Subs.");
          return finish(new Error("Claude OAuth state did not match"));
        }
        const error = callback.searchParams.get("error");
        const code = callback.searchParams.get("code");
        if (error || !code) {
          response.writeHead(400, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("Claude sign-in failed. You can close this tab and return to AI Subs.");
          return finish(new Error(error ?? "Claude authorization code is missing"));
        }
        try {
          const address = server.address();
          if (!address || typeof address === "string")
            throw new Error("Claude callback is unavailable");
          const credential = await exchange(
            code,
            verifier,
            `http://localhost:${address.port}/callback`,
            state,
            signal,
          );
          response.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("Claude connected. You can close this tab and return to AI Subs.");
          finish(undefined, credential);
        } catch (cause) {
          response.writeHead(400, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("Claude sign-in failed. You can close this tab and return to AI Subs.");
          finish(cause);
        }
      });
      const complete = new Promise<OAuthCredential>((resolve, reject) => {
        finish = (error, credential) => {
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (server.listening) server.close();
          if (error) reject(error);
          else resolve(credential!);
        };
      });
      let settled = false;
      const originalFinish = finish;
      finish = (error, credential) => {
        if (settled) return;
        settled = true;
        originalFinish(error, credential);
      };
      const abort = () => finish(new Error("Claude browser authorization cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Unable to start Claude callback");
      const redirectUri = `http://localhost:${address.port}/callback`;
      timer = setTimeout(
        () => finish(new Error("Claude browser authorization timed out")),
        LOGIN_TIMEOUT_MS,
      );
      timer.unref();
      const authorization = new URL(AUTHORIZE_URL);
      authorization.search = new URLSearchParams({
        code: "true",
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      return {
        prompt: {
          mode: "browser",
          authorizationUri: authorization.toString(),
          expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
        },
        complete,
      };
    },
    async refresh(credential, signal) {
      if (!credential.refreshToken) throw new Error("Claude refresh token is missing");
      const response = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: credential.refreshToken,
        }),
        signal,
      });
      if (!response.ok) {
        const raw = await response.json().catch(() => null);
        const record = isRecord(raw) ? raw : {};
        throw new ClaudeTokenError(response.status, stringValue(record.error));
      }
      return credentialFromTokens(await responseJson(response, "Claude token refresh"), credential);
    },
    async authorize(request, credential) {
      requireAllowedHost(request, ["api.anthropic.com"]);
      const raw: unknown =
        request.method === "POST" && new URL(request.url).pathname.endsWith("/messages")
          ? await request
              .clone()
              .json()
              .catch(() => null)
          : null;
      const beta = new Set([
        "claude-code-20250219",
        "oauth-2025-04-20",
        ...(request.headers.get("anthropic-beta")?.split(",") ?? []),
      ]);
      const authorized = bearerRequest(request, credential, {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": [...beta]
          .map((value) => value.trim())
          .filter(Boolean)
          .join(","),
        "user-agent": `claude-cli/${compatibilityVersion}`,
        "x-app": "cli",
      });
      if (!isRecord(raw)) return authorized;
      const system = raw.system;
      if (typeof system === "string" && system.startsWith(CLAUDE_CODE_SYSTEM)) return authorized;
      if (
        Array.isArray(system) &&
        isRecord(system[0]) &&
        stringValue(system[0].text) === CLAUDE_CODE_SYSTEM
      ) {
        return authorized;
      }
      const headers = new Headers(authorized.headers);
      headers.delete("content-length");
      const identity = { type: "text", text: CLAUDE_CODE_SYSTEM };
      const body = {
        ...raw,
        system: Array.isArray(system)
          ? [identity, ...system]
          : typeof system === "string"
            ? `${CLAUDE_CODE_SYSTEM}\n\n${system}`
            : [identity],
      };
      return new Request(authorized, { method: "POST", body: JSON.stringify(body), headers });
    },
    async getModels({ fetch, signal }) {
      const raw = await responseJson(
        await fetch("https://api.anthropic.com/v1/models", {
          headers: { accept: "application/json" },
          signal,
        }),
        "Claude models",
      );
      const values = Array.isArray(raw.data) ? raw.data : [];
      return values.flatMap((value): ProviderModel[] => {
        if (!isRecord(value)) return [];
        const id = stringValue(value.id);
        return id
          ? [
              {
                id,
                name: stringValue(value.display_name) ?? stringValue(value.name),
                description: stringValue(value.description),
                contextWindow: numberValue(value.context_window),
                maxOutputTokens: numberValue(value.max_output_tokens),
                inputModalities: ["text", "image", "document"],
                endpoints: ["messages"],
                supportsToolCall: true,
                available: true,
                selectable: true,
              },
            ]
          : [];
      });
    },
    isPermanentRefreshError(error) {
      return (
        error instanceof ClaudeTokenError &&
        (error.status === 401 || error.status === 403 || error.code === "invalid_grant")
      );
    },
  };
}
