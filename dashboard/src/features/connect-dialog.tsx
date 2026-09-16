import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  ExternalLink,
  Link2,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { nextAccountKey } from "../../../src/account-key.js";
import { api, icon } from "../lib";
import type { LoginFlow, Provider, Session } from "../types";
import { CopyButton, ErrorBanner, Modal, iconButton, primaryButton } from "../components/ui";

export function ConnectDialog({
  providers,
  sessions,
  initial,
  initialAccount,
  replaceExisting = false,
  onClose,
  onConnected,
}: {
  providers: Provider[];
  sessions: Session[];
  initial?: Provider;
  initialAccount?: string;
  replaceExisting?: boolean;
  onClose(): void;
  onConnected(): void;
}) {
  const [provider, setProvider] = useState<Provider | null>(initial ?? null);
  const [account, setAccount] = useState(
    () => initialAccount ?? (initial ? nextAccountKey(sessions, initial.id) : "default"),
  );
  const [mode, setMode] = useState(initial?.loginModes[0] ?? "device");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [login, setLogin] = useState<LoginFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (login?.state === "complete") {
      onConnected();
      return;
    }
    if (!login || login.state !== "pending") return;
    const abort = new AbortController();
    let timer: number;
    const poll = async () => {
      try {
        const status = await api<Omit<LoginFlow, "prompt">>(`/v1/logins/${login.id}`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setError(null);
        if (status.state !== "pending") {
          setLogin((current) => (current ? { ...current, ...status } : current));
        } else timer = window.setTimeout(poll, 1000);
      } catch (nextError) {
        if (abort.signal.aborted) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        timer = window.setTimeout(poll, 5000);
      }
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [login?.id, login?.state, onConnected]);

  const choose = (next: Provider) => {
    setProvider(next);
    setAccount(nextAccountKey(sessions, next.id));
    setMode(next.loginModes.includes("browser") ? "browser" : (next.loginModes[0] ?? "device"));
    setFields({});
    setError(null);
  };

  const start = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    const popup = mode === "browser" ? window.open("", "_blank") : null;
    if (popup) popup.opener = null;
    try {
      const next = await api<LoginFlow>(`/v1/auth/${provider.id}/login`, {
        method: "POST",
        body: JSON.stringify({
          account: account.trim(),
          replace:
            replaceExisting && provider.id === initial?.id && account.trim() === initialAccount,
          mode,
          ...fields,
        }),
      });
      setLogin(next);
      const authorizationUri = next.prompt.mode === "browser" ? next.prompt.authorizationUri : null;
      if (popup && authorizationUri) popup.location.href = authorizationUri;
      else popup?.close();
      if (authorizationUri && !popup) window.open(authorizationUri, "_blank", "noopener");
    } catch (nextError) {
      popup?.close();
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const normalizedAccount = account.trim();
  const duplicateAccount = Boolean(
    provider &&
    !(replaceExisting && provider.id === initial?.id && normalizedAccount === initialAccount) &&
    sessions.some(
      (session) =>
        (session.authenticated || session.reauthRequired) &&
        session.provider === provider.id &&
        session.accountKey === normalizedAccount,
    ),
  );
  const missingRequiredField = provider?.loginFields?.some(
    (field) => field.required && !fields[field.name]?.trim(),
  );

  const close = async () => {
    if (busy) return;
    if (login?.state === "pending") {
      setBusy(true);
      try {
        await api(`/v1/logins/${login.id}`, { method: "DELETE" });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        return;
      } finally {
        setBusy(false);
      }
    }
    onClose();
  };

  return (
    <Modal labelledBy="connect-title" onClose={() => void close()}>
      <section className="max-h-[92dvh] w-full max-w-[560px] overflow-y-auto rounded-t-xl border border-zinc-300 bg-white shadow-2xl sm:max-h-[calc(100dvh-48px)] sm:rounded-xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-6 border-b border-zinc-200 p-5 dark:border-zinc-800">
          <div>
            <h2 className="m-0 text-lg tracking-tight" id="connect-title">
              {provider ? `Connect ${provider.name}` : "Add an AI account"}
            </h2>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              {provider
                ? "Choose a local name and complete the provider sign-in."
                : "Select the subscription you want to use."}
            </p>
          </div>
          <button
            className={iconButton}
            type="button"
            disabled={busy}
            onClick={() => void close()}
            aria-label="Close"
          >
            <X {...icon} />
          </button>
        </div>

        {!provider ? (
          <div className="grid gap-2 p-3">
            {providers.map((item) => (
              <button
                className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg border border-transparent bg-transparent p-2.5 text-left transition hover:border-zinc-200 hover:bg-zinc-100 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
                key={item.id}
                type="button"
                onClick={() => choose(item)}
              >
                <span className="grid min-w-0">
                  <strong className="text-[13px]">{item.name}</strong>
                  <small className="truncate text-[11px] text-zinc-600 dark:text-zinc-300">
                    {item.description}
                  </small>
                </span>
                <ChevronRight className="text-zinc-500 dark:text-zinc-400" {...icon} />
              </button>
            ))}
          </div>
        ) : login ? (
          <div className="flex min-h-[390px] flex-col items-center justify-center p-9 text-center">
            <span className="grid size-[58px] place-items-center rounded-xl bg-zinc-100 dark:bg-zinc-800">
              {login.state === "complete" ? <Check size={24} /> : <ExternalLink size={24} />}
            </span>
            <h3 className="mt-[18px] mb-1 text-[19px] tracking-tight">
              {login.state === "complete"
                ? "Account connected"
                : login.state === "failed"
                  ? "Could not connect"
                  : login.state === "cancelled"
                    ? "Sign-in cancelled"
                    : "Finish signing in"}
            </h3>
            {login.state === "pending" && login.prompt.mode === "device" ? (
              <>
                <p className="mb-[18px] max-w-[390px] text-zinc-600 dark:text-zinc-300">
                  Open the provider page and enter this one-time code.
                </p>
                <div className="mb-[18px] flex items-center gap-2">
                  <code className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-lg font-bold tracking-[0.1em] dark:border-zinc-700 dark:bg-zinc-950">
                    {login.prompt.userCode}
                  </code>
                  <CopyButton value={login.prompt.userCode} />
                </div>
                <a
                  className={primaryButton}
                  href={login.prompt.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open provider <ArrowUpRight {...icon} />
                </a>
              </>
            ) : login.state === "pending" ? (
              <p className="mb-[18px] max-w-[390px] text-zinc-600 dark:text-zinc-300">
                Complete the sign-in in the window that opened. This page will update automatically.
              </p>
            ) : null}
            {login.error ? <ErrorBanner>{login.error}</ErrorBanner> : null}
            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
            {login.state === "failed" || login.state === "cancelled" ? (
              <button
                className={primaryButton}
                type="button"
                onClick={() => {
                  setLogin(null);
                  setError(null);
                }}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-[18px] p-5">
            <button
              className="inline-flex w-fit items-center gap-1.5 bg-transparent p-0 text-xs font-semibold text-zinc-600 transition hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50"
              type="button"
              onClick={() => setProvider(null)}
            >
              <ArrowLeft size={16} /> All providers
            </button>
            <label className="grid gap-2">
              <span className="text-xs font-bold">Local account name</span>
              <input
                className="h-10 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-zinc-500 focus:ring-3 focus:ring-zinc-300/50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-400 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                value={account}
                maxLength={128}
                onChange={(event) => setAccount(event.target.value)}
                placeholder="work"
              />
              <small className="text-[11px] text-zinc-600 dark:text-zinc-300">
                Use a short name such as work or personal.
              </small>
              {duplicateAccount ? (
                <small className="text-[11px] text-red-600 dark:text-red-400">
                  That local name is already connected.
                </small>
              ) : null}
            </label>
            {provider.loginModes.length > 1 ? (
              <fieldset className="m-0 grid grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-2">
                <legend className="col-span-full mb-2 text-xs font-bold">Sign-in method</legend>
                {provider.loginModes.map((item) => (
                  <label
                    className="flex items-center gap-2 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-700"
                    key={item}
                  >
                    <input
                      type="radio"
                      name="mode"
                      checked={mode === item}
                      onChange={() => setMode(item)}
                    />
                    <span>{item === "browser" ? "Browser" : "Device code"}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {provider.loginFields?.map((field) => (
              <label className="grid gap-2" key={field.name}>
                <span className="text-xs font-bold">{field.label}</span>
                <input
                  className="h-10 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-zinc-500 focus:ring-3 focus:ring-zinc-300/50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:placeholder:text-zinc-400 dark:focus:border-zinc-500 dark:focus:ring-zinc-700"
                  type={field.type ?? "text"}
                  value={fields[field.name] ?? ""}
                  required={field.required}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
                {field.description ? (
                  <small className="text-[11px] text-zinc-600 dark:text-zinc-300">
                    {field.description}
                  </small>
                ) : null}
              </label>
            ))}
            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
            <button
              className={`${primaryButton} w-full`}
              type="button"
              disabled={busy || !normalizedAccount || duplicateAccount || missingRequiredField}
              onClick={() => void start()}
            >
              {busy ? <RefreshCw className="animate-spin" {...icon} /> : <Link2 {...icon} />}{" "}
              {busy ? "Starting sign-in" : `Connect ${provider.name}`}
            </button>
          </div>
        )}
      </section>
    </Modal>
  );
}
