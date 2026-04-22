import { useEffect, useMemo, useRef, useState } from "react";
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
          onKeysChanged={async () => {
            try { setKeys(await api.listKeys()); } catch { /* non-fatal */ }
          }}
          onClose={() => setEdit(null)}
          onDone={async () => { setEdit(null); await refresh(); }}
        />
      )}
    </div>
  );
}

/** Pull a repo name out of common clone-URL shapes. Returns "" for
 *  anything that wouldn't pass BotDock's safe-name regex so the user is
 *  prompted to pick one explicitly instead of starting with a junk name. */
function deriveNameFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  // Strip protocol + auth; grab the last non-empty path segment.
  const stripped = trimmed
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const seg = stripped.split(/[\/:]/).filter(Boolean).pop() ?? "";
  if (!seg) return "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(seg)) return "";
  return seg;
}

function GitRepoEditor(props: {
  target: Exclude<EditTarget, null>;
  keys: KeyMeta[];
  onKeysChanged: () => void | Promise<void>;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [r, setR] = useState<GitRepoResource>(blank());
  const [tagStr, setTagStr] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Branch-probe state — populated by a debounced call whenever the URL
  // (or deploy_key) changes and is non-empty. On success we drop the user
  // into a select-of-branches with the remote's default preselected; the
  // raw-text fallback stays available so SHAs / tags still work.
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState("");
  // Has the user typed in the Name field? Flips on first edit and locks
  // out URL-driven auto-fill so we never clobber the user's typing.
  const nameEdited = useRef(props.target.mode === "edit");
  const [showPub, setShowPub] = useState(false);
  const [pub, setPub] = useState<string>("");
  const [pubErr, setPubErr] = useState("");
  const [newKeyModal, setNewKeyModal] = useState(false);

  useEffect(() => {
    if (props.target.mode === "edit") {
      api.getGitRepo(props.target.name).then((loaded) => {
        setR(loaded);
        setTagStr((loaded.tags ?? []).join(", "));
      }).catch((e) => setErr(String((e as Error).message ?? e)));
    }
  }, []);

  // Debounced branch probe. Triggers on URL / deploy_key change in BOTH
  // new and edit modes — edit mode is where you're most likely to want to
  // switch from a stale branch to whatever the upstream default is now.
  useEffect(() => {
    if (!r.url || !r.url.trim()) {
      setBranches([]); setDefaultBranch(null); setProbeErr(""); setProbing(false);
      return;
    }
    let cancelled = false;
    setProbeErr("");
    setProbing(true);
    const t = window.setTimeout(async () => {
      try {
        const out = await api.probeGitRepo({
          url: r.url.trim(),
          deploy_key: r.deploy_key || undefined,
        });
        if (cancelled) return;
        setBranches(out.branches);
        setDefaultBranch(out.default_branch);
        // New repo and user hasn't touched Ref? Pre-select the default.
        // Edit mode: don't override an existing ref — user chose it on
        // purpose and may prefer it sticks through a re-probe.
        setR((cur) => {
          if (
            props.target.mode === "new"
            && !customRefFlag.current
            && (!cur.ref || !cur.ref.trim())
            && out.default_branch
          ) {
            return { ...cur, ref: out.default_branch };
          }
          return cur;
        });
      } catch (e) {
        if (cancelled) return;
        setBranches([]); setDefaultBranch(null);
        setProbeErr(String((e as Error).message ?? e));
      } finally {
        if (!cancelled) setProbing(false);
      }
    }, 500);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [r.url, r.deploy_key, props.target.mode]);

  // Load / clear the selected deploy key's public key so the "show pub" panel
  // can render it inline without forcing another round-trip per reveal click.
  useEffect(() => {
    if (!r.deploy_key) { setPub(""); setPubErr(""); return; }
    let cancelled = false;
    api.getKey(r.deploy_key)
      .then((d) => { if (!cancelled) { setPub(d.publicKey.trim()); setPubErr(""); } })
      .catch((e) => { if (!cancelled) { setPub(""); setPubErr(String((e as Error).message ?? e)); } });
    return () => { cancelled = true; };
  }, [r.deploy_key]);

  const set = <K extends keyof GitRepoResource>(k: K, v: GitRepoResource[K]) =>
    setR((cur) => ({ ...cur, [k]: v }));

  const onUrlChange = (next: string) => {
    setCustomRef(false);  // fresh URL → let the probe's auto-fill re-arm
    setR((cur) => {
      const copy = { ...cur, url: next };
      if (props.target.mode === "new" && !nameEdited.current) {
        const derived = deriveNameFromUrl(next);
        copy.name = derived;
      }
      return copy;
    });
  };

  const onNameChange = (next: string) => {
    nameEdited.current = true;
    set("name", next);
  };

  const refInBranches = useMemo(
    () => branches.includes((r.ref ?? "").trim()),
    [branches, r.ref],
  );
  // Sticky "user explicitly chose Custom" flag — independent of ref's
  // current value. Without this, picking Custom while ref still held a
  // valid branch name would flip `refInBranches` back to true and the
  // select would snap back to the branch instead of dropping to the
  // free-text input.
  const [customRef, setCustomRef] = useState(false);
  const refCustomInputRef = useRef<HTMLInputElement>(null);
  // Mirror `customRef` into a ref so the probe's setTimeout (which closes
  // over its creation-time state) can read the live value without needing
  // to be in the effect's dep list. If the user flips to Custom while a
  // probe is in flight we don't want the auto-fill to snap ref back.
  const customRefFlag = useRef(customRef);
  customRefFlag.current = customRef;

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
        <span>URL</span>
        <input
          autoFocus={props.target.mode === "new"}
          value={r.url}
          placeholder="git@github.com:owner/repo.git"
          onChange={(e) => onUrlChange(e.target.value)}
        />
      </label>

      <label>
        <span>
          Deploy key{" "}
          <span className="muted">(optional — pushed with the repo at session time if you opt in)</span>
        </span>
        <div className="row" style={{ gap: 6 }}>
          <select
            style={{ flex: 1 }}
            value={r.deploy_key ?? ""}
            onChange={(e) => set("deploy_key", e.target.value || undefined)}
          >
            <option value="">(none)</option>
            {props.keys.map((k) => <option key={k.nickname} value={k.nickname}>{k.nickname}</option>)}
          </select>
          <button
            type="button"
            className="secondary"
            title="Generate a new ed25519 deploy key"
            onClick={() => setNewKeyModal(true)}
          >+ New key</button>
        </div>
        {r.deploy_key && (
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="secondary"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => setShowPub((v) => !v)}
            >{showPub ? "Hide public key" : "Show public key"}</button>
            {showPub && (
              <div
                className="mono"
                style={{
                  marginTop: 6,
                  padding: 8,
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {pubErr ? <span className="muted">{pubErr}</span>
                  : pub
                    ? pub
                    : <span className="muted">loading…</span>}
                {pub && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: 10, padding: "1px 6px" }}
                      onClick={() => { navigator.clipboard?.writeText(pub); }}
                    >Copy</button>
                    <span className="muted" style={{ fontSize: 10, marginLeft: 8 }}>
                      Paste into the git host's deploy-keys settings.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </label>

      <label>
        <span>Name</span>
        <input
          value={r.name}
          disabled={props.target.mode === "edit"}
          placeholder={props.target.mode === "new" ? "auto-filled from URL" : "botdock-main"}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </label>

      <label>
        <span>
          Ref <span className="muted">(branch / tag / SHA — optional)</span>
          {probing && <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>probing…</span>}
          {!probing && probeErr && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 11, color: "var(--warn)" }}>
              probe failed — enter a ref manually
            </span>
          )}
        </span>
        {branches.length > 0 ? (
          <select
            value={customRef || !refInBranches ? "__custom__" : (r.ref ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom__") {
                setCustomRef(true);
                // Drop the branch name so the input starts blank — the user
                // is about to type a tag/SHA and shouldn't have to erase
                // "main" first. Focus the input on the next tick.
                set("ref", "");
                window.setTimeout(() => refCustomInputRef.current?.focus(), 0);
              } else {
                setCustomRef(false);
                set("ref", v);
              }
            }}
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}{b === defaultBranch ? "  (default)" : ""}
              </option>
            ))}
            <option value="__custom__">Custom (tag / SHA / other)…</option>
          </select>
        ) : null}
        {(branches.length === 0 || customRef || !refInBranches) && (
          <input
            ref={refCustomInputRef}
            value={r.ref ?? ""}
            placeholder={defaultBranch ? `default: ${defaultBranch}` : "main"}
            onChange={(e) => set("ref", e.target.value)}
          />
        )}
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

      {newKeyModal && (
        <NewKeyMiniModal
          existing={props.keys}
          suggestedNickname={r.name ? `${r.name}-deploy-key` : ""}
          onClose={() => setNewKeyModal(false)}
          onCreated={async (nickname) => {
            setNewKeyModal(false);
            set("deploy_key", nickname);
            await props.onKeysChanged();
          }}
        />
      )}
    </Modal>
  );
}

