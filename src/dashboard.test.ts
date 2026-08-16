import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
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

    const dashboard = await fetch(running.url);
    const sessionCookie = dashboard.headers.get("set-cookie")?.split(";", 1)[0];
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

  test("rejects DNS-rebinding host headers", async () => {
    const auth = new SubscriptionAuth(new FileCredentialStore("/dev/null"), [provider]);
    running = await createSubscriptionAuthDashboardServer({ auth });

    const response = await new Promise<{ status: number; cookie: string[] | undefined }>(
      (resolve, reject) => {
        const call = request(running!.url, { headers: { host: "attacker.example" } }, (result) => {
          result.resume();
          resolve({ status: result.statusCode ?? 0, cookie: result.headers["set-cookie"] });
        });
        call.on("error", reject);
        call.end();
      },
    );
    expect(response.status).toBe(421);
    expect(response.cookie).toBeUndefined();
  });

  test("shows and regenerates the API key from the dashboard session", async () => {
    const auth = new SubscriptionAuth(new FileCredentialStore("/dev/null"), [provider]);
    const regenerate = vi.fn().mockResolvedValue("replacement");
    running = await createSubscriptionAuthDashboardServer({
      auth,
      apiKey: "original",
      regenerateApiKey: regenerate,
    });
    const dashboard = await fetch(running.url);
    const cookie = dashboard.headers.get("set-cookie")?.split(";", 1)[0];
    const headers = { cookie: cookie!, origin: running.url };

    await expect(
      fetch(`${running.url}/v1/api-key`, { headers }).then((response) => response.json()),
    ).resolves.toEqual({ apiKey: "original" });
    await expect(
      fetch(`${running.url}/v1/api-key/regenerate`, { method: "POST", headers }).then((response) =>
        response.json(),
      ),
    ).resolves.toEqual({ apiKey: "replacement" });
    expect(regenerate).toHaveBeenCalledOnce();
    expect(running.apiKey).toBe("replacement");
    expect(
      (
        await fetch(`${running.url}/v1/providers`, {
          headers: { authorization: "Bearer original" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${running.url}/v1/providers`, {
          headers: { authorization: "Bearer replacement" },
        })
      ).status,
    ).toBe(200);
  });

  test("coalesces simultaneous API key regeneration", async () => {
    const auth = new SubscriptionAuth(new FileCredentialStore("/dev/null"), [provider]);
    let finish!: (value: string) => void;
    const regenerate = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    running = await createSubscriptionAuthDashboardServer({
      auth,
      apiKey: "original",
      regenerateApiKey: regenerate,
    });
    const dashboard = await fetch(running.url);
    const cookie = dashboard.headers.get("set-cookie")?.split(";", 1)[0];
    const options = { method: "POST", headers: { cookie: cookie!, origin: running.url } };

    const requests = [
      fetch(`${running.url}/v1/api-key/regenerate`, options),
      fetch(`${running.url}/v1/api-key/regenerate`, options),
    ];
    await vi.waitFor(() => expect(regenerate).toHaveBeenCalledOnce());
    finish("replacement");

    const results = await Promise.all(requests);
    await expect(Promise.all(results.map((response) => response.json()))).resolves.toEqual([
      { apiKey: "replacement" },
      { apiKey: "replacement" },
    ]);
  });

  test("streams redacted request logs to the dashboard session", async () => {
    const auth = new SubscriptionAuth(new FileCredentialStore("/dev/null"), [provider]);
    vi.spyOn(auth, "proxy").mockResolvedValue(
      Response.json({ error: { message: "provider rejected request" } }, { status: 400 }),
    );
    running = await createSubscriptionAuthDashboardServer({ auth, apiKey: "secret" });
    const dashboard = await fetch(running.url);
    const cookie = dashboard.headers.get("set-cookie")?.split(";", 1)[0];
    const log = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const call = request(
        `${running!.url}/v1/logs/stream`,
        { headers: { cookie } },
        (response) => {
          expect(response.headers["content-type"]).toBe("text/event-stream");
          response.setEncoding("utf8");
          let buffer = "";
          response.on("data", (chunk: string) => {
            buffer += chunk;
            for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = event.match(/^data: (.+)$/m)?.[1];
              if (!data) continue;
              const entry = JSON.parse(data) as Record<string, unknown>;
              if (entry.path === "/aisubs/test/default/v1/responses") {
                resolve(entry);
                response.destroy();
              }
            }
          });
          void fetch(`${running!.url}/aisubs/test/default/v1/responses`, {
            method: "POST",
            headers: { authorization: "Bearer secret" },
          }).catch(reject);
        },
      );
      call.on("error", reject);
      call.end();
    });

    expect(log).toMatchObject({
      method: "POST",
      path: "/aisubs/test/default/v1/responses",
      status: 400,
      error: "provider rejected request",
    });
    expect(log).not.toHaveProperty("headers");
  });

  test("proxies authenticated account requests instead of serving the dashboard", async () => {
    directory = await mkdtemp(join(tmpdir(), "aisubs-dashboard-"));
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const auth = new SubscriptionAuth(store, [provider]);
    vi.spyOn(auth, "proxy").mockResolvedValue(Response.json({ path: "/responses" }));
    running = await createSubscriptionAuthDashboardServer({ auth, apiKey: "secret" });

    const response = await fetch(`${running.url}/aisubs/test/default/v1/responses`, {
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
