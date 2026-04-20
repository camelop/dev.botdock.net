import { useEffect, useMemo, useState } from "react";
import { api, type Session } from "../api";
import { SessionView } from "./SessionsPage";
import { AgentAvatar } from "./WarRoomPage";
import { isAcked, ackSession, unackSession } from "../lib/acks";
import { setAlias, getAliases, touchLastAccess, getLastAccess } from "../lib/session-meta";
import { relativeTime, fullTime } from "../lib/time";

/**
 * Three-column workspace:
 *   left   = grouped session list (pending / running / other) with aliases
 *   middle = terminal + send-input (SessionView's left pane)
 *   right  = meta + transcript + events (SessionView's right pane)
 */
export function SessionHubPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [aliases, setAliases] = useState(getAliases());
  const [tick, setTick] = useState(0);  // force re-read of localStorage (acks, last-access)

  const refresh = async () => {
    try {
      const list = await api.listSessions();
      setSessions(list);
      // If current selection is gone (deleted), clear it so the user
      // doesn't stare at a dead pane.
      setSelected((cur) => (cur && list.find((s) => s.id === cur)) ? cur : (list[0]?.id ?? null));
    } catch { /* tolerate transient errors */ }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (selected) touchLastAccess(selected);
  }, [selected]);

  const pickDefault = (list: Session[]) => {
    // Prefer pending, then running, then most-recently accessed overall.
    const pending = list.find((s) => s.status === "active" && s.agent_kind === "claude-code"
      && s.activity === "pending" && !isAcked(s.id, s.last_transcript_at));
    if (pending) return pending.id;
    const running = list.find((s) => s.status === "active");
    if (running) return running.id;
    return list[0]?.id ?? null;
  };

  // On first mount, pick a sensible default.
  useEffect(() => {
    if (selected == null && sessions.length > 0) setSelected(pickDefault(sessions));
  }, [sessions.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const pending: Session[] = [];
    const running: Session[] = [];
    const other:   Session[] = [];
    for (const s of sessions) {
      if (s.status === "active"
          && s.agent_kind === "claude-code"
          && s.activity === "pending"
          && !isAcked(s.id, s.last_transcript_at)) {
        pending.push(s);
      } else if (s.status === "active" || s.status === "provisioning") {
        running.push(s);
      } else {
        other.push(s);
      }
    }
    const cmp = (a: Session, b: Session) => {
      const la = getLastAccess(a.id);
      const lb = getLastAccess(b.id);
      if (la !== lb) return lb - la;
      // tiebreak: newest transcript activity first
      return (b.last_transcript_at ?? b.started_at ?? b.created_at)
        .localeCompare(a.last_transcript_at ?? a.started_at ?? a.created_at);
    };
    pending.sort(cmp); running.sort(cmp); other.sort(cmp);
    return { pending, running, other };
  }, [sessions, tick]);

  const onAck = (s: Session) => { ackSession(s.id, s.last_transcript_at); setTick((v) => v + 1); };
  const onUnack = (s: Session) => { unackSession(s.id); setTick((v) => v + 1); };

  const onRename = (id: string, alias: string) => {
    setAlias(id, alias);
    setAliases(getAliases());
  };

  return (
    <div
      style={{
        display: "flex",
        height: "calc(100vh - 90px)",
        minHeight: 480,
        gap: 0,
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--bg-card)",
      }}
    >
      <SessionSidebar
        grouped={grouped}
        aliases={aliases}
        selectedId={selected}
        onSelect={(id) => setSelected(id)}
        onAck={onAck}
        onUnack={onUnack}
        onRename={onRename}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {selected ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {/* Full session view (left + right columns), without the modal
                backdrop. Flex-in-flex so the terminal stretches. */}
            <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
              <HubSessionView id={selected} onChange={refresh} />
            </div>
          </div>
        ) : (
          <div
            className="empty"
            style={{ padding: 60, textAlign: "center", width: "100%" }}
          >
            No sessions yet. Create one from the Dashboard or Sessions → List.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Thin wrapper — SessionView already uses the .session-modal flex layout so
 * we just need to ensure it fills the hub's middle/right area.
 */
function HubSessionView({ id, onChange }: { id: string; onChange: () => void | Promise<void> }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
      <SessionView id={id} onChange={onChange} />
    </div>
  );
}