/**
 * Bite-sized key generator that re-uses `/api/keys` so the created key
 * lands in the shared private-keys registry (same as the Keys page).
 * Only covers the generate-ed25519 path — for imports the user still
 * goes to Keys. Kept in this file because it's the git-repo editor's
 * inline escape hatch.
 */
function NewKeyMiniModal(props: {
  existing: KeyMeta[];
  /** Pre-filled nickname when the modal opens — usually `<repo>-deploy-key`
   *  so the user can accept-and-go. If it collides with an existing key
   *  we don't try to de-dupe; the clash banner below points that out. */
  suggestedNickname?: string;
  onClose: () => void;
  onCreated: (nickname: string) => void | Promise<void>;
}) {
  const suggested = (() => {
    const raw = (props.suggestedNickname ?? "").trim();
    // Must still pass the server-side safe-name regex or the Generate
    // button would be disabled on open. For anything invalid (empty,
    // bad chars) we fall back to empty so the field reads as placeholder.
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(raw) ? raw : "";
  })();
  const [nickname, setNickname] = useState(suggested);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const taken = useMemo(
    () => new Set(props.existing.map((k) => k.nickname)),
    [props.existing],
  );
  const nameOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(nickname);
  const nameClash = nickname && taken.has(nickname);

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      await api.createKey({
        nickname,
        comment: comment.trim() || `botdock:${nickname}`,
      });
      await props.onCreated(nickname);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New deploy key" onClose={props.onClose}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Generates a passphrase-less ed25519 key and adds it to your private
        key registry. After it's created, paste the public key into the git
        host's deploy-keys settings.
      </div>
      <label>
        <span>Nickname</span>
        <input
          autoFocus
          value={nickname}
          placeholder="my-repo-deploy"
          onChange={(e) => setNickname(e.target.value)}
        />
        {nickname && !nameOk && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            letters/digits/<code>._-</code> only, max 64 chars
          </div>
        )}
        {nameClash && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4, color: "var(--warn)" }}>
            a key with this nickname already exists
          </div>
        )}
      </label>
      <label>
        <span>Comment <span className="muted">(optional)</span></span>
        <input
          value={comment}
          placeholder="botdock:<nickname>"
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button
          onClick={submit}
          disabled={submitting || !nameOk || !!nameClash}
        >{submitting ? "Generating…" : "Generate"}</button>
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
