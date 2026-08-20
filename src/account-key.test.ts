import { describe, expect, test } from "vitest";
import { nextAccountKey } from "./account-key.js";
import type { Session } from "./types.js";

const account = (provider: string, accountKey: string, authenticated = true): Session => ({
  provider,
  accountKey,
  authenticated,
});

describe("account keys", () => {
  test("chooses the first free key without counting other providers or empty sessions", () => {
    const sessions = [
      account("chatgpt", "default"),
      account("chatgpt", "account-2"),
      account("chatgpt", "account-4"),
      account("claude", "account-3"),
      account("chatgpt", "account-3", false),
    ];
    expect(nextAccountKey(sessions, "chatgpt")).toBe("account-3");
    expect(nextAccountKey(sessions, "grok")).toBe("default");
  });

  test("does not reuse the key of an account awaiting reauthentication", () => {
    expect(
      nextAccountKey(
        [
          {
            ...account("chatgpt", "default", false),
            reauthRequired: true,
          },
        ],
        "chatgpt",
      ),
    ).toBe("account-2");
  });
});
