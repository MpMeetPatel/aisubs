import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubscriptionAuth } from "./auth.js";
import { handleSubscriptionAuthApi, routeSegments, sendJson } from "./http.js";
import { errorMessage, urlHost } from "./utils.js";

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

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function secure(response: ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function hostname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

export interface SubscriptionAuthDashboardOptions {
  auth: SubscriptionAuth;
  apiKey?: string;
  regenerateApiKey?: () => Promise<string>;
  host?: string;
  port?: number;
  /** Maximum buffered proxy request body. Defaults to 10 MiB. */
  maxProxyBodyBytes?: number;
}

export interface SubscriptionAuthDashboardServer {
  server: Server;
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
  }> = [];
  const logStreams = new Set<ServerResponse>();
  let requestId = 0;

  const server = createServer(async (request, response) => {
    secure(response);
    try {
      if (hostname(request.headers.host) !== host) {
        return sendJson(response, 421, { error: "Invalid local host" });
      }
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname.startsWith("/aisubs/")) {
        const startedAt = performance.now();
        response.once("finish", () => {
          const entry = {
            id: ++requestId,
            timestamp: Date.now(),
            method: request.method ?? "GET",
            path: url.pathname,
            status: response.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          };
          requestLogs.push(entry);
          if (requestLogs.length > 200) requestLogs.shift();
          const event = `data: ${JSON.stringify(entry)}\n\n`;
          for (const stream of logStreams) stream.write(event);
        });
      }
      if (url.pathname === "/health") {
        return sendJson(
          response,
          200,
          { ok: true },
          {
            "x-aisubs-service": "aisubs",
            "x-aisubs-pid": String(process.pid),
          },
        );
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.setHeader(
          "set-cookie",
          `aisubs_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/`,
        );
      }
      const bearer = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice(7)
        : undefined;
      const headerKey = Array.isArray(request.headers["x-api-key"])
        ? request.headers["x-api-key"][0]
        : request.headers["x-api-key"];
      const bearerAuthenticated = sameSecret(bearer, apiKey) || sameSecret(headerKey, apiKey);
      const cookieAuthenticated = sameSecret(cookie(request, "aisubs_session"), sessionToken);
      const apiRoute = ["v1", "aisubs"].includes(routeSegments(url.pathname)[0] ?? "");
      if (apiRoute && !bearerAuthenticated && !cookieAuthenticated) {
        return sendJson(response, 401, { error: "Unauthorized" });
      }
      if (request.method === "GET" && url.pathname === "/v1/logs/stream") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.flushHeaders();
        for (const entry of requestLogs) response.write(`data: ${JSON.stringify(entry)}\n\n`);
        logStreams.add(response);
        request.once("close", () => logStreams.delete(response));
        return;
      }
      if (apiRoute && cookieAuthenticated && !bearerAuthenticated) {
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET") &&
          request.headers.origin !== `http://${request.headers.host}`
        ) {
          return sendJson(response, 403, { error: "Cross-origin mutation blocked" });
        }
        if (request.method === "GET" && url.pathname === "/v1/api-key") {
          return sendJson(response, 200, { apiKey });
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
          return sendJson(response, 200, { apiKey });
        }
      }

      if (apiRoute) {
        if (
          !(await handleSubscriptionAuthApi(
            options.auth,
            request,
            response,
            url,
            options.maxProxyBodyBytes,
          ))
        ) {
          sendJson(response, 404, { error: "Not found" });
        }
        return;
      }

      const requested = url.pathname === "/" ? "index.html" : url.pathname;
      const assetPath = resolve(ASSET_DIRECTORY, `.${requested}`);
      const assetRelative = relative(ASSET_DIRECTORY, assetPath);
      if (assetRelative.startsWith("..") || isAbsolute(assetRelative)) {
        return sendJson(response, 404, { error: "Not found" });
      }
      let file = assetPath;
      let body = await readFile(file).catch(() => null);
      if (!body || !extname(file)) {
        file = join(ASSET_DIRECTORY, "index.html");
        body = await readFile(file);
      }
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": relative(ASSET_DIRECTORY, file).startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-store",
      });
      response.end(body);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else sendJson(response, 400, { error: errorMessage(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine AI Subs dashboard port");
  }
  const url = `${origin}:${address.port}`;
  return {
    server,
    get apiKey() {
      return apiKey;
    },
    url,
    bootstrapUrl: url,
    close: () => {
      for (const stream of logStreams) stream.end();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
