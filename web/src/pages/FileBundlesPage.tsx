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

type Mode = "folder" | "files" | "archive";

function NewBundlePanel(props: {
  onCancel: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [mode, setMode] = useState<Mode>("folder");
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [looseFiles, setLooseFiles] = useState<File[]>([]);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  // Native <input type="file"> renders the browser's default button,
  // which never matches the surrounding dark-theme aesthetic. We hide
  // the input visually and trigger it from a properly-styled button via
  // ref — same approach used in most design systems.
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  const nameOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);

  const pickedAny = (e: React.ChangeEvent<HTMLInputElement>): File[] => {
    const list = e.target.files;
    if (!list) return [];
    const arr: File[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list.item(i);
      if (f) arr.push(f);
    }
    return arr;
  };

  const onPickFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFolderFiles(pickedAny(e));
  };
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLooseFiles(pickedAny(e));
  };
  const onPickArchive = (e: React.ChangeEvent<HTMLInputElement>) => {
    setArchiveFile(e.target.files?.item(0) ?? null);
  };

  const totalBytes =
    mode === "folder" ? folderFiles.reduce((s, f) => s + f.size, 0)
    : mode === "files"  ? looseFiles.reduce((s, f) => s + f.size, 0)
    : archiveFile?.size ?? 0;

  const canSubmit =
    nameOk
    && !submitting
    && (
      (mode === "folder" && folderFiles.length > 0)
      || (mode === "files" && looseFiles.length > 0)
      || (mode === "archive" && !!archiveFile)
    );

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
      } else if (mode === "files") {
        await api.createFileBundleFromFiles({
          name,
          tags: tags.trim() || undefined,
          // Loose files land flat at the bundle root under their basename.
          // Browsers strip directory info from regular multi-select so we
          // can't reconstruct sub-paths even if the user dragged in files
          // from different dirs.
          files: looseFiles.map((f) => ({ file: f, rel_path: f.name })),
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

      <div className="row" style={{ gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
        <ModeRadio label="Folder"  checked={mode === "folder"}  onSelect={() => setMode("folder")} />
        <ModeRadio label="File(s)" checked={mode === "files"}   onSelect={() => setMode("files")} />
        <ModeRadio label="Archive" checked={mode === "archive"} onSelect={() => setMode("archive")} />
      </div>

      {mode === "folder" && (
        <PickerRow
          onClick={() => folderInputRef.current?.click()}
          summary={
            folderFiles.length > 0
              ? `${folderFiles.length} file${folderFiles.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`
              : "Pick a folder — its full sub-tree is preserved."
          }
          buttonLabel={folderFiles.length > 0 ? "Change folder" : "Choose folder"}
        />
      )}
      {mode === "files" && (
        <PickerRow
          onClick={() => filesInputRef.current?.click()}
          summary={
            looseFiles.length > 0
              ? `${looseFiles.length} file${looseFiles.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`
              : "Pick one or more files — flattened to the bundle root by basename."
          }
          buttonLabel={looseFiles.length > 0 ? "Change files" : "Choose files"}
        />
      )}
      {mode === "archive" && (
        <PickerRow
          onClick={() => archiveInputRef.current?.click()}
          summary={
            archiveFile
              ? `${archiveFile.name} · ${formatBytes(totalBytes)}`
              : "Pick a tar / tar.gz / tar.bz2 / zip. Extracted server-side."
          }
          buttonLabel={archiveFile ? "Change archive" : "Choose archive"}
        />
      )}

      {/* Hidden native inputs — clicked programmatically via refs above. */}
      <input
        ref={folderInputRef}
        type="file"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        multiple
        onChange={onPickFolder}
        style={HIDDEN_INPUT}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        onChange={onPickFiles}
        style={HIDDEN_INPUT}
      />
      <input
        ref={archiveInputRef}
        type="file"
        accept=".tar,.tar.gz,.tgz,.tar.bz2,.tbz2,.zip"
        onChange={onPickArchive}
        style={HIDDEN_INPUT}
      />

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

function ModeRadio(props: { label: string; checked: boolean; onSelect: () => void }) {
  return (
    <label
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        margin: 0, fontSize: 13, cursor: "pointer",
      }}
    >
      <input
        type="radio"
        name="bundle-mode"
        checked={props.checked}
        onChange={props.onSelect}
        style={CHECKBOX_STYLE}
      />
      <span style={LABEL_SPAN_STYLE}>{props.label}</span>
    </label>
  );
}

function PickerRow(props: {
  onClick: () => void;
  buttonLabel: string;
  summary: string;
}) {
  return (
    <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" className="secondary" onClick={props.onClick}>
        {props.buttonLabel}
      </button>
      <div className="muted" style={{ fontSize: 11, flex: 1, minWidth: 0 }}>
        {props.summary}
      </div>
    </div>
  );
}

// Accessible hide — off-screen rather than display:none so React keeps
// the element in the accessibility tree and the click trigger works.
const HIDDEN_INPUT: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

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
