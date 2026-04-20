import { useEffect, useState } from "react";
import { api, type KeyMeta, type Machine, type SecretMeta, type Session } from "../api";
import { SessionDetailModal, NewSessionModal, freshDraft, type SessionDraft } from "./SessionsPage";
import { relativeTime, fullTime } from "../lib/time";
import { isAcked } from "../lib/acks";

export function DashboardPage() {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<SessionDraft | null>(null);
  const openNew = () => setDraft((cur) => cur ?? freshDraft(machines));

  const refresh = () =>
    Promise.all([api.listKeys(), api.listMachines(), api.listSecrets(), api.listSessions()])
      .then(([k, m, s, ss]) => { setKeys(k); setMachines(m); setSecrets(s); setSessions(ss); })
      .catch((e) => setErr(String(e?.message ?? e)));

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // Count sessions by observable state. "Active" = session is alive on
  // the remote. "Pending attention" = claude-code session whose agent has
  // finished its turn and is awaiting user input — and the user hasn't
  // already acknowledged this transcript (ack is keyed on last_transcript_at,
  // so it auto-invalidates on new output).
  const active = sessions.filter((s) => s.status === "active").length;
  const pending = sessions.filter(
    (s) => s.status === "active"
      && s.agent_kind === "claude-code"
      && s.activity === "pending"
      && !isAcked(s.id, s.last_transcript_at),
  ).length;
  const recent = sessions.slice(0, 8);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <button onClick={openNew} disabled={machines.length === 0}>
          {machines.length === 0 ? "Add a machine first" : "+ New session"}
        </button>
      </div>
      {err && <div className="error-banner">{err}</div>}

      <div className="card">
        <div className="row" style={{ gap: 40, flexWrap: "wrap" }}>
          <Stat label="Keys" value={keys.length} />
          <Stat label="Machines" value={machines.length} />
          <Stat label="Secrets" value={secrets.length} />
          <Separator />
          <Stat label="Active sessions" value={active} accent="ok" />
          <Stat label="Needs attention" value={pending} accent={pending > 0 ? "warn" : undefined} />
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: "12px 16px 8px" }}>Recent sessions</h2>
        {recent.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            Nothing yet. Go to Sessions to launch one.
          </div>
        ) : (
          <table className="table">
            <tbody>
              {recent.map((s) => (
                <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setSelected(s.id)}>
                  <td className="mono">{s.id}</td>
                  <td><DashboardPill session={s} /></td>
                  <td>{s.machine}</td>
                  <td className="mono" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.cmd}
                  </td>
                  <td className="muted" title={fullTime(s.started_at ?? s.created_at)}>
                    {relativeTime(s.started_at ?? s.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <SessionDetailModal
          id={selected}
          onClose={() => setSelected(null)}
          onChange={refresh}
        />
      )}

      {draft && (
        <NewSessionModal
          machines={machines}
          draft={draft}
          onDraft={setDraft}
          onCancel={() => setDraft(null)}
          onDone={async (id) => {
            setDraft(null);
            await refresh();
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}

function DashboardPill({ session: s }: { session: Session }) {
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

function Stat({ label, value, accent }: { label: string; value: number; accent?: "ok" | "warn" | "err" }) {
  const color = accent === "ok" ? "var(--ok)" : accent === "warn" ? "var(--warn)" : accent === "err" ? "var(--danger)" : "var(--fg)";
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

function Separator() {
  return <div style={{ width: 1, background: "var(--border)", alignSelf: "stretch" }} />;
}
