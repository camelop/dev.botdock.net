import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Status } from "./api";
import { KeysPage } from "./pages/KeysPage";
import { MachinesPage } from "./pages/MachinesPage";
import { SecretsPage } from "./pages/SecretsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { SessionsPage } from "./pages/SessionsPage";
import { ForwardsPage } from "./pages/ForwardsPage";
import { CreditsPage } from "./pages/CreditsPage";
import { TerminalsPage } from "./pages/TerminalsPage";
import { WarRoomPage } from "./pages/WarRoomPage";

type Tab = "dashboard" | "sessions" | "warroom" | "budgets" | "keys" | "secrets" | "machines" | "forwards" | "terminals";

type NavItem  = { id: Tab; label: string };
type NavGroup = { kind: "group"; label: string; items: NavItem[] };
type NavEntry = NavItem | NavGroup;

const NAV: NavEntry[] = [
  { id: "dashboard", label: "Dashboard" },
  {
    kind: "group",
    label: "Private",
    items: [
      { id: "keys",    label: "Keys" },
      { id: "secrets", label: "Secrets" },
    ],
  },
  {
    kind: "group",
    label: "Machines",
    items: [
      { id: "machines",  label: "Machines" },
      { id: "forwards",  label: "Forwards" },
      { id: "terminals", label: "Terminals" },
    ],
  },
  {
    kind: "group",
    label: "Sessions",
    items: [
      { id: "warroom",  label: "War Room" },
      { id: "sessions", label: "List" },
    ],
  },
  { id: "budgets",  label: "Budgets" },
];

const ALL_TABS: Tab[] = NAV.flatMap((e) =>
  "kind" in e ? e.items.map((i) => i.id) : [e.id],
);

function isNavGroup(e: NavEntry): e is NavGroup {
  return "kind" in e && e.kind === "group";
}

function initialTab(): Tab {
  const h = window.location.hash.slice(1) as Tab;
  return ALL_TABS.includes(h) ? h : "dashboard";
}

export function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string>("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.status().then(setStatus).catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  // Click outside the nav closes any open dropdown.
  useEffect(() => {
    if (!openGroup) return;
    const onClick = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenGroup(null); };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [openGroup]);

  const activeByGroup = useMemo(() => {
    const map: Record<string, Tab | undefined> = {};
    for (const e of NAV) {
      if (isNavGroup(e)) {
        const hit = e.items.find((i) => i.id === tab);
        if (hit) map[e.label] = hit.id;
      }
    }
    return map;
  }, [tab]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <BotdockLogo />
          <span>BotDock</span>
        </div>
        <div className="tabs" ref={navRef}>
          {NAV.map((entry) => {
            if (isNavGroup(entry)) {
              const isOpen = openGroup === entry.label;
              const groupActive = entry.items.some((i) => i.id === tab);
              return (
                <div key={entry.label} className="dropdown-wrap">
                  <div
                    className={`tab ${groupActive ? "active" : ""}`}
                    onClick={() => setOpenGroup(isOpen ? null : entry.label)}
                  >
                    {entry.label}
                    <span className="chev">▾</span>
                  </div>
                  {isOpen && (
                    <div className="dropdown">
                      {entry.items.map((item) => (
                        <div
                          key={item.id}
                          className={`dropdown-item ${tab === item.id ? "active" : ""}`}
                          onClick={() => { setTab(item.id); setOpenGroup(null); }}
                        >
                          {item.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div
                key={entry.id}
                className={`tab ${tab === entry.id ? "active" : ""}`}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </div>
            );
          })}
        </div>
        <div className="spacer" />
        <div className="status">
          {status ? `${status.home}${status.dev ? " · dev" : ""}` : err ? "offline" : "…"}
        </div>
      </div>
      <div className="main">
        {err && <div className="error-banner">connection error: {err}</div>}
        {tab === "dashboard" && <DashboardPage />}
        {tab === "warroom" && <WarRoomPage />}
        {tab === "sessions" && <SessionsPage />}
        {tab === "budgets" && <CreditsPage />}
        {tab === "keys" && <KeysPage />}
        {tab === "secrets" && <SecretsPage />}
        {tab === "machines" && <MachinesPage />}
        {tab === "forwards" && <ForwardsPage />}
        {tab === "terminals" && <TerminalsPage />}
      </div>
    </div>
  );
}

/**
 * Minimal "ladder of bars" mark — loose nod to stacked agent slots being
 * docked. Uses the accent color so it picks up the dark theme.
 */
function BotdockLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3"  y="13" width="4" height="8"  rx="1" fill="var(--accent)" opacity="0.55" />
      <rect x="10" y="9"  width="4" height="12" rx="1" fill="var(--accent)" opacity="0.8" />
      <rect x="17" y="4"  width="4" height="17" rx="1" fill="var(--accent)" />
    </svg>
  );
}
