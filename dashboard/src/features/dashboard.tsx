import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Provider, Session } from "../types";
import { api, go, icon } from "../lib";
import {
  AccountRow,
  AccountSkeleton,
  CopyButton,
  ErrorBanner,
  ProviderMark,
  page,
  panel,
  primaryButton,
  secondaryButton,
  iconButton,
} from "../components/ui";
import { ConnectDialog } from "./connect-dialog";

function ProviderCard({
  provider,
  accounts,
  onConnect,
  onReconnect,
}: {
  provider: Provider;
  accounts: Session[];
  onConnect(provider: Provider): void;
  onReconnect(session: Session): void;
}) {
  return (
    <section
      className={`${panel} transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lg dark:hover:border-zinc-700`}
    >
      <header className="flex flex-col items-start justify-between gap-3 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderMark provider={provider} />
          <span className="min-w-0">
            <h2 className="m-0 text-sm tracking-tight">{provider.name}</h2>
            <p className="mt-0.5 truncate text-[11px] text-zinc-600 dark:text-zinc-300">
              {provider.description}
            </p>
          </span>
        </div>
        <div className="flex w-full items-center justify-end gap-3 sm:w-auto">
          <button
            className={`${secondaryButton} min-h-8 px-2.5`}
            type="button"
            onClick={() => onConnect(provider)}
          >
            <Plus size={15} /> Connect
          </button>
        </div>
      </header>
      {accounts.length ? (
        <div>
          {accounts.map((session) => (
            <AccountRow
              key={`${session.provider}:${session.accountKey}`}
              session={session}
              supportsUsage={provider.supportsUsage}
              onReconnect={onReconnect}
            />
          ))}
        </div>
      ) : (
        <button
          className="flex min-h-[58px] w-full items-center justify-between border-t border-zinc-200 bg-zinc-100/70 px-4 text-left text-[11px] text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          type="button"
          onClick={() => onConnect(provider)}
        >
          Connect {provider.name} <ChevronRight size={15} />
        </button>
      )}
    </section>
  );
}

