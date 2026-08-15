import { useCallback, useEffect, useState } from "react";
import { accountRoute, api } from "./lib";
import type { Provider, Session, Theme } from "./types";
import { AppHeader } from "./components/ui";
import { AccountDetails } from "./features/account-details";
import { Dashboard } from "./features/dashboard";

export function App() {
  const [route, setRoute] = useState(accountRoute);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(
    () =>
      (localStorage.getItem("aisubs-theme") as Theme | null) ??
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [providerData, sessionData] = await Promise.all([
        api<{ providers: Provider[] }>("/v1/providers"),
        api<{ sessions: Session[] }>("/v1/auth"),
      ]);
      setProviders(providerData.providers);
      setSessions(sessionData.sessions);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const update = () => setRoute(accountRoute());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("aisubs-theme", theme);
  }, [theme]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="min-h-dvh bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-50">
      <AppHeader theme={theme} onTheme={setTheme} />
      {route ? (
        <AccountDetails
          route={route}
          providers={providers}
          providersLoading={loading}
          refreshAccounts={refresh}
        />
      ) : (
        <Dashboard
          providers={providers}
          sessions={sessions}
          loading={loading}
          error={error}
          refresh={refresh}
        />
      )}
    </div>
  );
}
