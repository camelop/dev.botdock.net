import { useEffect, useState } from "react";
import { api, type KeyMeta, type Machine, type SecretMeta, type Session } from "../api";
import { SessionDetailModal } from "./SessionsPage";
import { relativeTime, fullTime } from "../lib/time";

export function DashboardPage() {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([api.listKeys(), api.listMachines(), api.listSecrets(), api.listSessions()])
      .then(([k, m, s, ss]) => { setKeys(k); setMachines(m); setSecrets(s); setSessions(ss); })
      .catch((e) => setErr(String(e?.message ?? e)));

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const running = sessions.filter((s) => s.status === "running").length;
  const pending = sessions.filter((s) => s.status === "provisioning").length;
  const recent = sessions.slice(0, 8);

  return (
    <div>
      <h1>Dashboard</h1>
      {err && <div className="error-banner">{err}</div>}

      <div className="card">
        <div className="row" style={{ gap: 40, flexWrap: "wrap" }}>
          <Stat label="Keys" value={keys.length} />
          <Stat label="Machines" value={machines.length} />
          <Stat label="Secrets" value={secrets.length} />
          <Separator />
          <Stat label="Running sessions" value={running} accent="ok" />
          <Stat label="Pending" value={pending} accent={pending > 0 ? "warn" : undefined} />
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
                  <td>
                    <span className={`pill ${
                      s.status === "running" ? "ok" :
                      s.status === "failed_to_start" ? "err" :
                      s.status === "provisioning" ? "warn" : ""
                    }`}>
                      {s.status}
                    </span>
                  </td>
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
    </div>
  );
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
