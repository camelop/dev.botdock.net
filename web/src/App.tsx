import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Status } from "./api";
import { KeysPage } from "./pages/KeysPage";
import { MachinesPage } from "./pages/MachinesPage";
import { SecretsPage } from "./pages/SecretsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { SessionsPage } from "./pages/SessionsPage";
import { SessionHubPage } from "./pages/SessionHubPage";
import { ForwardsPage } from "./pages/ForwardsPage";
import { CreditsPage } from "./pages/CreditsPage";
import { TerminalsPage } from "./pages/TerminalsPage";
import { WarRoomPage } from "./pages/WarRoomPage";

type Tab = "dashboard" | "sessions" | "hub" | "warroom" | "budgets" | "keys" | "secrets" | "machines" | "forwards" | "terminals";

type NavItem  = { id: Tab; label: string };
type NavGroup = { kind: "group"; label: string; items: NavItem[] };
type NavEntry = NavItem | NavGroup;

const NAV: NavEntry[] = [
  { id: "dashboard", label: "Dashboard" },
  {
    kind: "group",
    label: "Sessions",
    items: [
      { id: "hub",      label: "Workspace" },
      { id: "warroom",  label: "Card view" },
      { id: "sessions", label: "List view" },
    ],
  },
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
  // Budgets: temporarily disabled until the Anthropic cost-report integration
  // is hardened. Re-enable by uncommenting this entry and restoring the
  // {tab === "budgets" && <CreditsPage />} line below.
  // { id: "budgets",  label: "Budgets" },
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
  const [serverDown, setServerDown] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const firstInstanceId = useRef<string | null>(null);

  // Poll /api/status so we can (a) notice a daemon restart and force the
  // page to reload (new instance_id ⇒ every cached WS / in-flight fetch is
  // stale) and (b) surface a banner when the daemon is unreachable. Without
  // this the UI quietly hangs onto dead websockets after `botdock serve`
  // restarts.
  useEffect(() => {
    let cancelled = false;
    let failures = 0;
    const tick = async () => {
      try {
        const s = await api.status();
        if (cancelled) return;
        if (firstInstanceId.current === null) {
          firstInstanceId.current = s.instance_id;
        } else if (s.instance_id && s.instance_id !== firstInstanceId.current) {
          // Backend restarted — hard reload so every consumer re-initializes.
          window.location.reload();
          return;
        }
        failures = 0;
        setStatus(s);
        setErr("");
        setServerDown(false);
      } catch (e) {
        if (cancelled) return;
        failures += 1;
        if (failures >= 2) setServerDown(true);
        setErr(String((e as Error)?.message ?? e));
      }
    };
    tick();
    const h = window.setInterval(tick, 4000);
    return () => { cancelled = true; window.clearInterval(h); };
  }, []);

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  // React to external hash changes — e.g. the session modal's "Open in
  // workspace" button that navigates via `location.hash = "hub"`. Without
  // this listener the address bar would update but the active tab wouldn't.
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1) as Tab;
      if (ALL_TABS.includes(h) && h !== tab) setTab(h);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
      {serverDown && <ServerDownOverlay />}
      <div className="topbar">
        <a
          className="brand"
          href="https://github.com/camelop/dev.botdock.net"
          target="_blank"
          rel="noreferrer"
          title="View BotDock on GitHub"
          style={{ color: "inherit", textDecoration: "none" }}
        >
          <BotdockLogo />
          <span>BotDock</span>
        </a>
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
      <div className={`main ${tab === "hub" ? "main-wide" : ""}`}>
        {err && <div className="error-banner">connection error: {err}</div>}
        {tab === "dashboard" && <DashboardPage />}
        {tab === "warroom" && <WarRoomPage />}
        {tab === "hub" && <SessionHubPage />}
        {tab === "sessions" && <SessionsPage />}
        {/* {tab === "budgets" && <CreditsPage />} */}
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
/**
 * Full-viewport blocker shown when the daemon is unreachable (two failed
 * /api/status polls in a row). Any UI underneath is likely to be operating
 * on stale state — dead websockets, half-finished fetches — so we don't want
 * the user clicking around. A reload button covers the usual fix.
 */
function ServerDownOverlay() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "24px 28px",
          maxWidth: 460,
          textAlign: "center",
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--fg)" }}>
          BotDock daemon unreachable
        </h2>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
          The local server stopped responding. Any live sessions are still
          running on their remote machines — this browser tab has just lost
          its pipe to the daemon. Start BotDock again and reload to
          reconnect.
        </div>
        <button onClick={() => window.location.reload()}>↻ Reload page</button>
      </div>
    </div>
  );
}

function BotdockLogo() {
  return (
    <img
      src="/logo.png"
      alt="BotDock"
      width={32}
      height={32}
      style={{ display: "block", borderRadius: 6 }}
    />
  );
}
