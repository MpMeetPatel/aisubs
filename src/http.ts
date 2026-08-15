import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { SubscriptionAuth } from "./auth.js";
import type { ProviderId } from "./types.js";
import { errorMessage, isRecord, stringValue, urlHost } from "./utils.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

function proxyBodyLimit(value = MAX_PROXY_BODY_BYTES): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxProxyBodyBytes must be a positive safe integer");
  }
  return value;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function upstreamHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
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
      headers[name] = value;
    }
  });
  return headers;
}

async function sendUpstream(response: ServerResponse, upstream: Response): Promise<void> {
  response.writeHead(upstream.status, upstreamHeaders(upstream));
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), response);
  else response.end();
}

export async function readProxyBody(
  request: IncomingMessage,
  maxBytes = MAX_PROXY_BODY_BYTES,
): Promise<Buffer> {
  return readBody(request, proxyBodyLimit(maxBytes));
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function routeSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

export async function handleSubscriptionAuthApi(
  auth: SubscriptionAuth,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  maxProxyBodyBytes = MAX_PROXY_BODY_BYTES,
): Promise<boolean> {
  const parts = routeSegments(url.pathname);
  if (parts[0] === "aisubs" && parts[1] && parts[2] && request.method !== "OPTIONS") {
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
    ]);
    for (const [name, value] of Object.entries(request.headers)) {
      if (value != null && !privateHeaders.has(name)) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    const body = await readProxyBody(request, maxProxyBodyBytes);
    const path = parts.slice(3).map(encodeURIComponent).join("/") + url.search;
    const upstream = await auth.proxy(parts[1] as ProviderId, parts[2], path, {
      method: request.method,
      headers,
      body: body.length ? (body as unknown as BodyInit) : undefined,
    });
    await sendUpstream(response, upstream);
    return true;
  }
  if (request.method === "GET" && parts.join("/") === "v1/providers") {
    sendJson(response, 200, { providers: auth.listProviders() });
    return true;
  }
  if (request.method === "GET" && parts.join("/") === "v1/auth") {
    sendJson(response, 200, { sessions: await auth.statuses() });
    return true;
  }
  if (parts[0] === "v1" && parts[1] === "auth" && parts[2]) {
    const provider = parts[2] as ProviderId;
    if (request.method === "GET" && parts.length === 3) {
      sendJson(
        response,
        200,
        await auth.status(provider, {
          account: url.searchParams.get("account") ?? undefined,
          validate: url.searchParams.get("validate") === "true",
        }),
      );
      return true;
    }
    if (request.method === "GET" && parts[3] === "accounts") {
      sendJson(response, 200, { accounts: await auth.listAccounts(provider) });
      return true;
    }
    if (request.method === "GET" && parts[3] === "details") {
      sendJson(
        response,
        200,
        await auth.credentialSummary(provider, url.searchParams.get("account") ?? undefined),
      );
      return true;
    }
    if (request.method === "POST" && parts[3] === "login") {
      const body = await readJsonBody(request);
      const attempt = await auth.signIn(provider, isRecord(body) ? body : undefined);
      sendJson(response, 202, {
        id: attempt.id,
        provider: attempt.provider,
        accountKey: attempt.accountKey,
        state: attempt.state,
        prompt: attempt.prompt,
      });
      return true;
    }
    if (request.method === "DELETE" && parts.length === 3) {
      const accountKey = url.searchParams.get("account") ?? "default";
      await auth.signOut(provider, accountKey);
      sendJson(response, 200, { provider, accountKey, authenticated: false });
      return true;
    }
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "logins" && parts[2]) {
    const attempt = auth.getLoginAttempt(parts[2]);
    if (attempt) sendJson(response, 200, attempt);
    else sendJson(response, 404, { error: "Login not found" });
    return true;
  }
  if (request.method === "DELETE" && parts[0] === "v1" && parts[1] === "logins" && parts[2]) {
    if (auth.cancelLoginAttempt(parts[2])) sendJson(response, 200, { cancelled: true });
    else sendJson(response, 404, { error: "Pending login not found" });
    return true;
  }
  if (request.method === "POST" && parts[0] === "v1" && parts[1] === "fetch" && parts[2]) {
    const body = await readJsonBody(request);
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
    const upstream = await auth.fetch(
      parts[2] as ProviderId,
      targetUrl,
      {
        method: stringValue(body.method) ?? (requestBody ? "POST" : "GET"),
        headers,
        body: requestBody,
      },
      stringValue(body.account),
    );
    await sendUpstream(response, upstream);
    return true;
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "usage" && parts[2]) {
    const usage = await auth.getUsage(
      parts[2] as ProviderId,
      url.searchParams.get("account") ?? undefined,
    );
    if (usage) sendJson(response, 200, usage);
    else sendJson(response, 404, { error: "Usage is not supported by this provider" });
    return true;
  }
  if (request.method === "GET" && parts[0] === "v1" && parts[1] === "models" && parts[2]) {
    const models = await auth.getModels(
      parts[2] as ProviderId,
      url.searchParams.get("account") ?? undefined,
    );
    if (models) sendJson(response, 200, models);
    else sendJson(response, 404, { error: "Models are not supported by this provider" });
    return true;
  }
  return false;
}

export interface SubscriptionAuthServerOptions {
  auth: SubscriptionAuth;
  apiKey: string;
  host?: string;
  port?: number;
  /** Maximum buffered proxy request body. Defaults to 10 MiB. */
  maxProxyBodyBytes?: number;
}

export interface SubscriptionAuthServer {
  server: Server;
  apiKey: string;
  url: string;
  close(): Promise<void>;
}

export async function createSubscriptionAuthServer(
  options: SubscriptionAuthServerOptions,
): Promise<SubscriptionAuthServer> {
  if (!options.apiKey) throw new Error("A non-empty API key is required");
  const maxProxyBodyBytes = proxyBodyLimit(options.maxProxyBodyBytes);
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The built-in auth server may only bind to localhost");
  }
  const origin = `http://${urlHost(host)}`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/health") return sendJson(response, 200, { ok: true });
      const headerKey = Array.isArray(request.headers["x-api-key"])
        ? request.headers["x-api-key"][0]
        : request.headers["x-api-key"];
      if (
        request.headers.authorization !== `Bearer ${options.apiKey}` &&
        headerKey !== options.apiKey
      ) {
        return sendJson(response, 401, { error: "Unauthorized" });
      }
      if (
        !(await handleSubscriptionAuthApi(options.auth, request, response, url, maxProxyBodyBytes))
      ) {
        sendJson(response, 404, { error: "Not found" });
      }
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
    throw new Error("Unable to determine auth server port");
  }
  return {
    server,
    apiKey: options.apiKey,
    url: `${origin}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
