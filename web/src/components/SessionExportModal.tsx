import { useState } from "react";
import { api, type Session } from "../api";
import { Modal } from "./Modal";

// Global CSS bleeds into unstyled inputs — see
// feedback_css_bleed_checkboxes.md. We reuse the same overrides the
// context popover uses so acknowledgement checkboxes stay at native
// size and the inline text beside them doesn't stack vertically.
const CHECKBOX_STYLE: React.CSSProperties = {
  width: "auto", margin: 0, padding: 0, flex: "none",
};
const LABEL_SPAN_STYLE: React.CSSProperties = {
  display: "inline", marginBottom: 0,
};

/**
 * Export a session's access bundle (machine + key + session dir — minus
 * notes.md — + metadata) as a .zip download. The operator must tick
 * three acknowledgement checkboxes before the Download button enables,
 * because the zip contains a private SSH key and sharing it carelessly
 * grants permanent access to the underlying machine.
 *
 * For sessions pinned to the managed `local` machine, an additional
 * "reachable hostname / IP" field is required — the recipient can't
 * route to the exporter's 127.0.0.1, so we substitute whatever they
 * type into the machine record we ship.
 */
export function SessionExportModal(props: {
  session: Session;
  onClose: () => void;
}) {
  const { session } = props;
  const isLocal = session.machine === "local";

  const [reachableHost, setReachableHost] = useState<string>(
    isLocal ? guessDefaultHost() : "",
  );
  const [ack1, setAck1] = useState(false);
  const [ack2, setAck2] = useState(false);
  const [ack3, setAck3] = useState(false);
  const [err, setErr] = useState("");
  const [downloading, setDownloading] = useState(false);

  const hostReady = !isLocal || reachableHost.trim().length > 0;
  const canExport = ack1 && ack2 && ack3 && hostReady && !downloading;

  const onDownload = async () => {
    setErr("");
    setDownloading(true);
    try {
      const url = api.sessionExportUrl(session.id, isLocal ? reachableHost : undefined);
      // Navigate the whole window to the export URL so the browser
      // handles Content-Disposition itself. <a download> with click()
      // would work too but feels flakier across browsers.
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        let parsed: string | undefined;
        try { parsed = (JSON.parse(body) as { error?: string }).error; } catch { /* ignore */ }
        throw new Error(parsed || body || `export failed (${res.status})`);
      }
      const cd = res.headers.get("content-disposition") ?? "";
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m?.[1] ?? `${session.id}.zip`;
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a beat before revoking so the download starts.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      props.onClose();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal title="Export session" onClose={props.onClose}>
      <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
        Bundles everything another BotDock instance needs to attach to this
        session on <span className="mono">{session.machine}</span>: the
        target machine's record + its SSH key + this session's logs and
        transcript. Both sides end up pointed at the same remote tmux.
      </div>

      {isLocal && (
        <div style={{ marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
            Reachable hostname or IP
          </div>
          <input
            value={reachableHost}
            onChange={(e) => setReachableHost(e.target.value)}
            placeholder="e.g. my-desktop.lan or 203.0.113.7"
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            This session is on your managed <span className="mono">local</span> machine.
            The recipient can't reach <span className="mono">127.0.0.1</span>;
            BotDock will ship a rewritten machine record with the address you
            enter here instead.
          </div>
        </div>
      )}

      <div
        style={{
          background: "rgba(228,92,92,0.08)",
          border: "1px solid rgba(228,92,92,0.35)",
          borderRadius: 6,
          padding: "10px 12px",
          marginBottom: 10,
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          Before you download — please read:
        </div>
        <AckLine checked={ack1} onChange={setAck1}>
          This zip contains a <b>private SSH key</b>. Anyone who ends up
          with the file has permanent access to the machine running the
          session.
        </AckLine>
        <AckLine checked={ack2} onChange={setAck2}>
          Access cannot be revoked by re-importing; the recipient must be
          someone you trust.
        </AckLine>
        <AckLine checked={ack3} onChange={setAck3}>
          I'll send this over a secure channel (Signal, encrypted email,
          password-protected share) — not plaintext email or a public
          pastebin.
        </AckLine>
      </div>

      {err && <div className="error-banner" style={{ fontSize: 12 }}>{err}</div>}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose} disabled={downloading}>
          Cancel
        </button>
        <button onClick={onDownload} disabled={!canExport}>
          {downloading ? "Preparing…" : "Download zip"}
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

/** Best-effort default for the reachable-host field. The browser can
 *  see location.hostname which, if BotDock is accessed from outside
 *  localhost, is a useful starting point. Otherwise we leave it blank
 *  rather than pre-filling "127.0.0.1" (which would defeat the purpose). */
function guessDefaultHost(): string {
  try {
    const h = window.location.hostname;
    if (h && h !== "127.0.0.1" && h !== "localhost" && !h.startsWith("[::")) return h;
  } catch { /* non-browser env, fine */ }
  return "";
}
