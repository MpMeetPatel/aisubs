import { Check, ChevronRight, CircleAlert, Copy, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { api, go, icon, planKind } from "../lib";
import type { Provider, ProviderUsage, Session, Theme } from "../types";
import { copy } from "./syntax";

export const primaryButton =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-xs font-bold whitespace-nowrap text-zinc-50 shadow-sm transition hover:bg-zinc-700 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
export const secondaryButton =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3.5 text-xs font-bold whitespace-nowrap text-zinc-900 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-100 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600 dark:hover:bg-zinc-800";
export const dangerButton =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3.5 text-xs font-bold whitespace-nowrap text-white transition hover:bg-red-700 active:translate-y-px disabled:pointer-events-none disabled:opacity-50";
export const iconButton =
  "grid size-9 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition hover:border-zinc-300 hover:text-zinc-950 active:translate-y-px dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-50";
export const panel =
  "overflow-hidden rounded-[10px] border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900";
export const page = "mx-auto min-h-dvh w-full max-w-[1180px] px-4 pt-24 pb-12 sm:px-6 sm:pb-16";

function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange(theme: Theme): void }) {
  const option =
    "grid size-7 place-items-center rounded-md text-zinc-500 transition hover:text-zinc-950 aria-pressed:bg-zinc-900 aria-pressed:text-zinc-50 dark:text-zinc-400 dark:hover:text-zinc-50 dark:aria-pressed:bg-zinc-100 dark:aria-pressed:text-zinc-900";
  return (
    <div
      className="pointer-events-auto inline-flex items-center gap-0.5 rounded-[10px] border border-zinc-200/80 bg-white/80 p-0.5 shadow-sm backdrop-blur-xl dark:border-zinc-700 dark:bg-zinc-900/80"
      role="group"
      aria-label="Color theme"
    >
      <button
        className={option}
        type="button"
        aria-label="Use light theme"
        aria-pressed={theme === "light"}
        onClick={() => onChange("light")}
      >
        <Sun size={14} />
      </button>
      <button
        className={option}
        type="button"
        aria-label="Use dark theme"
        aria-pressed={theme === "dark"}
        onClick={() => onChange("dark")}
      >
        <Moon size={14} />
      </button>
    </div>
  );
}

export function PlanBadge({ plan, className = "" }: { plan: string; className?: string }) {
  const color = {
    paid: "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    free: "border-blue-600/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    unknown: "border-zinc-400/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
  }[planKind(plan)];
  return (
    <span
      className={`inline-flex min-h-6 w-fit items-center rounded-full border px-2 text-[11px] font-bold leading-none whitespace-nowrap ${color} ${className}`}
    >
      {plan}
    </span>
  );
}

const providerLogo = {
  chatgpt: [
    "border-emerald-500/40 bg-emerald-500/10",
    "text-emerald-600 dark:text-emerald-300 [mask-image:url('/logos/openai.svg')]",
  ],
  claude: [
    "border-orange-500/40 bg-orange-500/10",
    "text-orange-600 dark:text-orange-300 [mask-image:url('/logos/anthropic.svg')]",
  ],
  copilot: [
    "border-violet-500/40 bg-violet-500/10",
    "text-violet-600 dark:text-violet-300 [mask-image:url('/logos/github-copilot.svg')]",
  ],
  grok: [
    "border-zinc-400/40 bg-zinc-500/10",
    "text-zinc-800 dark:text-zinc-100 [mask-image:url('/logos/xai.svg')]",
  ],
} as const;