function SessionSidebar(props: {
  grouped: { pending: Session[]; running: Session[]; other: Session[] };
  aliases: Record<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAck: (s: Session) => void;
  onUnack: (s: Session) => void;
  onRename: (id: string, alias: string) => void;
}) {
  const { grouped } = props;
  return (
    <div
      className="scroll-panel"
      style={{
        width: 280,
        flex: "0 0 280px",
        borderRight: "1px solid var(--border)",
        background: "var(--bg-elev)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Group title="Needs attention" sessions={grouped.pending}
             {...props} tone="warn" />
      <Group title="Active" sessions={grouped.running}
             {...props} tone="ok" />
      <Group title="Other" sessions={grouped.other}
             {...props} tone="muted" collapsedByDefault />
    </div>
  );
}

function Group(props: {
  title: string;
  tone: "warn" | "ok" | "muted";
  sessions: Session[];
  aliases: Record<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAck: (s: Session) => void;
  onUnack: (s: Session) => void;
  onRename: (id: string, alias: string) => void;
  collapsedByDefault?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(!!props.collapsedByDefault);
  const header = (
    <div
      onClick={() => setCollapsed((v) => !v)}
      style={{
        padding: "6px 12px",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--fg-dim)",
        cursor: "pointer",
        userSelect: "none",
        display: "flex",
        alignItems: "center",
        gap: 6,
        borderTop: "1px solid var(--border)",
      }}
    >
      <span>{collapsed ? "▸" : "▾"}</span>
      <span>{props.title}</span>
      <span style={{ opacity: 0.6 }}>· {props.sessions.length}</span>
    </div>
  );
  if (props.sessions.length === 0) return <>{header}</>;
  return (
    <div>
      {header}
      {!collapsed && props.sessions.map((s) => (
        <SidebarRow
          key={s.id}
          session={s}
          alias={props.aliases[s.id]}
          selected={props.selectedId === s.id}
          onClick={() => props.onSelect(s.id)}
          onAck={() => props.onAck(s)}
          onUnack={() => props.onUnack(s)}
          onRename={(alias) => props.onRename(s.id, alias)}
        />
      ))}
    </div>
  );
}

function SidebarRow(props: {
  session: Session;
  alias: string | undefined;
  selected: boolean;
  onClick: () => void;
  onAck: () => void;
  onUnack: () => void;
  onRename: (alias: string) => void;
}) {
  const { session: s, alias, selected } = props;
  const isPending = s.status === "active" && s.agent_kind === "claude-code" && s.activity === "pending";
  const acked = isPending && isAcked(s.id, s.last_transcript_at);
  const displayName = alias || shortCmd(s);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(alias ?? "");

  const commit = () => {
    props.onRename(draft);
    setEditing(false);
  };

  return (
    <div
      onClick={props.onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px",
        cursor: "pointer",
        background: selected ? "var(--bg-card)" : "transparent",
        borderLeft: selected ? "3px solid var(--accent)" : "3px solid transparent",
      }}
    >
      <AgentAvatar session={s} size={32} acked={acked} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(alias ?? ""); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder={s.id}
            style={{ fontSize: 13, padding: "2px 6px" }}
          />
        ) : (
          <div
            onDoubleClick={(e) => { e.stopPropagation(); setDraft(alias ?? ""); setEditing(true); }}
            title={alias ? `${s.id} (double-click to rename)` : "Double-click to rename"}
            style={{
              fontSize: 13,
              fontWeight: selected ? 600 : 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {displayName}
          </div>
        )}
        <div
          className="muted mono"
          style={{ fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          title={fullTime(s.last_transcript_at ?? s.started_at ?? s.created_at)}
        >
          {s.machine} · {relativeTime(s.last_transcript_at ?? s.started_at ?? s.created_at)}
        </div>
      </div>
      {isPending && !acked && (
        <button
          className="secondary"
          onClick={(e) => { e.stopPropagation(); props.onAck(); }}
          style={{ padding: "2px 6px", fontSize: 10 }}
          title="Acknowledge — demote from the needs-attention group"
        >Ack</button>
      )}
      {isPending && acked && (
        <button
          className="secondary"
          onClick={(e) => { e.stopPropagation(); props.onUnack(); }}
          style={{ padding: "2px 6px", fontSize: 10, opacity: 0.6 }}
          title="Un-acknowledge"
        >✓</button>
      )}
    </div>
  );
}

function shortCmd(s: Session): string {
  const label = s.cmd && s.cmd.length > 0 ? s.cmd : s.id;
  return label.length > 30 ? label.slice(0, 30) + "…" : label;
}
