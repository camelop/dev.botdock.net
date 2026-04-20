import { useEffect, useMemo, useState } from "react";
import Avatar from "boring-avatars";
import { api, type Session } from "../api";
import { SessionDetailModal } from "./SessionsPage";
import { parseTranscript, type TranscriptTurn } from "../lib/transcript";
import { relativeTime, fullTime } from "../lib/time";
import { isAcked, ackSession, unackSession } from "../lib/acks";

const AVATAR_PALETTE = ["#6aa4ff", "#6ecf6e", "#f2b94b", "#c47fd6", "#4bd0c7"];

export function WarRoomPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [turnsBySession, setTurnsBySession] = useState<Record<string, TranscriptTurn[]>>({});
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"grid" | "geo">("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const [ackTick, setAckTick] = useState(0); // force re-read of localStorage after ack/unack
  const [showAcked, setShowAcked] = useState(false);

  const refresh = async () => {
    try {
      const list = await api.listSessions();
      setSessions(list);
      // Fetch recent turns for every session in parallel — cheap per session.
      const updates: Record<string, TranscriptTurn[]> = {};
      await Promise.all(
        list.map(async (s) => {
          if (s.agent_kind !== "claude-code") return;
          if (s.status === "exited" || s.status === "failed_to_start") {
            // Still fetch once in case transcript has history worth showing.
          }
          try {
            const r = await api.getSessionRecentTurns(s.id, 20);
            // Server returns raw JSONL objects; parse into turns.
            const jsonl = r.turns.map((t) => JSON.stringify(t)).join("\n");
            updates[s.id] = parseTranscript(jsonl);
          } catch { /* drop per-session errors silently */ }
        }),
      );
      setTurnsBySession((cur) => ({ ...cur, ...updates }));
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // Needs-attention = pending claude-code sessions that user hasn't acked
  // for this particular transcript state.
  const needsAttention = sessions.filter(
    (s) => s.status === "active"
      && s.agent_kind === "claude-code"
      && s.activity === "pending"
      && !isAcked(s.id, s.last_transcript_at),
  );

  // Order: needs-attention first, then other active, then everything else.
  const ordered = useMemo(() => {
    const score = (s: Session) => {
      if (s.status === "active" && s.agent_kind === "claude-code"
          && s.activity === "pending" && !isAcked(s.id, s.last_transcript_at)) return 0;
      if (s.status === "active") return 1;
      if (s.status === "provisioning") return 2;
      if (s.status === "exited") return 3;
      return 4;
    };
    return [...sessions].sort((a, b) => {
      const d = score(a) - score(b);
      if (d !== 0) return d;
      return (b.last_transcript_at ?? b.started_at ?? b.created_at)
        .localeCompare(a.last_transcript_at ?? a.started_at ?? a.created_at);
    });
  }, [sessions, ackTick]);

  const onAck = (s: Session) => { ackSession(s.id, s.last_transcript_at); setAckTick((v) => v + 1); };
  const onUnack = (s: Session) => { unackSession(s.id); setAckTick((v) => v + 1); };

  const visibleSessions = showAcked
    ? ordered
    : ordered.filter((s) => !(s.status === "exited" || s.status === "failed_to_start"));

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>War Room</h1>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="secondary"
            onClick={() => setMode(mode === "grid" ? "geo" : "grid")}
            title="Switch layout"
          >{mode === "grid" ? "Geographic view" : "Grid view"}</button>
          <button
            className="secondary"
            onClick={() => setShowAcked((v) => !v)}
          >{showAcked ? "Hide finished" : "Show finished"}</button>
        </div>
      </div>
      {err && <div className="error-banner">{err}</div>}

      {needsAttention.length > 0 && (
        <div
          className="card"
          style={{
            borderColor: "rgba(242,185,75,0.4)",
            background: "rgba(242,185,75,0.06)",
            marginBottom: 16,
          }}
        >
          <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 20 }}>⚠</span>
            <strong style={{ fontSize: 14 }}>
              {needsAttention.length} {needsAttention.length === 1 ? "agent is" : "agents are"} waiting on you
            </strong>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {needsAttention.map((s) => (
              <div
                key={s.id}
                onClick={() => setSelected(s.id)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "4px 10px 4px 6px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 18,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                <AgentAvatar session={s} size={26} />
                <span className="mono">{shortLabel(s)}</span>
                <button
                  className="secondary"
                  style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={(e) => { e.stopPropagation(); onAck(s); }}
                  title="Mark as seen; hides this card until the agent posts again"
                >Ack</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {visibleSessions.length === 0 ? (
        <div className="card">
          <div className="empty">No sessions to show. Create one from Sessions → List.</div>
        </div>
      ) : mode === "grid" ? (
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          }}
        >
          {visibleSessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              turns={turnsBySession[s.id] ?? []}
              onOpen={() => setSelected(s.id)}
              onAck={() => onAck(s)}
              onUnack={() => onUnack(s)}
            />
          ))}
        </div>
      ) : (
        <GeographicView
          sessions={visibleSessions}
          turnsBySession={turnsBySession}
          onOpen={(id) => setSelected(id)}
          onAck={onAck}
          onUnack={onUnack}
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

function shortLabel(s: Session): string {
  if (s.agent_kind === "claude-code") {
    if (s.cmd) return s.cmd.length > 36 ? s.cmd.slice(0, 36) + "…" : s.cmd;
    return s.id;
  }
  return s.id;
}

export function AgentAvatar({ session, size = 40, acked = false }: {
  session: Session; size?: number; acked?: boolean;
}) {
  const state = badgeState(session, acked);
  const badgeSize = Math.max(14, Math.round(size * 0.38));
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <Avatar
        size={size}
        name={session.id}
        variant="beam"
        colors={AVATAR_PALETTE}
      />
      <span
        title={badgeLabel(state)}
        className={`agent-badge state-${state}`}
        style={{
          width: badgeSize, height: badgeSize,
          fontSize: Math.max(9, Math.round(badgeSize * 0.65)),
        }}
      />
    </div>
  );
}

export type AgentBadgeState =
  | "active"
  | "exited"
  | "failed"
  | "provisioning"
  | "running"
  | "pending"
  | "pending-acked";

export function badgeState(s: Session, acked: boolean): AgentBadgeState {
  if (s.status === "exited") return "exited";
  if (s.status === "failed_to_start") return "failed";
  if (s.status === "provisioning") return "provisioning";
  if (s.agent_kind === "claude-code" && s.activity === "pending") return acked ? "pending-acked" : "pending";
  if (s.agent_kind === "claude-code" && s.activity === "running") return "running";
  return "active";
}

function badgeLabel(state: AgentBadgeState): string {
  switch (state) {
    case "running":       return "agent is working";
    case "pending":       return "agent waiting on you";
    case "pending-acked": return "pending (acknowledged)";
    case "provisioning":  return "provisioning";
    case "exited":        return "exited";
    case "failed":        return "failed to start";
    case "active":        return "active";
  }
}

function SessionCard(props: {
  session: Session;
  turns: TranscriptTurn[];
  onOpen: () => void;
  onAck: () => void;
  onUnack: () => void;
}) {
  const { session: s, turns } = props;
  const summary = useMemo(() => summarizeTurns(turns), [turns]);
  const isPending = s.status === "active" && s.agent_kind === "claude-code"
    && s.activity === "pending";
  const acked = isPending && isAcked(s.id, s.last_transcript_at);

  return (
    <div
      className="card"
      style={{
        display: "flex", flexDirection: "column", gap: 8,
        cursor: "pointer",
        border: isPending && !acked ? "1px solid rgba(242,185,75,0.45)" : undefined,
      }}
      onClick={props.onOpen}
    >
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <AgentAvatar session={s} size={40} acked={acked} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {shortLabel(s)}
          </div>
          <div className="muted mono" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {s.machine} · {s.workdir}
          </div>
        </div>
        <div className="row" style={{ gap: 4, alignItems: "center", flexShrink: 0 }}>
          {isPending && !acked && (
            <button
              className="secondary"
              style={{ padding: "3px 8px", fontSize: 11 }}
              onClick={(e) => { e.stopPropagation(); props.onAck(); }}
              title="Ack this pending state; it'll re-surface if the agent posts again"
            >Ack</button>
          )}
          {isPending && acked && (
            <button
              className="secondary"
              style={{ padding: "3px 8px", fontSize: 11, opacity: 0.7 }}
              onClick={(e) => { e.stopPropagation(); props.onUnack(); }}
              title="Un-acknowledge — put this back on the needs-attention list"
            >✓</button>
          )}
        </div>
      </div>

      {summary.latestUser && (
        <div>
          <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>you</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.4, whiteSpace: "pre-wrap", maxHeight: 72, overflow: "hidden" }}>
            {summary.latestUser}
          </div>
        </div>
      )}
      {summary.latestAssistant && (
        <div>
          <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>agent</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.4, whiteSpace: "pre-wrap", maxHeight: 96, overflow: "hidden" }}>
            {summary.latestAssistant}
          </div>
        </div>
      )}
      {!summary.latestUser && !summary.latestAssistant && (
        <div className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>
          No conversation yet.
        </div>
      )}

      <div className="muted" style={{ fontSize: 11, marginTop: "auto" }}>
        <span title={fullTime(s.last_transcript_at ?? s.started_at ?? s.created_at)}>
          updated {relativeTime(s.last_transcript_at ?? s.started_at ?? s.created_at)}
        </span>
        {summary.toolHint && <> · {summary.toolHint}</>}
      </div>
    </div>
  );
}

