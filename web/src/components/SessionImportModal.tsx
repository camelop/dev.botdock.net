import { useRef, useState } from "react";
import { api, type SessionImportPreview } from "../api";
import { Modal } from "./Modal";

const CHECKBOX_STYLE: React.CSSProperties = {
  width: "auto", margin: 0, padding: 0, flex: "none",
};
const LABEL_SPAN_STYLE: React.CSSProperties = {
  display: "inline", marginBottom: 0,
};
const HIDDEN_INPUT: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};

/**
 * Two-step import flow:
 *   1. User picks a zip — frontend POSTs /inspect which unpacks to a temp
 *      dir, summarises contents, and reports conflicts against the local
 *      data dir. Nothing is written yet.
 *   2. If no conflicts AND three acks are ticked, POST /apply commits the
 *      files and the modal redirects to the hub view of the imported
 *      session.
 *
 * Hard-block on any conflict (session id / machine name / key nickname
 * already exists) — we don't auto-rename because that would mask
 * accidental duplicate imports of the same zip.
 */
export function SessionImportModal(props: {
  onClose: () => void;
  onImported: (sessionId: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SessionImportPreview | null>(null);
  const [inspectErr, setInspectErr] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [ack1, setAck1] = useState(false);
  const [ack2, setAck2] = useState(false);
  const [ack3, setAck3] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState("");

  const resetAcks = () => {
    setAck1(false); setAck2(false); setAck3(false);
  };

  const onPickFile = async (f: File) => {
    setFile(f);
    setPreview(null);
    setInspectErr("");
    resetAcks();
    setInspecting(true);
    try {
      const p = await api.inspectSessionImport(f);
      setPreview(p);
    } catch (e) {
      setInspectErr(String((e as Error).message ?? e));
    } finally {
      setInspecting(false);
    }
  };

  const onApply = async () => {
    if (!file) return;
    setApplyErr("");
    setApplying(true);
    try {
      const r = await api.applySessionImport(file);
      props.onImported(r.session_id);
    } catch (e) {
      setApplyErr(String((e as Error).message ?? e));
    } finally {
      setApplying(false);
    }
  };

  const hasConflicts = (preview?.conflicts.length ?? 0) > 0;
  const canApply =
    !!preview && !hasConflicts && ack1 && ack2 && ack3 && !applying;

  return (
    <Modal title="Import session" onClose={props.onClose}>
      <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
        Attach to a session someone else exported from their BotDock.
        You'll register the same machine + SSH key on this side and land
        inside the live tmux they're in.
      </div>

      <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 10 }}>
        <button
          type="button"
          className="secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={inspecting || applying}
        >
          {file ? "Change zip" : "Choose zip"}
        </button>
        <div className="muted" style={{ fontSize: 11, flex: 1, minWidth: 0 }}>
          {inspecting
            ? "Inspecting…"
            : file
              ? `${file.name} · ${formatBytes(file.size)}`
              : "Pick the .zip your collaborator sent you."}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          style={HIDDEN_INPUT}
          onChange={(e) => {
            const f = e.target.files?.item(0);
            if (f) onPickFile(f);
          }}
        />
      </div>

      {inspectErr && <div className="error-banner" style={{ fontSize: 12 }}>{inspectErr}</div>}

      {preview && (
        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg-card)",
            borderRadius: 6,
            padding: 10,
            marginBottom: 10,
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Will register:</div>
          <PreviewRow label="Session"
            value={<span className="mono">{preview.session_id}</span>}
          />
          <PreviewRow label="Machine"
            value={<span className="mono">{preview.machine_name}</span>}
          />
          <PreviewRow label="Key"
            value={<span className="mono">{preview.key_name}</span>}
          />
          {preview.exported_by && (
            <PreviewRow
              label="Exported by"
              value={
                <span>
                  <span className="mono">{preview.exported_by}</span>
                  {preview.exported_at && (
                    <span className="muted" style={{ marginLeft: 6 }}>
                      {preview.exported_at}
                    </span>
                  )}
                  {preview.botdock_version && (
                    <span className="muted" style={{ marginLeft: 6 }}>
                      (BotDock v{preview.botdock_version})
                    </span>
                  )}
                </span>
              }
            />
          )}
          {preview.notes.length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {preview.notes.map((n, i) => <div key={i}>· {n}</div>)}
            </div>
          )}
        </div>
      )}

      {hasConflicts && (
        <div
          style={{
            border: "1px solid rgba(228,92,92,0.5)",
            background: "rgba(228,92,92,0.08)",
            borderRadius: 6,
            padding: "10px 12px",
            marginBottom: 10,
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Import blocked — naming conflicts with existing records:
          </div>
          {preview!.conflicts.map((c) => (
            <div key={`${c.kind}:${c.name}`} style={{ marginTop: 4 }}>
              · <span className="mono">{c.kind} / {c.name}</span>{" "}
              <span className="muted">— {c.detail}</span>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Rename or delete the existing entries on this BotDock, then
            pick the zip again.
          </div>
        </div>
      )}

      {preview && !hasConflicts && (
        <div
          style={{
            background: "rgba(242,185,75,0.08)",
            border: "1px solid rgba(242,185,75,0.4)",
            borderRadius: 6,
            padding: "10px 12px",
            marginBottom: 10,
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Before you import — please read:
          </div>
          <AckLine checked={ack1} onChange={setAck1}>
            This zip embeds a private SSH key that BotDock will use for
            outbound connections. An attacker's zip could point it at a
            host you don't control.
          </AckLine>
          <AckLine checked={ack2} onChange={setAck2}>
            Importing lets the exporter's tmux / ttyd run on the target
            machine — don't import zips from sources you wouldn't let
            execute code on your behalf.
          </AckLine>
          <AckLine checked={ack3} onChange={setAck3}>
            This BotDock instance may open outbound SSH tunnels to the
            imported machine. Only import if you understand the network
            exposure that implies.
          </AckLine>
        </div>
      )}

      {applyErr && <div className="error-banner" style={{ fontSize: 12 }}>{applyErr}</div>}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose} disabled={applying}>
          Cancel
        </button>
        <button onClick={onApply} disabled={!canApply}>
          {applying ? "Importing…" : "Import"}
        </button>
      </div>
    </Modal>
  );
}

function AckLine(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        margin: "4px 0",
        cursor: "pointer",
        fontSize: 12,
        color: "var(--fg)",
        lineHeight: 1.45,
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        style={{ ...CHECKBOX_STYLE, marginTop: 3 }}
      />
      <span style={LABEL_SPAN_STYLE}>{props.children}</span>
    </label>
  );
}

function PreviewRow(props: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 2 }}>
      <div
        className="muted"
        style={{ minWidth: 90, fontSize: 11 }}
      >{props.label}</div>
      <div style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>
        {props.value}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
