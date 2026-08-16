import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server, ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubscriptionAuth } from "./auth.js";
import {
  clientAbortSignal,
  handleSubscriptionAuthApi,
  routeSegments,
  sendWebResponse,
} from "./http.js";
import { registerRealtimeProxy } from "./realtime.js";
import { errorMessage, isRecord, stringValue, urlHost } from "./utils.js";

const ASSET_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "dashboard");
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

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

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function secure(reply: FastifyReply): void {
  reply.header(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  reply.header("referrer-policy", "no-referrer");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("cross-origin-resource-policy", "same-origin");
  reply.header("permissions-policy", "camera=(), geolocation=(), microphone=()");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
}

function hostname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

async function responseFailure(response: Response): Promise<string | undefined> {
  if (response.ok) return undefined;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const failure = isRecord(body) ? body.error : undefined;
  const message = isRecord(failure) ? stringValue(failure.message) : stringValue(failure);
  return (message ?? `HTTP ${response.status}`).slice(0, 2_000);
}

export interface SubscriptionAuthDashboardOptions {
  auth: SubscriptionAuth;
  apiKey?: string;
  regenerateApiKey?: () => Promise<string>;
  host?: string;
  port?: number;
  /** Maximum request body accepted by the compatibility proxy. Defaults to 10 MiB. */
  maxProxyBodyBytes?: number;
}

export interface SubscriptionAuthDashboardServer {
  server: Server;
  app: FastifyInstance;
  apiKey: string;
  url: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}

export async function createSubscriptionAuthDashboardServer(
  options: SubscriptionAuthDashboardOptions,
): Promise<SubscriptionAuthDashboardServer> {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("The AI Subs dashboard may only bind to localhost");
  }
  const origin = `http://${urlHost(host)}`;
  let apiKey = options.apiKey ?? `aisubs_${randomBytes(32).toString("base64url")}`;
  let regeneratingApiKey: Promise<string> | undefined;
  const sessionToken = randomBytes(32).toString("base64url");
  const requestLogs: Array<{
    id: number;
    timestamp: number;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    error?: string;
  }> = [];
  const requestErrors = new WeakMap<FastifyRequest, string>();
  const logStreams = new Set<ServerResponse>();
  let requestId = 0;

  const app = Fastify({
    bodyLimit: options.maxProxyBodyBytes ?? 10 * 1024 * 1024,
    forceCloseConnections: true,
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  await app.register(cors, {
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
  await app.register(websocket);
  await app.register(async (scope) => {
    registerRealtimeProxy(scope, options.auth, (request) => {
      return (
        requestApiKeys(request).some((value) => sameSecret(value, apiKey)) ||
        sameSecret(cookie(request, "aisubs_session"), sessionToken)
      );
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    secure(reply);
    if (hostname(request.headers.host) !== host) {
      await reply.code(421).send({ error: "Invalid local host" });
      return;
    }
    if (request.url.startsWith("/aisubs/")) {
      const startedAt = performance.now();
      reply.raw.once("finish", () => {
        const path = new URL(request.url, origin).pathname;
        const entry = {
          id: ++requestId,
          timestamp: Date.now(),
          method: request.method,
          path,
          status: reply.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
          error: requestErrors.get(request),
        };
        requestLogs.push(entry);
        if (requestLogs.length > 200) requestLogs.shift();
        const event = `data: ${JSON.stringify(entry)}\n\n`;
        for (const stream of logStreams) stream.write(event);
      });
    }
  });

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/*",
    async handler(request, reply) {
      const url = new URL(request.url, origin);
      if (url.pathname === "/health") {
        await reply
          .header("x-aisubs-service", "aisubs")
          .header("x-aisubs-pid", String(process.pid))
          .send({ ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        reply.header(
          "set-cookie",
          `aisubs_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/`,
        );
      }
      const bearerAuthenticated = requestApiKeys(request).some((value) =>
        sameSecret(value, apiKey),
      );
      const cookieAuthenticated = sameSecret(cookie(request, "aisubs_session"), sessionToken);
      const apiRoute = ["v1", "aisubs"].includes(routeSegments(url.pathname)[0] ?? "");
      if (apiRoute && !bearerAuthenticated && !cookieAuthenticated) {
        await reply.code(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/logs/stream") {
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        reply.raw.flushHeaders();
        for (const entry of requestLogs) reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
        logStreams.add(reply.raw);
        request.raw.once("close", () => logStreams.delete(reply.raw));
        return;
      }
      if (apiRoute && cookieAuthenticated && !bearerAuthenticated) {
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
          request.headers.origin !== `http://${request.headers.host}`
        ) {
          await reply.code(403).send({ error: "Cross-origin mutation blocked" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/api-key") {
          await reply.send({ apiKey });
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/api-key/regenerate") {
          regeneratingApiKey ??= (
            options.regenerateApiKey
              ? options.regenerateApiKey()
              : Promise.resolve(`aisubs_${randomBytes(32).toString("base64url")}`)
          ).finally(() => {
            regeneratingApiKey = undefined;
          });
          apiKey = await regeneratingApiKey;
          await reply.send({ apiKey });
          return;
        }
      }
      if (apiRoute) {
        const response = await handleSubscriptionAuthApi(
          options.auth,
          request,
          clientAbortSignal(request, reply),
        );
        if (response) {
          const failure = await responseFailure(response);
          if (failure) requestErrors.set(request, failure);
          await sendWebResponse(reply, response);
        } else await reply.code(404).send({ error: "Not found" });
        return;
      }

      const requested = url.pathname === "/" ? "index.html" : url.pathname;
      const assetPath = resolve(ASSET_DIRECTORY, `.${requested}`);
      const assetRelative = relative(ASSET_DIRECTORY, assetPath);
      if (assetRelative.startsWith("..") || isAbsolute(assetRelative)) {
        await reply.code(404).send({ error: "Not found" });
        return;
      }
      let file = assetPath;
      let body = await readFile(file).catch(() => null);
      if (!body || !extname(file)) {
        file = join(ASSET_DIRECTORY, "index.html");
        body = await readFile(file);
      }
      await reply
        .type(CONTENT_TYPES[extname(file)] ?? "application/octet-stream")
        .header(
          "cache-control",
          relative(ASSET_DIRECTORY, file).startsWith("assets/")
            ? "public, max-age=31536000, immutable"
            : "no-store",
        )
        .send(body);
    },
  });

  app.setErrorHandler(async (error, request, reply) => {
    requestErrors.set(request, errorMessage(error));
    await reply.code(400).send({ error: errorMessage(error) });
  });

  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    await app.close();
    throw new Error("Unable to determine AI Subs dashboard port");
  }
  const url = `${origin}:${address.port}`;
  return {
    server: app.server,
    app,
    get apiKey() {
      return apiKey;
    },
    url,
    bootstrapUrl: url,
    close: async () => {
      for (const stream of logStreams) stream.end();
      await app.close();
    },
  };
}
