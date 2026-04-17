import { useEffect, useState } from "react";
import { api, type Machine, type JumpHop, type KeyMeta, type TestResult } from "../api";
import { Modal } from "../components/Modal";

type EditTarget = { mode: "new" } | { mode: "edit"; name: string } | null;

export function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<EditTarget>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; result: TestResult } | null>(null);

  const refresh = async () => {
    try {
      const [ms, ks] = await Promise.all([api.listMachines(), api.listKeys()]);
      setMachines(ms); setKeys(ks);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  useEffect(() => { refresh(); }, []);

  const onDelete = async (name: string) => {
    if (!confirm(`Remove machine "${name}"?`)) return;
    try { await api.deleteMachine(name); await refresh(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  const onTest = async (name: string) => {
    setTesting(name); setErr("");
    try {
      const result = await api.testMachine(name);
      setTestResult({ name, result });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Machines</h1>
        <button onClick={() => setEdit({ mode: "new" })}>New machine</button>
      </div>
      {err && <div className="error-banner">{err}</div>}
      <div className="card" style={{ padding: 0 }}>
        {machines.length === 0 ? (
          <div className="empty">No machines yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Key</th>
                <th>Hops</th>
                <th>Tags</th>
                <th style={{ width: 240 }}></th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => (
                <tr key={m.name}>
                  <td>{m.name}</td>
                  <td className="mono">{m.user}@{m.host}:{m.port ?? 22}</td>
                  <td className="mono">{m.key}</td>
                  <td>{m.jump?.length ?? 0}</td>
                  <td>{m.tags?.map((t) => <span key={t} className="pill" style={{ marginRight: 4 }}>{t}</span>)}</td>
                  <td>
                    <div className="actions">
                      <button className="secondary" disabled={testing === m.name} onClick={() => onTest(m.name)}>
                        {testing === m.name ? "testing…" : "test"}
                      </button>
                      <button className="secondary" onClick={() => setEdit({ mode: "edit", name: m.name })}>Edit</button>
                      <button className="secondary" onClick={() => onDelete(m.name)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <MachineEditor
          target={edit}
          keys={keys}
          onClose={() => setEdit(null)}
          onDone={async () => { setEdit(null); await refresh(); }}
        />
      )}
      {testResult && (
        <Modal title={`Test: ${testResult.name}`} onClose={() => setTestResult(null)}>
          <div style={{ marginBottom: 10 }}>
            {testResult.result.ok
              ? <span className="pill ok">reachable</span>
              : <span className="pill err">failed (exit {testResult.result.exit_code})</span>}
            <span className="muted" style={{ marginLeft: 8 }}>{testResult.result.hops} hop(s)</span>
          </div>
          {testResult.result.stdout && (
            <>
              <div className="muted" style={{ fontSize: 12 }}>stdout</div>
              <pre className="code">{testResult.result.stdout}</pre>
            </>
          )}
          {testResult.result.stderr && (
            <>
              <div className="muted" style={{ fontSize: 12 }}>stderr</div>
              <pre className="code">{testResult.result.stderr}</pre>
            </>
          )}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={() => setTestResult(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function blankMachine(): Machine {
  return { name: "", host: "", user: "", key: "" };
}

function MachineEditor(props: {
  target: Exclude<EditTarget, null>;
  keys: KeyMeta[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [m, setM] = useState<Machine>(blankMachine());
  const [tagStr, setTagStr] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (props.target.mode === "edit") {
      api.getMachine(props.target.name).then((loaded) => {
        setM(loaded);
        setTagStr((loaded.tags ?? []).join(", "));
      }).catch((e) => setErr(String((e as Error).message ?? e)));
    }
  }, []);

  const setField = <K extends keyof Machine>(k: K, v: Machine[K]) =>
    setM((cur) => ({ ...cur, [k]: v }));

  const setHop = (i: number, patch: Partial<JumpHop>) =>
    setM((cur) => ({
      ...cur,
      jump: (cur.jump ?? []).map((h, idx) => (idx === i ? { ...h, ...patch } : h)),
    }));

  const addHop = () =>
    setM((cur) => ({ ...cur, jump: [...(cur.jump ?? []), { host: "", user: "", key: "" }] }));

  const removeHop = (i: number) =>
    setM((cur) => ({ ...cur, jump: (cur.jump ?? []).filter((_, idx) => idx !== i) }));

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      const payload: Machine = {
        ...m,
        tags: tagStr.split(",").map((s) => s.trim()).filter(Boolean),
      };
      if (!payload.tags?.length) delete payload.tags;
      if (!payload.jump?.length) delete payload.jump;
      if (props.target.mode === "new") await api.createMachine(payload);
      else await api.updateMachine(props.target.name, payload);
      await props.onDone();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  const keyOptions = props.keys.map((k) => k.nickname);

  return (
    <Modal title={props.target.mode === "new" ? "New machine" : `Edit: ${props.target.name}`} onClose={props.onClose}>
      <div className="row" style={{ gap: 10 }}>
        <label className="grow">
          <span>Name</span>
          <input
            value={m.name}
            disabled={props.target.mode === "edit"}
            onChange={(e) => setField("name", e.target.value)}
          />
        </label>
        <label style={{ width: 120 }}>
          <span>Port</span>
          <input type="number" value={m.port ?? ""} onChange={(e) => setField("port", e.target.value ? Number(e.target.value) : undefined)} placeholder="22" />
        </label>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <label className="grow">
          <span>Host</span>
          <input value={m.host} onChange={(e) => setField("host", e.target.value)} />
        </label>
        <label className="grow">
          <span>User</span>
          <input value={m.user} onChange={(e) => setField("user", e.target.value)} />
        </label>
      </div>
      <label>
        <span>Key</span>
        <KeySelect value={m.key} options={keyOptions} onChange={(v) => setField("key", v)} />
      </label>
      <label>
        <span>Tags (comma-separated)</span>
        <input value={tagStr} onChange={(e) => setTagStr(e.target.value)} placeholder="gpu, prod" />
      </label>
      <label>
        <span>Notes</span>
        <textarea rows={2} value={m.notes ?? ""} onChange={(e) => setField("notes", e.target.value || undefined)} />
      </label>

      <div style={{ marginTop: 8 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>Jump hops (applied in order)</div>
          <button className="secondary" onClick={addHop}>Add hop</button>
        </div>
        {(m.jump ?? []).map((hop, i) => (
          <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <label className="grow">
                <span>Host</span>
                <input value={hop.host} onChange={(e) => setHop(i, { host: e.target.value })} />
              </label>
              <label className="grow">
                <span>User</span>
                <input value={hop.user} onChange={(e) => setHop(i, { user: e.target.value })} />
              </label>
              <label style={{ width: 100 }}>
                <span>Port</span>
                <input type="number" value={hop.port ?? ""} onChange={(e) => setHop(i, { port: e.target.value ? Number(e.target.value) : undefined })} />
              </label>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 4, alignItems: "flex-end" }}>
              <label className="grow">
                <span>Key</span>
                <KeySelect value={hop.key} options={keyOptions} onChange={(v) => setHop(i, { key: v })} />
              </label>
              <button className="secondary" onClick={() => removeHop(i)}>remove hop</button>
            </div>
          </div>
        ))}
      </div>

      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button disabled={submitting || !m.name || !m.host || !m.user || !m.key} onClick={submit}>
          {props.target.mode === "new" ? "Create" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function KeySelect(props: { value: string; options: string[]; onChange: (v: string) => void }) {
  if (props.options.length === 0) {
    return <input disabled placeholder="No keys — create one first" />;
  }
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="" disabled>Select a key…</option>
      {props.options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
