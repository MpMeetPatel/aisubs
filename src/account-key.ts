import type { ProviderId, Session } from "./types.js";

export function nextAccountKey(sessions: readonly Session[], provider: ProviderId): string {
  const used = new Set(
    sessions
      .filter((session) => session.provider === provider && session.authenticated)
      .map((session) => session.accountKey),
  );
  if (!used.has("default")) return "default";
  let index = 2;
  while (used.has(`account-${index}`)) index += 1;
  return `account-${index}`;
}
