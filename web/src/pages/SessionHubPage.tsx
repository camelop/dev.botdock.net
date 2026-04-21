import { useEffect, useMemo, useState } from "react";
import { api, type Session } from "../api";
import { SessionView, SessionConfigDialog } from "./SessionsPage";
import { AgentAvatar } from "./WarRoomPage";
import { isAcked, ackSession, unackSession } from "../lib/acks";
import { relativeTime, fullTime } from "../lib/time";
import { aliasColor } from "../lib/alias-colors";
import { SessionNameChip } from "../components/SessionNameChip";

/**
 * Three-column workspace:
 *   left   = grouped session list (pending / running / other) with aliases
 *   middle = terminal + send-input (SessionView's left pane)
 *   right  = meta + transcript + events (SessionView's right pane)
 */
export function SessionHubPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);  // force re-read of localStorage acks

  const [err, setErr] = useState<string>("");

  const refresh = async () => {
    try {
      const list = await api.listSessions();
      setSessions(list);
      setErr("");
      // Only react to *disappearance* of the current selection. When cur is
      // null we leave it null so the preselect effect below can consume a
      // pending hub-preselect hint; without this the first refresh would
      // race-to-list[0] and clobber the "Open in workspace" target.
      setSelected((cur) => {
        if (cur == null) return null;
        return list.find((s) => s.id === cur) ? cur : null;
      });
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  const pickDefault = (list: Session[]) => {
    const pending = list.find((s) => s.status === "active" && s.agent_kind === "claude-code"
      && s.activity === "pending" && !isAcked(s.id, s.last_transcript_at));
    if (pending) return pending.id;
    const running = list.find((s) => s.status === "active");
    if (running) return running.id;
    return list[0]?.id ?? null;
  };

  // On first mount, honor a preselect hint (set by the detail modal's
  // "Open in workspace" button) if it points at a still-present session.
  useEffect(() => {
    if (selected != null) return;
    if (sessions.length === 0) return;
    let preselect: string | null = null;
    try {
      preselect = sessionStorage.getItem("botdock:hub-preselect");
    } catch { /* private-browsing / no sessionStorage */ }
    if (preselect && sessions.find((s) => s.id === preselect)) {
      setSelected(preselect);
      try { sessionStorage.removeItem("botdock:hub-preselect"); } catch {}
    } else if (!preselect) {
      setSelected(pickDefault(sessions));
    }
    // If preselect is set but the session isn't yet in the list, leave it in
    // sessionStorage — the next refresh will pick it up.
  }, [sessions]);  // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const cmp = (a: Session, b: Session) => {
      const ta = a.last_transcript_at ?? a.started_at ?? a.created_at;
      const tb = b.last_transcript_at ?? b.started_at ?? b.created_at;
      return tb.localeCompare(ta);
    };

    const needsAttention: Session[] = [];   // overlay — duplicates OK
    const active: Session[] = [];           // active + no tags
    const tagMap = new Map<string, Session[]>();  // tag → sessions
    const other: Session[] = [];

    for (const s of sessions) {
      const isLive = s.status === "active" || s.status === "provisioning";
      const isPendingUnacked = s.status === "active"
        && s.agent_kind === "claude-code"
        && s.activity === "pending"
        && !isAcked(s.id, s.last_transcript_at);

      if (isPendingUnacked) needsAttention.push(s);

      // A session with tags shows up in EACH tag group (and NOT in the
      // catch-all "Active / Other"). Needs attention is an overlay on top
      // of that — it duplicates the pending session's appearance so the
      // user can see it both under a tag and in the attention group.
      const tags = (s.tags ?? []).filter((t) => t.length > 0);
      if (tags.length > 0) {
        for (const t of tags) {
          const bucket = tagMap.get(t) ?? [];
          bucket.push(s);
          tagMap.set(t, bucket);
        }
      } else if (isLive) {
        active.push(s);
      } else {
        other.push(s);
      }
    }

    needsAttention.sort(cmp);
    active.sort(cmp);
    other.sort(cmp);
    const tagGroups: Array<{ tag: string; sessions: Session[] }> = Array.from(tagMap.entries())
      .map(([tag, list]) => ({ tag, sessions: list.slice().sort(cmp) }))
      .sort((a, b) => a.tag.localeCompare(b.tag));

    return { needsAttention, active, tagGroups, other };
  }, [sessions, tick]);

  const onAck = (s: Session) => { ackSession(s.id, s.last_transcript_at); setTick((v) => v + 1); };
  const onUnack = (s: Session) => { unackSession(s.id); setTick((v) => v + 1); };
  // Merge a just-saved session back into state so the sidebar reflects the
  // alias / color / tag edit immediately without waiting for the 3s poll.
  const onSaved = (next: Session) => setSessions((cur) => cur.map((s) => s.id === next.id ? next : s));


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
        selectedId={selected}
        onSelect={(id) => setSelected(id)}
        onAck={onAck}
        onUnack={onUnack}
        onSaved={onSaved}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {err && (
          <div className="error-banner" style={{ margin: 10 }}>
            Workspace refresh failed: {err}
          </div>
        )}
        {selected ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
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

function HubSessionView({ id, onChange }: { id: string; onChange: () => void | Promise<void> }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
      <SessionView id={id} onChange={onChange} />
    </div>
  );
}

