import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SubscriptionAuth } from "./auth.js";
import {
  createSubscriptionAuthDashboardServer,
  type SubscriptionAuthDashboardServer,
} from "./dashboard.js";
import { FileCredentialStore } from "./store.js";
import type { ProviderAdapter } from "./types.js";

const provider: ProviderAdapter = {
  id: "test",
  name: "Test",
  loginModes: ["device"],
  async startLogin() {
    return {
      prompt: {
        mode: "device",
        verificationUri: "https://example.test/device",
        userCode: "ABCD",
        expiresAt: Date.now() + 60_000,
      },
      complete: new Promise(() => undefined),
    };
  },
  async refresh(credential) {
    return credential;
  },
  authorize(request) {
    return request;
  },
  async proxy(request) {
    return Response.json({ path: new URL(request.url).pathname });
  },
};

let directory: string | undefined;
let running: SubscriptionAuthDashboardServer | undefined;

afterEach(async () => {
  await running?.close().catch(() => undefined);
  if (directory) await rm(directory, { recursive: true, force: true });
  running = undefined;
  directory = undefined;
});

describe("subscription auth dashboard", () => {
  test("accepts same-origin mutations on a dynamic port", async () => {
    directory = await mkdtemp(join(tmpdir(), "aisubs-dashboard-"));
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const auth = new SubscriptionAuth(store, [provider]);
    running = await createSubscriptionAuthDashboardServer({ auth });

    const bootstrap = await fetch(running.bootstrapUrl, { redirect: "manual" });
    const sessionCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    expect(sessionCookie).toBeTruthy();

    const response = await fetch(`${running.url}/v1/auth/test/login`, {
      method: "POST",
      headers: {
        cookie: sessionCookie!,
        "content-type": "application/json",
        origin: running.url,
      },
      body: JSON.stringify({ account: "work" }),
    });
    expect(response.status).toBe(202);
  });

  test("proxies authenticated account requests instead of serving the dashboard", async () => {
    directory = await mkdtemp(join(tmpdir(), "aisubs-dashboard-"));
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const auth = new SubscriptionAuth(store, [provider]);
    vi.spyOn(auth, "proxy").mockResolvedValue(Response.json({ path: "/responses" }));
    running = await createSubscriptionAuthDashboardServer({ auth, apiKey: "secret" });

    const response = await fetch(`${running.url}/aisubs/test/default/responses`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        store: false,
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello from AI Subs" }] }],
      }),
    });

    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ path: "/responses" });
  });
});
