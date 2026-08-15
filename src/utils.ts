import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredential } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length ? values : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    throw new Error("Login cancelled");
  }
}

export async function responseJson(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = isRecord(raw)
      ? (stringValue(raw.error_description) ?? stringValue(raw.error) ?? stringValue(raw.message))
      : undefined;
    throw new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!isRecord(raw)) throw new Error(`${label} returned invalid JSON`);
  return raw;
}

export function requireAllowedHost(request: Request, hosts: readonly (string | RegExp)[]): void {
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    throw new Error(`Refusing to send subscription credentials over ${url.protocol}`);
  }
  const host = url.hostname;
  if (
    !hosts.some((allowed) => (typeof allowed === "string" ? host === allowed : allowed.test(host)))
  ) {
    throw new Error(`Refusing to send subscription credentials to ${host}`);
  }
}

export function bearerRequest(
  request: Request,
  credential: OAuthCredential,
  extraHeaders?: Record<string, string>,
): Request {
  const headers = new Headers(request.headers);
  for (const name of [
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "x-goog-api-key",
  ]) {
    headers.delete(name);
  }
  headers.set("authorization", `Bearer ${credential.accessToken}`);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
  return new Request(request, { headers });
}

export function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
