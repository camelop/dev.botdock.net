import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  sessionWatchUrl,
  type AgentKind,
  type Machine,
  type Session,
  type SessionEventRecord,
  type SessionStatus,
} from "../api";
import { Modal } from "../components/Modal";
import { relativeTime, fullTime } from "../lib/time";
import { twoWordSlug } from "../lib/slug";

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
                  <td className="muted" title={fullTime(s.started_at)}>{relativeTime(s.started_at)}</td>
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
  const [workdir, setWorkdir] = useState(() => `~/.botdock/projects/${twoWordSlug()}`);
  const [agentKind, setAgentKind] = useState<AgentKind>("generic-cmd");
  const [cmd, setCmd] = useState('echo "hello from BotDock"; sleep 1; date');
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const regenSlug = () => setWorkdir(`~/.botdock/projects/${twoWordSlug()}`);

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      const s = await api.createSession({ machine, workdir, agent_kind: agentKind, cmd });
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

      <AgentKindPicker value={agentKind} onChange={setAgentKind} />

      <WorkdirPicker
        machine={machine}
        value={workdir}
        onChange={setWorkdir}
        onRegen={regenSlug}
      />

      <label>
        <span>Command</span>
        <textarea rows={4} value={cmd} onChange={(e) => setCmd(e.target.value)} />
      </label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        The command runs inside a tmux session. BotDock creates the working directory if it doesn't exist.
      </div>
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button disabled={submitting || !machine || !workdir || !cmd} onClick={submit}>Create &amp; launch</button>
      </div>
    </Modal>
  );
}

function AgentKindPicker({ value, onChange }: { value: AgentKind; onChange: (v: AgentKind) => void }) {
  const kinds: Array<{ id: AgentKind; label: string; disabled?: boolean; hint?: string }> = [
    { id: "generic-cmd", label: "Generic command", hint: "any shell command inside tmux" },
    { id: "claude-code", label: "Claude Code", disabled: true, hint: "coming in M3" },
  ];
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Agent kind</div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {kinds.map((k) => {
          const selected = value === k.id;
          return (
            <button
              key={k.id}
              type="button"
              className="secondary"
              disabled={k.disabled}
              onClick={() => !k.disabled && onChange(k.id)}
              style={{
                borderColor: selected ? "var(--accent)" : undefined,
                boxShadow: selected ? "inset 0 0 0 1px var(--accent)" : undefined,
                opacity: k.disabled ? 0.55 : 1,
              }}
              title={k.hint}
            >
              {k.label}{k.disabled ? " (soon)" : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkdirPicker(props: {
  machine: string;
  value: string;
  onChange: (v: string) => void;
  onRegen: () => void;
}) {
  const [entries, setEntries] = useState<Array<{ name: string; kind: "dir" | "file" }>>([]);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced fetch of the parent dir's listing.
  useEffect(() => {
    if (!props.machine || !props.value) { setEntries([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const r = await api.browseMachine(props.machine, props.value);
        if (cancelled) return;
        setEntries(r.entries ?? []);
      } catch { setEntries([]); }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [props.machine, props.value]);

  // Suggestions = subset of entries whose name starts with the typed leaf.
  const suggestions = useMemo(() => {
    const lastSlash = props.value.lastIndexOf("/");
    const parent = props.value.slice(0, lastSlash + 1);
    const leaf = props.value.slice(lastSlash + 1).toLowerCase();
    return entries
      .filter((e) => e.kind === "dir" && e.name.toLowerCase().startsWith(leaf))
      .slice(0, 8)
      .map((e) => parent + e.name);
  }, [entries, props.value]);

  return (
    <label style={{ position: "relative", marginBottom: 10 }}>
      <span>Working directory (on the machine)</span>
      <div className="row" style={{ gap: 6 }}>
        <input
          ref={inputRef}
          className="grow"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="/home/... or ~/..."
          spellCheck={false}
          autoCorrect="off"
          style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}
        />
        <button type="button" className="secondary" title="Generate a new random name" onClick={props.onRegen}>↻</button>
      </div>
      {focused && suggestions.length > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "100%",
            marginTop: 2,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            maxHeight: 180,
            overflowY: "auto",
            zIndex: 20,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
          }}
        >
          {suggestions.map((s) => (
            <div
              key={s}
              onMouseDown={(e) => { e.preventDefault(); props.onChange(s + "/"); inputRef.current?.focus(); }}
              style={{ padding: "4px 10px", cursor: "pointer" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#2a2f38")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            >
              {s}/
            </div>
          ))}
        </div>
      )}
      <span className="muted" style={{ fontSize: 11 }}>
        BotDock will create this path if missing. ~ expands to the remote user's home.
      </span>
    </label>
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
        <EventsTable events={events} />
      </div>
    </div>
  );
}

function EventsTable({ events }: { events: SessionEventRecord[] }) {
  // Tick once every 5s so the relative timestamps don't feel stale while the
  // modal is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
      <table className="table" style={{ fontSize: 11.5 }}>
        <tbody>
          {events.map((ev, i) => (
            <tr key={i}>
              <td className="muted" style={{ whiteSpace: "nowrap", width: 110 }} title={fullTime(ev.ts)}>
                {relativeTime(ev.ts)}
              </td>
              <td><span className="pill">{ev.kind}</span></td>
              <td className="mono">{renderEventPayload(ev)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Meta({ s }: { s: Session }) {
  const T = ({ t }: { t?: string }) => (
    <span title={fullTime(t)}>{relativeTime(t)}</span>
  );
  return (
    <div className="card" style={{ padding: 12, fontSize: 12.5 }}>
      <Row k="cmd"><span className="mono">{s.cmd}</span></Row>
      <Row k="tmux"><span className="mono">{s.tmux_session}</span></Row>
      <Row k="created"><T t={s.created_at} /></Row>
      <Row k="started"><T t={s.started_at} /></Row>
      <Row k="exited">
        <T t={s.exited_at} />
        {s.exit_code !== undefined ? ` (code ${s.exit_code})` : ""}
      </Row>
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
