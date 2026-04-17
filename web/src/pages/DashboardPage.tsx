import { useEffect, useState } from "react";
import { api, type KeyMeta, type Machine, type SecretMeta } from "../api";

export function DashboardPage() {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    Promise.all([api.listKeys(), api.listMachines(), api.listSecrets()])
      .then(([k, m, s]) => { setKeys(k); setMachines(m); setSecrets(s); })
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      {err && <div className="error-banner">{err}</div>}
      <div className="card">
        <div className="row" style={{ gap: 32 }}>
          <Stat label="Keys" value={keys.length} />
          <Stat label="Machines" value={machines.length} />
          <Stat label="Secrets" value={secrets.length} />
          <Stat label="Sessions" value={0} />
        </div>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sessions</h2>
        <div className="empty">Session orchestration lands in M2 / M3.</div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
