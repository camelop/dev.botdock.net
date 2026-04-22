import { useEffect, useState } from "react";
import { api, type GitRepoResource, type KeyMeta } from "../api";
import { Modal } from "../components/Modal";
import { relativeTime, fullTime } from "../lib/time";

type EditTarget = { mode: "new" } | { mode: "edit"; name: string } | null;

export function GitReposPage() {
  const [repos, setRepos] = useState<GitRepoResource[]>([]);
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<EditTarget>(null);

  const refresh = async () => {
    try {
      const [rs, ks] = await Promise.all([api.listGitRepos(), api.listKeys()]);
      setRepos(rs); setKeys(ks);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  useEffect(() => { refresh(); }, []);

  const onDelete = async (name: string) => {
    if (!confirm(`Delete git-repo "${name}"?`)) return;
    try { await api.deleteGitRepo(name); await refresh(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Git Repos</h1>
        <button onClick={() => setEdit({ mode: "new" })}>➕ New git-repo</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Registered git repositories the BotDock host can push to a session.
        BotDock doesn't clone anything itself — the meta is mirrored into
        <code className="mono">{" "}.botdock/resources/git-repo/</code>{" "}
        on the remote and an agent-side skill does the `git clone`.
      </div>
      {err && <div className="error-banner">{err}</div>}
      <div className="card" style={{ padding: 0 }}>
        {repos.length === 0 ? (
          <div className="empty">No git repos yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Ref</th>
                <th>Deploy key</th>
                <th>Tags</th>
                <th>Updated</th>
                <th style={{ width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="mono" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.url}</td>
                  <td className="mono">{r.ref || <span className="muted">(default)</span>}</td>
                  <td className="mono">{r.deploy_key || <span className="muted">—</span>}</td>
                  <td>{r.tags?.map((t) => <span key={t} className="pill" style={{ marginRight: 4 }}>{t}</span>)}</td>
                  <td className="muted" title={fullTime(r.updated_at)}>{relativeTime(r.updated_at)}</td>
                  <td>
                    <div className="actions">
                      <button className="secondary" onClick={() => setEdit({ mode: "edit", name: r.name })}>Edit</button>
                      <button className="secondary" onClick={() => onDelete(r.name)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <GitRepoEditor
          target={edit}
          keys={keys}
          onClose={() => setEdit(null)}
          onDone={async () => { setEdit(null); await refresh(); }}
        />
      )}
    </div>
  );
}

function GitRepoEditor(props: {
  target: Exclude<EditTarget, null>;
  keys: KeyMeta[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [r, setR] = useState<GitRepoResource>(blank());
  const [tagStr, setTagStr] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (props.target.mode === "edit") {
      api.getGitRepo(props.target.name).then((loaded) => {
        setR(loaded);
        setTagStr((loaded.tags ?? []).join(", "));
      }).catch((e) => setErr(String((e as Error).message ?? e)));
    }
  }, []);

  const set = <K extends keyof GitRepoResource>(k: K, v: GitRepoResource[K]) =>
    setR((cur) => ({ ...cur, [k]: v }));

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      const tags = tagStr.split(",").map((s) => s.trim()).filter(Boolean);
      const payload: Partial<GitRepoResource> = {
        name: r.name,
        url: r.url,
        ref: r.ref?.trim() || undefined,
        deploy_key: r.deploy_key?.trim() || undefined,
        tags: tags.length ? tags : undefined,
      };
      if (props.target.mode === "new") {
        await api.createGitRepo(payload as { name: string; url: string });
      } else {
        await api.updateGitRepo(props.target.name, payload);
      }
      await props.onDone();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={props.target.mode === "new" ? "New git-repo" : `Edit: ${props.target.name}`}
      onClose={props.onClose}
    >
      <label>
        <span>Name</span>
        <input
          value={r.name}
          disabled={props.target.mode === "edit"}
          placeholder="botdock-main"
          onChange={(e) => set("name", e.target.value)}
        />
      </label>
      <label>
        <span>URL</span>
        <input
          value={r.url}
          placeholder="git@github.com:owner/repo.git"
          onChange={(e) => set("url", e.target.value)}
        />
      </label>
      <label>
        <span>Ref <span className="muted">(branch / tag / SHA — optional)</span></span>
        <input
          value={r.ref ?? ""}
          placeholder="main"
          onChange={(e) => set("ref", e.target.value)}
        />
      </label>
      <label>
        <span>Deploy key <span className="muted">(optional — pushed with the repo at session time if you opt in)</span></span>
        <select value={r.deploy_key ?? ""} onChange={(e) => set("deploy_key", e.target.value || undefined)}>
          <option value="">(none)</option>
          {props.keys.map((k) => <option key={k.nickname} value={k.nickname}>{k.nickname}</option>)}
        </select>
      </label>
      <label>
        <span>Tags <span className="muted">(comma-separated)</span></span>
        <input
          value={tagStr}
          placeholder="internal, docs"
          onChange={(e) => setTagStr(e.target.value)}
        />
      </label>
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button onClick={submit} disabled={submitting || !r.name || !r.url}>
          {submitting ? "Saving…" : props.target.mode === "new" ? "Create" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function blank(): GitRepoResource {
  return {
    name: "",
    url: "",
    created_at: "",
    updated_at: "",
  };
}
