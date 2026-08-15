import type { AccountRoute, UsageMeter } from "./types";

export const icon = { size: 18, strokeWidth: 1.75 };

export function accountRoute(): AccountRoute | null {
  const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return parts[0] === "accounts" && parts[1] && parts[2]
    ? { provider: parts[1], account: parts[2] }
    : null;
}

export function go(path: string): void {
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function formatDate(value?: number): string {
  if (!value || value >= Date.UTC(2099, 0, 1)) return "No scheduled expiry";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}

export function formatNumber(value?: number): string {
  if (value == null) return "Not published";
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

export function meterValue(meter: UsageMeter): string {
  if (meter.unlimited) return "Unlimited";
  if (meter.remaining != null) return `${formatNumber(meter.remaining)} remaining`;
  if (meter.percentUsed != null) return `${Math.round(meter.percentUsed)}% used`;
  if (meter.used != null && meter.limit != null)
    return `${formatNumber(meter.used)} of ${formatNumber(meter.limit)}`;
  if (meter.used != null) return `${formatNumber(meter.used)} used`;
  return meter.included === false ? "Not included" : "Included";
}

export function meterPercent(meter: UsageMeter): number | null {
  const value =
    meter.percentUsed ??
    (meter.used != null && meter.limit ? (meter.used / meter.limit) * 100 : undefined);
  return value == null ? null : Math.max(0, Math.min(100, value));
}

export function meterTone(meter: UsageMeter): "default" | "warning" | "danger" {
  const percent = meterPercent(meter);
  if (percent != null && percent >= 90) return "danger";
  if (percent != null && percent >= 80) return "warning";
  return "default";
}

export function planKind(plan?: string): "free" | "paid" | "unknown" {
  if (!plan || /not reported|not published|connected subscription|checking/i.test(plan)) {
    return "unknown";
  }
  return /free/i.test(plan) ? "free" : "paid";
}

export function loginMethods(provider: { loginModes: string[] }): string {
  return provider.loginModes
    .map((mode) =>
      mode === "external-cli"
        ? "Official CLI browser sign-in"
        : mode === "external-token"
          ? "External token"
          : mode === "device"
            ? "Device code"
            : mode === "browser"
              ? "Browser OAuth"
              : mode,
    )
    .join(", ");
}