export function ProviderMark({ provider }: { provider: Provider }) {
  if (provider.id === "opencode-go" || provider.id === "opencode-zen") {
    return (
      <span
        className="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-stone-400/40 bg-stone-500/10 dark:border-stone-500/40 dark:bg-stone-400/10"
        role="img"
        aria-label={`${provider.name} logo`}
      >
        <img className="size-5 dark:hidden" src="/logos/opencode-light.svg" alt="" />
        <img className="hidden size-5 dark:block" src="/logos/opencode-dark.svg" alt="" />
      </span>
    );
  }
  const [mark, logo] = providerLogo[provider.id as keyof typeof providerLogo] ?? providerLogo.grok;
  return (
    <span
      className={`grid size-[38px] shrink-0 place-items-center rounded-[10px] border ${mark}`}
      role="img"
      aria-label={`${provider.name} logo`}
    >
      <span
        className={`size-5 bg-current [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain] ${logo}`}
      />
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`inline-flex min-h-7 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 text-xs font-bold text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-950 active:translate-y-px dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-50 ${className}`}
      type="button"
      onClick={() => {
        void copy(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check {...icon} /> : <Copy {...icon} />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function AppHeader({ theme, onTheme }: { theme: Theme; onTheme(theme: Theme): void }) {
  return (
    <header className="pointer-events-none fixed inset-x-[14px] top-[14px] z-20 flex items-center justify-between sm:inset-x-[18px] sm:top-4">
      <button
        className="pointer-events-auto inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-200/80 bg-white/80 py-1 pr-2 pl-1 shadow-sm backdrop-blur-xl transition hover:-translate-y-px hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900/80 dark:hover:border-zinc-600"
        type="button"
        onClick={() => go("/")}
      >
        <img
          className="size-[30px] invert dark:invert-0"
          src="/aisubs-mark.svg"
          alt=""
          aria-hidden="true"
        />
        <strong className="text-[13px] tracking-tight">AI Subs</strong>
      </button>
      <div className="pointer-events-auto flex items-center gap-2">
        <ThemeSwitch theme={theme} onChange={onTheme} />
      </div>
    </header>
  );
}

export function ErrorBanner({ children }: { children: string }) {
  return (
    <div
      className="mb-[18px] flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-300"
      role="alert"
    >
      <CircleAlert className="mt-px shrink-0" {...icon} />
      <span>{children}</span>
    </div>
  );
}

export function AccountRow({
  session,
  supportsUsage,
  onReconnect,
}: {
  session: Session;
  supportsUsage: boolean;
  onReconnect(session: Session): void;
}) {
  const [live, setLive] = useState<ProviderUsage | null>(null);
  const [checked, setChecked] = useState(!supportsUsage);
  useEffect(() => {
    if (!supportsUsage) return;
    let active = true;
    const suffix = `account=${encodeURIComponent(session.accountKey)}`;
    void api<ProviderUsage>(`/v1/usage/${session.provider}?${suffix}`)
      .then((usage) => active && setLive(usage))
      .catch(() => undefined)
      .finally(() => active && setChecked(true));
    return () => {
      active = false;
    };
  }, [session.accountKey, session.provider, supportsUsage]);
  const identity = live?.account ?? session.account;
  const title = identity?.label ?? identity?.email ?? session.accountKey;
  const plan = identity?.plan ?? live?.plan ?? (checked ? "Not reported" : "Checking…");
  return (
    <button
      className="grid min-h-[60px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t border-zinc-200 bg-transparent px-4 py-2 text-left transition hover:bg-zinc-100 active:translate-y-px sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] dark:border-zinc-800 dark:hover:bg-zinc-800"
      type="button"
      onClick={() =>
        session.reauthRequired
          ? onReconnect(session)
          : go(
              `/accounts/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.accountKey)}`,
            )
      }
    >
      <div className="grid min-w-0">
        <strong className="truncate text-[13px]">{title}</strong>
        <small className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
          {identity?.email && identity.email !== title
            ? identity.email
            : `Local name: ${session.accountKey}`}
        </small>
      </div>
      <div className="col-start-1 row-start-2 grid sm:col-auto sm:row-auto">
        <PlanBadge plan={plan} />
      </div>
      <span
        className={`col-start-2 row-start-1 inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-bold sm:col-auto sm:row-auto ${session.reauthRequired ? "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-300" : "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}
      >
        {session.reauthRequired ? <CircleAlert size={14} /> : <Check size={14} />}{" "}
        {session.reauthRequired ? "Session expired" : "Connected"}
      </span>
      <ChevronRight
        className="col-start-2 row-start-2 justify-self-end text-zinc-500 sm:col-auto sm:row-auto dark:text-zinc-400"
        size={18}
      />
    </button>
  );
}

export function AccountSkeleton() {
  return (
    <div
      className="grid grid-cols-1 items-start gap-3 md:grid-cols-2"
      aria-label="Loading accounts"
    >
      <div className="h-44 animate-pulse rounded-[10px] bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-44 animate-pulse rounded-[10px] bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
