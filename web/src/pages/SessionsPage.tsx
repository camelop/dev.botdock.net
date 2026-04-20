import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { parseAnsi, spanStyle } from "../lib/ansi";
import { parseTranscript, type TranscriptTurn } from "../lib/transcript";

export type SessionDraft = {
  machine: string;
  workdir: string;
  agent_kind: AgentKind;
  cmd: string;
  /** claude-code: auto-accept the folder-trust dialog and tool permission
   * prompts (maps to `--dangerously-skip-permissions`). Defaults to the
   * user's last choice, persisted in localStorage. */
  cc_skip_trust: boolean;
};

const TRUST_PREF_KEY = "botdock:cc-skip-trust";
function loadTrustPref(): boolean {
  try { return localStorage.getItem(TRUST_PREF_KEY) === "1"; } catch { return false; }
}
function saveTrustPref(v: boolean): void {
  try { localStorage.setItem(TRUST_PREF_KEY, v ? "1" : "0"); } catch {}
}

export function freshDraft(machines: Machine[]): SessionDraft {
  return {
    machine: machines[0]?.name ?? "",
    workdir: `~/.botdock/projects/${twoWordSlug()}`,
    agent_kind: "claude-code",
    cmd: "",
    cc_skip_trust: loadTrustPref(),
  };
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState<SessionDraft | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);

  // Open the modal with either the persisted draft or a fresh one.
  const openNew = () => {
    setDraft((cur) => cur ?? freshDraft(machines));
    setNewOpen(true);
  };

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
        <button onClick={openNew} disabled={machines.length === 0}>
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
                  <td><SessionPill session={s} /></td>
                  <td>{s.machine}</td>
                  <td className="mono" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.cmd}</td>
                  <td className="muted" title={fullTime(s.started_at)}>{relativeTime(s.started_at)}</td>
                  <td className="mono">{s.exit_code ?? (s.status === "active" ? "…" : "—")}</td>
                  <td>
                    <button className="secondary" onClick={(e) => { e.stopPropagation(); setSelected(s.id); }}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newOpen && draft && (
        <NewSessionModal
          machines={machines}
          draft={draft}
          onDraft={setDraft}
          onCancel={() => setNewOpen(false)}
          onDone={async (id) => {
            setNewOpen(false);
            setDraft(null);  // clear on successful submit only
            await refresh();
            setSelected(id);
          }}
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

/**
 * Single pill that merges session status and agent activity. Priority:
 *   - exited / failed_to_start: show the terminal status
 *   - provisioning: show it (starting up)
 *   - active + claude-code agent with known activity: show activity
 *     ("running" while producing output, "pending" while idle)
 *   - otherwise: show "active"
 */
function SessionPill({ session: s }: { session: Pick<Session, "status" | "activity" | "agent_kind"> }) {
  let label: string;
  let cls: string;
  if (s.status === "exited") { label = "exited"; cls = ""; }
  else if (s.status === "failed_to_start") { label = "failed"; cls = "err"; }
  else if (s.status === "provisioning") { label = "provisioning"; cls = "warn"; }
  else if (s.agent_kind === "claude-code" && s.activity === "pending") { label = "pending"; cls = "warn"; }
  else if (s.agent_kind === "claude-code" && s.activity === "running") { label = "running"; cls = "ok"; }
  else { label = "active"; cls = "ok"; }
  return <span className={`pill ${cls}`}>{label}</span>;
}

/** Legacy wrapper kept for code paths that only have a SessionStatus. */
function StatusPill({ status }: { status: SessionStatus }) {
  return <SessionPill session={{ status, agent_kind: "generic-cmd" }} />;
}

export function NewSessionModal(props: {
  machines: Machine[];
  draft: SessionDraft;
  onDraft: (d: SessionDraft) => void;
  onCancel: () => void;
  onDone: (id: string) => void | Promise<void>;
}) {
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { draft, onDraft } = props;
  const patch = (p: Partial<SessionDraft>) => onDraft({ ...draft, ...p });

  const regenSlug = () => patch({ workdir: `~/.botdock/projects/${twoWordSlug()}` });

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      // Remember the trust-dialog choice so future modals default to it.
      if (draft.agent_kind === "claude-code") saveTrustPref(draft.cc_skip_trust);
      const s = await api.createSession(draft);
      await props.onDone(s.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New session" onClose={props.onCancel}>
      <label>
        <span>Machine</span>
        <select value={draft.machine} onChange={(e) => patch({ machine: e.target.value })}>
          {props.machines.map((m) => <option key={m.name} value={m.name}>{m.name} — {m.user}@{m.host}</option>)}
        </select>
      </label>

      <AgentKindPicker value={draft.agent_kind} onChange={(v) => patch({ agent_kind: v })} />

      <WorkdirPicker
        machine={draft.machine}
        value={draft.workdir}
        onChange={(v) => patch({ workdir: v })}
        onRegen={regenSlug}
      />

      <label>
        <span>{draft.agent_kind === "claude-code" ? "Initial prompt (optional)" : "Command"}</span>
        <textarea
          rows={4}
          value={draft.cmd}
          onChange={(e) => patch({ cmd: e.target.value })}
          placeholder={draft.agent_kind === "claude-code"
            ? "e.g. Explain this repo's README"
            : 'echo "hello"; sleep 1'}
        />
      </label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {draft.agent_kind === "claude-code"
          ? "Runs the `claude` CLI inside tmux. Leave the prompt blank to start an empty conversation. Requires `claude` installed and authenticated on the remote."
          : "The command runs inside a tmux session. BotDock creates the working directory if it doesn't exist."}
      </div>
      {draft.agent_kind === "claude-code" && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
          <input
            id="cc-skip-trust"
            type="checkbox"
            checked={draft.cc_skip_trust}
            onChange={(e) => patch({ cc_skip_trust: e.target.checked })}
            style={{ width: 16, height: 16, marginTop: 2, cursor: "pointer" }}
          />
          <label
            htmlFor="cc-skip-trust"
            style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0, cursor: "pointer", lineHeight: 1.5 }}
          >
            Auto-accept the folder-trust prompt. Pre-writes{" "}
            <code className="mono">hasTrustDialogAccepted</code> for this workdir into{" "}
            <code className="mono">~/.claude.json</code> on the remote, so <code className="mono">claude</code>{" "}
            doesn't pause on startup. Per-tool permission prompts are NOT skipped.
          </label>
        </div>
      )}
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onCancel}>Cancel (keep draft)</button>
        <button
          disabled={submitting || !draft.machine || !draft.workdir || (draft.agent_kind !== "claude-code" && !draft.cmd)}
          onClick={submit}
        >Create &amp; launch</button>
      </div>
    </Modal>
  );
}

