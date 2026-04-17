import { useEffect, useState } from "react";
import { api, type KeyMeta } from "../api";
import { Modal } from "../components/Modal";
import { relativeTime, fullTime } from "../lib/time";

export function KeysPage() {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [err, setErr] = useState<string>("");
  const [showNew, setShowNew] = useState(false);
  const [inspect, setInspect] = useState<string | null>(null);

  const refresh = () => api.listKeys().then(setKeys).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => { refresh(); }, []);

  const onDelete = async (nickname: string) => {
    if (!confirm(`Delete key "${nickname}"? This cannot be undone.`)) return;
    try { await api.deleteKey(nickname); await refresh(); } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Keys</h1>
        <button onClick={() => setShowNew(true)}>New key</button>
      </div>
      {err && <div className="error-banner">{err}</div>}
      <div className="card" style={{ padding: 0 }}>
        {keys.length === 0 ? (
          <div className="empty">No keys yet. Create one to use with machines.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Nickname</th>
                <th>Fingerprint</th>
                <th>Source</th>
                <th>Created</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.nickname}>
                  <td>{k.nickname}</td>
                  <td className="mono">{k.fingerprint}</td>
                  <td>
                    <span className={`pill ${k.source === "generated" ? "" : "warn"}`}>{k.source}</span>
                  </td>
                  <td className="muted" title={fullTime(k.created_at)}>{relativeTime(k.created_at)}</td>
                  <td>
                    <div className="actions">
                      <button className="secondary" onClick={() => setInspect(k.nickname)}>View</button>
                      <button className="secondary" onClick={() => onDelete(k.nickname)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showNew && (
        <NewKeyModal
          onClose={() => setShowNew(false)}
          onDone={async () => { setShowNew(false); await refresh(); }}
        />
      )}
      {inspect && <KeyDetailModal nickname={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}

function NewKeyModal(props: { onClose: () => void; onDone: () => void | Promise<void> }) {
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [nickname, setNickname] = useState("");
  const [comment, setComment] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      await api.createKey({
        nickname,
        comment: comment || undefined,
        private_key: mode === "import" ? privateKey : undefined,
      });
      await props.onDone();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New key" onClose={props.onClose}>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row" style={{ marginBottom: 0 }}>
          <input type="radio" name="mode" checked={mode === "generate"} onChange={() => setMode("generate")} style={{ width: "auto" }} />
          <span style={{ marginBottom: 0 }}>Generate ed25519</span>
        </label>
        <label className="row" style={{ marginBottom: 0, marginLeft: 16 }}>
          <input type="radio" name="mode" checked={mode === "import"} onChange={() => setMode("import")} style={{ width: "auto" }} />
          <span style={{ marginBottom: 0 }}>Import existing</span>
        </label>
      </div>
      <label>
        <span>Nickname</span>
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. prod" autoFocus />
      </label>
      <label>
        <span>Comment (optional)</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={`botdock:${nickname || "..."}`} />
      </label>
      {mode === "import" && (
        <label>
          <span>OpenSSH private key</span>
          <textarea rows={8} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"} />
        </label>
      )}
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button disabled={submitting || !nickname || (mode === "import" && !privateKey)} onClick={submit}>
          {mode === "generate" ? "Generate" : "Import"}
        </button>
      </div>
    </Modal>
  );
}

function KeyDetailModal(props: { nickname: string; onClose: () => void }) {
  const [detail, setDetail] = useState<{ meta: KeyMeta; publicKey: string } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.getKey(props.nickname).then(setDetail).catch((e) => setErr(String(e?.message ?? e)));
  }, [props.nickname]);
  return (
    <Modal title={`Key: ${props.nickname}`} onClose={props.onClose}>
      {err && <div className="error-banner">{err}</div>}
      {detail && (
        <>
          <div className="mono" style={{ marginBottom: 8 }}>{detail.meta.fingerprint}</div>
          <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
            {detail.meta.source} · {detail.meta.comment}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>public key</div>
          <pre className="code">{detail.publicKey}</pre>
        </>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}
