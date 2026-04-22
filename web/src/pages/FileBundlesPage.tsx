import { useEffect, useRef, useState } from "react";
import { api, type FileBundleMeta } from "../api";
import { relativeTime, fullTime } from "../lib/time";

/**
 * File-bundle page: list of registered bundles + an inline "New bundle"
 * panel that folds down from the top when the user clicks ➕. Import
 * supports two modes:
 *   (a) Folder — `<input webkitdirectory>`; preserves the picked folder's
 *       sub-tree on the server.
 *   (c) Archive — single tar/tar.gz/tbz2/zip file; extracted server-side.
 *
 * Intentionally no inline tree editor: bundles are imported, not edited,
 * so CRUD is create/delete only. Updating a bundle is "delete + re-create".
 */
export function FileBundlesPage() {
  const [list, setList] = useState<FileBundleMeta[]>([]);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    try {
      setList(await api.listFileBundles());
      setErr("");
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };
  useEffect(() => { refresh(); }, []);

  const onDelete = async (name: string) => {
    if (!confirm(`Delete file-bundle "${name}"? This cannot be undone.`)) return;
    try {
      await api.deleteFileBundle(name);
      await refresh();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>File bundles</h1>
        {!creating && (
          <button onClick={() => setCreating(true)}>➕ New bundle</button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Arbitrary directory trees (config templates, shared snippets,
        anything) pushed into a session's context on demand. Import either
        a local folder or a tar/zip archive.
      </div>
      {err && <div className="error-banner">{err}</div>}

      {creating && (
        <NewBundlePanel
          onCancel={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      <div className="card" style={{ padding: 0 }}>
        {list.length === 0 ? (
          <div className="empty">No file bundles yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 80 }}>Files</th>
                <th style={{ width: 100 }}>Size</th>
                <th>Tags</th>
                <th>Updated</th>
                <th style={{ width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td className="mono">{b.file_count}</td>
                  <td className="mono">{formatBytes(b.bytes)}</td>
                  <td>
                    {b.tags?.map((t) => (
                      <span key={t} className="pill" style={{ marginRight: 4 }}>{t}</span>
                    ))}
                  </td>
                  <td className="muted" title={fullTime(b.updated_at)}>{relativeTime(b.updated_at)}</td>
                  <td>
                    <div className="actions">
                      <button className="secondary" onClick={() => onDelete(b.name)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type Mode = "folder" | "archive";

function NewBundlePanel(props: {
  onCancel: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [mode, setMode] = useState<Mode>("folder");
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  const nameOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);

  const onPickFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list) return;
    const arr: File[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list.item(i);
      if (f) arr.push(f);
    }
    setFolderFiles(arr);
  };

  const onPickArchive = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.item(0) ?? null;
    setArchiveFile(f);
  };

  const totalBytes = mode === "folder"
    ? folderFiles.reduce((sum, f) => sum + f.size, 0)
    : archiveFile?.size ?? 0;

  const canSubmit =
    nameOk
    && !submitting
    && ((mode === "folder" && folderFiles.length > 0) || (mode === "archive" && !!archiveFile));

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      if (mode === "folder") {
        await api.createFileBundleFromFiles({
          name,
          tags: tags.trim() || undefined,
          files: folderFiles.map((f) => ({
            file: f,
            // webkitRelativePath is "<picked-folder>/a/b/c.txt". We preserve
            // it as-is so the bundle mirrors the user's directory layout.
            // If the browser somehow didn't populate it, fall back to the
            // basename — better than failing the upload.
            rel_path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
          })),
        });
      } else {
        await api.createFileBundleFromArchive({
          name,
          tags: tags.trim() || undefined,
          archive: archiveFile!,
        });
      }
      await props.onCreated();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="card"
      style={{ marginBottom: 12, padding: 16, borderColor: "rgba(106,164,255,0.4)" }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>New file bundle</div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-config"
            autoFocus
          />
          {name && !nameOk && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4, color: "var(--warn)" }}>
              letters/digits/<code>._-</code> only, max 64 chars
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
            Tags <span className="muted">(comma-separated)</span>
          </div>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="config, template"
          />
        </div>
      </div>

      <div className="row" style={{ gap: 16, marginBottom: 10 }}>
        <label
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            margin: 0, fontSize: 13, cursor: "pointer",
          }}
        >
          <input
            type="radio"
            name="bundle-mode"
            checked={mode === "folder"}
            onChange={() => setMode("folder")}
            style={CHECKBOX_STYLE}
          />
          <span style={LABEL_SPAN_STYLE}>Upload a folder</span>
        </label>
        <label
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            margin: 0, fontSize: 13, cursor: "pointer",
          }}
        >
          <input
            type="radio"
            name="bundle-mode"
            checked={mode === "archive"}
            onChange={() => setMode("archive")}
            style={CHECKBOX_STYLE}
          />
          <span style={LABEL_SPAN_STYLE}>Upload an archive</span>
        </label>
      </div>

      {mode === "folder" ? (
        <div>
          <input
            ref={folderInputRef}
            type="file"
            /* webkitdirectory: every browser that ships the Chromium File API
             * honours this (Chrome, Edge, Safari 11.1+, Firefox 50+). Typed
             * as any because the React DOM typings still flag it as
             * non-standard. */
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            multiple
            onChange={onPickFolder}
            style={{ width: "auto", padding: 4 }}
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {folderFiles.length > 0
              ? `${folderFiles.length} file${folderFiles.length === 1 ? "" : "s"} selected · ${formatBytes(totalBytes)}`
              : "Pick a folder — its full sub-tree is preserved."}
          </div>
        </div>
      ) : (
        <div>
          <input
            ref={archiveInputRef}
            type="file"
            accept=".tar,.tar.gz,.tgz,.tar.bz2,.tbz2,.zip"
            onChange={onPickArchive}
            style={{ width: "auto", padding: 4 }}
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {archiveFile
              ? `${archiveFile.name} · ${formatBytes(totalBytes)}`
              : "Pick a tar / tar.gz / tar.bz2 / zip. Extracted server-side."}
          </div>
        </div>
      )}

      {err && <div className="error-banner" style={{ marginTop: 10 }}>{err}</div>}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button className="secondary" onClick={props.onCancel} disabled={submitting}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit}>
          {submitting ? "Uploading…" : "Create"}
        </button>
      </div>
    </div>
  );
}

// Match the popover's idiom — global `input { width: 100% }` bleeds into
// radio buttons too and stretches them across the row otherwise. See
// feedback_css_bleed_checkboxes.md for the history.
const CHECKBOX_STYLE: React.CSSProperties = {
  width: "auto", flex: "none", margin: 0, padding: 0,
};
const LABEL_SPAN_STYLE: React.CSSProperties = {
  display: "inline", marginBottom: 0,
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
