import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import type { SubscriptionAuth } from "./auth.js";
import { proxyCompatible } from "./compatibility.js";
import { registerRealtimeProxy } from "./realtime.js";
import type { ProviderId, ProviderModel } from "./types.js";
import { errorMessage, isRecord, numberValue, stringValue, urlHost } from "./utils.js";

const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

function bodyLimit(value = MAX_PROXY_BODY_BYTES): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxProxyBodyBytes must be a positive safe integer");
  }
  return value;
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestApiKeys(request: FastifyRequest): string[] {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const header = (name: "x-api-key" | "x-goog-api-key") => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const queryKey = new URL(request.url, "http://aisubs.local").searchParams.get("key") ?? undefined;
  return [bearer, header("x-api-key"), header("x-goog-api-key"), queryKey].filter(
    (value): value is string => value != null,
  );
}

export function routeSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function bodyBuffer(request: FastifyRequest): Buffer {
  if (request.body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === "string") return Buffer.from(request.body);
  return Buffer.from(JSON.stringify(request.body));
}

function jsonBody(request: FastifyRequest): unknown {
  const body = bodyBuffer(request);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  const privateHeaders = new Set([
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "proxy-authenticate",
    "proxy-authorization",
    "referer",
    "te",
    "trailer",
    "upgrade",
    "x-api-key",
    "x-goog-api-key",
  ]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (value != null && !privateHeaders.has(name)) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  upstream.headers.forEach((value, name) => {
    if (
      ![
        "cache-control",
        "connection",
        "content-encoding",
        "content-length",
        "keep-alive",
        "set-cookie",
        "transfer-encoding",
      ].includes(name)
    ) {
      headers.set(name, value);
    }
  });
  return headers;
}

export async function sendWebResponse(reply: FastifyReply, upstream: Response): Promise<void> {
  reply.code(upstream.status);
  responseHeaders(upstream).forEach((value, name) => reply.header(name, value));
  if (!upstream.body) {
    await reply.send();
    return;
  }
  await reply.send(Readable.fromWeb(upstream.body as never));
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}

function accountPath(
  parts: string[],
): { provider: ProviderId; account: string; path: string; versioned: boolean } | null {
  if (parts[0] !== "aisubs" || !parts[1] || !parts[2]) return null;
  const upstream = parts.slice(3);
  const versioned = upstream[0] === "v1";
  if (versioned) upstream.shift();
  return {
    provider: parts[1] as ProviderId,
    account: parts[2],
    path: upstream.map(encodeURIComponent).join("/"),
    versioned,
  };
}

function openAiModel(provider: ProviderId, model: ProviderModel) {
  return {
    id: model.id,
    object: "model",
    owned_by: provider,
    capabilities: {
      endpoints: model.endpoints ?? [],
      input_modalities: model.inputModalities ?? ["text"],
      reasoning_efforts: model.reasoningEfforts ?? [],
      tools: model.supportsToolCall ?? false,
    },
  };
}

export async function handleSubscriptionAuthApi(
  auth: SubscriptionAuth,
  request: FastifyRequest,
  signal?: AbortSignal,
): Promise<Response | null> {
  const url = new URL(request.url, "http://aisubs.local");
  const parts = routeSegments(url.pathname);
  const account = accountPath(parts);
  if (account && request.method !== "OPTIONS") {
    if (account.versioned && request.method === "GET" && account.path === "models") {
      const catalog = await auth.getModels(account.provider, account.account);
      return jsonResponse({
        object: "list",
        data: (catalog?.models ?? []).map((model) => openAiModel(account.provider, model)),
      });
    }
    if (account.versioned && request.method === "GET" && account.path.startsWith("models/")) {
      const id = decodeURIComponent(account.path.slice("models/".length));
      const catalog = await auth.getModels(account.provider, account.account);
      const model = catalog?.models.find((candidate) => candidate.id === id);
      return model
        ? jsonResponse(openAiModel(account.provider, model))
        : jsonResponse(
            {
              error: {
                message: `Model not found: ${id}`,
                type: "invalid_request_error",
                code: "model_not_found",
              },
            },
            404,
          );
    }
    const headers = requestHeaders(request);
    const body = bodyBuffer(request);
    url.searchParams.delete("key");
    const path = `${account.path}${url.search}`;
    if (account.versioned && request.method === "POST") {
      const compatible = await proxyCompatible(
        auth,
        account.provider,
        account.account,
        path,
        body,
        headers,
        signal,
      );
      if (compatible) return compatible;
    }
    return auth.proxy(account.provider, account.account, path, {
      method: request.method,
      headers,
      body: body.length ? (body as unknown as BodyInit) : undefined,
      signal,
    });
  }

  if (request.method === "GET" && parts.join("/") === "v1/providers") {
    return jsonResponse({ providers: auth.listProviders() });
  }
  if (request.method === "GET" && parts.join("/") === "v1/auth") {
    return jsonResponse({ sessions: await auth.statuses() });
  }
  if (parts[0] === "v1" && parts[1] === "auth" && parts[2]) {
    const provider = parts[2] as ProviderId;
    if (request.method === "GET" && parts.length === 3) {
      return jsonResponse(
        await auth.status(provider, {
          account: url.searchParams.get("account") ?? undefined,
          validate: url.searchParams.get("validate") === "true",
        }),
      );
    }
    if (request.method === "GET" && parts[3] === "accounts") {
      return jsonResponse({ accounts: await auth.listAccounts(provider) });
    }
    if (request.method === "GET" && parts[3] === "details") {
      return jsonResponse(
        await auth.credentialSummary(provider, url.searchParams.get("account") ?? undefined),
      );
    }
    if (request.method === "POST" && parts[3] === "login") {
      const body = jsonBody(request);
      const attempt = await auth.signIn(provider, isRecord(body) ? body : undefined);
      return jsonResponse(
        {
          id: attempt.id,
          provider: attempt.provider,
          accountKey: attempt.accountKey,
          state: attempt.state,
          prompt: attempt.prompt,
        },
        202,
      );
    }
    if (request.method === "DELETE" && parts.length === 3) {
      const accountKey = url.searchParams.get("account") ?? "default";
      await auth.signOut(provider, accountKey);
      return jsonResponse({ provider, accountKey, authenticated: false });
    }
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "logins" && parts[2]) {
    const attempt = auth.getLoginAttempt(parts[2]);
    return attempt ? jsonResponse(attempt) : jsonResponse({ error: "Login not found" }, 404);
  }
  if (request.method === "DELETE" && parts[0] === "v1" && parts[1] === "logins" && parts[2]) {
    return auth.cancelLoginAttempt(parts[2])
      ? jsonResponse({ cancelled: true })
      : jsonResponse({ error: "Pending login not found" }, 404);
  }
  if (request.method === "POST" && parts[0] === "v1" && parts[1] === "fetch" && parts[2]) {
    const body = jsonBody(request);
    if (!isRecord(body)) throw new Error("Fetch body requires an absolute url");
    const targetUrl = stringValue(body.url);
    if (!targetUrl) throw new Error("Fetch body requires an absolute url");
    const headers = new Headers();
    if (isRecord(body.headers)) {
      for (const [name, value] of Object.entries(body.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
    }
    let requestBody: BodyInit | undefined;
    if (typeof body.body === "string") requestBody = body.body;
    else if (body.body != null) {
      requestBody = JSON.stringify(body.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return auth.fetch(
      parts[2] as ProviderId,
      targetUrl,
      {
        method: stringValue(body.method) ?? (requestBody ? "POST" : "GET"),
        headers,
        body: requestBody,
        signal,
      },
      stringValue(body.account),
    );
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "usage" && parts[2]) {
    const usage = await auth.getUsage(
      parts[2] as ProviderId,
      url.searchParams.get("account") ?? undefined,
      signal,
    );
    return usage
      ? jsonResponse(usage)
      : jsonResponse({ error: "Usage is not supported by this provider" }, 404);
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "models" && parts[2]) {
    const models = await auth.getModels(
      parts[2] as ProviderId,
      url.searchParams.get("account") ?? undefined,
      signal,
    );
    return models
      ? jsonResponse(models)
      : jsonResponse({ error: "Models are not supported by this provider" }, 404);
  }
  return null;
}

/** Abort upstream work only when the client disconnects before the response finishes. */
export function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!reply.raw.writableFinished && !controller.signal.aborted) controller.abort();
  };
  const cleanup = (): void => {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abort);
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  reply.raw.once("finish", cleanup);
  if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableFinished)) abort();
  return controller.signal;
}

