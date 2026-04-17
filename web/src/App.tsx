import { useEffect, useState } from "react";
import { api, type Status } from "./api";
import { KeysPage } from "./pages/KeysPage";
import { MachinesPage } from "./pages/MachinesPage";
import { SecretsPage } from "./pages/SecretsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { SessionsPage } from "./pages/SessionsPage";

type Tab = "dashboard" | "sessions" | "keys" | "machines" | "secrets";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "sessions", label: "Sessions" },
  { id: "keys", label: "Keys" },
  { id: "machines", label: "Machines" },
  { id: "secrets", label: "Secrets" },
];

function initialTab(): Tab {
  const h = window.location.hash.slice(1) as Tab;
  return (TABS.find((t) => t.id === h)?.id) ?? "dashboard";
}

export function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    api.status().then(setStatus).catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">BotDock</div>
        <div className="tabs">
          {TABS.map((t) => (
            <div
              key={t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </div>
          ))}
        </div>
        <div className="spacer" />
        <div className="status">
          {status ? `${status.home}${status.dev ? " · dev" : ""}` : err ? "offline" : "…"}
        </div>
      </div>
      <div className="main">
        {err && <div className="error-banner">connection error: {err}</div>}
        {tab === "dashboard" && <DashboardPage />}
        {tab === "sessions" && <SessionsPage />}
        {tab === "keys" && <KeysPage />}
        {tab === "machines" && <MachinesPage />}
        {tab === "secrets" && <SecretsPage />}
      </div>
    </div>
  );
}
