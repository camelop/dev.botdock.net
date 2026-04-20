import { useEffect, useMemo, useState } from "react";
import {
  forwardsApi,
  api,
  type Forward,
  type ForwardDirection,
  type ForwardState,
  type ForwardWithStatus,
  type Machine,
} from "../api";
import { Modal } from "../components/Modal";

export function ForwardsPage() {
  const [forwards, setForwards] = useState<ForwardWithStatus[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<{ mode: "new" } | { mode: "edit"; name: string } | null>(null);
  const [embedded, setEmbedded] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [fs, ms] = await Promise.all([forwardsApi.list(), api.listMachines()]);
      setForwards(fs); setMachines(ms);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  const onStart = async (name: string) => {
    try { await forwardsApi.start(name); await refresh(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  const onStop = async (name: string) => {
    try { await forwardsApi.stop(name); await refresh(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  const onDelete = async (name: string) => {
    if (!confirm(`Delete forward "${name}"?`)) return;
    try { await forwardsApi.remove(name); await refresh(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  const { userForwards, systemForwards } = useMemo(() => {
    const user: ForwardWithStatus[] = [];
    const sys:  ForwardWithStatus[] = [];
    for (const f of forwards) {
      if (f.managed_by && f.managed_by.startsWith("system:")) sys.push(f);
      else user.push(f);
    }
    return { userForwards: user, systemForwards: sys };
  }, [forwards]);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Forwards</h1>
        <button onClick={() => setEdit({ mode: "new" })} disabled={machines.length === 0}>
          {machines.length === 0 ? "Add a machine first" : "New forward"}
        </button>
      </div>
      {err && <div className="error-banner">{err}</div>}

      <ForwardSection
        title="User forwards"
        hint="Forwards you create yourself."
        forwards={userForwards}
        onStart={onStart} onStop={onStop} onDelete={onDelete}
        onEdit={(name) => setEdit({ mode: "edit", name })}
        onEmbed={(name) => setEmbedded(name)}
        emptyHint="No user forwards yet. Local, reverse, and dynamic (SOCKS) SSH tunnels can be managed here."
        readOnlyActions={false}
      />

      <ForwardSection
        title="Managed by BotDock"
        hint="Forwards auto-created by features like per-machine terminals. These are reconciled by the system — edit the owning feature rather than these directly."
        forwards={systemForwards}
        onStart={onStart} onStop={onStop} onDelete={onDelete}
        onEdit={(name) => setEdit({ mode: "edit", name })}
        onEmbed={() => undefined}  // system forwards aren't meant to be surface-browsed
        emptyHint="No system-managed forwards yet. Start a terminal from the Machines page to spawn one."
        readOnlyActions={true}
      />

      {edit && (
        <ForwardEditor
          target={edit}
          machines={machines}
          onClose={() => setEdit(null)}
          onDone={async () => { setEdit(null); await refresh(); }}
        />
      )}
      {embedded && (
        <EmbedOverlay name={embedded} onClose={() => setEmbedded(null)} />
      )}
    </div>
  );
}

function EmbedOverlay({ name, onClose }: { name: string; onClose: () => void }) {
  const url = `/api/forwards/${encodeURIComponent(name)}/proxy/`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "#0a0c10",
        display: "flex", flexDirection: "column",
      }}
    >
      <div
        className="row"
        style={{
          padding: "6px 10px",
          background: "var(--bg-elev)",
          borderBottom: "1px solid var(--border)",
          gap: 8,
        }}
      >
        <span className="mono" style={{ fontSize: 13 }}>{name}</span>
        <span className="muted" style={{ fontSize: 12 }}>proxied through /api/forwards/{name}/proxy</span>
        <div style={{ flex: 1 }} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="secondary"
          style={{
            padding: "4px 10px", fontSize: 12, borderRadius: 6, textDecoration: "none",
            background: "#323844", color: "var(--fg)", border: "1px solid #3f4754",
          }}
        >↗ New tab</a>
        <button className="secondary" onClick={onClose} title="Exit (Esc)">× Exit</button>
      </div>
      <iframe
        title={`proxy-${name}`}
        src={url}
        style={{ flex: 1, border: "none", width: "100%" }}
      />
    </div>
  );
}

type ForwardActionHandlers = {
  onStart: (name: string) => void | Promise<void>;
  onStop: (name: string) => void | Promise<void>;
  onDelete: (name: string) => void | Promise<void>;
  onEdit: (name: string) => void;
  onEmbed: (name: string) => void;
};

function ForwardSection(props: ForwardActionHandlers & {
  title: string;
  hint: string;
  forwards: ForwardWithStatus[];
  emptyHint: string;
  readOnlyActions: boolean;
}) {
  const [showError, setShowError] = useState<{ name: string; error: string } | null>(null);
  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ marginBottom: 4, color: "var(--fg)" }}>{props.title}</h2>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{props.hint}</div>
      <div className="card" style={{ padding: 0 }}>
        {props.forwards.length === 0 ? (
          <div className="empty">{props.emptyHint}</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>State</th>
                <th>Shape</th>
                <th>Auto-start</th>
                <th style={{ width: 280 }}></th>
              </tr>
            </thead>
            <tbody>
              {props.forwards.map((f) => (
                <tr key={f.name}>
                  <td>
                    {f.name}
                    {f.managed_by && <span className="pill" style={{ marginLeft: 6, fontSize: 10 }}>{f.managed_by}</span>}
                    {f.description && <div className="muted" style={{ fontSize: 11 }}>{f.description}</div>}
                  </td>
                  <td>
                    <StatePill state={f.status.state} />
                    {(f.status.last_error || f.status.state === "failed") && (
                      <button
                        className="secondary"
                        style={{ padding: "2px 8px", fontSize: 11, marginLeft: 4 }}
                        onClick={() => setShowError({
                          name: f.name,
                          error: f.status.last_error
                            || `State is "failed" but no error was captured. exit_code=${f.status.exit_code ?? "null"} signal=${f.status.exit_signal ?? "null"}. argv: ssh ${(f.status.last_args ?? []).join(" ")}`,
                        })}
                      >{f.status.last_error ? "view error" : "details"}</button>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{f.description_line}</td>
                  <td>{f.auto_start ? <span className="pill">on boot</span> : <span className="muted">no</span>}</td>
                  <td>
                    <div className="actions">
                      {f.status.state !== "running" && f.status.state !== "starting" && (
                        <button className="secondary" onClick={() => props.onStart(f.name)}>Start</button>
                      )}
                      {(f.status.state === "running" || f.status.state === "starting") && (
                        <button className="secondary" onClick={() => props.onStop(f.name)}>Stop</button>
                      )}
                      {/* Web proxy controls for user local (-L) forwards that are live. */}
                      {!props.readOnlyActions && f.direction === "local" && f.status.state === "running" && (
                        <>
                          <a
                            href={`/api/forwards/${encodeURIComponent(f.name)}/proxy/`}
                            target="_blank"
                            rel="noreferrer"
                            className="secondary"
                            style={{
                              padding: "6px 14px", borderRadius: 6, textDecoration: "none",
                              background: "#323844", color: "var(--fg)",
                              border: "1px solid #3f4754", fontSize: 13,
                              display: "inline-flex", alignItems: "center",
                            }}
                            title="Open the forwarded service in a new browser tab, via BotDock's web proxy"
                          >↗ Open</a>
                          <button
                            className="secondary"
                            onClick={() => props.onEmbed(f.name)}
                            title="Embed the forwarded service in a full-screen iframe inside BotDock"
                          >⛶ Embed</button>
                        </>
                      )}
                      {!props.readOnlyActions && (
                        <>
                          <button className="secondary" onClick={() => props.onEdit(f.name)}>Edit</button>
                          <button className="secondary" onClick={() => props.onDelete(f.name)}>Delete</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showError && (
        <Modal title={`Error: ${showError.name}`} onClose={() => setShowError(null)}>
          <pre className="code scroll-panel" style={{ maxHeight: 300 }}>{showError.error}</pre>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={() => setShowError(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function StatePill({ state }: { state: ForwardState }) {
  const cls = state === "running" ? "ok"
    : state === "failed" ? "err"
    : state === "starting" ? "warn"
    : "";
  const label = state === "idle" ? "not started" : state;
  return <span className={`pill ${cls}`}>{label}</span>;
}

function blank(machines: Machine[]): Forward {
  return {
    name: "",
    machine: machines[0]?.name ?? "",
    direction: "local",
    local_port: 8080,
    remote_host: "localhost",
    remote_port: 80,
    auto_start: false,
  };
}

function ForwardEditor(props: {
  target: { mode: "new" } | { mode: "edit"; name: string };
  machines: Machine[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const isNew = props.target.mode === "new";
  const [f, setF] = useState<Forward>(blank(props.machines));
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isNew) {
      forwardsApi.get((props.target as { name: string }).name).then(setF).catch((e) => setErr(String(e.message ?? e)));
    }
  }, []);

  const patch = <K extends keyof Forward>(k: K, v: Forward[K]) => setF((cur) => ({ ...cur, [k]: v }));

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      if (isNew) await forwardsApi.create(f);
      else await forwardsApi.update(f.name, f);
      await props.onDone();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setSubmitting(false); }
  };

  return (
    <Modal title={isNew ? "New forward" : `Edit: ${f.name}`} onClose={props.onClose}>
      <label>
        <span>Name</span>
        <input value={f.name} disabled={!isNew} onChange={(e) => patch("name", e.target.value)} autoFocus />
      </label>
      <label>
        <span>Machine</span>
        <select value={f.machine} onChange={(e) => patch("machine", e.target.value)}>
          {props.machines.map((m) => <option key={m.name} value={m.name}>{m.name} — {m.user}@{m.host}</option>)}
        </select>
      </label>
      <label>
        <span>Direction</span>
        <select value={f.direction} onChange={(e) => patch("direction", e.target.value as ForwardDirection)}>
          <option value="local">Local (-L)  — local port → remote host:port</option>
          <option value="remote">Remote (-R) — remote port → local host:port</option>
          <option value="dynamic">Dynamic (-D) — SOCKS proxy on local port</option>
        </select>
      </label>

      {f.direction === "local" && (
        <>
          <div className="row" style={{ gap: 10 }}>
            <label className="grow">
              <span>Local port</span>
              <input type="number" value={f.local_port}
                onChange={(e) => patch("local_port", Number(e.target.value))} />
            </label>
            <label className="grow">
              <span>Remote host</span>
              <input value={f.remote_host ?? ""} onChange={(e) => patch("remote_host", e.target.value)} />
            </label>
            <label style={{ width: 120 }}>
              <span>Remote port</span>
              <input type="number" value={f.remote_port ?? 0}
                onChange={(e) => patch("remote_port", Number(e.target.value))} />
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Clients on your basedock connecting to <span className="mono">localhost:{f.local_port || "?"}</span> will
            reach <span className="mono">{f.remote_host || "?"}:{f.remote_port || "?"}</span> as seen from {f.machine}.
          </div>
        </>
      )}

      {f.direction === "remote" && (
        <>
          <div className="row" style={{ gap: 10 }}>
            <label style={{ width: 140 }}>
              <span>Remote port</span>
              <input type="number" value={f.local_port}
                onChange={(e) => patch("local_port", Number(e.target.value))} />
            </label>
            <label className="grow">
              <span>Local host</span>
              <input value={f.local_host ?? "localhost"} onChange={(e) => patch("local_host", e.target.value)} />
            </label>
            <label style={{ width: 140 }}>
              <span>Local port (target)</span>
              <input type="number" value={f.remote_port ?? 0}
                onChange={(e) => patch("remote_port", Number(e.target.value))} />
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            On {f.machine}, <span className="mono">localhost:{f.local_port}</span> will tunnel back to
            <span className="mono"> {f.local_host || "localhost"}:{f.remote_port || "?"}</span> on your basedock.
          </div>
        </>
      )}

      {f.direction === "dynamic" && (
        <>
          <label style={{ maxWidth: 160 }}>
            <span>Local port (SOCKS)</span>
            <input type="number" value={f.local_port}
              onChange={(e) => patch("local_port", Number(e.target.value))} />
          </label>
          <div className="muted" style={{ fontSize: 12 }}>
            Point your SOCKS5 client at <span className="mono">localhost:{f.local_port}</span> to route traffic through {f.machine}.
          </div>
        </>
      )}

      <label className="row" style={{ gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={!!f.auto_start}
          onChange={(e) => patch("auto_start", e.target.checked)} style={{ width: "auto" }} />
        <span style={{ marginBottom: 0 }}>Auto-start with BotDock</span>
      </label>
      <label>
        <span>Description (optional)</span>
        <input value={f.description ?? ""} onChange={(e) => patch("description", e.target.value)} />
      </label>

      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button disabled={submitting || !f.name || !f.machine} onClick={submit}>
          {isNew ? "Create" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
