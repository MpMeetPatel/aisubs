import type { FastifyInstance, FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";
import type { SubscriptionAuth } from "./auth.js";
import type { ProviderId } from "./types.js";
import { errorMessage } from "./utils.js";

type RealtimeAuth = (request: FastifyRequest) => boolean | Promise<boolean>;

function rawDataBytes(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return data.byteLength;
}

function closeSocket(socket: WebSocket, code: number, reason: Buffer): void {
  if (code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)) {
    socket.close(code, reason);
  } else socket.close();
}

function upstreamHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (
      ![
        "connection",
        "content-length",
        "host",
        "sec-websocket-extensions",
        "sec-websocket-key",
        "sec-websocket-protocol",
        "sec-websocket-version",
        "upgrade",
      ].includes(name)
    ) {
      headers[name] = value;
    }
  });
  return headers;
}

function clientHeaders(request: FastifyRequest): Record<string, string> {
  const local = new Set([
    "authorization",
    "connection",
    "cookie",
    "host",
    "origin",
    "proxy-authorization",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
    "upgrade",
    "x-api-key",
    "x-goog-api-key",
  ]);
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value == null || local.has(name)
        ? []
        : [[name, Array.isArray(value) ? value.join(", ") : String(value)]],
    ),
  );
}

/** Register a native Realtime WebSocket tunnel for providers that expose one. */
export function registerRealtimeProxy(
  app: FastifyInstance,
  auth: SubscriptionAuth,
  authenticate: RealtimeAuth,
): void {
  app.route({
    method: "GET",
    url: "/aisubs/:provider/:account/v1/realtime",
    async preValidation(request, reply) {
      if (!(await authenticate(request))) {
        await reply.code(401).send({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        });
      }
    },
    async handler(_request, reply) {
      await reply.code(426).send({
        error: {
          message: "Use a WebSocket connection for the Realtime endpoint",
          type: "invalid_request_error",
          code: "websocket_required",
        },
      });
    },
    wsHandler(socket, request) {
      const params = request.params as { provider: string; account: string };
      const url = new URL(request.url, "http://aisubs.local");
      url.searchParams.delete("key");
      const search = url.search;
      const pending: Array<{ data: RawData; binary: boolean }> = [];
      let pendingBytes = 0;
      let upstream: WebSocket | undefined;

      socket.on("message", (data, binary) => {
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary });
          return;
        }
        const bytes = rawDataBytes(data);
        pendingBytes += bytes;
        if (pending.length >= 100 || pendingBytes > 1024 * 1024) {
          socket.close(1009, "Realtime startup queue exceeded");
          return;
        }
        pending.push({ data, binary });
      });

      socket.once("close", (code, reason) => {
        if (upstream?.readyState === WebSocket.OPEN) closeSocket(upstream, code, reason);
        else upstream?.terminate();
      });

      void auth
        .authorizeProxyRequest(params.provider as ProviderId, params.account, `realtime${search}`, {
          method: "GET",
          headers: clientHeaders(request),
        })
        .then((authorized) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const target = new URL(authorized.url);
          target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
          const protocols = request.headers["sec-websocket-protocol"]
            ?.split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          upstream = protocols?.length
            ? new WebSocket(target, protocols, { headers: upstreamHeaders(authorized) })
            : new WebSocket(target, { headers: upstreamHeaders(authorized) });
          upstream.on("open", () => {
            for (const item of pending) upstream!.send(item.data, { binary: item.binary });
            pending.length = 0;
            pendingBytes = 0;
          });
          upstream.on("message", (data, binary) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
          });
          upstream.on("close", (code, reason) => {
            if (socket.readyState === WebSocket.OPEN) closeSocket(socket, code, reason);
          });
          upstream.on("error", (error) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "provider_error",
                    code: "realtime_connection_failed",
                    message: errorMessage(error),
                  },
                }),
              );
              socket.close(1011, "Provider Realtime connection failed");
            }
          });
        })
        .catch((error) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: "error",
                error: {
                  type: "provider_error",
                  code: "realtime_connection_failed",
                  message: errorMessage(error),
                },
              }),
            );
            socket.close(1011, "Provider Realtime connection failed");
          }
        });
    },
  });
}
