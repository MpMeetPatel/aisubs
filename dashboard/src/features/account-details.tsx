import {
  ArrowLeft,
  ChevronRight,
  Cpu,
  Link2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  formatDate,
  formatNumber,
  go,
  icon,
  loginMethods,
  meterPercent,
  meterTone,
  meterValue,
} from "../lib";
import type {
  AccountRoute,
  CredentialSummary,
  Provider,
  ProviderModels,
  ProviderUsage,
} from "../types";
import {
  CopyButton,
  dangerButton,
  iconButton,
  page,
  panel,
  primaryButton,
  secondaryButton,
  ErrorBanner,
  PlanBadge,
} from "../components/ui";
import { IntegrationPanel } from "./integration-panel";
import { ConnectDialog } from "./connect-dialog";

function Fact({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="min-w-0 p-3.5">
      <dt className="mb-1 text-[10px] font-bold tracking-[0.05em] text-zinc-500 uppercase dark:text-zinc-400">
        {label}
      </dt>
      <dd className="m-0 flex min-w-0 items-center justify-between gap-2 text-xs font-semibold">
        <span className="min-w-0 wrap-break-word">{value}</span>
        {copyable ? <CopyButton value={value} /> : null}
      </dd>
    </div>
  );
}

export function AccountDetails({
  route,
  providers,
  providersLoading,
  refreshAccounts,
}: {
  route: AccountRoute;
  providers: Provider[];
  providersLoading: boolean;
  refreshAccounts(): void;
}) {
  const provider = providers.find((item) => item.id === route.provider);
  const [credential, setCredential] = useState<CredentialSummary | null>(null);
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [models, setModels] = useState<ProviderModels | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [disconnect, setDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (!provider) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setCredential(null);
    setUsage(null);
    setModels(null);
    const suffix = `account=${encodeURIComponent(route.account)}`;
    const [details, nextUsage, nextModels] = await Promise.allSettled([
      api<CredentialSummary>(`/v1/auth/${provider.id}/details?${suffix}`),
      provider.supportsUsage
        ? api<ProviderUsage>(`/v1/usage/${provider.id}?${suffix}`)
        : Promise.resolve(null),
      provider.supportsModels
        ? api<ProviderModels>(`/v1/models/${provider.id}?${suffix}`)
        : Promise.resolve(null),
    ]);
    if (generation !== loadGeneration.current) return;
    if (details.status === "fulfilled") setCredential(details.value);
    else
      setError(details.reason instanceof Error ? details.reason.message : String(details.reason));
    if (nextUsage.status === "fulfilled") setUsage(nextUsage.value);
    if (nextModels.status === "fulfilled") setModels(nextModels.value);
    const partial = [nextUsage, nextModels].flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    if (details.status === "fulfilled" && partial.length)
      setError(`Some live details could not be loaded: ${partial.join(" ")}`);
    setLoading(false);
  }, [provider, route.account]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setQuery(""), [route.account, route.provider]);
  const identity = usage?.account ?? credential?.account;
  const filteredModels = (models?.models ?? []).filter((model) =>
    `${model.name ?? ""} ${model.id} ${model.description ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const localBase = `${location.origin}/aisubs/${encodeURIComponent(route.provider)}/${encodeURIComponent(route.account)}/v1`;
  const usageFacts = [
    ...(usage?.facts ?? []),
    ...(usage?.resetCredits
      ? [
          { label: "Available reset credits", value: String(usage.resetCredits.availableCount) },
          ...(usage.resetCredits.credits ?? []).map((credit, index) => ({
            label: credit.id ? `Reset credit ${credit.id}` : `Reset credit ${index + 1}`,
            value:
              [
                credit.status,
                credit.grantedAt ? `granted ${formatDate(credit.grantedAt)}` : undefined,
                credit.expiresAt ? `expires ${formatDate(credit.expiresAt)}` : undefined,
              ]
                .filter(Boolean)
                .join(", ") || "Available",
          })),
        ]
      : []),
  ];

  if (!provider && providersLoading)
    return (
      <main className={page}>
        <div
          className="min-h-[420px] animate-pulse rounded-[10px] bg-zinc-200 dark:bg-zinc-800"
          aria-label="Loading account"
        />
      </main>
    );
  if (!provider)
    return (
      <main className={page}>
        <ErrorBanner>Provider not found.</ErrorBanner>
      </main>
    );
  return (
    <main className={page}>
      <button
        className="mb-[18px] inline-flex w-fit items-center gap-1.5 bg-transparent p-0 text-xs font-semibold text-zinc-600 transition hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50"
        type="button"
        onClick={() => go("/")}
      >
        <ArrowLeft size={16} /> All accounts
      </button>
      <section className="mb-5 flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <div>
            <p className="mb-0.5 text-xs font-bold text-zinc-600 dark:text-zinc-300">
              {provider.name}
            </p>
            <h1 className="m-0 wrap-break-word text-[clamp(26px,3vw,36px)] font-bold tracking-[-0.05em] leading-[1.08]">
              {identity?.label ?? identity?.email ?? route.account}
            </h1>
          </div>
        </div>
        <div className="flex w-full items-center gap-4 sm:w-auto">
          {credential?.reauthRequired ? (
            <button
              className={`${primaryButton} flex-1 sm:flex-none`}
              type="button"
              onClick={() => setReconnect(true)}
            >
              <Link2 {...icon} /> Reconnect
            </button>
          ) : null}
          <button
            className={`${secondaryButton} flex-1 sm:flex-none`}
            type="button"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} {...icon} /> Refresh details
          </button>
          <button
            className={`${iconButton} hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-400`}
            type="button"
            onClick={() => setDisconnect(true)}
            aria-label="Disconnect account"
          >
            <Trash2 {...icon} />
          </button>
        </div>
      </section>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {loading && !credential ? (
        <div className="min-h-[420px] animate-pulse rounded-[10px] bg-zinc-200 dark:bg-zinc-800" />
      ) : credential ? (
        <>
          <section
            className="grid items-stretch gap-3 lg:grid-cols-[minmax(250px,.36fr)_minmax(0,1fr)]"
            aria-label="Account snapshot"
          >
            <div className={`${panel} grid divide-y divide-zinc-200 dark:divide-zinc-800`}>
              <div className="grid min-h-[54px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 px-3.5 py-2.5">
                <small className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Plan
                </small>
                <PlanBadge plan={identity?.plan ?? usage?.plan ?? "Not published"} />
              </div>
              <div className="grid min-h-[54px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 px-3.5 py-2.5">
                <small className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Connection
                </small>
                <strong className="truncate text-right text-[13px]">
                  {credential.reauthRequired
                    ? "Session expired"
                    : credential.needsRefresh
                      ? "Refresh required"
                      : "Ready"}
                </strong>
              </div>
              <div className="grid min-h-[54px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 px-3.5 py-2.5">
                <small className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Authentication
                </small>
                <strong className="truncate text-right text-[13px]">
                  {credential.externallyManaged ? "Official client" : "Stored locally"}
                </strong>
              </div>
              <div className="grid min-h-[54px] min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 px-3.5 py-2.5">
                <small className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                  Access expiry
                </small>
                <strong className="truncate text-right text-[13px]">
                  {formatDate(credential.expiresAt)}
                </strong>
              </div>
            </div>
            <div className={`${panel} bg-zinc-100/50 dark:bg-zinc-900`}>
              <div className="flex min-h-[54px] flex-col items-start justify-between gap-1.5 border-b border-zinc-200 px-4 py-2.5 sm:flex-row sm:items-center dark:border-zinc-800">
                <span className="grid gap-0.5">
                  <strong className="text-xs">Subscription usage</strong>
                  <small className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    Current provider limits and credits
                  </small>
                </span>
                {usage ? (
                  <time className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
                    {formatDate(usage.asOf)}
                  </time>
                ) : null}
              </div>
              <div className="divide-y divide-zinc-200 px-4 dark:divide-zinc-800">
                {(usage?.meters ?? []).map((meter) => {
                  const percent = meterPercent(meter);
                  return (
                    <div
                      className={`grid min-h-[54px] items-center gap-3 sm:gap-5 ${percent == null ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_160px]"}`}
                      data-tone={meterTone(meter)}
                      key={meter.id}
                    >
                      <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
                        <span className="grid gap-0.5">
                          <small className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                            {meter.label}
                          </small>
                          <em className="truncate text-[10px] not-italic text-zinc-500 dark:text-zinc-400">
                            {meter.resetAt
                              ? `Resets ${formatDate(meter.resetAt)}`
                              : (meter.window ?? meter.unit)}
                          </em>
                        </span>
                        <strong
                          className={`truncate text-[13px] ${meterTone(meter) === "danger" ? "text-red-600 dark:text-red-400" : meterTone(meter) === "warning" ? "text-amber-600 dark:text-amber-300" : ""}`}
                        >
                          {meterValue(meter)}
                        </strong>
                      </span>
                      {percent != null ? (
                        <span
                          className="h-[3px] w-full overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-700"
                          role="progressbar"
                          aria-label={`${meter.label}: ${Math.round(percent)}% used`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(percent)}
                        >
                          <i
                            className={`block h-full rounded-full ${meterTone(meter) === "danger" ? "bg-red-600" : meterTone(meter) === "warning" ? "bg-amber-500" : "bg-zinc-900 dark:bg-zinc-100"}`}
                            style={{ width: `${percent}%` }}
                          />
                        </span>
                      ) : null}
                    </div>
                  );
                })}
                {!usage?.meters?.length ? (
                  <p className="m-0 py-4 text-[11px] text-zinc-600 dark:text-zinc-300">
                    {provider.supportsUsage
                      ? "No live usage meters reported"
                      : "Usage is provider managed"}
                  </p>
                ) : null}
              </div>
              {usageFacts.length ? (
                <dl className="m-0 grid grid-cols-1 border-t border-zinc-200 sm:grid-cols-2 dark:border-zinc-800 [&>div]:min-w-0 [&>div]:p-4 [&>div:nth-child(even)]:sm:border-l [&>div:nth-child(even)]:sm:border-zinc-200 [&>div:nth-child(n+3)]:sm:border-t [&>div:nth-child(n+3)]:sm:border-zinc-200 dark:[&>div:nth-child(even)]:sm:border-zinc-800 dark:[&>div:nth-child(n+3)]:sm:border-zinc-800 [&_dt]:mb-1 [&_dt]:text-[9px] [&_dt]:font-bold [&_dt]:tracking-[0.05em] [&_dt]:text-zinc-500 [&_dt]:uppercase dark:[&_dt]:text-zinc-400 [&_dd]:m-0 [&_dd]:wrap-break-word [&_dd]:text-[11px] [&_dd]:font-semibold">
                  {usageFacts.map((fact) => (
                    <div key={`${fact.label}:${fact.value}`}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {usage?.note ? (
                <p className="m-0 border-t border-zinc-200 px-4 py-2.5 text-[10px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                  {usage.note}
                </p>
              ) : null}
            </div>
          </section>

          <details className={`${panel} group mt-2.5`}>
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-4 [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 items-center gap-2">
                <Link2 {...icon} />
                <strong className="text-[11px]">Connection details</strong>
                <small className="hidden truncate text-[10px] text-zinc-500 sm:inline dark:text-zinc-400">
                  Identity, routing, credential status, and approved hosts
                </small>
              </span>
              <ChevronRight
                className="shrink-0 text-zinc-500 transition group-open:rotate-90 dark:text-zinc-400"
                size={17}
              />
            </summary>
            <section className="grid grid-cols-1 border-t border-zinc-200 md:grid-cols-2 dark:border-zinc-800">
              <div className="overflow-hidden border-b border-zinc-200 md:border-r md:border-b-0 dark:border-zinc-800">
                <div className="flex items-start gap-2.5 border-b border-zinc-200 p-4 dark:border-zinc-800">
                  <Link2 {...icon} />
                  <span>
                    <h2 className="m-0 text-[13px] tracking-tight">Account</h2>
                    <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                      Provider identity and local routing information.
                    </p>
                  </span>
                </div>
                <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 [&>div]:border-t [&>div]:border-zinc-200 [&>div:nth-child(-n+2)]:sm:border-t-0 [&>div:nth-child(odd)]:sm:border-r dark:[&>div]:border-zinc-800">
                  <Fact label="Local name" value={route.account} copyable />
                  {identity?.email ? <Fact label="Email" value={identity.email} copyable /> : null}
                  {identity?.id ? (
                    <Fact label="Provider account ID" value={identity.id} copyable />
                  ) : null}
                  <Fact label="Plan" value={identity?.plan ?? usage?.plan ?? "Not published"} />
                  {credential.endpoint ? (
                    <Fact label="Provider endpoint" value={credential.endpoint} copyable />
                  ) : null}
                  {provider.supportsProxy ? (
                    <Fact label="Local API base URL" value={localBase} copyable />
                  ) : null}
                  {provider.homepage ? (
                    <Fact label="Provider homepage" value={provider.homepage} copyable />
                  ) : null}
                  <Fact label="Sign-in methods" value={loginMethods(provider)} />
                  <Fact
                    label="Programmatic access"
                    value={provider.supportsProxy ? "Local API proxy" : "Unavailable"}
                  />
                </dl>
              </div>
              <div className="overflow-hidden">
                <div className="flex items-start gap-2.5 border-b border-zinc-200 p-4 dark:border-zinc-800">
                  <ShieldCheck {...icon} />
                  <span>
                    <h2 className="m-0 text-[13px] tracking-tight">Credential</h2>
                    <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                      Safe status only. Secret values are never returned.
                    </p>
                  </span>
                </div>
                <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 [&>div]:border-t [&>div]:border-zinc-200 [&>div:nth-child(-n+2)]:sm:border-t-0 [&>div:nth-child(odd)]:sm:border-r dark:[&>div]:border-zinc-800">
                  <Fact
                    label="Access credential"
                    value={
                      credential.externallyManaged
                        ? "Managed by official CLI"
                        : credential.accessCredentialStored
                          ? "Stored locally"
                          : "Not stored"
                    }
                  />
                  <Fact
                    label="Refresh credential"
                    value={credential.refreshCredentialStored ? "Stored locally" : "Not issued"}
                  />
                  <Fact
                    label="Automatic refresh"
                    value={credential.automaticRefresh ? "Enabled" : "Unavailable"}
                  />
                  <Fact label="Access expiry" value={formatDate(credential.expiresAt)} />
                  <Fact
                    label="Connection state"
                    value={credential.needsRefresh ? "Refresh required" : "Ready"}
                  />
                  <Fact
                    label="Approved hosts"
                    value={provider.allowedHosts?.join(", ") ?? "Provider managed"}
                  />
                </dl>
              </div>
            </section>
          </details>

          {provider.supportsProxy ? (
            <IntegrationPanel
              provider={provider}
              account={route.account}
              models={models?.models ?? []}
            />
          ) : null}

          <section className={`${panel} mt-3`}>
            <div className="flex min-h-[60px] flex-col items-start justify-between gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-center dark:border-zinc-800">
              <div className="flex items-start gap-2.5">
                <Cpu {...icon} />
                <span>
                  <h2 className="m-0 text-[13px] tracking-tight">Available models</h2>
                  <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                    Every model the provider reports for this account.
                  </p>
                </span>
              </div>
              {models?.models.length ? (
                <label className="flex h-[34px] w-full items-center gap-2 rounded-lg border border-zinc-300 bg-zinc-50 px-2 text-zinc-500 sm:w-[220px] dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
                  <Search size={16} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-[30px] min-w-0 flex-1 border-0 bg-transparent p-0 text-[11px] text-zinc-900 outline-none placeholder:text-zinc-500 dark:text-zinc-50 dark:placeholder:text-zinc-400"
                    placeholder="Find a model"
                  />
                </label>
              ) : null}
            </div>
            {filteredModels.length ? (
              <div className="grid grid-cols-1 gap-px bg-zinc-200 md:grid-cols-2 dark:bg-zinc-800">
                {filteredModels.map((model) => (
                  <article className="min-w-0 bg-white p-[18px] dark:bg-zinc-900" key={model.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="m-0 text-[13px]">{model.name ?? model.id}</h3>
                        <code className="mt-1 block wrap-break-word text-[10px] text-zinc-600 dark:text-zinc-300">
                          {model.id}
                        </code>
                      </div>
                      <CopyButton value={model.id} />
                    </div>
                    {model.description ? (
                      <p className="my-3 text-[11px] text-zinc-600 dark:text-zinc-300">
                        {model.description}
                      </p>
                    ) : null}
                    <dl className="m-[-18px] mt-3 grid grid-cols-1 border-t border-zinc-200 sm:grid-cols-2 dark:border-zinc-800 [&>div]:border-t [&>div]:border-zinc-200 [&>div:nth-child(-n+2)]:sm:border-t-0 [&>div:nth-child(odd)]:sm:border-r dark:[&>div]:border-zinc-800 [&_dt]:text-[9px] [&_dd]:text-[10px]">
                      <Fact label="Context window" value={formatNumber(model.contextWindow)} />
                      <Fact label="Max output" value={formatNumber(model.maxOutputTokens)} />
                      <Fact
                        label="Input"
                        value={model.inputModalities?.join(", ") ?? "Not published"}
                      />
                      <Fact
                        label="Reasoning"
                        value={model.reasoningEfforts?.join(", ") ?? "Provider default"}
                      />
                      <Fact
                        label="Endpoints"
                        value={model.endpoints?.join(", ") ?? "Provider default"}
                      />
                      <Fact
                        label="Selection"
                        value={
                          model.selectable === false
                            ? "Automatic routing"
                            : model.available === false
                              ? "Unavailable"
                              : "Selectable"
                        }
                      />
                    </dl>
                  </article>
                ))}
              </div>
            ) : (
              <p className="m-0 p-[18px] text-xs text-zinc-600 dark:text-zinc-300">
                {query
                  ? "No models match this search."
                  : "This provider did not return an account-specific model catalog."}
              </p>
            )}
          </section>
        </>
      ) : null}

      {disconnect ? (
        <div className="fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-zinc-950/35 p-4 backdrop-blur-sm sm:p-6">
          <section
            className="w-full max-w-[420px] rounded-xl border border-zinc-300 bg-white p-6 text-center shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
            role="dialog"
            aria-modal="true"
          >
            <span className="mx-auto mb-4 grid size-[54px] place-items-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
              <Trash2 size={22} />
            </span>
            <h2 className="m-0 text-lg tracking-tight">Disconnect this account?</h2>
            <p className="mx-auto mt-2 mb-[22px] max-w-[330px] text-xs text-zinc-600 dark:text-zinc-300">
              AISubs will remove its local credential. This does not cancel the provider
              subscription.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                className={secondaryButton}
                type="button"
                onClick={() => setDisconnect(false)}
              >
                Keep account
              </button>
              <button
                className={dangerButton}
                type="button"
                disabled={disconnecting}
                onClick={() => {
                  setDisconnecting(true);
                  void api(`/v1/auth/${provider.id}?account=${encodeURIComponent(route.account)}`, {
                    method: "DELETE",
                  })
                    .then(() => {
                      refreshAccounts();
                      go("/");
                    })
                    .catch((nextError) => {
                      setDisconnect(false);
                      setError(nextError instanceof Error ? nextError.message : String(nextError));
                    })
                    .finally(() => setDisconnecting(false));
                }}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {reconnect ? (
        <ConnectDialog
          providers={providers}
          sessions={[
            {
              provider: route.provider,
              accountKey: route.account,
              authenticated: false,
              reauthRequired: true,
            },
          ]}
          initial={provider}
          initialAccount={route.account}
          replaceExisting
          onClose={() => setReconnect(false)}
          onConnected={() => {
            setReconnect(false);
            refreshAccounts();
            void load();
          }}
        />
      ) : null}
    </main>
  );
}