function AgentKindPicker({ value, onChange }: { value: AgentKind; onChange: (v: AgentKind) => void }) {
  const kinds: Array<{ id: AgentKind; label: string; disabled?: boolean; hint?: string }> = [
    { id: "generic-cmd", label: "Generic command", hint: "any shell command inside tmux" },
    { id: "claude-code", label: "Claude Code", hint: "interactive `claude` CLI; initial prompt optional" },
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

/**
 * Return the "parent directory" portion of a user-typed path. Treats a bare
 * "~" as if it were "~/" so autocomplete fires before the user adds a slash.
 */
function parentOf(v: string): string {
  if (v === "~") return "~/";
  const i = v.lastIndexOf("/");
  return i < 0 ? "" : v.slice(0, i + 1);
}

function WorkdirPicker(props: {
  machine: string;
  value: string;
  onChange: (v: string) => void;
  onRegen: () => void;
}) {
  type Entry = { name: string; kind: "dir" | "file" };
  // Remember which parent dir the fetched entries belong to. Prevents stale
  // suggestions from showing when the user navigates into a new level — the
  // old list would otherwise be joined onto the new parent, yielding
  // nonsense entries like "~/blog.seedclaw.net/.bun".
  const [state, setState] = useState<{ parent: string; entries: Entry[] }>({ parent: "", entries: [] });
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const parent = parentOf(props.value);

  useEffect(() => {
    if (!props.machine || !props.value) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const r = await api.browseMachine(props.machine, props.value);
        if (cancelled) return;
        setState({ parent, entries: r.entries ?? [] });
      } catch {
        if (!cancelled) setState({ parent, entries: [] });
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [props.machine, props.value, parent]);

  const suggestions = useMemo(() => {
    // If the stored entries are for a different parent than currently typed,
    // don't show anything — waiting on fetch is better than showing junk.
    if (state.parent !== parent) return [] as string[];
    const leaf = props.value.slice(parent.length).toLowerCase();
    return state.entries
      .filter((e) => e.kind === "dir" && e.name.toLowerCase().startsWith(leaf))
      .map((e) => parent + e.name);
  }, [state, props.value, parent]);

  const choose = (s: string) => {
    props.onChange(s + "/");
    inputRef.current?.focus();
  };

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
          className="scroll-panel"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "100%",
            marginTop: 2,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            maxHeight: 260,
            zIndex: 20,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
          }}
        >
          {suggestions.map((s) => (
            <div
              key={s}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              style={{ padding: "5px 10px", cursor: "pointer" }}
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

/**
 * Presentation of a single session: terminal + transcript + events.
 * Used standalone by SessionHubPage, and wrapped in a modal backdrop by
 * SessionDetailModal. Pass `onClose` to render the × button in the top-
 * right of the right column; omit it for contexts (like the hub) where
 * the view is persistent.
 */
export function SessionView(props: {
  id: string;
  onClose?: () => void;
  onChange?: () => void | Promise<void>;
  // When true, the view styles itself as a floating modal (background,
  // border, shadow). When false (hub embed), it's a bare two-column pane.
  inModal?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEventRecord[]>([]);
  const [rawText, setRawText] = useState("");
  const [transcriptText, setTranscriptText] = useState("");
  const [err, setErr] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // SendInput pane is collapsed by default to give the terminal more room —
  // a button in the terminal toolbar toggles it.
  const [showInput, setShowInput] = useState(false);

  // WebSocket is the single source of truth for events + raw. The server's
  // initial snapshot on open already covers everything up to "now", so we
  // don't do a parallel HTTP fetch (doing so races with the WS snapshot and
  // double-counts the raw log).
  useEffect(() => {
    setEvents([]);
    setRawText("");
    setTranscriptText("");
    setErr("");
    api.getSession(props.id).then(setSession).catch((e) => setErr(String(e.message ?? e)));

    const ws = new WebSocket(sessionWatchUrl(props.id));
    wsRef.current = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.type === "events") {
        setEvents((cur) => [...cur, ...m.records]);
      } else if (m.type === "raw") {
        setRawText((cur) => cur + m.data);
      } else if (m.type === "transcript") {
        setTranscriptText((cur) => cur + m.data);
      } else if (m.type === "session") {
        // Authoritative session meta from the server — picks up activity
        // transitions, exit_code, etc. without re-fetching HTTP.
        setSession(m.session as Session);
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
    if (!confirm("Deactivate this session? The remote tmux is killed; local logs stay.")) return;
    try {
      const s = await api.stopSession(props.id);
      setSession(s);
      await props.onChange?.();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  const onDelete = async () => {
    if (!confirm("Delete this session (files and all)?")) return;
    try {
      await api.deleteSession(props.id);
      await props.onChange?.();
      props.onClose?.();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  return (
    <div
      className={props.inModal ? "modal session-modal" : "session-modal"}
      onClick={(e) => e.stopPropagation()}
    >
        {/* LEFT: terminal fills the column, SendInput collapses behind a toggle. */}
        <div className="session-left">
          <div className="terminal-fill">
            {session?.agent_kind === "claude-code" ? (
              <ClaudeTerminal
                session={session}
                fillParent
                extraButtons={session.status === "active" ? (
                  <button
                    className="secondary"
                    style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, flexShrink: 0 }}
                    onClick={() => setShowInput((v) => !v)}
                    title="Toggle the input pane (send text / quick keys to tmux)"
                  >
                    {showInput ? "▾ Hide input" : "⌨ Input"}
                  </button>
                ) : null}
              />
            ) : (
              <>
                <div className="row" style={{ gap: 6, alignItems: "center", marginBottom: 8 }}>
                  <h2 style={{ margin: 0, flex: 1 }}>Live log</h2>
                  {session?.status === "active" && (
                    <button
                      className="secondary"
                      style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, flexShrink: 0 }}
                      onClick={() => setShowInput((v) => !v)}
                      title="Toggle the input pane"
                    >{showInput ? "▾ Hide input" : "⌨ Input"}</button>
                  )}
                </div>
                <div
                  ref={logRef}
                  className="mono scroll-panel"
                  style={{
                    flex: 1,
                    minHeight: 0,
                    background: "#0a0c10",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 10,
                    whiteSpace: "pre-wrap",
                    fontSize: 12,
                  }}
                >
                  <AnsiText text={rawText} />
                  {session?.status === "active" && (
                    <span className="pill ok" style={{ fontSize: 10, marginTop: 8, display: "inline-block" }}>streaming</span>
                  )}
                </div>
              </>
            )}
          </div>
          {session?.status === "active" && showInput && <SendInput id={session.id} />}
        </div>

        {/* RIGHT: title / meta / transcript / events — scrolls independently.
            Close is pinned to the top-right corner (doesn't fight for horizontal
            space with the title). Deactivate / Delete sit on their own row
            below the header so the meta never gets clipped. */}
        <div className="session-right scroll-panel">
          {/* Title + all action buttons live on one row. Title ellipsizes so
              Deactivate / × never get pushed to a new line. */}
          <div className="row" style={{ gap: 6, alignItems: "center", marginBottom: 4 }}>
            <h2 style={{
              flex: 1,
              minWidth: 0,
              margin: 0,
              fontSize: 16,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}>Session {props.id}</h2>
            {session?.status === "active" && (
              <button className="secondary" style={{ fontSize: 12, padding: "4px 12px", flexShrink: 0 }} onClick={onStop}>
                Deactivate
              </button>
            )}
            {session && (session.status === "exited" || session.status === "failed_to_start") && (
              <button className="secondary" style={{ fontSize: 12, padding: "4px 12px", flexShrink: 0 }} onClick={onDelete}>
                Delete
              </button>
            )}
            {props.onClose && (
              <button
                className="secondary"
                onClick={props.onClose}
                title="Close"
                style={{ padding: "4px 10px", fontSize: 13, flexShrink: 0 }}
              >×</button>
            )}
          </div>
          {session && (
            <div className="mono muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
              <SessionPill session={session} />{" "}
              {session.machine} · {session.workdir}
            </div>
          )}

          {err && <div className="error-banner">{err}</div>}
          {session && <Meta s={session} />}

          {session?.agent_kind === "claude-code" && (
            <TranscriptView text={transcriptText} hasFile={!!session.cc_session_file} />
          )}

          <h2>Events</h2>
          <EventsTable events={events} />
        </div>
    </div>
  );
}

/** Modal wrapper around SessionView — used from Sessions List / War Room. */
export function SessionDetailModal(props: {
  id: string;
  onClose: () => void;
  onChange: () => void | Promise<void>;
}) {
  // Esc closes the modal. Scoped to this mount — the wrapper unmounts on
  // close, so the listener cleans up automatically.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div className="modal-backdrop" onClick={() => { /* no-op; no backdrop dismiss */ }}>
      <SessionView id={props.id} onClose={props.onClose} onChange={props.onChange} inModal />
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
  // Defensive sort (oldest first). Clock skew between basedock and remote
  // can otherwise let a late-arriving event land out of place.
  const sorted = useMemo(
    () => [...events].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "")),
    [events],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll the container to the bottom on mount and whenever new events land.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sorted.length]);
  return (
    <div ref={scrollRef} className="scroll-panel" style={{ maxHeight: 220, border: "1px solid var(--border)", borderRadius: 6 }}>
      <table className="table" style={{ fontSize: 11.5 }}>
        <tbody>
          {sorted.map((ev, i) => (
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

function TranscriptView({ text, hasFile }: { text: string; hasFile: boolean }) {
  const turns = useMemo(() => parseTranscript(text), [text]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length]);

  if (!hasFile) {
    return (
      <>
        <h2>Transcript</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Waiting for Claude to create its JSONL — should appear a second or two after the session starts.
          </div>
        </div>
      </>
    );
  }

  if (turns.length === 0) {
    return (
      <>
        <h2>Transcript</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>No messages yet.</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <h2 style={{ margin: 0 }}>Transcript</h2>
        <button
          className="secondary"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => setShowRaw((v) => !v)}
          title="Show the underlying JSONL lines for debugging"
        >{showRaw ? "Hide raw" : "View raw"}</button>
      </div>
      <div
        ref={scrollRef}
        className="scroll-panel"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          maxHeight: 420,
          background: "#0e1116",
          padding: 8,
        }}
      >
        {showRaw ? (
          <pre className="code" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{text}</pre>
        ) : (
          turns.map((t, i) => <TranscriptTurnRow key={i} turn={t} />)
        )}
      </div>
    </>
  );
}

function TranscriptTurnRow({ turn }: { turn: TranscriptTurn }) {
  const roleStyle = useMemo(() => roleBadgeStyle(turn.kind), [turn.kind]);
  // Label: use the detected role/kind. For "unknown" entries prefer the
  // raw `type` field from the underlying JSON so the user still sees what
  // the line actually was (e.g. "system", "summary", future types).
  const label = turn.kind === "unknown"
    ? (typeof (turn.raw as any).type === "string" ? (turn.raw as any).type : "unknown")
    : roleStyle.label;

  return (
    <div style={{ margin: "10px 6px", paddingLeft: 8, borderLeft: `3px solid ${roleStyle.accent}` }}>
      <div className="row" style={{ gap: 8, alignItems: "baseline", marginBottom: 4 }}>
        <span className="pill" style={{
          background: roleStyle.bg, color: roleStyle.fg, fontSize: 11,
        }}>{label}</span>
        {turn.ts && (
          <span className="muted" style={{ fontSize: 11 }} title={fullTime(turn.ts)}>
            {relativeTime(turn.ts)}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {turn.blocks.length > 0
          ? turn.blocks.map((b, i) => <TranscriptBlock key={i} block={b} />)
          : <RawJsonBlock raw={turn.raw} />}
      </div>
    </div>
  );
}

/**
 * Shown for entries we can't decompose into semantic blocks (unknown top-
 * level types, or message shapes CC added after this parser was written).
 * Collapsed by default so the row stays skimmable; the full JSON is one
 * click away.
 */
function RawJsonBlock({ raw }: { raw: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    // Strip the frame fields that every row already shows, so the preview
    // actually carries signal.
    const rest: Record<string, unknown> = { ...raw };
    for (const k of ["uuid", "parentUuid", "timestamp", "sessionId", "cwd", "gitBranch", "version", "userType", "isSidechain", "requestId"]) {
      delete rest[k];
    }
    return JSON.stringify(rest).slice(0, 400);
  }, [raw]);
  return (
    <div
      onClick={() => setExpanded((v) => !v)}
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        fontFamily: "var(--mono)",
        fontSize: 12,
        color: "var(--fg-dim)",
      }}
      title="Click to expand the full JSON for this entry"
    >
      {expanded ? (
        <pre className="code" style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : (
        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ opacity: 0.6, marginRight: 6 }}>▸</span>
          {preview}
        </div>
      )}
    </div>
  );
}

function TranscriptBlock({ block }: { block: TranscriptTurn["blocks"][number] }) {
  const [expanded, setExpanded] = useState(block.type === "text");
  if (block.type === "text") {
    return (
      <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
        {block.text}
      </div>
    );
  }
  if (block.type === "tool_use") {
    const argsPreview = typeof block.input === "object" && block.input
      ? Object.keys(block.input as object).join(", ")
      : "";
    return (
      <div
        style={{
          background: "rgba(106,164,255,0.08)",
          border: "1px solid rgba(106,164,255,0.25)",
          borderRadius: 6,
          padding: "6px 10px",
        }}
      >
        <div
          className="row"
          style={{ gap: 6, fontSize: 12, cursor: "pointer", alignItems: "baseline" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="muted" style={{ fontSize: 11 }}>tool_use</span>
          <span className="mono" style={{ color: "var(--accent)" }}>{block.name}</span>
          {!expanded && argsPreview && <span className="muted" style={{ fontSize: 11 }}>({argsPreview})</span>}
          <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre className="code" style={{ marginTop: 6, fontSize: 11, maxHeight: 200 }}>{JSON.stringify(block.input, null, 2)}</pre>
        )}
      </div>
    );
  }
  if (block.type === "tool_result") {
    return (
      <div
        style={{
          background: block.is_error ? "rgba(239,107,107,0.08)" : "rgba(110,207,110,0.06)",
          border: `1px solid ${block.is_error ? "rgba(239,107,107,0.25)" : "rgba(110,207,110,0.18)"}`,
          borderRadius: 6,
          padding: "6px 10px",
        }}
      >
        <div
          className="row"
          style={{ gap: 6, fontSize: 12, cursor: "pointer", alignItems: "baseline" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="muted" style={{ fontSize: 11 }}>tool_result</span>
          {block.is_error && <span className="pill err" style={{ fontSize: 10 }}>error</span>}
          <span className="muted" style={{ fontSize: 11 }}>
            {block.content.length} chars
          </span>
          <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre
            className="code"
            style={{ marginTop: 6, fontSize: 11, maxHeight: 260, whiteSpace: "pre-wrap" }}
          >{block.content}</pre>
        )}
      </div>
    );
  }
  if (block.type === "image") {
    return <div className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>[image]</div>;
  }
  return (
    <pre className="code" style={{ fontSize: 11, maxHeight: 120 }}>{JSON.stringify(block.raw, null, 2)}</pre>
  );
}

function roleBadgeStyle(kind: TranscriptTurn["kind"]): { label: string; bg: string; fg: string; accent: string } {
  switch (kind) {
    case "user":        return { label: "user",        bg: "#2a3142", fg: "#aab4d0", accent: "#5b6475" };
    case "assistant":   return { label: "assistant",   bg: "rgba(106,164,255,0.15)", fg: "#c8d7ff", accent: "#6aa4ff" };
    case "tool_result": return { label: "tool_result", bg: "rgba(110,207,110,0.1)",  fg: "#c5e6c5", accent: "#6ecf6e" };
    case "system":      return { label: "system",      bg: "#2a2f38", fg: "var(--fg-dim)", accent: "#4a5160" };
    case "summary":     return { label: "summary",     bg: "rgba(242,185,75,0.1)",   fg: "#ead39a", accent: "var(--warn)" };
    default:            return { label: "?",           bg: "#2a2f38", fg: "var(--fg-dim)", accent: "#3a4150" };
  }
}

function ClaudeTerminal({ session, fillParent, extraButtons }: {
  session: Session;
  fillParent?: boolean;
  extraButtons?: React.ReactNode;
}) {
  const [zoomed, setZoomed] = useState(false);
  // Changing reloadKey remounts the iframe, which forces ttyd to do a
  // fresh handshake and re-measure its container — useful after modal
  // resizes that left the terminal drawn to stale dimensions.
  const [reloadKey, setReloadKey] = useState(0);
  // CSS zoom on the iframe scales the xterm content. Chrome/Safari/Edge
  // support this; Firefox ignores — acceptable. Clamped to a sane range.
  const [contentZoom, setContentZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoomed(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  // When the container resizes (modal open, column reflow, full-screen
  // toggle), nudge ttyd to re-measure by dispatching a resize event on
  // the iframe's window. Same-origin via the proxy so this is allowed.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fire = () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try { win.dispatchEvent(new Event("resize")); } catch {}
    };
    const ro = new ResizeObserver(() => fire());
    ro.observe(el);
    // Fire a couple of delayed pings after mount — the first ttyd handshake
    // can complete after the initial ResizeObserver tick.
    const timers = [120, 400, 900].map((ms) => window.setTimeout(fire, ms));
    return () => {
      ro.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [reloadKey, zoomed]);

  const url = `/api/sessions/${encodeURIComponent(session.id)}/terminal/`;
  const isLive = session.status === "active" || session.status === "provisioning";
  const portReady = !!session.terminal_local_port;

  if (!isLive) {
    return (
      <>
        <h2>Terminal</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Session is {session.status}. Terminal is only embedded while the session is active.
          </div>
        </div>
      </>
    );
  }

  if (!portReady) {
    // status is active/provisioning but we never got a terminal_local_port —
    // either still provisioning (should be brief) or setup failed. Check
    // the event stream for a session-terminal error.
    return (
      <>
        <h2>Terminal</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {session.status === "provisioning"
              ? "Provisioning remote ttyd + tunnel…"
              : "Terminal didn't come up. Check the Events below for the setup error, or ssh in and tmux attach manually."}
          </div>
          <pre className="code" style={{ marginTop: 8, fontSize: 11 }}>
{`ssh ${session.machine === "local" ? "<machine>" : session.machine} \\
  -t tmux attach -t ${session.tmux_session}`}
          </pre>
        </div>
      </>
    );
  }

  const containerStyle: React.CSSProperties = zoomed
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "#0a0c10", display: "flex", flexDirection: "column" }
    : fillParent
      // Fill the surrounding flex column (two-column modal layout).
      ? { flex: 1, minHeight: 320, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "#0a0c10", display: "flex", flexDirection: "column" }
      // Legacy single-column modal: fixed height so the flow below still fits.
      : { height: 420, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "#0a0c10", display: "flex", flexDirection: "column" };

  const iconBtn: React.CSSProperties = {
    padding: "4px 10px", fontSize: 12, borderRadius: 6, flexShrink: 0,
  };

  return (
    <>
      {!zoomed && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
          <button
            className="secondary"
            style={iconBtn}
            onClick={() => setReloadKey((k) => k + 1)}
            title="Reload the ttyd iframe (forces tmux to re-measure the pane)"
          >↻ Reload</button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="secondary"
            style={{
              ...iconBtn, textDecoration: "none",
              background: "#323844", color: "var(--fg)",
              border: "1px solid #3f4754",
            }}
            title="Open in a new browser tab"
          >↗ New tab</a>
          <button
            className="secondary"
            style={iconBtn}
            onClick={() => setZoomed(true)}
            title="Expand to full screen (Esc to exit)"
          >⛶ Full screen</button>
          <button
            className="secondary"
            style={iconBtn}
            onClick={() => setContentZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}
            title="Shrink terminal content (CSS zoom; Chromium/Safari only)"
          >−</button>
          <span className="muted mono" style={{ fontSize: 11, minWidth: 32, textAlign: "center" }}>
            {Math.round(contentZoom * 100)}%
          </span>
          <button
            className="secondary"
            style={iconBtn}
            onClick={() => setContentZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}
            title="Enlarge terminal content (CSS zoom; Chromium/Safari only)"
          >+</button>
          <button
            className="secondary"
            style={iconBtn}
            disabled
            title="Attach extra context to this session (coming soon)"
          >＋ Context</button>
          {extraButtons}
        </div>
      )}
      <div ref={containerRef} style={containerStyle}>
        {zoomed && (
          <div className="row" style={{ padding: 6, borderBottom: "1px solid var(--border)", background: "var(--bg-elev)" }}>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
              Session {session.id} · {session.machine} · {session.tmux_session}
            </span>
            <div style={{ flex: 1 }} />
            <button className="secondary" onClick={() => setReloadKey((k) => k + 1)} title="Reload" style={{ marginRight: 6 }}>↻ Reload</button>
            <button className="secondary" onClick={() => setZoomed(false)} title="Exit full screen (Esc)">× Exit</button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={reloadKey}
          title={`session-${session.id}-terminal`}
          src={url}
          scrolling="no"
          onLoad={() => {
            const win = iframeRef.current?.contentWindow;
            if (!win) return;
            // ttyd sometimes measures before the flex container has its
            // final size. Fire a couple of resizes post-load so it
            // re-fits without the user needing to hit Reload.
            [60, 250, 600].forEach((ms) => setTimeout(() => {
              try { win.dispatchEvent(new Event("resize")); } catch {}
            }, ms));
            // ttyd wires a beforeunload handler so the browser warns about
            // losing the WS session on navigation. We're a single-page app
            // that tears down the iframe on tab-switch; the dialog is just
            // noise. Same-origin via the proxy means we can null it out.
            try {
              win.onbeforeunload = null;
              win.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
                e.stopImmediatePropagation();
                delete (e as unknown as { returnValue?: string }).returnValue;
              }, { capture: true });
            } catch {}
          }}
          style={{
            flex: 1, border: "none", width: "100%", display: "block", overflow: "hidden",
            // `zoom` is webkit-style; Firefox ignores which is fine — the
            // default 1.0 is a no-op. We also cast because React's CSS
            // typings don't include zoom.
            ...(contentZoom !== 1 ? ({ zoom: contentZoom } as React.CSSProperties) : {}),
          }}
        />
      </div>
    </>
  );
}

function Meta({ s }: { s: Session }) {
  const T = ({ t }: { t?: string }) => (
    <span title={fullTime(t)}>{relativeTime(t)}</span>
  );
  const cmdLabel = s.agent_kind === "claude-code" ? "prompt" : "cmd";
  return (
    <div className="card" style={{ padding: 12, fontSize: 12.5 }}>
      <Row k="kind"><span className="mono">{s.agent_kind}</span></Row>
      <Row k={cmdLabel}><span className="mono">{s.cmd || <span className="muted">(none)</span>}</span></Row>
      <Row k="tmux"><span className="mono">{s.tmux_session}</span></Row>
      <Row k="created"><T t={s.created_at} /></Row>
      <Row k="started"><T t={s.started_at} /></Row>
      <Row k="exited">
        <T t={s.exited_at} />
        {s.exit_code !== undefined ? ` (code ${s.exit_code})` : ""}
      </Row>
      {s.cc_session_file && (
        <Row k="cc file"><span className="mono" style={{ wordBreak: "break-all" }}>{s.cc_session_file}</span></Row>
      )}
    </div>
  );
}

function SendInput({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  const sendText = async () => {
    setSending(true); setErr("");
    try {
      await api.sendSessionInput(id, { text });
      setText("");
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setSending(false); }
  };

  const sendKey = async (key: string) => {
    setSending(true); setErr("");
    try { await api.sendSessionInput(id, { keys: [key] }); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setSending(false); }
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(); }
  };

  const Key = ({ k, label, title }: { k: string; label: string; title?: string }) => (
    <button
      type="button"
      className="secondary"
      disabled={sending}
      onClick={() => sendKey(k)}
      title={title ?? `send ${k}`}
      style={{ padding: "4px 10px", fontSize: 12 }}
    >{label}</button>
  );

  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Send input to the running pane. <span className="mono">⌘/Ctrl+Enter</span> sends the text box + Enter;
        Send with empty text sends just Enter.
      </div>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <textarea
          className="grow"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="message to the running agent…"
        />
        <button disabled={sending} onClick={sendText} title="send-keys: text (if any) then Enter">
          {text ? "Send ↩" : "Enter ↩"}
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>Quick keys:</span>
        <Key k="Escape" label="Esc" />
        <Key k="Up" label="↑" />
        <Key k="Down" label="↓" />
        <Key k="Left" label="←" />
        <Key k="Right" label="→" />
        <Key k="Tab" label="Tab" />
        <Key k="BSpace" label="⌫ Backspace" />
        <Key k="C-c" label="Ctrl-C" title="interrupt" />
        <Key k="C-d" label="Ctrl-D" title="EOF / exit" />
      </div>
      {err && <div className="error-banner" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 12, marginBottom: 2, alignItems: "flex-start" }}>
      <span
        className="muted"
        style={{ width: 64, fontSize: 11, textTransform: "uppercase", flex: "none", paddingTop: 2 }}
      >{k}</span>
      <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>{children}</span>
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
 * Render ANSI-styled pane output. Colors + bold/italic/underline are
 * honored; cursor-move / clear-screen / OSC sequences are stripped because
 * we're rendering to a scrollback div, not a terminal emulator.
 */
function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {spans.map((s, i) =>
        Object.keys(s.style).length === 0
          ? <React.Fragment key={i}>{s.text}</React.Fragment>
          : <span key={i} style={spanStyle(s.style)}>{s.text}</span>
      )}
    </>
  );
}
