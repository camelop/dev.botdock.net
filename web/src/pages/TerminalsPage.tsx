import { useEffect, useState } from "react";
import { forwardsApi, type ForwardWithStatus } from "../api";

const TERMINAL_MANAGED_BY = "system:machine-terminal";

/**
 * Embedded terminals section. Renders nothing when no machine has a
 * running system:machine-terminal forward, so it's safe to drop at the
 * top of the Machines page without creating empty vertical space on
 * fresh setups.
 */
export function TerminalsSection() {
  return <TerminalsImpl heading="h2" />;
}

/** Full page version, if/when we want a standalone route again. */
export function TerminalsPage() {
  return <TerminalsImpl heading="h1" />;
}

function TerminalsImpl({ heading: Heading }: { heading: "h1" | "h2" }) {
  const [forwards, setForwards] = useState<ForwardWithStatus[]>([]);
  const [active, setActive] = useState<string | null>(null);
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

  // Pick a sensible default when the list changes.
  useEffect(() => {
    if (terminals.length === 0) { setActive(null); return; }
    if (!active || !terminals.some((t) => t.machine === active)) {
      setActive(terminals[0]!.machine);
    }
  }, [terminals.map((t) => t.machine).join("|")]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Esc to exit zoom.
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoomed(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  const activeForward = terminals.find((t) => t.machine === active);

  // When embedded, skip the whole block if nothing is running.
  if (terminals.length === 0 && Heading === "h2") return null;

  return (
    <div style={{ marginBottom: Heading === "h2" ? 24 : 0 }}>
      {!zoomed && (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <Heading style={{ margin: 0 }}>Terminals</Heading>
            {activeForward && (
              <div className="row" style={{ gap: 6 }}>
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
                <button className="secondary" onClick={() => setZoomed(true)} title="Expand to full-screen (Esc to exit)">
                  ⛶ Full screen
                </button>
              </div>
            )}
          </div>
          {err && <div className="error-banner">{err}</div>}
        </>
      )}

      {terminals.length === 0 ? (
        <div className="card">
          <div className="empty">
            No running terminals yet. Click "Start" on a machine below.
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
                  }}
                >
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
                title="Exit zoom (Esc)"
              >× Exit zoom</button>
            )}
          </div>

          {/* Iframe stack — all mounted, only active visible, so switching
              tabs doesn't drop the ws session. */}
          <div style={{ flex: 1, background: "#0a0c10", position: "relative" }}>
            {terminals.map((t) => {
              const isActive = t.machine === active;
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
  // 180px accounts for topbar + page heading + padding; tweak if the chrome changes.
  height: "calc(100vh - 180px)",
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
