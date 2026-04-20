import { useEffect, useState } from "react";
import { forwardsApi, type ForwardWithStatus } from "../api";

const TERMINAL_MANAGED_BY = "system:machine-terminal";

export function TerminalsPage() {
  const [forwards, setForwards] = useState<ForwardWithStatus[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [zoomed, setZoomed] = useState(false);
  const [err, setErr] = useState("");

  const refresh = () =>
    forwardsApi.list().then(setForwards).catch((e) => setErr(String(e?.message ?? e)));

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  // Only running system-managed terminals are visible here.
  const terminals = forwards.filter(
    (f) => f.managed_by === TERMINAL_MANAGED_BY && f.status.state === "running",
  );
  const aliveNames = new Set(terminals.map((t) => t.machine));

  // If a terminal goes away (forward stopped / removed), drop it from the
  // connected set so we don't try to keep a dead iframe mounted.
  useEffect(() => {
    setConnected((prev) => {
      const next = new Set<string>();
      for (const n of prev) if (aliveNames.has(n)) next.add(n);
      return next.size === prev.size ? prev : next;
    });
  }, [Array.from(aliveNames).sort().join("|")]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Pick a sensible default tab when the list changes — but do NOT
  // auto-connect. The user must click Connect explicitly.
  useEffect(() => {
    if (terminals.length === 0) { setActive(null); return; }
    if (!active || !aliveNames.has(active)) setActive(terminals[0]!.machine);
  }, [terminals.map((t) => t.machine).join("|")]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Esc to exit zoom.
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoomed(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  const activeForward = terminals.find((t) => t.machine === active);
  const activeConnected = active ? connected.has(active) : false;

  const connect    = (name: string) => setConnected((prev) => new Set([...prev, name]));
  const disconnect = (name: string) => setConnected((prev) => {
    const next = new Set(prev); next.delete(name); return next;
  });

  return (
    <div>
      {!zoomed && (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h1 style={{ margin: 0 }}>Terminals</h1>
            {activeForward && (
              <div className="row" style={{ gap: 6 }}>
                {!activeConnected && (
                  <button onClick={() => connect(activeForward.machine)} title="Load the ttyd iframe for this machine">
                    Connect
                  </button>
                )}
                {activeConnected && (
                  <button className="secondary" onClick={() => disconnect(activeForward.machine)}
                    title="Unmount this terminal's iframe (closes its WebSocket)">
                    Disconnect
                  </button>
                )}
                <a
                  href={`/api/machines/${encodeURIComponent(activeForward.machine)}/terminal/`}
                  target="_blank"
                  rel="noreferrer"
                  className="secondary"
                  style={{
                    padding: "6px 14px", borderRadius: 6, textDecoration: "none",
                    background: "#323844", color: "var(--fg)",
                    border: "1px solid #3f4754", fontSize: 13,
                  }}
                  title="Open this terminal in a new browser tab"
                >↗ New tab</a>
                <button className="secondary" onClick={() => setZoomed(true)} title="Expand to full screen (Esc to exit)">
                  ⛶ Full screen
                </button>
              </div>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Tabs stay dormant until you click <span className="mono">Connect</span> — keeps the browser
            from opening every machine's WebSocket at once. Disconnect an active tab with the button above.
          </div>
          {err && <div className="error-banner">{err}</div>}
        </>
      )}

      {terminals.length === 0 ? (
        <div className="card">
          <div className="empty">
            No running terminals yet. Go to Machines and click "Start" on a row.
          </div>
        </div>
      ) : (
        <div style={zoomed ? zoomStyle : normalStyle}>
          {/* Tab strip */}
          <div
            className="row scroll-panel"
            style={{
              gap: 0, overflowY: "hidden", overflowX: "auto",
              background: "var(--bg-elev)",
              borderBottom: "1px solid var(--border)",
              alignItems: "stretch",
            }}
          >
            {terminals.map((t) => {
              const isActive = t.machine === active;
              const isConnected = connected.has(t.machine);
              return (
                <div
                  key={t.machine}
                  onClick={() => setActive(t.machine)}
                  style={{
                    padding: "8px 16px",
                    cursor: "pointer",
                    color: isActive ? "var(--fg)" : "var(--fg-dim)",
                    background: isActive ? "#0a0c10" : "transparent",
                    borderRight: "1px solid var(--border)",
                    borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                  title={isConnected ? "connected" : "not connected"}
                >
                  <span style={{
                    display: "inline-block",
                    width: 6, height: 6, borderRadius: 3,
                    background: isConnected ? "var(--ok)" : "#4a5160",
                  }} />
                  {t.machine}
                </div>
              );
            })}
            {zoomed && (
              <div style={{ flex: 1 }} />
            )}
            {zoomed && (
              <button
                className="secondary"
                onClick={() => setZoomed(false)}
                style={{ margin: 6 }}
                title="Exit full screen (Esc)"
              >× Exit full screen</button>
            )}
          </div>

          {/* Iframe / connect prompt. Mounted iframes persist across tab
              switches (display:none when inactive) so their WS stays open
              and tmux scrollback is preserved. Non-connected tabs render a
              dim placeholder instead. */}
          <div style={{ flex: 1, background: "#0a0c10", position: "relative" }}>
            {terminals.map((t) => {
              const isActive = t.machine === active;
              const isConnected = connected.has(t.machine);
              if (!isConnected) {
                // Only render the placeholder when THIS tab is active —
                // inactive non-connected tabs don't need any DOM at all.
                if (!isActive) return null;
                return (
                  <div
                    key={t.machine}
                    style={{
                      position: "absolute", inset: 0,
                      display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center",
                      gap: 14,
                      color: "#4a5160",
                    }}
                  >
                    <div style={{ fontSize: 14, color: "#6b7588" }}>
                      Terminal for <span className="mono" style={{ color: "#9aa0a6" }}>{t.machine}</span> isn't connected.
                    </div>
                    <button onClick={() => connect(t.machine)}>Connect</button>
                  </div>
                );
              }
              return (
                <iframe
                  key={t.machine}
                  title={`terminal-${t.machine}`}
                  src={`/api/machines/${encodeURIComponent(t.machine)}/terminal/`}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    border: "none",
                    display: isActive ? "block" : "none",
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const normalStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // Leaves room for topbar + page heading + hint row.
  height: "calc(100vh - 200px)",
  minHeight: 360,
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
  background: "var(--bg-card)",
};

const zoomStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  background: "#0a0c10",
};
