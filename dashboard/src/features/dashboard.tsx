import { ChevronRight, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { Provider, Session } from "../types";
import { icon } from "../lib";
import {
  AccountRow,
  AccountSkeleton,
  ErrorBanner,
  ProviderMark,
  page,
  panel,
  primaryButton,
  secondaryButton,
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
  const connected = sessions.filter((session) => session.authenticated || session.reauthRequired);
  const activeProviders = new Set(connected.map((session) => session.provider)).size;
  const openCodeProviders = providers.filter((provider) => provider.id.startsWith("opencode-"));
  const otherProviders = providers.filter((provider) => !provider.id.startsWith("opencode-"));
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
        <button
          className={`${primaryButton} w-full sm:w-auto`}
          type="button"
          onClick={() => setConnect("picker")}
        >
          <Plus {...icon} /> Add account
        </button>
      </section>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
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
        <span>No telemetry, analytics, request logs, or activity history are collected.</span>
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
    </main>
  );
}
