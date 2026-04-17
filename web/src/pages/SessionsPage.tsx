import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  sessionWatchUrl,
  type Machine,
  type Session,
  type SessionEventRecord,
  type SessionStatus,
} from "../api";
import { Modal } from "../components/Modal";

export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [machines, setMachines] = useState<Machine[]>([]);

  const refresh = async () => {
    try {
      setSessions(await api.listSessions());
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  useEffect(() => { refresh(); api.listMachines().then(setMachines).catch(() => {}); }, []);
  // Background refresh of the list status badges.
  useEffect(() => {
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Sessions</h1>
        <button onClick={() => setNewOpen(true)} disabled={machines.length === 0}>
          {machines.length === 0 ? "Add a machine first" : "New session"}
        </button>
      </div>
      {err && <div className="error-banner">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        {sessions.length === 0 ? (
          <div className="empty">No sessions yet. Create one to launch on a machine.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Machine</th>
                <th>Cmd</th>
                <th>Started</th>
                <th>Exit</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setSelected(s.id)}>
                  <td className="mono">{s.id}</td>
                  <td><StatusPill status={s.status} /></td>
                  <td>{s.machine}</td>
                  <td className="mono" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.cmd}</td>
                  <td className="muted">{s.started_at ? new Date(s.started_at).toLocaleTimeString() : "—"}</td>
                  <td className="mono">{s.exit_code ?? (s.status === "running" ? "…" : "—")}</td>
                  <td>
                    <button className="secondary" onClick={(e) => { e.stopPropagation(); setSelected(s.id); }}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newOpen && (
        <NewSessionModal
          machines={machines}
          onClose={() => setNewOpen(false)}
          onDone={async (id) => { setNewOpen(false); await refresh(); setSelected(id); }}
        />
      )}
      {selected && (
        <SessionDetailModal
          id={selected}
          onClose={() => setSelected(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: SessionStatus }) {
  const cls = status === "running" ? "ok" : status === "exited" ? "" : status === "failed_to_start" ? "err" : "warn";
  return <span className={`pill ${cls}`}>{status}</span>;
}

function NewSessionModal(props: {
  machines: Machine[];
  onClose: () => void;
  onDone: (id: string) => void | Promise<void>;
}) {
  const [machine, setMachine] = useState(props.machines[0]?.name ?? "");
  const [workdir, setWorkdir] = useState("~/botdock-session");
  const [cmd, setCmd] = useState('echo "hello from BotDock"; sleep 1; date');
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      const s = await api.createSession({
        machine,
        workdir,
        agent_kind: "generic-cmd",
        cmd,
      });
      await props.onDone(s.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New session" onClose={props.onClose}>
      <label>
        <span>Machine</span>
        <select value={machine} onChange={(e) => setMachine(e.target.value)}>
          {props.machines.map((m) => <option key={m.name} value={m.name}>{m.name} — {m.user}@{m.host}</option>)}
        </select>
      </label>
      <label>
        <span>Working directory (absolute, on the machine)</span>
        <input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/home/…" />
      </label>
      <label>
        <span>Command</span>
        <textarea rows={4} value={cmd} onChange={(e) => setCmd(e.target.value)} />
      </label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        The command runs inside a tmux session. BotDock will mirror stdout / stderr and lifecycle events back.
      </div>
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button disabled={submitting || !machine || !workdir || !cmd} onClick={submit}>Create &amp; launch</button>
      </div>
    </Modal>
  );
}

function SessionDetailModal(props: {
  id: string;
  onClose: () => void;
  onChange: () => void | Promise<void>;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEventRecord[]>([]);
  const [rawText, setRawText] = useState("");
  const [err, setErr] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Initial load.
  useEffect(() => {
    api.getSession(props.id).then(setSession).catch((e) => setErr(String(e.message ?? e)));
    api.getSessionEvents(props.id).then((r) => setEvents(r.records)).catch(() => {});
    api.getSessionRaw(props.id).then((r) => setRawText(r.data)).catch(() => {});
  }, [props.id]);

  // WebSocket subscription.
  useEffect(() => {
    const ws = new WebSocket(sessionWatchUrl(props.id));
    wsRef.current = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.type === "events") {
        setEvents((cur) => [...cur, ...m.records]);
        // Refresh session meta for status flips.
        api.getSession(props.id).then(setSession).catch(() => {});
      } else if (m.type === "raw") {
        setRawText((cur) => cur + m.data);
      }
    });
    ws.addEventListener("error", () => setErr("websocket error"));
    return () => ws.close();
  }, [props.id]);

  // Auto-scroll raw log to bottom on append.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rawText]);

  const onStop = async () => {
    if (!confirm("Stop this session?")) return;
    try {
      const s = await api.stopSession(props.id);
      setSession(s);
      await props.onChange();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  const onDelete = async () => {
    if (!confirm("Delete this session (files and all)?")) return;
    try {
      await api.deleteSession(props.id);
      await props.onChange();
      props.onClose();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" style={{ minWidth: 800, maxWidth: 1100 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>Session {props.id}</h2>
            {session && (
              <div className="mono muted" style={{ fontSize: 12 }}>
                <StatusPill status={session.status} />{" "}
                {session.machine} · {session.workdir}
              </div>
            )}
          </div>
          <div className="actions">
            {session?.status === "running" && <button className="secondary" onClick={onStop}>Stop</button>}
            {session && session.status !== "running" && session.status !== "provisioning" && (
              <button className="secondary" onClick={onDelete}>Delete</button>
            )}
            <button className="secondary" onClick={props.onClose}>Close</button>
          </div>
        </div>

        {err && <div className="error-banner">{err}</div>}
        {session && <Meta s={session} />}

        <h2>Live log</h2>
        <div
          ref={logRef}
          className="mono"
          style={{
            background: "#0a0c10",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 10,
            height: 260,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            fontSize: 12,
          }}
        >
          <AnsiText text={rawText} />
          {session?.status === "running" && (
            <span className="pill ok" style={{ fontSize: 10, marginTop: 8, display: "inline-block" }}>streaming</span>
          )}
        </div>

        <h2>Events</h2>
        <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
          <table className="table" style={{ fontSize: 11.5 }}>
            <tbody>
              {events.map((ev, i) => (
                <tr key={i}>
                  <td className="muted" style={{ whiteSpace: "nowrap", width: 170 }}>{ev.ts}</td>
                  <td><span className="pill">{ev.kind}</span></td>
                  <td className="mono">{renderEventPayload(ev)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Meta({ s }: { s: Session }) {
  const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");
  return (
    <div className="card" style={{ padding: 12, fontSize: 12.5 }}>
      <Row k="cmd"><span className="mono">{s.cmd}</span></Row>
      <Row k="tmux"><span className="mono">{s.tmux_session}</span></Row>
      <Row k="created">{fmt(s.created_at)}</Row>
      <Row k="started">{fmt(s.started_at)}</Row>
      <Row k="exited">{fmt(s.exited_at)}{s.exit_code !== undefined ? ` (code ${s.exit_code})` : ""}</Row>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 12, marginBottom: 2 }}>
      <span className="muted" style={{ width: 64, fontSize: 11, textTransform: "uppercase" }}>{k}</span>
      <span>{children}</span>
    </div>
  );
}

function renderEventPayload(ev: SessionEventRecord): string {
  const { ts: _ts, kind: _kind, ...rest } = ev;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rest)) {
    if (k === "source") continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join("  ");
}

/**
 * Minimal ANSI stripper so terminal color codes don't render as garbage.
 * This doesn't interpret them — just filters them out. Good enough for M2.
 */
function AnsiText({ text }: { text: string }) {
  const cleaned = useMemo(() => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\[\?[0-9]+[hl]/g, ""), [text]);
  return <>{cleaned}</>;
}
