import { expect, test } from "vitest";
import { abortableDelay, bearerRequest, urlHost } from "./utils.js";

test("cancels an abortable delay", async () => {
  const abort = new AbortController();
  const pending = abortableDelay(60_000, abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow("Login cancelled");
});

test("replaces local credentials instead of forwarding them", () => {
  const request = bearerRequest(
    new Request("https://example.test", {
      headers: {
        authorization: "Bearer local",
        cookie: "session=local",
        "proxy-authorization": "Basic local",
        "x-api-key": "local",
        "x-goog-api-key": "local",
      },
    }),
    { accessToken: "provider", expiresAt: Date.now() + 60_000 },
  );
  expect(Object.fromEntries(request.headers)).toEqual({ authorization: "Bearer provider" });
});

test("brackets IPv6 URL hosts", () => {
  expect(urlHost("127.0.0.1")).toBe("127.0.0.1");
  expect(urlHost("::1")).toBe("[::1]");
});