/**
 * Distill a transcript into what's useful for a glance:
 *   - latestUser: most recent user text request (skipping tool_result turns)
 *   - latestAssistant: most recent assistant text (skipping turns that are
 *     just tool_use with no explanatory text)
 *   - toolHint: if the last assistant turn contained a tool_use, name it so
 *     the card can render "using Bash" etc.
 */
function summarizeTurns(turns: TranscriptTurn[]): { latestUser?: string; latestAssistant?: string; toolHint?: string } {
  const out: { latestUser?: string; latestAssistant?: string; toolHint?: string } = {};
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.kind === "user" && !out.latestUser) {
      const text = t.blocks.find((b) => b.type === "text" && b.text.trim());
      if (text && text.type === "text") out.latestUser = text.text.trim();
    }
    if (t.kind === "assistant" && !out.latestAssistant) {
      const text = t.blocks.find((b) => b.type === "text" && b.text.trim());
      if (text && text.type === "text") out.latestAssistant = text.text.trim();
      const tool = t.blocks.find((b) => b.type === "tool_use");
      if (!out.toolHint && tool && tool.type === "tool_use") out.toolHint = `using ${tool.name}`;
    }
    if (out.latestUser && out.latestAssistant) break;
  }
  return out;
}

function GeographicView(props: {
  sessions: Session[];
  turnsBySession: Record<string, TranscriptTurn[]>;
  onOpen: (id: string) => void;
  onAck: (s: Session) => void;
  onUnack: (s: Session) => void;
}) {
  // machine → workdir → sessions
  const tree = useMemo(() => {
    const byMachine: Record<string, Record<string, Session[]>> = {};
    for (const s of props.sessions) {
      const m = byMachine[s.machine] ?? (byMachine[s.machine] = {});
      (m[s.workdir] ?? (m[s.workdir] = [])).push(s);
    }
    return byMachine;
  }, [props.sessions]);

  const machines = Object.keys(tree).sort();
  if (machines.length === 0) {
    return (
      <div className="card"><div className="empty">No sessions.</div></div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {machines.map((m) => {
        const workdirs = Object.keys(tree[m]!).sort();
        return (
          <div key={m}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              {m}
              <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                {workdirs.length} workdir{workdirs.length === 1 ? "" : "s"}
              </span>
            </div>
            {workdirs.map((w) => {
              const sessions = tree[m]![w]!;
              return (
                <div key={w} style={{ marginBottom: 12, paddingLeft: 14, borderLeft: "2px solid var(--border)" }}>
                  <div className="muted mono" style={{ fontSize: 12, marginBottom: 6 }}>{w}</div>
                  <div style={{
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                  }}>
                    {sessions.map((s) => (
                      <SessionCard
                        key={s.id}
                        session={s}
                        turns={props.turnsBySession[s.id] ?? []}
                        onOpen={() => props.onOpen(s.id)}
                        onAck={() => props.onAck(s)}
                        onUnack={() => props.onUnack(s)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