type SidebarCommonProps = {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAck: (s: Session) => void;
  onUnack: (s: Session) => void;
  onSaved: (s: Session) => void;
};

function SessionSidebar(props: SidebarCommonProps & {
  grouped: {
    needsAttention: Session[];
    active: Session[];
    tagGroups: Array<{ tag: string; sessions: Session[] }>;
    other: Session[];
  };
}) {
  const { grouped, ...rest } = props;
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
      <Group title="Needs attention" sessions={grouped.needsAttention} {...rest} />
      {grouped.tagGroups.map((g) => (
        <Group key={g.tag} title={`# ${g.tag}`} sessions={g.sessions} {...rest} />
      ))}
      <Group title="Active" sessions={grouped.active} {...rest} />
      <Group title="Other" sessions={grouped.other} {...rest} collapsedByDefault />
    </div>
  );
}

function Group(props: SidebarCommonProps & {
  title: string;
  sessions: Session[];
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
      {!collapsed && props.sessions.map((s, i) => (
        <SidebarRow
          key={`${s.id}:${i}`}
          session={s}
          selected={props.selectedId === s.id}
          onClick={() => props.onSelect(s.id)}
          onAck={() => props.onAck(s)}
          onUnack={() => props.onUnack(s)}
          onSaved={props.onSaved}
        />
      ))}
    </div>
  );
}

function SidebarRow(props: {
  session: Session;
  selected: boolean;
  onClick: () => void;
  onAck: () => void;
  onUnack: () => void;
  onSaved: (s: Session) => void;
}) {
  const { session: s, selected } = props;
  const isPending = s.status === "active" && s.agent_kind === "claude-code" && s.activity === "pending";
  const acked = isPending && isAcked(s.id, s.last_transcript_at);
  const color = aliasColor(s.alias_color);
  const hasColor = !!color && color.name !== "none";
  // Selection highlight: strong accent stripe + a subtle inset ring so the
  // row visibly stands out even when the user's eye is on another group
  // (a tagged session selected in one group should still be obviously
  // active in every other group it appears in).
  const [editing, setEditing] = useState(false);
  const selectionBg = selected ? "rgba(106,164,255,0.12)" : "transparent";
  const selectionBorder = color?.accent ?? "var(--accent)";

  return (
    <>
      <div
        onClick={props.onClick}
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title={`${s.id}${s.cmd ? " — " + s.cmd : ""}\n(double-click for config)`}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px",
          cursor: "pointer",
          background: selected ? selectionBg : "transparent",
          borderLeft: selected
            ? `4px solid ${selectionBorder}`
            : `3px solid ${hasColor ? (color!.accent) : "transparent"}`,
          boxShadow: selected ? `inset 0 0 0 1px ${selectionBorder}` : undefined,
          fontWeight: selected ? 600 : undefined,
        }}
      >
        <AgentAvatar session={s} size={32} acked={acked} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: selected ? 600 : 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            <SessionNameChip session={s} fallback={shortCmd(s)} size={13} />
          </div>
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
      {editing && (
        <SessionConfigDialog
          session={s}
          onClose={() => setEditing(false)}
          onSaved={(next) => { props.onSaved(next); setEditing(false); }}
        />
      )}
    </>
  );
}

function shortCmd(s: Session): string {
  const label = s.cmd && s.cmd.length > 0 ? s.cmd : s.id;
  return label.length > 30 ? label.slice(0, 30) + "…" : label;
}