function UseGuide({
  providers,
  accounts,
  onClose,
}: {
  providers: Provider[];
  accounts: Session[];
  onClose(): void;
}) {
  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-zinc-950/35 p-0 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="max-h-[92dvh] w-full max-w-[700px] overflow-y-auto rounded-t-xl border border-zinc-300 bg-white shadow-2xl sm:max-h-[calc(100dvh-48px)] sm:rounded-xl dark:border-zinc-700 dark:bg-zinc-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="use-guide-title"
      >
        <header className="flex items-start justify-between gap-6 border-b border-zinc-200 p-5 dark:border-zinc-800">
          <div>
            <h2 className="m-0 text-lg tracking-tight" id="use-guide-title">
              How to use AISubs
            </h2>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              Connect once, then use each account from an existing AI app or SDK.
            </p>
          </div>
          <button className={iconButton} type="button" onClick={onClose} aria-label="Close guide">
            <X {...icon} />
          </button>
        </header>

        <div className="grid gap-5 p-5">
          <ol className="m-0 grid list-none gap-2 p-0 sm:grid-cols-3">
            {[
              ["1", "Connect an account", "Choose a provider and finish sign-in."],
              ["2", "Open the account", "Click its connected account row."],
              ["3", "Copy its setup", "Choose a model and integration tab."],
            ].map(([number, title, description]) => (
              <li
                className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950"
                key={number}
              >
                <span className="mb-2 grid size-6 place-items-center rounded-full bg-zinc-900 text-[10px] font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
                  {number}
                </span>
                <strong className="block text-xs">{title}</strong>
                <small className="mt-1 block text-[11px] text-zinc-600 dark:text-zinc-300">
                  {description}
                </small>
              </li>
            ))}
          </ol>

          <section className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <h3 className="m-0 text-xs">What every app needs</h3>
              <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                Find these exact values in the selected account's “Use this account anywhere” panel.
              </p>
            </div>
            <dl className="m-0 grid divide-y divide-zinc-200 text-xs dark:divide-zinc-700">
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[130px_1fr]">
                <dt className="font-bold">API base URL</dt>
                <dd className="m-0 break-all font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                  http://127.0.0.1:4319/aisubs/PROVIDER/ACCOUNT/v1
                </dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[130px_1fr]">
                <dt className="font-bold">API key</dt>
                <dd className="m-0 text-[11px] text-zinc-600 dark:text-zinc-300">
                  Copy the persistent key from Local API access on the main dashboard.
                </dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[130px_1fr]">
                <dt className="font-bold">Model and API</dt>
                <dd className="m-0 text-[11px] text-zinc-600 dark:text-zinc-300">
                  Use the exact model ID. OpenAI-compatible apps can use Chat Completions; native
                  Responses, Anthropic, Google-protocol, Realtime, and provider feature routes
                  remain available when the account supports them. Google protocol support does not
                  add a Google subscription provider.
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 className="m-0 text-xs">Account-specific documentation</h3>
            <p className="mt-1 mb-3 text-[11px] text-zinc-600 dark:text-zinc-300">
              Each account page contains copy-ready setup for compatible apps, JavaScript SDKs,
              Python, and cURL.
            </p>
            {accounts.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {accounts.map((account) => {
                  const provider = providers.find((item) => item.id === account.provider);
                  return (
                    <button
                      className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 text-left transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      key={`${account.provider}:${account.accountKey}`}
                      type="button"
                      onClick={() => {
                        onClose();
                        go(
                          `/accounts/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.accountKey)}`,
                        );
                      }}
                    >
                      <span className="grid min-w-0">
                        <strong className="truncate text-xs">
                          {provider?.name ?? account.provider} · {account.accountKey}
                        </strong>
                        <small className="text-[10px] text-zinc-500 dark:text-zinc-400">
                          Open full setup
                        </small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="m-0 rounded-lg bg-zinc-100 p-3 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                Connect an account first. Its full setup appears when you open the connected account
                row.
              </p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

interface RequestLog {
  id: number;
  timestamp: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
}

function LogsDialog({ onClose }: { onClose(): void }) {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let active = true;
    let stream: EventSource | undefined;
    let retry: number | undefined;
    const connect = () => {
      stream = new EventSource("/v1/logs/stream");
      stream.onopen = () => setConnected(true);
      stream.onmessage = (event) => {
        const entry = JSON.parse(event.data) as RequestLog;
        setLogs((current) =>
          [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 200),
        );
      };
      stream.onerror = () => {
        setConnected(false);
        stream?.close();
        void fetch("/", { cache: "no-store" })
          .catch(() => undefined)
          .finally(() => {
            if (active) retry = window.setTimeout(connect, 1000);
          });
      };
    };
    connect();
    return () => {
      active = false;
      stream?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);
  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-zinc-950/35 p-0 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="flex max-h-[92dvh] w-full max-w-[900px] flex-col overflow-hidden rounded-t-xl border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-2xl sm:max-h-[calc(100dvh-48px)] sm:rounded-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="logs-title"
      >
        <header className="flex items-start justify-between gap-6 border-b border-white/10 p-5">
          <div>
            <h2 className="m-0 text-lg tracking-tight" id="logs-title">
              Live account requests
            </h2>
            <p className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
              <span
                className={`size-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`}
              />
              {connected ? "Listening" : "Connecting…"} · newest first · kept in memory only
            </p>
          </div>
          <button
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/15 text-zinc-400 transition hover:text-white"
            type="button"
            onClick={onClose}
            aria-label="Close logs"
          >
            <X {...icon} />
          </button>
        </header>
        <div className="min-h-72 flex-1 overflow-auto font-mono text-[11px]">
          {logs.length ? (
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Path</th>
                  <th className="px-4 py-2 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr className="border-t border-white/5" key={log.id}>
                    <td className="whitespace-nowrap px-4 py-2 text-zinc-500">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2 text-sky-300">{log.method}</td>
                    <td
                      className={`px-4 py-2 ${log.status >= 400 ? "text-red-300" : "text-emerald-300"}`}
                    >
                      {log.status}
                    </td>
                    <td className="max-w-[520px] px-4 py-2">
                      <div className="truncate">{log.path}</div>
                      {log.error ? (
                        <div className="mt-1 line-clamp-2 break-all text-red-300" title={log.error}>
                          {log.error}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-zinc-400">
                      {log.durationMs} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="grid min-h-72 place-items-center text-zinc-500">
              Waiting for an account request…
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function Dashboard({
  providers,
  sessions,
  loading,
  error,
  refresh,
}: {
  providers: Provider[];
  sessions: Session[];
  loading: boolean;
  error: string | null;
  refresh(): void;
}) {
  const [connect, setConnect] = useState<Provider | "picker" | null>(null);
  const [reconnect, setReconnect] = useState<Session | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [changingApiKey, setChangingApiKey] = useState(false);
  const connected = sessions.filter((session) => session.authenticated || session.reauthRequired);
  const activeProviders = new Set(connected.map((session) => session.provider)).size;
  const openCodeProviders = providers.filter((provider) => provider.id.startsWith("opencode-"));
  const otherProviders = providers.filter((provider) => !provider.id.startsWith("opencode-"));
  useEffect(() => {
    void api<{ apiKey: string }>("/v1/api-key").then((result) => setApiKey(result.apiKey));
  }, []);

  const regenerateApiKey = async () => {
    if (!confirm("Regenerate the API key? Apps using the current key will stop working.")) return;
    setChangingApiKey(true);
    try {
      const result = await api<{ apiKey: string }>("/v1/api-key/regenerate", { method: "POST" });
      setApiKey(result.apiKey);
      setShowApiKey(true);
    } finally {
      setChangingApiKey(false);
    }
  };
  return (
    <main className={`${page} flex flex-col pt-[106px]`}>
      <section className="mb-6 flex flex-col items-start justify-between gap-7 sm:mb-7 sm:flex-row sm:items-end">
        <div>
          <h1 className="m-0 text-[clamp(28px,3vw,36px)] font-bold tracking-[-0.045em] leading-[1.05]">
            AI accounts
          </h1>
          <p className="mt-2 max-w-[630px] text-[13px] text-zinc-600 dark:text-zinc-300">
            Connect subscriptions, inspect what each account includes, and copy the supported setup.
          </p>
          <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <strong className="text-zinc-900 tabular-nums dark:text-zinc-50">
              {connected.length}
            </strong>{" "}
            connected
            <span className="h-3 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
            <strong className="text-zinc-900 tabular-nums dark:text-zinc-50">
              {activeProviders}
            </strong>{" "}
            providers in use
          </p>
        </div>
        <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
          <button className={secondaryButton} type="button" onClick={() => setShowGuide(true)}>
            <BookOpen {...icon} /> How to use
          </button>
          <button className={secondaryButton} type="button" onClick={() => setShowLogs(true)}>
            <Terminal {...icon} /> Account logs
          </button>
          <button
            className={`${primaryButton} w-full sm:w-auto`}
            type="button"
            onClick={() => setConnect("picker")}
          >
            <Plus {...icon} /> Add account
          </button>
        </div>
      </section>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <section
        className={`${panel} mb-3 grid gap-3 p-4 md:grid-cols-[minmax(220px,1fr)_minmax(240px,380px)_auto] md:items-center`}
        aria-label="Local API access"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <KeyRound {...icon} />
          <span className="min-w-0">
            <strong className="text-xs">Local API access</strong>
            <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
              Use this persistent key with any account base URL shown below.
            </p>
          </span>
        </div>
        <code className="flex h-9 min-w-0 items-center truncate rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-[11px] dark:border-zinc-700 dark:bg-zinc-950">
          {showApiKey ? apiKey || "Loading…" : "••••••••••••••••••••••••••••••••"}
        </code>
        <div className="flex min-w-0 items-center gap-2 md:justify-end">
          <button
            className={iconButton}
            type="button"
            onClick={() => setShowApiKey((value) => !value)}
            aria-label={showApiKey ? "Hide API key" : "Reveal API key"}
          >
            {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <CopyButton className="min-h-9" value={apiKey} label="Copy API key" />
          <button
            className={secondaryButton}
            type="button"
            onClick={() => void regenerateApiKey()}
            disabled={changingApiKey}
          >
            <RefreshCw className={changingApiKey ? "spin" : ""} size={15} /> Regenerate
          </button>
        </div>
      </section>
      {loading ? (
        <AccountSkeleton />
      ) : (
        <>
          <section
            className="grid grid-cols-1 items-start gap-3 md:grid-cols-2"
            aria-label="Providers"
          >
            {otherProviders.map((provider) => {
              const accounts = connected.filter((session) => session.provider === provider.id);
              return (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  accounts={accounts}
                  onConnect={setConnect}
                  onReconnect={setReconnect}
                />
              );
            })}
          </section>
          <section
            className="mt-3 grid grid-cols-1 items-start gap-3 md:grid-cols-2"
            aria-label="OpenCode providers"
          >
            {openCodeProviders.map((provider) => {
              const accounts = connected.filter((session) => session.provider === provider.id);
              return (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  accounts={accounts}
                  onConnect={setConnect}
                  onReconnect={setReconnect}
                />
              );
            })}
          </section>
        </>
      )}
      <footer className="mt-auto flex items-center justify-center gap-2 pt-8 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
        <ShieldCheck size={16} />
        <span>
          No telemetry or analytics. Account request logs stay in memory on this computer.
        </span>
      </footer>
      {connect ? (
        <ConnectDialog
          providers={providers}
          sessions={sessions}
          initial={connect === "picker" ? undefined : connect}
          onClose={() => setConnect(null)}
          onConnected={() => {
            setConnect(null);
            refresh();
          }}
        />
      ) : null}
      {reconnect ? (
        <ConnectDialog
          providers={providers}
          sessions={sessions}
          initial={providers.find((provider) => provider.id === reconnect.provider)}
          initialAccount={reconnect.accountKey}
          replaceExisting
          onClose={() => setReconnect(null)}
          onConnected={() => {
            setReconnect(null);
            refresh();
          }}
        />
      ) : null}
      {showGuide ? (
        <UseGuide providers={providers} accounts={connected} onClose={() => setShowGuide(false)} />
      ) : null}
      {showLogs ? <LogsDialog onClose={() => setShowLogs(false)} /> : null}
    </main>
  );
}
