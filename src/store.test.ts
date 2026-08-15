import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SubscriptionAuth } from "./auth.js";
import { FileApiKeyStore, FileCredentialStore } from "./store.js";
import type { ProviderAdapter } from "./types.js";

describe("FileCredentialStore", () => {
  test("serializes refresh across package instances and protects the credential file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subscription-auth-"));
    const file = join(directory, "credentials.json");
    const firstStore = new FileCredentialStore(file);
    await firstStore.modify("test", () => ({
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: 1,
    }));
    const refresh = vi.fn(async () => ({
      accessToken: "fresh",
      refreshToken: "rotated",
      expiresAt: Date.now() + 60_000,
    }));
    const provider: ProviderAdapter = {
      id: "test",
      name: "Test",
      loginModes: ["device"],
      startLogin: async () => Promise.reject(new Error("unused")),
      refresh,
      authorize: (request) => request,
    };
    const first = new SubscriptionAuth(firstStore, [provider]);
    const second = new SubscriptionAuth(new FileCredentialStore(file), [provider]);

    await expect(
      Promise.all([first.getAccessToken("test"), second.getAccessToken("test")]),
    ).resolves.toEqual(["fresh", "fresh"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      test: { accessToken: "fresh", refreshToken: "rotated" },
    });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("does not overwrite a corrupted credential file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subscription-auth-corrupt-"));
    const file = join(directory, "credentials.json");
    await writeFile(file, "not-json");
    const store = new FileCredentialStore(file);
    await expect(
      store.modify("test", () => ({ accessToken: "new", expiresAt: 1 })),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("not-json");
  });

  test("supports account keys longer than a filesystem filename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subscription-auth-long-key-"));
    const file = join(directory, "credentials.json");
    const store = new FileCredentialStore(file);
    const account = "😀".repeat(64);
    const key = `$subscription-account$${Buffer.from(JSON.stringify(["test", account])).toString(
      "base64url",
    )}`;
    const credential = { accessToken: "token", expiresAt: Date.now() + 60_000 };

    await expect(store.modify(key, () => credential)).resolves.toEqual(credential);
    await expect(store.read(key)).resolves.toEqual(credential);
  });
});

describe("FileApiKeyStore", () => {
  test("keeps one private key until it is regenerated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aisubs-api-key-"));
    const file = join(directory, "api-key");
    const store = new FileApiKeyStore(file);

    const created = await Promise.all(Array.from({ length: 8 }, () => store.readOrCreate()));
    const first = created[0]!;
    expect(new Set(created)).toEqual(new Set([first]));
    expect(await store.readOrCreate()).toBe(first);
    const replacement = await store.regenerate();
    expect(replacement).not.toBe(first);
    expect(await new FileApiKeyStore(file).readOrCreate()).toBe(replacement);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
