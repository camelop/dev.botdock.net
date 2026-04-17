import { useEffect, useState } from "react";
import { api, type KeyMeta, type Machine, type SecretMeta, type Session } from "../api";

export function DashboardPage() {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState<string>("");

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
  const recent = sessions.slice(0, 6);

  return (
    <div>
      <h1>Dashboard</h1>
      {err && <div className="error-banner">{err}</div>}
      <div className="card">
        <div className="row" style={{ gap: 32 }}>
          <Stat label="Keys" value={keys.length} />
          <Stat label="Machines" value={machines.length} />
          <Stat label="Secrets" value={secrets.length} />
          <Stat label="Sessions (running)" value={running} total={sessions.length} />
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: "12px 16px 8px" }}>Recent sessions</h2>
        {recent.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>Nothing yet. Go to Sessions to launch one.</div>
        ) : (
          <table className="table">
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td><span className={`pill ${s.status === "running" ? "ok" : s.status === "failed_to_start" ? "err" : ""}`}>{s.status}</span></td>
                  <td>{s.machine}</td>
                  <td className="mono" style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.cmd}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, total }: { label: string; value: number; total?: number }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600 }}>
        {value}
        {total !== undefined && <span className="muted" style={{ fontSize: 14, marginLeft: 4 }}>/ {total}</span>}
      </div>
    </div>
  );
}