export interface SubscriptionAuthServerOptions {
  auth: SubscriptionAuth;
  apiKey: string;
  host?: string;
  port?: number;
  /** Maximum request body accepted by the compatibility proxy. Defaults to 10 MiB. */
  maxProxyBodyBytes?: number;
}

export interface SubscriptionAuthServer {
  server: Server;
  app: FastifyInstance;
  apiKey: string;
  url: string;
  close(): Promise<void>;
}

export function createApiApp(options: SubscriptionAuthServerOptions): FastifyInstance {
  if (!options.apiKey) throw new Error("A non-empty API key is required");
  const app = Fastify({
    bodyLimit: bodyLimit(options.maxProxyBodyBytes),
    forceCloseConnections: true,
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  void app.register(cors, {
    origin: true,
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "x-api-key",
      "x-goog-api-key",
      "anthropic-version",
      "anthropic-beta",
      "openai-beta",
    ],
    exposedHeaders: ["x-request-id", "retry-after"],
  });
  void app.register(websocket);
  app.get("/health", async () => ({ ok: true }));
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (!requestApiKeys(request).some((value) => sameSecret(value, options.apiKey))) {
      await reply.code(401).send({
        error: { message: "Unauthorized", type: "authentication_error", code: "invalid_api_key" },
      });
    }
  });
  void app.register(async (scope) => {
    registerRealtimeProxy(scope, options.auth, (request) =>
      requestApiKeys(request).some((value) => sameSecret(value, options.apiKey)),
    );
  });
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/*",
    async handler(request, reply) {
      const response = await handleSubscriptionAuthApi(
        options.auth,
        request,
        clientAbortSignal(request, reply),
      );
      if (response) await sendWebResponse(reply, response);
      else
        await reply.code(404).send({
          error: { message: "Not found", type: "invalid_request_error", code: "not_found" },
        });
    },
  });
  app.setErrorHandler(async (error, request, reply) => {
    const statusCode = isRecord(error) ? numberValue(error.statusCode) : undefined;
    const status = statusCode && statusCode >= 400 ? statusCode : 400;
    const code = isRecord(error) ? stringValue(error.code) : undefined;
    const openAi = request.url.startsWith("/aisubs/");
    await reply.code(status).send(
      openAi
        ? {
            error: {
              message: errorMessage(error),
              type: "invalid_request_error",
              code: code ?? "invalid_request_error",
            },
          }
        : { error: errorMessage(error) },
    );
  });
  return app;
}

export async function createSubscriptionAuthServer(
  options: SubscriptionAuthServerOptions,
): Promise<SubscriptionAuthServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The built-in auth server may only bind to localhost");
  }
  const app = createApiApp(options);
  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    await app.close();
    throw new Error("Unable to determine auth server port");
  }
  return {
    server: app.server,
    app,
    apiKey: options.apiKey,
    url: `http://${urlHost(host)}:${address.port}`,
    close: () => app.close(),
  };
}
