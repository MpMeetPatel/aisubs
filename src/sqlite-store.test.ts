import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { SubscriptionAuth } from "./auth.js";
import { SqliteApiKeyStore, SqliteCredentialStore } from "./sqlite-store.js";
import type { OAuthCredential, ProviderAdapter } from "./types.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("SQLite stores", () => {
  test("shares credentials across instances and isolates AISubs tables", async () => {
    const folder = await temporaryFolder();
    const database = join(folder, "installation.db");
    const first = new SqliteCredentialStore(database);
    const second = new SqliteCredentialStore(database);
    const credential = { accessToken: "secret", refreshToken: "refresh", expiresAt: 4e12 };

    await first.modify("provider", () => credential);
    expect(await second.read("provider")).toEqual(credential);
    expect(await second.listKeys()).toEqual(["provider"]);

    first.close();
    second.close();
  });

  test("does not close a host-owned connection", async () => {
    const folder = await temporaryFolder();
    const database = new DatabaseSync(join(folder, "installation.db"));
    const store = new SqliteCredentialStore(database);
    await store.modify("provider", () => ({ accessToken: "token", expiresAt: 4e12 }));

    store.close();

    expect(database.prepare("SELECT count(*) AS count FROM aisubs_credentials").get()).toEqual({
      count: 1,
    });
    database.close();
  });

  test("persists and rotates standalone API keys", async () => {
    const folder = await temporaryFolder();
    const database = join(folder, "aisubs.db");
    const first = new SqliteApiKeyStore(database);
    const initial = await first.readOrCreate();
    first.close();

    const second = new SqliteApiKeyStore(database);
    expect(await second.readOrCreate()).toBe(initial);
    expect(await second.regenerate()).not.toBe(initial);
    second.close();
  });

  test("claims one refresh across independent SDK instances", async () => {
    const folder = await temporaryFolder();
    const database = join(folder, "installation.db");
    const firstStore = new SqliteCredentialStore(database);
    const secondStore = new SqliteCredentialStore(database);
    await firstStore.modify("provider", () => expired());
    let refreshes = 0;
    const provider = adapter(async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: "fresh", refreshToken: "rotated", expiresAt: 4e12 };
    });
    const first = new SubscriptionAuth(firstStore, [provider], { refreshTimeoutMs: 1_000 });
    const second = new SubscriptionAuth(secondStore, [provider], { refreshTimeoutMs: 1_000 });

    await expect(
      Promise.all([first.getAccessToken("provider"), second.getAccessToken("provider")]),
    ).resolves.toEqual(["fresh", "fresh"]);
    expect(refreshes).toBe(1);
    firstStore.close();
    secondStore.close();
  });

  test("does not let a late refresh restore a logged-out account", async () => {
    const folder = await temporaryFolder();
    const database = join(folder, "installation.db");
    const refreshingStore = new SqliteCredentialStore(database);
    const logoutStore = new SqliteCredentialStore(database);
    await refreshingStore.modify("provider", () => expired());
    const result = Promise.withResolvers<OAuthCredential>();
    const auth = new SubscriptionAuth(refreshingStore, [adapter(() => result.promise)]);
    const other = new SubscriptionAuth(logoutStore, [adapter(() => result.promise)]);

    const refresh = auth.getAccessToken("provider");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await other.signOut("provider");
    result.resolve({ accessToken: "late", refreshToken: "rotated", expiresAt: 4e12 });

    await expect(refresh).rejects.toThrow("Session changed");
    await expect(refreshingStore.read("provider")).resolves.toBeNull();
    refreshingStore.close();
    logoutStore.close();
  });

  test("does not report a stale cross-process login as successful", async () => {
    const folder = await temporaryFolder();
    const database = join(folder, "installation.db");
    const firstStore = new SqliteCredentialStore(database);
    const secondStore = new SqliteCredentialStore(database);
    const firstLogin = Promise.withResolvers<OAuthCredential>();
    const secondLogin = Promise.withResolvers<OAuthCredential>();
    const provider = (complete: Promise<OAuthCredential>): ProviderAdapter => ({
      ...adapter(async () => Promise.reject(new Error("unused"))),
      async startLogin() {
        return {
          prompt: { mode: "external-token", expiresAt: 4e12 },
          complete,
        };
      },
    });
    const first = new SubscriptionAuth(firstStore, [provider(firstLogin.promise)]);
    const second = new SubscriptionAuth(secondStore, [provider(secondLogin.promise)]);

    const staleAttempt = await first.signIn("provider");
    const winningAttempt = await second.signIn("provider");
    secondLogin.resolve({ accessToken: "winner", expiresAt: 4e12 });
    await expect(winningAttempt.wait()).resolves.toMatchObject({ authenticated: true });
    firstLogin.resolve({ accessToken: "stale", expiresAt: 4e12 });

    await expect(staleAttempt.wait()).rejects.toThrow("Login cancelled");
    await expect(firstStore.read("provider")).resolves.toMatchObject({ accessToken: "winner" });
    firstStore.close();
    secondStore.close();
  });
});

async function temporaryFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "aisubs-sqlite-"));
  folders.push(folder);
  return folder;
}

function expired(): OAuthCredential {
  return { accessToken: "old", refreshToken: "refresh", expiresAt: 1 };
}

function adapter(refresh: ProviderAdapter["refresh"]): ProviderAdapter {
  return {
    id: "provider",
    name: "Provider",
    loginModes: ["device"],
    startLogin: async () => Promise.reject(new Error("unused")),
    refresh,
    authorize: (request) => request,
  };
}
