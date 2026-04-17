import { useEffect, useState } from "react";
import { api, type SecretMeta } from "../api";
import { Modal } from "../components/Modal";
import { relativeTime, fullTime } from "../lib/time";

export function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<{ name: string } | "new" | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);

  const refresh = () => api.listSecrets().then(setSecrets).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => { refresh(); }, []);

  const onDelete = async (name: string) => {
    if (!confirm(`Delete secret "${name}"?`)) return;
    try { await api.deleteSecret(name); await refresh(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Secrets</h1>
        <button onClick={() => setEditing("new")}>New secret</button>
      </div>
      {err && <div className="error-banner">{err}</div>}
      <div className="card" style={{ padding: 0 }}>
        {secrets.length === 0 ? (
          <div className="empty">No secrets yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Size</th>
                <th>Updated</th>
                <th style={{ width: 260 }}></th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className="muted">{s.description || <span className="muted">—</span>}</td>
                  <td className="mono">{s.byte_length}B</td>
                  <td className="muted" title={fullTime(s.updated_at)}>{relativeTime(s.updated_at)}</td>
                  <td>
                    <div className="actions">
                      <button className="secondary" onClick={() => setRevealing(s.name)}>Reveal</button>
                      <button className="secondary" onClick={() => setEditing({ name: s.name })}>Edit</button>
                      <button className="secondary" onClick={() => onDelete(s.name)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <SecretEditor
          target={editing}
          onClose={() => setEditing(null)}
          onDone={async () => { setEditing(null); await refresh(); }}
        />
      )}
      {revealing && <RevealModal name={revealing} onClose={() => setRevealing(null)} />}
    </div>
  );
}

function SecretEditor(props: {
  target: "new" | { name: string };
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const isNew = props.target === "new";
  const [name, setName] = useState(isNew ? "" : (props.target as { name: string }).name);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isNew) {
      api.getSecret((props.target as { name: string }).name)
        .then((m) => setDescription(m.description))
        .catch((e) => setErr(String((e as Error).message ?? e)));
    }
  }, []);

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      if (isNew) await api.createSecret({ name, value, description: description || undefined });
      else await api.updateSecret((props.target as { name: string }).name, { value, description: description || undefined });
      await props.onDone();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={isNew ? "New secret" : `Edit: ${(props.target as { name: string }).name}`} onClose={props.onClose}>
      {isNew && (
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
      )}
      <label>
        <span>Description (optional)</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        <span>Value {isNew ? "" : "(enter new value to replace)"}</span>
        <textarea rows={5} value={value} onChange={(e) => setValue(e.target.value)} placeholder="secret value…" />
      </label>
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button disabled={submitting || !name || !value} onClick={submit}>{isNew ? "Create" : "Save"}</button>
      </div>
    </Modal>
  );
}

function RevealModal(props: { name: string; onClose: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const reveal = async () => {
    try {
      const { value } = await api.getSecretValue(props.name);
      setValue(value);
      setConfirmed(true);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  return (
    <Modal title={`Secret: ${props.name}`} onClose={props.onClose}>
      {!confirmed ? (
        <>
          <div className="muted" style={{ marginBottom: 10 }}>
            The secret value will be shown in plain text. Make sure nothing is watching your screen.
          </div>
          {err && <div className="error-banner">{err}</div>}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button className="secondary" onClick={props.onClose}>Cancel</button>
            <button onClick={reveal}>Reveal</button>
          </div>
        </>
      ) : (
        <>
          <pre className="code" style={{ maxHeight: 240 }}>{value}</pre>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button className="secondary" onClick={() => navigator.clipboard.writeText(value ?? "")}>Copy</button>
            <button onClick={props.onClose}>Close</button>
          </div>
        </>
      )}
    </Modal>
  );
}
