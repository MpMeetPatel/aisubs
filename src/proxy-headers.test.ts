import { expect, test } from "vitest";
import { proxyRequestHeaders } from "./proxy-headers.js";

test("preserves provider options while stripping local credentials and proxy metadata", () => {
  const headers = proxyRequestHeaders({
    authorization: "Bearer local",
    cookie: "session=local",
    connection: "keep-alive, x-private",
    "x-private": "private",
    forwarded: "for=private",
    "x-forwarded-host": "local.example",
    "x-forwarded-for": "127.0.0.1",
    referer: "http://localhost/?key=local",
    "sec-websocket-key": "local-handshake",
    "x-goog-api-key": "local",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  });
  expect(Object.fromEntries(headers)).toEqual({
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  });
});
