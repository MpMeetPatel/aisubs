import { afterEach, expect, test, vi } from "vitest";
import { api } from "./lib";

afterEach(() => vi.unstubAllGlobals());

test("reports malformed successful responses while accepting empty deletions", async () => {
  vi.stubGlobal("fetch", async () => new Response("<html>Unexpected page</html>"));
  await expect(api("/v1/providers")).rejects.toThrow("invalid JSON");
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  await expect(api("/v1/logins/test", { method: "DELETE" })).resolves.toBeUndefined();
  vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
  await expect(api("/v1/providers")).rejects.toThrow("Request failed (503)");
});
