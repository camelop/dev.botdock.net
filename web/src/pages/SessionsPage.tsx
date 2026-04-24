import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  sessionWatchUrl,
  type AgentKind,
  type CcSessionEntry,
  type Machine,
  type Session,
  type SessionEventRecord,
  type SessionStatus,
} from "../api";
import { Modal } from "../components/Modal";
import { relativeTime, fullTime } from "../lib/time";
import { ALIAS_COLORS } from "../lib/alias-colors";
import * as streamCache from "../lib/session-stream-cache";
import { twoWordSlug } from "../lib/slug";
import { parseAnsi, spanStyle } from "../lib/ansi";
import { parseTranscript, type TranscriptTurn } from "../lib/transcript";
import { SessionNameChip } from "../components/SessionNameChip";
import { ContextPushPopover } from "../components/ContextPushPopover";
import { SessionExportModal } from "../components/SessionExportModal";
import { SessionImportModal } from "../components/SessionImportModal";

export type SessionDraft = {
  machine: string;
  workdir: string;
  agent_kind: AgentKind;
  cmd: string;
  /** claude-code: auto-accept the folder-trust dialog and tool permission
   * prompts (maps to `--dangerously-skip-permissions`). Defaults to the
   * user's last choice, persisted in localStorage. */
  cc_skip_trust: boolean;
  /** claude-code: if set, the new session runs `claude --resume <uuid>`
   * instead of starting fresh. Selecting a session in the UI also
   * overwrites `workdir` with the resumed session's cwd. */
  cc_resume_uuid?: string;
  /** Advanced: override the claude launch command. Empty = "claude". */
  launch_command: string;
  /** Advanced: opt into CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in the
   * remote shim before launching claude. */
  cc_agent_teams: boolean;
  /** codex: auto-approve everything — maps to
   *  `--dangerously-bypass-approvals-and-sandbox` (alias --yolo). Mirrors
   *  the semantic of cc_skip_trust for the codex approvals/sandbox stack. */
  codex_skip_trust: boolean;
  /** codex: if set, the shim runs `codex resume <uuid>` rather than a
   *  fresh conversation. Not surfaced in the New Session modal yet —
   *  field exists so P1 can switch on the resume picker without a
   *  schema change. */
  codex_resume_uuid?: string;
};

const TRUST_PREF_KEY = "botdock:cc-skip-trust";
function loadTrustPref(): boolean {
  try { return localStorage.getItem(TRUST_PREF_KEY) === "1"; } catch { return false; }
}
function saveTrustPref(v: boolean): void {
  try { localStorage.setItem(TRUST_PREF_KEY, v ? "1" : "0"); } catch {}
}

// Codex has its own "yolo" toggle (--dangerously-bypass-approvals-and-sandbox)
// with different semantics from CC's trust dialog, so we persist the user's
// last choice separately rather than conflating the two defaults.
const CODEX_TRUST_PREF_KEY = "botdock:codex-skip-trust";
function loadCodexTrustPref(): boolean {
  try { return localStorage.getItem(CODEX_TRUST_PREF_KEY) === "1"; } catch { return false; }
}
function saveCodexTrustPref(v: boolean): void {
  try { localStorage.setItem(CODEX_TRUST_PREF_KEY, v ? "1" : "0"); } catch {}
}

// Terminal content zoom is a single global preference — setting it in
// one session's modal should carry to every other session's terminal
// on next mount. Clamped to [0.5, 2.0] at write time.
const TERM_ZOOM_KEY = "botdock:terminal-zoom";
function loadTerminalZoom(): number {
  try {
    const v = parseFloat(localStorage.getItem(TERM_ZOOM_KEY) ?? "");
    if (Number.isFinite(v) && v >= 0.5 && v <= 2) return v;
  } catch {}
  return 1;
}
function saveTerminalZoom(v: number): void {
  try { localStorage.setItem(TERM_ZOOM_KEY, String(v)); } catch {}
}

// Persisted layout for the floating Notes panel — one global position +
// size pair shared across sessions, so a power user's "I always want my
// notes in the lower-left corner at 400x300" preference sticks.
const NOTES_RECT_KEY = "botdock:notes-rect";
type PersistedNotesRect = { top: number; left: number; width: number; height: number };
function loadNotesRect(): PersistedNotesRect | null {
  try {
    const raw = localStorage.getItem(NOTES_RECT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o === "object" && o
        && typeof o.top === "number" && typeof o.left === "number"
        && typeof o.width === "number" && typeof o.height === "number") {
      return o;
    }
  } catch {}
  return null;
}
function saveNotesRect(r: PersistedNotesRect): void {
  try { localStorage.setItem(NOTES_RECT_KEY, JSON.stringify(r)); } catch {}
}

// Notes textarea font size is a single global preference so a user's
// "I like 14px" choice follows them across sessions and reloads.
const NOTES_FONT_KEY = "botdock:notes-font";
function loadNotesFont(): number {
  try {
    const v = parseFloat(localStorage.getItem(NOTES_FONT_KEY) ?? "");
    if (Number.isFinite(v) && v >= 10 && v <= 22) return v;
  } catch {}
  return 12.5;
}
function saveNotesFont(v: number): void {
  try { localStorage.setItem(NOTES_FONT_KEY, String(v)); } catch {}
}

// Shared "toggle button is currently active" styling — picked once so the
// Notes / Keyboard / FileBrowser left-side toggles all look the same when
// their thing is on. Colored border + inset ring + subtle tint.
const ACTIVE_TOGGLE_STYLE: React.CSSProperties = {
  borderColor: "var(--accent)",
  boxShadow: "inset 0 0 0 1px var(--accent)",
  background: "rgba(106,164,255,0.12)",
};

export function freshDraft(machines: Machine[]): SessionDraft {
  const enabled = machines.filter((m) => !m.disabled);
  return {
    machine: enabled[0]?.name ?? machines[0]?.name ?? "",
    workdir: `~/.botdock/projects/${twoWordSlug()}`,
    agent_kind: "claude-code",
    cmd: "",
    cc_skip_trust: loadTrustPref(),
    launch_command: "",
    cc_agent_teams: false,
    codex_skip_trust: loadCodexTrustPref(),
  };
}

/**
 * Short label for the `cmd` column in session tables. For generic-cmd that's
 * the shell command. For claude-code, `cmd` is the initial prompt (or, for
 * resumed sessions, the first user message lifted from the resumed
 * transcript at launch time). Falls back to "(no prompt)" when the CC
 * session was launched with no prompt at all.
 */
/** Whether this agent drives a TUI we should embed via ttyd (vs the raw
 *  log view). Currently claude-code and codex; generic-cmd shows Live log. */
export function isInteractiveAgent(kind: Session["agent_kind"]): boolean {
  return kind === "claude-code" || kind === "codex";
}

export function sessionCmdLabel(s: Pick<Session, "cmd" | "agent_kind">): string {
  if (s.cmd && s.cmd.length > 0) return s.cmd;
  if (isInteractiveAgent(s.agent_kind)) return "(no prompt)";
  return "";
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState<SessionDraft | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [importOpen, setImportOpen] = useState(false);

  // Open the modal with either the persisted draft or a fresh one.
  const openNew = () => {
    setDraft((cur) => cur ?? freshDraft(machines));
    setNewOpen(true);
  };

  const refresh = async () => {
    try {
      setSessions(await api.listSessions());
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  useEffect(() => { refresh(); api.listMachines().then(setMachines).catch(() => {}); }, []);
  // Background refresh of the list status badges.
  useEffect(() => {
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Sessions</h1>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="secondary"
            onClick={() => setImportOpen(true)}
            title="Attach to a session someone exported from their BotDock"
          >Import session</button>
          <button onClick={openNew} disabled={machines.length === 0}>
            {machines.length === 0 ? "Add a machine first" : "New session"}
          </button>
        </div>
      </div>
      {err && <div className="error-banner">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        {sessions.length === 0 ? (
          <div className="empty">No sessions yet. Create one to launch on a machine.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Machine</th>
                <th>Cmd</th>
                <th>Started</th>
                <th>Exit</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setSelected(s.id)}>
                  <td><SessionNameChip session={s} /></td>
                  <td><SessionPill session={s} /></td>
                  <td>{s.machine}</td>
                  <td className="mono" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionCmdLabel(s)}</td>
                  <td className="muted" title={fullTime(s.started_at)}>{relativeTime(s.started_at)}</td>
                  <td className="mono">{s.exit_code ?? (s.status === "active" ? "…" : "—")}</td>
                  <td>
                    <button className="secondary" onClick={(e) => { e.stopPropagation(); setSelected(s.id); }}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newOpen && draft && (
        <NewSessionModal
          machines={machines}
          draft={draft}
          onDraft={setDraft}
          onCancel={() => setNewOpen(false)}
          onDone={async (id) => {
            setNewOpen(false);
            setDraft(null);  // clear on successful submit only
            await refresh();
            setSelected(id);
          }}
        />
      )}
      {selected && (
        <SessionDetailModal
          id={selected}
          onClose={() => setSelected(null)}
          onChange={refresh}
        />
      )}
      {importOpen && (
        <SessionImportModal
          onClose={() => setImportOpen(false)}
          onImported={async (id) => {
            setImportOpen(false);
            await refresh();
            // Hand off to the Workspace view pointed at the newly-imported
            // session — same affordance as "Open in workspace" on the
            // detail modal.
            try { sessionStorage.setItem("botdock:hub-preselect", id); } catch {}
            window.location.hash = `hub/${encodeURIComponent(id)}`;
          }}
        />
      )}
    </div>
  );
}

/**
 * Single pill that merges session status and agent activity. Priority:
 *   - exited / failed_to_start: show the terminal status
 *   - provisioning: show it (starting up)
 *   - active + claude-code agent with known activity: show activity
 *     ("running" while producing output, "pending" while idle)
 *   - otherwise: show "active"
 */
function SessionPill({ session: s }: { session: Pick<Session, "status" | "activity" | "agent_kind"> }) {
  let label: string;
  let cls: string;
  if (s.status === "exited") { label = "exited"; cls = ""; }
  else if (s.status === "failed_to_start") { label = "failed"; cls = "err"; }
  else if (s.status === "provisioning") { label = "provisioning"; cls = "warn"; }
  else if (s.agent_kind === "claude-code" && s.activity === "syncing") { label = "syncing"; cls = "warn"; }
  else if (s.agent_kind === "claude-code" && s.activity === "pending") { label = "pending"; cls = "warn"; }
  else if (s.agent_kind === "claude-code" && s.activity === "running") { label = "running"; cls = "ok"; }
  else { label = "active"; cls = "ok"; }
  return <span className={`pill ${cls}`}>{label}</span>;
}

/** Legacy wrapper kept for code paths that only have a SessionStatus. */
function StatusPill({ status }: { status: SessionStatus }) {
  return <SessionPill session={{ status, agent_kind: "generic-cmd" }} />;
}

export function NewSessionModal(props: {
  machines: Machine[];
  draft: SessionDraft;
  onDraft: (d: SessionDraft) => void;
  onCancel: () => void;
  onDone: (id: string) => void | Promise<void>;
}) {
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { draft, onDraft } = props;
  const patch = (p: Partial<SessionDraft>) => onDraft({ ...draft, ...p });

  const regenSlug = () => patch({ workdir: `~/.botdock/projects/${twoWordSlug()}` });

  // Track which resumable sessions are currently "live" (another claude
  // process still has the workdir open). When the user picks one of these
  // AND the flag is still true at submit time, we confirm before launching.
  const [activeResumeUuids, setActiveResumeUuids] = useState<Set<string>>(new Set());

  const submit = async () => {
    setErr("");
    if (draft.cc_resume_uuid && activeResumeUuids.has(draft.cc_resume_uuid)) {
      const ok = confirm(
        "The session you picked still has an active `claude` process in its workdir. "
        + "If you resume now, claude will fork a new branch instead of continuing cleanly. "
        + "Proceed anyway?"
      );
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      if (draft.agent_kind === "claude-code") saveTrustPref(draft.cc_skip_trust);
      if (draft.agent_kind === "codex")       saveCodexTrustPref(draft.codex_skip_trust);
      const s = await api.createSession(draft);
      await props.onDone(s.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New session" onClose={props.onCancel}>
      <label>
        <span>Machine</span>
        <select value={draft.machine} onChange={(e) => patch({ machine: e.target.value })}>
          {props.machines.filter((m) => !m.disabled).map((m) =>
            <option key={m.name} value={m.name}>{m.name} — {m.user}@{m.host}</option>
          )}
        </select>
      </label>

      <AgentKindPicker value={draft.agent_kind} onChange={(v) => patch({ agent_kind: v })} />

      {draft.agent_kind === "claude-code" && draft.machine && (
        <ResumePicker
          machine={draft.machine}
          selectedUuid={draft.cc_resume_uuid}
          onSelect={(entry) => {
            if (!entry) {
              patch({ cc_resume_uuid: undefined });
              return;
            }
            // Picking a session overwrites workdir with the resumed session's
            // cwd — claude --resume only makes sense from that path. We also
            // lift the resumed conversation's first user message into `cmd`
            // so the session-list tables show it as the label (shim still
            // ignores cmd when RESUME_UUID is set).
            patch({
              cc_resume_uuid: entry.uuid,
              workdir: entry.workdir,
              cmd: entry.preview || "",
            });
          }}
          onActiveUuidsChange={setActiveResumeUuids}
        />
      )}

      <WorkdirPicker
        machine={draft.machine}
        value={draft.workdir}
        onChange={(v) => patch({ workdir: v, cc_resume_uuid: undefined })}
        onRegen={regenSlug}
      />

      {!draft.cc_resume_uuid && (
        <label>
          <span>{draft.agent_kind === "generic-cmd" ? "Command" : "Initial prompt (optional)"}</span>
          <textarea
            rows={4}
            value={draft.cmd}
            onChange={(e) => patch({ cmd: e.target.value })}
            placeholder={draft.agent_kind === "generic-cmd"
              ? 'echo "hello"; sleep 1'
              : "e.g. Explain this repo's README"}
          />
        </label>
      )}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {draft.agent_kind === "claude-code"
          ? (draft.cc_resume_uuid
            ? "Resuming an existing conversation — BotDock runs `claude --resume <uuid>` in a fresh tmux."
            : "Runs the `claude` CLI inside tmux. Leave the prompt blank to start an empty conversation. Requires `claude` installed and authenticated on the remote.")
          : draft.agent_kind === "codex"
            ? "Runs the `codex` CLI inside tmux. Leave the prompt blank to start empty. Requires `codex` installed and authenticated on the remote (OPENAI_API_KEY or `codex login`)."
            : "The command runs inside a tmux session. BotDock creates the working directory if it doesn't exist."}
      </div>
      {draft.agent_kind === "claude-code" && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
          <input
            id="cc-skip-trust"
            type="checkbox"
            checked={draft.cc_skip_trust}
            onChange={(e) => patch({ cc_skip_trust: e.target.checked })}
            style={{ width: 16, height: 16, marginTop: 2, cursor: "pointer" }}
          />
          <label
            htmlFor="cc-skip-trust"
            style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0, cursor: "pointer", lineHeight: 1.5 }}
          >
            Auto-accept the folder-trust prompt. Pre-writes{" "}
            <code className="mono">hasTrustDialogAccepted</code> for this workdir into{" "}
            <code className="mono">~/.claude.json</code> on the remote, so <code className="mono">claude</code>{" "}
            doesn't pause on startup. Per-tool permission prompts are NOT skipped.
          </label>
        </div>
      )}
      {draft.agent_kind === "codex" && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
          <input
            id="codex-skip-trust"
            type="checkbox"
            checked={draft.codex_skip_trust}
            onChange={(e) => patch({ codex_skip_trust: e.target.checked })}
            style={{ width: 16, height: 16, marginTop: 2, cursor: "pointer" }}
          />
          <label
            htmlFor="codex-skip-trust"
            style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0, cursor: "pointer", lineHeight: 1.5 }}
          >
            Bypass approvals + sandbox (maps to{" "}
            <code className="mono">--dangerously-bypass-approvals-and-sandbox</code>{" "}
            aka <code className="mono">--yolo</code>). The agent runs without per-tool
            confirmation prompts in the session's workdir. Only opt in when you trust
            both the workdir and the model's current instructions.
          </label>
        </div>
      )}
      <AdvancedSessionOptions
        draft={draft}
        onLaunchCommand={(v) => patch({ launch_command: v })}
        onAgentTeams={(v) => patch({ cc_agent_teams: v })}
      />
      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onCancel}>Cancel (keep draft)</button>
        <button
          disabled={submitting || !draft.machine || !draft.workdir || (draft.agent_kind === "generic-cmd" && !draft.cmd)}
          onClick={submit}
        >Create &amp; launch</button>
      </div>
    </Modal>
  );
}

/**
 * Collapsible "Advanced" block inside NewSessionModal. Everything in here
 * defaults to identical-to-current-behavior so an unmodified draft is
 * byte-identical on the wire to what the old modal sent.
 */
function AdvancedSessionOptions(props: {
  draft: SessionDraft;
  onLaunchCommand: (v: string) => void;
  onAgentTeams: (v: boolean) => void;
}) {
  const { draft } = props;
  const [open, setOpen] = useState(false);
  // Visual hint when an advanced option is non-default, so the user
  // remembers they've tweaked something even when the section is folded.
  const hasOverrides = (draft.launch_command && draft.launch_command.trim().length > 0)
    || draft.cc_agent_teams;

  // Advanced is claude-code-scoped for now (launch_command is CC-specific,
  // agent_teams is a CC env var). Hide for generic-cmd.
  if (draft.agent_kind !== "claude-code") return null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 12, color: "var(--fg-dim)",
          cursor: "pointer", userSelect: "none",
          padding: "4px 0",
        }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Advanced</span>
        {hasOverrides && <span className="pill" style={{ fontSize: 10, padding: "1px 6px" }}>customized</span>}
      </div>
      {open && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 10,
            background: "var(--bg-card)",
            marginTop: 4,
          }}
        >
          <label style={{ marginBottom: 10 }}>
            <span>Launch command</span>
            <input
              value={draft.launch_command}
              onChange={(e) => props.onLaunchCommand(e.target.value)}
              placeholder="claude"
              style={{ fontSize: 12 }}
            />
            <span className="muted" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
              Word-split into argv. Leave empty for the default{" "}
              <code className="mono">claude</code>. Example:{" "}
              <code className="mono">claude --verbose</code>.
            </span>
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input
              id="cc-agent-teams"
              type="checkbox"
              checked={draft.cc_agent_teams}
              onChange={(e) => props.onAgentTeams(e.target.checked)}
              style={{ width: 16, height: 16, marginTop: 2, cursor: "pointer" }}
            />
            <label
              htmlFor="cc-agent-teams"
              style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0, cursor: "pointer", lineHeight: 1.5 }}
            >
              Use agent teams — sets{" "}
              <code className="mono">CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1</code>{" "}
              in the remote environment before launching claude.
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Dropdown picker over every CC jsonl we could find on the selected machine.
 * Each row shows workdir, relative mtime, and a preview of the first user
 * message. Entries whose workdir still has a live `claude` process get a
 * "⚠ open" badge and a tooltip — the row is still selectable, but the
 * modal's submit handler confirms before launching.
 */
function ResumePicker(props: {
  machine: string;
  selectedUuid?: string;
  onSelect: (entry: CcSessionEntry | null) => void;
  onActiveUuidsChange: (uuids: Set<string>) => void;
}) {
  const { machine, selectedUuid } = props;
  const [sessions, setSessions] = useState<CcSessionEntry[] | null>(null);
  const [err, setErr] = useState<string>("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setSessions(null);
    setErr("");
    if (!machine) return;
    let cancelled = false;
    api.listCcSessions(machine).then((r) => {
      if (cancelled) return;
      const list = r.sessions ?? [];
      setSessions(list);
      if (r.error) setErr(r.error);
      props.onActiveUuidsChange(new Set(list.filter((s) => s.has_active_process).map((s) => s.uuid)));
    }).catch((e) => {
      if (cancelled) return;
      setErr(String((e as Error).message ?? e));
      setSessions([]);
      props.onActiveUuidsChange(new Set());
    });
    return () => { cancelled = true; };
  }, [machine]);  // eslint-disable-line react-hooks/exhaustive-deps

  const selected = sessions?.find((s) => s.uuid === selectedUuid);

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Resume a previous conversation
      </div>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          padding: "6px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-card)",
          cursor: "pointer",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? (
            <>
              <span className="mono">{selected.uuid.slice(0, 8)}</span>
              {" — "}
              <span className="mono muted">{selected.workdir}</span>
              {" · "}
              <span className="muted">{selected.preview || "(no preview)"}</span>
            </>
          ) : (
            <span className="muted">Start fresh (no resume)</span>
          )}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div
          className="scroll-panel"
          style={{
            marginTop: 4,
            border: "1px solid var(--border)",
            borderRadius: 6,
            maxHeight: 280,
            background: "var(--bg-card)",
          }}
        >
          <ResumeRow
            active={!selectedUuid}
            onClick={() => { props.onSelect(null); setExpanded(false); }}
            title={<span className="muted" style={{ fontStyle: "italic" }}>Start fresh (no resume)</span>}
            subtitle=""
            badge={null}
          />
          {sessions === null && <div className="empty" style={{ padding: 16, fontSize: 12 }}>Loading…</div>}
          {sessions && sessions.length === 0 && (
            <div className="empty" style={{ padding: 16, fontSize: 12 }}>
              No CC transcripts found on this machine.
              {err ? <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{err}</div> : null}
            </div>
          )}
          {sessions?.map((s) => (
            <ResumeRow
              key={s.uuid}
              active={selectedUuid === s.uuid}
              onClick={() => { props.onSelect(s); setExpanded(false); }}
              title={<>
                <span className="mono" style={{ fontSize: 11 }}>{s.uuid.slice(0, 8)}</span>
                {" "}
                <span style={{ fontSize: 13 }}>{s.preview || <span className="muted">(no preview)</span>}</span>
              </>}
              subtitle={`${s.workdir} · ${relativeTime(new Date(s.mtime * 1000).toISOString())}`}
              badge={s.has_active_process ? (
                <span
                  className="pill warn"
                  style={{ fontSize: 10 }}
                  title="A `claude` process is still running in this workdir. Resuming now will fork a new branch — close the other session first."
                >⚠ already opened</span>
              ) : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ResumeRow({ active, onClick, title, subtitle, badge }: {
  active: boolean;
  onClick: () => void;
  title: React.ReactNode;
  subtitle: string;
  badge: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "8px 10px",
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
        background: active ? "rgba(106,164,255,0.08)" : "transparent",
        borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent",
      }}
    >
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </div>
        {badge}
      </div>
      {subtitle && (
        <div className="muted mono" style={{ fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function AgentKindPicker({ value, onChange }: { value: AgentKind; onChange: (v: AgentKind) => void }) {
  const kinds: Array<{ id: AgentKind; label: string; disabled?: boolean; hint?: string }> = [
    { id: "generic-cmd", label: "Generic command", hint: "any shell command inside tmux" },
    { id: "claude-code", label: "Claude Code",     hint: "interactive `claude` CLI; initial prompt optional" },
    { id: "codex",       label: "Codex",           hint: "interactive `codex` CLI (OpenAI); initial prompt optional" },
  ];
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Agent kind</div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {kinds.map((k) => {
          const selected = value === k.id;
          return (
            <button
              key={k.id}
              type="button"
              className="secondary"
              disabled={k.disabled}
              onClick={() => !k.disabled && onChange(k.id)}
              style={{
                borderColor: selected ? "var(--accent)" : undefined,
                boxShadow: selected ? "inset 0 0 0 1px var(--accent)" : undefined,
                opacity: k.disabled ? 0.55 : 1,
              }}
              title={k.hint}
            >
              {k.label}{k.disabled ? " (soon)" : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Return the "parent directory" portion of a user-typed path. Treats a bare
 * "~" as if it were "~/" so autocomplete fires before the user adds a slash.
 */
function parentOf(v: string): string {
  if (v === "~") return "~/";
  const i = v.lastIndexOf("/");
  return i < 0 ? "" : v.slice(0, i + 1);
}

function WorkdirPicker(props: {
  machine: string;
  value: string;
  onChange: (v: string) => void;
  onRegen: () => void;
}) {
  type Entry = { name: string; kind: "dir" | "file" };
  // Remember which parent dir the fetched entries belong to. Prevents stale
  // suggestions from showing when the user navigates into a new level — the
  // old list would otherwise be joined onto the new parent, yielding
  // nonsense entries like "~/blog.seedclaw.net/.bun".
  const [state, setState] = useState<{ parent: string; entries: Entry[] }>({ parent: "", entries: [] });
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const parent = parentOf(props.value);

  useEffect(() => {
    if (!props.machine || !props.value) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const r = await api.browseMachine(props.machine, props.value);
        if (cancelled) return;
        setState({ parent, entries: r.entries ?? [] });
      } catch {
        if (!cancelled) setState({ parent, entries: [] });
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [props.machine, props.value, parent]);

  const suggestions = useMemo(() => {
    // If the stored entries are for a different parent than currently typed,
    // don't show anything — waiting on fetch is better than showing junk.
    if (state.parent !== parent) return [] as string[];
    const leaf = props.value.slice(parent.length).toLowerCase();
    return state.entries
      .filter((e) => e.kind === "dir" && e.name.toLowerCase().startsWith(leaf))
      .map((e) => parent + e.name);
  }, [state, props.value, parent]);

  const choose = (s: string) => {
    props.onChange(s + "/");
    inputRef.current?.focus();
  };

  return (
    <label style={{ position: "relative", marginBottom: 10 }}>
      <span>Working directory (on the machine)</span>
      <div className="row" style={{ gap: 6 }}>
        <input
          ref={inputRef}
          className="grow"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="/home/... or ~/..."
          spellCheck={false}
          autoCorrect="off"
          style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}
        />
        <button type="button" className="secondary" title="Generate a new random name" onClick={props.onRegen}>↻</button>
      </div>
      {focused && suggestions.length > 0 && (
        <div
          className="scroll-panel"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "100%",
            marginTop: 2,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            maxHeight: 260,
            zIndex: 20,
            fontFamily: "var(--mono)",
            fontSize: 12.5,
          }}
        >
          {suggestions.map((s) => (
            <div
              key={s}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              style={{ padding: "5px 10px", cursor: "pointer" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#2a2f38")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            >
              {s}/
            </div>
          ))}
        </div>
      )}
      <span className="muted" style={{ fontSize: 11 }}>
        BotDock will create this path if missing. ~ expands to the remote user's home.
      </span>
    </label>
  );
}

/**
 * Presentation of a single session: terminal + transcript + events.
 * Used standalone by SessionHubPage, and wrapped in a modal backdrop by
 * SessionDetailModal. Pass `onClose` to render the × button in the top-
 * right of the right column; omit it for contexts (like the hub) where
 * the view is persistent.
 */
export function SessionView(props: {
  id: string;
  onClose?: () => void;
  onChange?: () => void | Promise<void>;
  // When true, the view styles itself as a floating modal (background,
  // border, shadow). When false (hub embed), it's a bare two-column pane.
  inModal?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEventRecord[]>([]);
  const [rawText, setRawText] = useState("");
  const [err, setErr] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // SendInput pane is collapsed by default to give the terminal more room —
  // a button in the terminal toolbar toggles it.
  const [showInput, setShowInput] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Floating scratchpad. Open/close is transient (per-mount); text is
  // loaded once on first open and debounce-saved to notes.md on change.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesText, setNotesText] = useState<string | null>(null);  // null = not yet loaded
  const [notesSaving, setNotesSaving] = useState(false);
  const notesSaveTimer = useRef<number | null>(null);
  // Refs so the unmount/session-switch cleanup can flush the RIGHT text to
  // the RIGHT id — capturing them in a closure would lock us to the initial
  // render's values.
  const notesTextRef = useRef<string | null>(null);
  notesTextRef.current = notesText;
  // Position + size of the floating panel. Persisted in localStorage so the
  // user's drag/resize choices stick across sessions and reloads. Initial
  // null → open() anchors the panel under the Notes button.
  type NotesRect = { top: number; left: number; width: number; height: number };
  const [notesRect, setNotesRect] = useState<NotesRect | null>(() => loadNotesRect());
  const notesButtonRef = useRef<HTMLButtonElement | null>(null);
  // Filebrowser lifecycle: null while not-starting, "starting" during the
  // server round-trip, string url once it's up. Errors surface inline.
  type FbState = "idle" | "starting" | "stopping";
  const [fbState, setFbState] = useState<FbState>("idle");
  const [fbErr, setFbErr] = useState<string>("");
  // Same pattern for code-server.
  const [csState, setCsState] = useState<FbState>("idle");
  const [csErr, setCsErr] = useState<string>("");

  // WebSocket carries events + raw + session-meta deltas. Transcript is
  // NOT streamed anymore — TranscriptView pulls it a page at a time via
  // HTTP so opening a session with a multi-MB transcript is instant.
  useEffect(() => {
    const cached = streamCache.getCache(props.id);
    setEvents(cached?.events ?? []);
    setRawText(cached?.rawText ?? "");
    setErr("");
    api.getSession(props.id).then(setSession).catch((e) => setErr(String(e.message ?? e)));

    const ws = new WebSocket(sessionWatchUrl(props.id, cached ? {
      events: cached.eventsOffset,
      raw: cached.rawBytes,
    } : undefined));
    wsRef.current = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.type === "events") {
        const merged = streamCache.appendEvents(props.id, m.records, m.nextOffset);
        setEvents(merged);
      } else if (m.type === "raw") {
        const merged = streamCache.appendRaw(props.id, m.data);
        setRawText(merged);
      } else if (m.type === "session") {
        // Authoritative session meta from the server — picks up activity
        // transitions, remote_transcript_size growth (used by TranscriptView
        // as a refresh trigger), exit_code, etc. without re-polling HTTP.
        setSession(m.session as Session);
      }
    });
    ws.addEventListener("error", () => setErr("websocket error"));
    return () => ws.close();
  }, [props.id]);

  // Auto-scroll raw log to bottom on append.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rawText]);

  const onStop = async () => {
    if (!confirm("Deactivate this session? The remote tmux is killed; local logs stay.")) return;
    try {
      const s = await api.stopSession(props.id);
      setSession(s);
      await props.onChange?.();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  // Session switch: wipe notes state so the next open re-fetches for the
  // new session. The cleanup branch of this same effect handles flushing
  // any pending debounced save for the OLD session — using refs so the
  // saved text + session id are always current, not stale-from-init.
  useEffect(() => {
    const sid = props.id;
    return () => {
      if (notesSaveTimer.current != null) {
        window.clearTimeout(notesSaveTimer.current);
        notesSaveTimer.current = null;
      }
      const pending = notesTextRef.current;
      if (pending != null) {
        // Fire-and-forget; no await in cleanup. Correct session id is the
        // `sid` captured when THIS effect instance registered.
        api.putSessionNotes(sid, pending).catch(() => {});
      }
    };
  }, [props.id]);
  useEffect(() => {
    setNotesText(null);   // clear so the next fetch runs for the new id
  }, [props.id]);

  // Fetch notes on first open. Subsequent opens keep the last-fetched state
  // so the user doesn't see a flash while the round-trip happens.
  useEffect(() => {
    if (!notesOpen || notesText !== null) return;
    const sid = props.id;
    api.getSessionNotes(sid).then((r) => {
      // Ignore late responses for a session the user already switched away
      // from — the reset effect above would otherwise clobber the new one.
      if (sid === props.id) setNotesText(r.text ?? "");
    }).catch(() => { if (sid === props.id) setNotesText(""); });
  }, [notesOpen, notesText, props.id]);

  const onNotesChange = (next: string) => {
    setNotesText(next);
    if (notesSaveTimer.current != null) window.clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = window.setTimeout(() => {
      setNotesSaving(true);
      api.putSessionNotes(props.id, next)
        .catch(() => { /* transient — next keystroke will retry */ })
        .finally(() => setNotesSaving(false));
    }, 500);
  };

  // Open the panel: if we don't have a persisted layout yet, anchor it
  // directly under the Notes button so the user can see where it came
  // from. Clamped so it never spawns off-screen.
  const onToggleNotes = () => {
    setNotesOpen((v) => {
      const next = !v;
      if (next && !notesRect) {
        const btn = notesButtonRef.current;
        if (btn) {
          const r = btn.getBoundingClientRect();
          const width = 360;
          const height = 420;
          const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left));
          const top = Math.max(8, Math.min(window.innerHeight - height - 8, r.bottom + 6));
          setNotesRect({ top, left, width, height });
        } else {
          setNotesRect({ top: 120, left: 24, width: 360, height: 420 });
        }
      }
      return next;
    });
  };

  const onNotesRectChange = (r: NotesRect) => {
    setNotesRect(r);
    saveNotesRect(r);
  };

  const onStartFilebrowser = async () => {
    setFbErr(""); setFbState("starting");
    try {
      const r = await api.startSessionFilebrowser(props.id);
      // Update local session immediately so the UI flips without waiting
      // for the next WS meta push.
      setSession((cur) => cur ? { ...cur, filebrowser_local_port: r.local_port, filebrowser_remote_port: r.remote_port } : cur);
      await props.onChange?.();
    } catch (e) {
      setFbErr(String((e as Error)?.message ?? e));
    } finally {
      setFbState("idle");
    }
  };
  const onStopFilebrowser = async () => {
    setFbErr(""); setFbState("stopping");
    try {
      await api.stopSessionFilebrowser(props.id);
      setSession((cur) => cur ? { ...cur, filebrowser_local_port: undefined, filebrowser_remote_port: undefined } : cur);
      await props.onChange?.();
    } catch (e) {
      setFbErr(String((e as Error)?.message ?? e));
    } finally {
      setFbState("idle");
    }
  };

  const onStartCodeServer = async () => {
    setCsErr(""); setCsState("starting");
    try {
      const r = await api.startSessionCodeServer(props.id);
      setSession((cur) => cur ? {
        ...cur,
        codeserver_local_port: r.local_port,
        codeserver_remote_port: r.remote_port,
        // Tilde-expanded absolute path from the remote — used as ?folder=
        // on the Open URL so VS Code lands in the session's workdir
        // instead of the welcome page.
        codeserver_workdir: r.workdir,
      } : cur);
      await props.onChange?.();
    } catch (e) {
      setCsErr(String((e as Error)?.message ?? e));
    } finally {
      setCsState("idle");
    }
  };
  const onStopCodeServer = async () => {
    setCsErr(""); setCsState("stopping");
    try {
      await api.stopSessionCodeServer(props.id);
      setSession((cur) => cur ? {
        ...cur,
        codeserver_local_port: undefined,
        codeserver_remote_port: undefined,
        codeserver_workdir: undefined,
      } : cur);
      await props.onChange?.();
    } catch (e) {
      setCsErr(String((e as Error)?.message ?? e));
    } finally {
      setCsState("idle");
    }
  };
  const onDelete = async () => {
    if (!confirm("Delete this session (files and all)?")) return;
    try {
      await api.deleteSession(props.id);
      await props.onChange?.();
      props.onClose?.();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  return (
    <div
      className={props.inModal ? "modal session-modal" : "session-modal"}
      onClick={(e) => e.stopPropagation()}
    >
        {/* LEFT: terminal fills the column, SendInput collapses behind a toggle. */}
        <div className="session-left">
          <div className="terminal-fill">
            {session && isInteractiveAgent(session.agent_kind) ? (
              <ClaudeTerminal
                session={session}
                fillParent
                notesToggle={(
                  <button
                    ref={notesButtonRef}
                    className="secondary action-bar-btn"
                    style={notesOpen ? ACTIVE_TOGGLE_STYLE : undefined}
                    onClick={onToggleNotes}
                    title="Toggle the floating scratchpad (persisted to notes.md)"
                  >
                    <span className="emoji">📝</span>
                    {notesOpen ? "Hide Notes" : "Notes"}
                  </button>
                )}
                inputToggle={session.status === "active" ? (
                  <button
                    className="secondary action-bar-btn"
                    style={showInput ? ACTIVE_TOGGLE_STYLE : undefined}
                    onClick={() => setShowInput((v) => !v)}
                    title="Toggle the input pane (send text / quick keys to tmux)"
                  >
                    <span className="emoji">⌨</span>
                    {showInput ? "Hide Keyboard" : "Keyboard"}
                  </button>
                ) : null}
                fileBrowserControls={session.status === "active" ? (
                  <FileBrowserControls
                    session={session}
                    state={fbState}
                    err={fbErr}
                    onStart={onStartFilebrowser}
                    onStop={onStopFilebrowser}
                  />
                ) : null}
                codeServerControls={session.status === "active" ? (
                  <VsCodeControls
                    session={session}
                    state={csState}
                    err={csErr}
                    onStart={onStartCodeServer}
                    onStop={onStopCodeServer}
                  />
                ) : null}
                onOpenInWorkspace={props.inModal ? () => {
                  try { sessionStorage.setItem("botdock:hub-preselect", session.id); } catch {}
                  props.onClose?.();
                  window.location.hash = "hub";
                } : undefined}
              />
            ) : (
              <>
                <div className="row" style={{ gap: 6, alignItems: "center", marginBottom: 8 }}>
                  <h2 style={{ margin: 0, flex: 1 }}>Live log</h2>
                  {session?.status === "active" && (
                    <button
                      className="secondary action-bar-btn"
                      onClick={() => setShowInput((v) => !v)}
                      title="Toggle the input pane"
                    >
                      <span className="emoji">{showInput ? "▾" : "⌨"}</span>
                      {showInput ? "Hide keyboard" : "Keyboard"}
                    </button>
                  )}
                </div>
                <div
                  ref={logRef}
                  className="mono scroll-panel"
                  style={{
                    flex: 1,
                    minHeight: 0,
                    background: "#0a0c10",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 10,
                    whiteSpace: "pre-wrap",
                    fontSize: 12,
                  }}
                >
                  <AnsiText text={rawText} />
                  {session?.status === "active" && (
                    <span className="pill ok" style={{ fontSize: 10, marginTop: 8, display: "inline-block" }}>streaming</span>
                  )}
                </div>
              </>
            )}
          </div>
          {session?.status === "active" && showInput && <SendInput id={session.id} />}
        </div>

        {/* RIGHT: title / meta / transcript / events — scrolls independently.
            Close is pinned to the top-right corner (doesn't fight for horizontal
            space with the title). Deactivate / Delete sit on their own row
            below the header so the meta never gets clipped. */}
        <div className="session-right scroll-panel">
          {/* Title + all action buttons live on one row. Title ellipsizes so
              Deactivate / × never get pushed to a new line. */}
          <div className="row" style={{ gap: 6, alignItems: "center", marginBottom: 4 }}>
            <h2 style={{
              flex: 1,
              minWidth: 0,
              margin: 0,
              fontSize: 16,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}>
              {session
                ? <SessionNameChip session={session} fallback={`Session ${props.id}`} size={16} />
                : `Session ${props.id}`}
            </h2>
            {session && (
              <button
                className="secondary"
                style={{ fontSize: 12, padding: "4px 12px", flexShrink: 0 }}
                onClick={() => setConfigOpen(true)}
                title="Rename this session and pick an accent color"
              >Config</button>
            )}
            {session && (
              <button
                className="secondary"
                style={{ fontSize: 12, padding: "4px 12px", flexShrink: 0 }}
                onClick={() => setExportOpen(true)}
                title="Download a zip that lets another BotDock attach to this session"
              >Export</button>
            )}
            {session?.status === "active" && (
              <button className="secondary" style={{ fontSize: 12, padding: "4px 12px", flexShrink: 0 }} onClick={onStop}>
                Deactivate
              </button>
            )}
            {session && (session.status === "exited" || session.status === "failed_to_start") && (
              <button className="secondary" style={{ fontSize: 12, padding: "4px 12px", flexShrink: 0 }} onClick={onDelete}>
                Delete
              </button>
            )}
            {props.onClose && (
              <button
                className="secondary"
                onClick={props.onClose}
                title="Close"
                style={{ padding: "4px 10px", fontSize: 13, flexShrink: 0 }}
              >×</button>
            )}
          </div>
          {configOpen && session && (
            <SessionConfigDialog
              session={session}
              onClose={() => setConfigOpen(false)}
              onSaved={(s) => { setSession(s); props.onChange?.(); }}
            />
          )}
          {exportOpen && session && (
            <SessionExportModal
              session={session}
              onClose={() => setExportOpen(false)}
            />
          )}
          {session && (
            <div className="mono muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
              <SessionPill session={session} />{" "}
              {session.machine} · {session.workdir}
            </div>
          )}

          {err && <div className="error-banner">{err}</div>}
          {session && <Meta s={session} />}

          {session?.agent_kind === "claude-code" && (
            <TranscriptView
              sessionId={props.id}
              hasFile={!!session.cc_session_file}
              transcriptSize={session.remote_transcript_size}
              lastTranscriptAt={session.last_transcript_at}
            />
          )}

          <h2>Events</h2>
          <EventsTable events={events} />
        </div>
        {notesOpen && session && notesRect && (
          <NotesPanel
            sessionId={props.id}
            alias={session.alias}
            text={notesText ?? ""}
            loading={notesText === null}
            saving={notesSaving}
            rect={notesRect}
            onRectChange={onNotesRectChange}
            onChange={onNotesChange}
            onClose={() => setNotesOpen(false)}
          />
        )}
    </div>
  );
}

/**
 * Floating scratchpad pinned to the top-right of the viewport. Text is
 * debounce-saved to `sessions/<id>/notes.md`. Pure textarea; no rich
 * rendering — the file ends in .md so the user can pipe it into their
 * markdown editor of choice externally if they want.
 */
type NotesRect = { top: number; left: number; width: number; height: number };

function NotesPanel({ sessionId, alias, text, loading, saving, rect, onRectChange, onChange, onClose }: {
  sessionId: string;
  alias?: string;
  text: string;
  loading: boolean;
  saving: boolean;
  rect: NotesRect;
  onRectChange: (r: NotesRect) => void;
  onChange: (next: string) => void;
  onClose: () => void;
}) {
  // Drag: header mousedown captures pointer, mousemove updates top/left,
  // mouseup releases. Resize handle: same pattern, updates width/height.
  // Both clamp against viewport so the user can't lose the panel.
  //
  // `dragMode` drives a fullscreen transparent overlay that sits above the
  // ttyd iframe during drags — without it, once the cursor enters the
  // iframe the browser delivers mousemove events to ttyd instead of us, so
  // the panel "sticks" to the mouse until we pass back over our own window.
  const [dragMode, setDragMode] = useState<"none" | "move" | "resize">("none");

  // Font size for the textarea. Global preference (matches terminal zoom's
  // model — per-user, not per-session). Clamped to the sane range above.
  const [fontSize, setFontSizeState] = useState<number>(() => loadNotesFont());
  const bumpFont = (delta: number) => {
    setFontSizeState((prev) => {
      const next = Math.max(10, Math.min(22, +(prev + delta).toFixed(1)));
      saveNotesFont(next);
      return next;
    });
  };

  const onHeaderDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;   // don't drag when clicking ×
    e.preventDefault();
    setDragMode("move");
    const startX = e.clientX, startY = e.clientY;
    const start = rect;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      const w = start.width, h = start.height;
      const left = Math.max(0, Math.min(window.innerWidth - w, start.left + dx));
      const top  = Math.max(0, Math.min(window.innerHeight - h, start.top + dy));
      onRectChange({ ...start, left, top });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragMode("none");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const onResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragMode("resize");
    const startX = e.clientX, startY = e.clientY;
    const start = rect;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      const width  = Math.max(240, Math.min(900, start.width + dx));
      const height = Math.max(160, Math.min(800, start.height + dy));
      onRectChange({ ...start, width, height });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragMode("none");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      {dragMode !== "none" && (
        <div
          // Transparent fullscreen guard to keep mouse events on the parent
          // window during a drag. Without this the ttyd iframe swallows
          // the mousemove events as soon as the cursor enters it and the
          // panel stops tracking the pointer. zIndex 49: below the panel
          // (50) but above the iframe (auto → 0).
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 49,
            cursor: dragMode === "move" ? "grabbing" : "nwse-resize",
          }}
        />
      )}
    <div
      style={{
        position: "fixed",
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="row"
        onMouseDown={onHeaderDown}
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          gap: 6,
          cursor: "move",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>📝 Notes</span>
        <span className="muted mono" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {alias ? alias : sessionId}
        </span>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 10 }}>
          {loading ? "loading…" : saving ? "saving…" : "saved"}
        </span>
        {/* Font-size control — one step per click, clamped to 10–22. */}
        <button
          className="secondary"
          onClick={() => bumpFont(-1)}
          disabled={fontSize <= 10}
          style={{ padding: "2px 6px", fontSize: 11 }}
          title="Smaller text"
        >A-</button>
        <span className="muted mono" style={{ fontSize: 10, minWidth: 22, textAlign: "center" }}>
          {Math.round(fontSize)}
        </span>
        <button
          className="secondary"
          onClick={() => bumpFont(1)}
          disabled={fontSize >= 22}
          style={{ padding: "2px 6px", fontSize: 11 }}
          title="Larger text"
        >A+</button>
        <button
          className="secondary"
          onClick={onClose}
          style={{ padding: "2px 8px", fontSize: 11 }}
          title="Close the notes panel (content is already saved)"
        >×</button>
      </div>
      <textarea
        value={text}
        disabled={loading}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Scratch notes for this session. Auto-saved to notes.md."
        style={{
          flex: 1,
          border: "none",
          borderRadius: 0,
          fontFamily: "var(--mono)",
          fontSize,
          background: "transparent",
          resize: "none",
          padding: 10,
        }}
      />
      {/* Resize grip — bottom-right corner. 14x14 of diagonal stripes, only
          picks up mouse on its own box so text selection isn't blocked. */}
      <div
        onMouseDown={onResizeDown}
        title="Drag to resize"
        style={{
          position: "absolute",
          right: 0, bottom: 0,
          width: 14, height: 14,
          cursor: "nwse-resize",
          background:
            "linear-gradient(135deg, transparent 0, transparent 40%, var(--fg-dim) 40%, var(--fg-dim) 50%, transparent 50%, transparent 70%, var(--fg-dim) 70%, var(--fg-dim) 80%, transparent 80%)",
        }}
      />
    </div>
    </>
  );
}

/** Modal wrapper around SessionView — used from Sessions List / War Room. */
export function SessionDetailModal(props: {
  id: string;
  onClose: () => void;
  onChange: () => void | Promise<void>;
}) {
  // Esc closes the modal. Scoped to this mount — the wrapper unmounts on
  // close, so the listener cleans up automatically.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <div className="modal-backdrop" onClick={() => { /* no-op; no backdrop dismiss */ }}>
      <SessionView id={props.id} onClose={props.onClose} onChange={props.onChange} inModal />
    </div>
  );
}

function EventsTable({ events }: { events: SessionEventRecord[] }) {
  // Tick once every 5s so the relative timestamps don't feel stale while the
  // modal is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  // Defensive sort (oldest first). Clock skew between basedock and remote
  // can otherwise let a late-arriving event land out of place.
  const sorted = useMemo(
    () => [...events].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? "")),
    [events],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll the container to the bottom on mount and whenever new events land.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sorted.length]);
  return (
    <div
      ref={scrollRef}
      className="scroll-panel"
      style={{ maxHeight: 140, border: "1px solid var(--border)", borderRadius: 6, fontSize: 10.5 }}
    >
      {sorted.map((ev, i) => (
        <div
          key={i}
          style={{
            padding: "4px 8px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <span className="pill" style={{ fontSize: 9, padding: "1px 6px" }}>{ev.kind}</span>
            <span className="muted" title={fullTime(ev.ts)} style={{ fontSize: 10 }}>
              {relativeTime(ev.ts)}
            </span>
          </div>
          <div
            className="mono muted"
            style={{
              fontSize: 10,
              marginTop: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {renderEventPayload(ev)}
          </div>
        </div>
      ))}
    </div>
  );
}

const TRANSCRIPT_PAGE_SIZE = 20;

/**
 * The "N/total · turnCount" label is click-to-edit: tap it, type a page,
 * hit Enter. Out-of-range values are clamped; Escape cancels.
 */
function TranscriptPageIndicator({ totalPages, pageIndex, lineCount, onJump }: {
  totalPages: number;
  pageIndex: number;   // 0-indexed from start
  lineCount: number;
  onJump: (oneIndexedPage: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const visiblePage = pageIndex + 1;  // 1-indexed for display

  useEffect(() => {
    if (editing) setDraft(String(visiblePage));
  }, [editing, visiblePage]);

  if (!editing) {
    return (
      <span
        className="muted mono"
        onClick={() => setEditing(true)}
        style={{
          fontSize: 11, minWidth: 72, textAlign: "center",
          cursor: "pointer", padding: "2px 4px", borderRadius: 4,
        }}
        title="Click to jump to a specific page"
      >
        {visiblePage}/{totalPages} · {lineCount}
      </span>
    );
  }
  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n)) onJump(n);
    setEditing(false);
  };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      style={{ width: 60, fontSize: 11, padding: "2px 4px", textAlign: "center" }}
    />
  );
}

/**
 * Paginated view over the local transcript.ndjson. Fetches one page (20
 * lines by default) from the daemon rather than streaming / parsing the
 * whole multi-MB file up-front. The latest page is loaded on mount and
 * whenever `transcriptSize` grows; other pages only load when the user
 * explicitly clicks to them. Older pages are cached per-session per-tab
 * so flipping back and forth is instant.
 */
function TranscriptView({ sessionId, hasFile, transcriptSize, lastTranscriptAt }: {
  sessionId: string;
  hasFile: boolean;
  transcriptSize?: number;
  lastTranscriptAt?: string;
}) {
  type PageCache = Map<number, { turns: TranscriptTurn[]; text: string }>;
  const scrollRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<PageCache>(new Map());
  const [pageIndex, setPageIndex] = useState(-1);   // -1 = "latest"; server resolves
  const [lineCount, setLineCount] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState("");

  const resolvedPage = pageIndex < 0
    ? Math.max(0, totalPages - 1)
    : Math.min(pageIndex, Math.max(0, totalPages - 1));
  const onLatest = resolvedPage === Math.max(0, totalPages - 1);

  // Reset cache + pageIndex whenever we switch sessions.
  useEffect(() => {
    cacheRef.current = new Map();
    setPageIndex(-1);
    setLineCount(0);
    setTotalPages(0);
    setRawText("");
    setShowRaw(false);
    setErr("");
  }, [sessionId]);

  // Fetch the current page (re-fetch on growth if we're on the latest page).
  useEffect(() => {
    if (!hasFile) return;
    // Only reuse a cached page if we're NOT on the latest — the latest page's
    // contents change whenever CC appends, so always ask the server for it.
    const cacheKey = pageIndex;  // preserve "-1" sentinel for latest
    const cached = !onLatest ? cacheRef.current.get(resolvedPage) : undefined;
    if (cached) return;

    let cancelled = false;
    setLoading(true);
    setErr("");
    api.getSessionTranscriptPage(sessionId, cacheKey).then((r) => {
      if (cancelled) return;
      setLineCount(r.line_count);
      setTotalPages(r.total_pages);
      setPageSize(r.page_size);
      const turns = parseTranscript(r.text);
      cacheRef.current.set(r.page_index, { turns, text: r.text });
      // Keep pageIndex at -1 for the "follow latest" mode. Previously we
      // promoted it to r.page_index on first fetch, but that pinned the
      // user's view to an absolute page number — so when new transcript
      // content bumped total_pages, resolvedPage stayed put and the
      // view stopped advancing. Staying at -1 lets resolvedPage track
      // totalPages - 1 automatically on every subsequent growth.
    }).catch((e) => {
      if (cancelled) return;
      setErr(String((e as Error)?.message ?? e));
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // transcriptSize / lastTranscriptAt drive refresh-on-growth for the
    // latest page. For non-latest pages they're ignored (cached).
  }, [sessionId, pageIndex, transcriptSize, lastTranscriptAt, hasFile]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom when we're on latest + new content lands.
  useEffect(() => {
    if (onLatest && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [onLatest, lineCount]);

  // "View raw" fetches the whole transcript lazily via the byte-range
  // endpoint; skipped unless the user toggles it.
  useEffect(() => {
    if (!showRaw) return;
    let cancelled = false;
    api.getSessionTranscript(sessionId, 0, 10 * 1024 * 1024).then((r) => {
      if (cancelled) return;
      setRawText(r.data);
    }).catch((e) => !cancelled && setErr(String((e as Error)?.message ?? e)));
    return () => { cancelled = true; };
  }, [showRaw, sessionId]);

  if (!hasFile) {
    return (
      <>
        <h2>Transcript</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Waiting for Claude to create its JSONL — should appear a second or two after the session starts.
          </div>
        </div>
      </>
    );
  }

  const currentPage = cacheRef.current.get(resolvedPage);
  const pageTurns = currentPage?.turns ?? [];

  if (totalPages === 0 && !loading) {
    return (
      <>
        <h2>Transcript</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>No messages yet.</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Transcript</h2>
        <div className="row" style={{ gap: 4 }}>
          {!showRaw && totalPages > 1 && (
            <>
              <button
                className="secondary"
                style={{ padding: "4px 8px", fontSize: 12 }}
                disabled={resolvedPage <= 0}
                onClick={() => setPageIndex(Math.max(0, resolvedPage - 1))}
                title="Older turns"
              >←</button>
              <TranscriptPageIndicator
                totalPages={totalPages}
                pageIndex={resolvedPage}
                lineCount={lineCount}
                onJump={(oneIndexed) => setPageIndex(Math.max(0, Math.min(totalPages - 1, oneIndexed - 1)))}
              />
              <button
                className="secondary"
                style={{ padding: "4px 8px", fontSize: 12 }}
                disabled={resolvedPage >= totalPages - 1}
                onClick={() => setPageIndex(Math.min(totalPages - 1, resolvedPage + 1))}
                title="Newer turns"
              >→</button>
              <button
                className="secondary"
                style={{ padding: "4px 8px", fontSize: 12 }}
                disabled={onLatest}
                onClick={() => setPageIndex(-1)}
                title="Jump to the most recent turns"
              >⤓</button>
            </>
          )}
          <button
            className="secondary"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => setShowRaw((v) => !v)}
            title="Show the underlying JSONL lines for debugging"
          >{showRaw ? "Hide raw" : "View raw"}</button>
        </div>
      </div>
      {err && <div className="error-banner" style={{ marginTop: 6 }}>{err}</div>}
      <div
        ref={scrollRef}
        className="scroll-panel"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          maxHeight: 420,
          background: "#0e1116",
          padding: 8,
        }}
      >
        {showRaw
          ? <pre className="code" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{rawText}</pre>
          : (pageTurns.length === 0 && loading
              ? <div className="muted" style={{ padding: 16, fontSize: 12 }}>Loading page…</div>
              : pageTurns.map((t, i) => <TranscriptTurnRow key={resolvedPage * pageSize + i} turn={t} />)
          )}
      </div>
    </>
  );
}

function TranscriptTurnRow({ turn }: { turn: TranscriptTurn }) {
  const roleStyle = useMemo(() => roleBadgeStyle(turn.kind), [turn.kind]);
  // Label: use the detected role/kind. For "unknown" entries prefer the
  // raw `type` field from the underlying JSON so the user still sees what
  // the line actually was (e.g. "system", "summary", future types).
  const label = turn.kind === "unknown"
    ? (typeof (turn.raw as any).type === "string" ? (turn.raw as any).type : "unknown")
    : roleStyle.label;

  return (
    <div style={{ margin: "10px 6px", paddingLeft: 8, borderLeft: `3px solid ${roleStyle.accent}` }}>
      <div className="row" style={{ gap: 8, alignItems: "baseline", marginBottom: 4 }}>
        <span className="pill" style={{
          background: roleStyle.bg, color: roleStyle.fg, fontSize: 11,
        }}>{label}</span>
        {turn.ts && (
          <span className="muted" style={{ fontSize: 11 }} title={fullTime(turn.ts)}>
            {relativeTime(turn.ts)}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {turn.blocks.length > 0
          ? turn.blocks.map((b, i) => <TranscriptBlock key={i} block={b} />)
          : <RawJsonBlock raw={turn.raw} />}
      </div>
    </div>
  );
}

/**
 * Shown for entries we can't decompose into semantic blocks (unknown top-
 * level types, or message shapes CC added after this parser was written).
 * Collapsed by default so the row stays skimmable; the full JSON is one
 * click away.
 */
function RawJsonBlock({ raw }: { raw: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    // Strip the frame fields that every row already shows, so the preview
    // actually carries signal.
    const rest: Record<string, unknown> = { ...raw };
    for (const k of ["uuid", "parentUuid", "timestamp", "sessionId", "cwd", "gitBranch", "version", "userType", "isSidechain", "requestId"]) {
      delete rest[k];
    }
    return JSON.stringify(rest).slice(0, 400);
  }, [raw]);
  return (
    <div
      onClick={() => setExpanded((v) => !v)}
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        fontFamily: "var(--mono)",
        fontSize: 12,
        color: "var(--fg-dim)",
      }}
      title="Click to expand the full JSON for this entry"
    >
      {expanded ? (
        <pre className="code" style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap" }}>
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : (
        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ opacity: 0.6, marginRight: 6 }}>▸</span>
          {preview}
        </div>
      )}
    </div>
  );
}

function TranscriptBlock({ block }: { block: TranscriptTurn["blocks"][number] }) {
  const [expanded, setExpanded] = useState(block.type === "text");
  if (block.type === "text") {
    return (
      <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
        {block.text}
      </div>
    );
  }
  if (block.type === "tool_use") {
    const argsPreview = typeof block.input === "object" && block.input
      ? Object.keys(block.input as object).join(", ")
      : "";
    return (
      <div
        style={{
          background: "rgba(106,164,255,0.08)",
          border: "1px solid rgba(106,164,255,0.25)",
          borderRadius: 6,
          padding: "6px 10px",
        }}
      >
        <div
          className="row"
          style={{ gap: 6, fontSize: 12, cursor: "pointer", alignItems: "baseline" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="muted" style={{ fontSize: 11 }}>tool_use</span>
          <span className="mono" style={{ color: "var(--accent)" }}>{block.name}</span>
          {!expanded && argsPreview && <span className="muted" style={{ fontSize: 11 }}>({argsPreview})</span>}
          <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre className="code" style={{ marginTop: 6, fontSize: 11, maxHeight: 200 }}>{JSON.stringify(block.input, null, 2)}</pre>
        )}
      </div>
    );
  }
  if (block.type === "tool_result") {
    return (
      <div
        style={{
          background: block.is_error ? "rgba(239,107,107,0.08)" : "rgba(110,207,110,0.06)",
          border: `1px solid ${block.is_error ? "rgba(239,107,107,0.25)" : "rgba(110,207,110,0.18)"}`,
          borderRadius: 6,
          padding: "6px 10px",
        }}
      >
        <div
          className="row"
          style={{ gap: 6, fontSize: 12, cursor: "pointer", alignItems: "baseline" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="muted" style={{ fontSize: 11 }}>tool_result</span>
          {block.is_error && <span className="pill err" style={{ fontSize: 10 }}>error</span>}
          <span className="muted" style={{ fontSize: 11 }}>
            {block.content.length} chars
          </span>
          <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{expanded ? "▾" : "▸"}</span>
        </div>
        {expanded && (
          <pre
            className="code"
            style={{ marginTop: 6, fontSize: 11, maxHeight: 260, whiteSpace: "pre-wrap" }}
          >{block.content}</pre>
        )}
      </div>
    );
  }
  if (block.type === "image") {
    return <div className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>[image]</div>;
  }
  return (
    <pre className="code" style={{ fontSize: 11, maxHeight: 120 }}>{JSON.stringify(block.raw, null, 2)}</pre>
  );
}

function roleBadgeStyle(kind: TranscriptTurn["kind"]): { label: string; bg: string; fg: string; accent: string } {
  switch (kind) {
    case "user":        return { label: "user",        bg: "#2a3142", fg: "#aab4d0", accent: "#5b6475" };
    case "assistant":   return { label: "assistant",   bg: "rgba(106,164,255,0.15)", fg: "#c8d7ff", accent: "#6aa4ff" };
    case "tool_result": return { label: "tool_result", bg: "rgba(110,207,110,0.1)",  fg: "#c5e6c5", accent: "#6ecf6e" };
    case "system":      return { label: "system",      bg: "#2a2f38", fg: "var(--fg-dim)", accent: "#4a5160" };
    case "summary":     return { label: "summary",     bg: "rgba(242,185,75,0.1)",   fg: "#ead39a", accent: "var(--warn)" };
    default:            return { label: "?",           bg: "#2a2f38", fg: "var(--fg-dim)", accent: "#3a4150" };
  }
}

/**
 * Three-state button group for per-session filebrowser. Idle → Start.
 * Running → Open (new tab) + Stop. Disabled while the server round-trip
 * is in flight. Error toasts inline below the button with a small pill.
 */
function FileBrowserControls({ session, state, err, onStart, onStop }: {
  session: Session;
  state: "idle" | "starting" | "stopping";
  err: string;
  onStart: () => void;
  onStop: () => void;
}) {
  const running = !!session.filebrowser_local_port;
  const url = `/api/sessions/${encodeURIComponent(session.id)}/files/`;

  if (!running) {
    // Idle: single button (no group). Uses the shared active-toggle style
    // when starting so the visual "I'm doing something" is consistent with
    // Notes/Keyboard being open.
    return (
      <div className="row" style={{ gap: 4, alignItems: "center" }}>
        <button
          className="secondary action-bar-btn"
          style={state === "starting" ? ACTIVE_TOGGLE_STYLE : undefined}
          onClick={onStart}
          disabled={state !== "idle"}
          title="Spawn filebrowser on the remote scoped to this session's workdir"
        >
          <span className="emoji">📁</span>
          {state === "starting" ? "Starting…" : "FileBrowser"}
        </button>
        {err && <span className="pill err" style={{ fontSize: 10 }} title={err}>error</span>}
      </div>
    );
  }

  // Running: segmented button group. The two halves share a border and the
  // active-toggle accent is applied across the whole group so it reads as
  // one "FileBrowser is on" affordance, with the specific action buttons
  // inside.
  const groupBtnStyle: React.CSSProperties = {
    ...ACTIVE_TOGGLE_STYLE,
    borderRadius: 0,
  };
  return (
    <div className="row" style={{ gap: 0, alignItems: "center" }}>
      {/* Rendering Open as a <button> + window.open rather than <a> avoids
          the browser's :visited color rules turning the text invisible on
          the accent-tinted background after first use. `.secondary` CSS
          only targets `button.secondary`, which is another reason <a> was
          mis-styled here. */}
      <button
        className="secondary action-bar-btn"
        style={{
          ...groupBtnStyle,
          borderTopLeftRadius: 6,
          borderBottomLeftRadius: 6,
          borderRight: "none",
        }}
        onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        title="Open the filebrowser UI in a new tab"
      >
        <span className="emoji">📁</span>
        Open FileBrowser
        <span className="emoji">↗</span>
      </button>
      <button
        className="secondary action-bar-btn"
        style={{
          ...groupBtnStyle,
          borderTopRightRadius: 6,
          borderBottomRightRadius: 6,
        }}
        onClick={onStop}
        disabled={state !== "idle"}
        title="Kill the remote filebrowser and drop its SSH forward"
      >
        {state === "stopping" ? "Stopping…" : <><span className="emoji">⏹</span>Stop</>}
      </button>
      {err && <span className="pill err" style={{ fontSize: 10, marginLeft: 4 }} title={err}>error</span>}
    </div>
  );
}

/**
 * Copy of FileBrowserControls structure pointed at the code-server
 * endpoints. Segmented button group when running (Open + Stop), single
 * button when idle.
 */
function VsCodeControls({ session, state, err, onStart, onStop }: {
  session: Session;
  state: "idle" | "starting" | "stopping";
  err: string;
  onStart: () => void;
  onStop: () => void;
}) {
  const running = !!session.codeserver_local_port;
  // Default-open the session's workdir in the browser VS Code instead of
  // the welcome page. code-server reads ?folder=<abs> to auto-open.
  const baseUrl = `/api/sessions/${encodeURIComponent(session.id)}/code/`;
  const url = session.codeserver_workdir
    ? `${baseUrl}?folder=${encodeURIComponent(session.codeserver_workdir)}`
    : baseUrl;

  if (!running) {
    return (
      <div className="row" style={{ gap: 4, alignItems: "center" }}>
        <button
          className="secondary action-bar-btn"
          style={state === "starting" ? ACTIVE_TOGGLE_STYLE : undefined}
          onClick={onStart}
          disabled={state !== "idle"}
          title="Spawn code-server (browser VS Code) scoped to this session's workdir — first launch downloads ~200MB"
        >
          <span className="emoji">🧑‍💻</span>
          {state === "starting" ? "Starting…" : "VS Code"}
        </button>
        {err && <span className="pill err" style={{ fontSize: 10 }} title={err}>error</span>}
      </div>
    );
  }

  const groupBtnStyle: React.CSSProperties = {
    ...ACTIVE_TOGGLE_STYLE,
    borderRadius: 0,
  };
  return (
    <div className="row" style={{ gap: 0, alignItems: "center" }}>
      <button
        className="secondary action-bar-btn"
        style={{
          ...groupBtnStyle,
          borderTopLeftRadius: 6,
          borderBottomLeftRadius: 6,
          borderRight: "none",
        }}
        onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        title="Open VS Code in a new tab"
      >
        <span className="emoji">🧑‍💻</span>
        Open VS Code
        <span className="emoji">↗</span>
      </button>
      <button
        className="secondary action-bar-btn"
        style={{
          ...groupBtnStyle,
          borderTopRightRadius: 6,
          borderBottomRightRadius: 6,
        }}
        onClick={onStop}
        disabled={state !== "idle"}
        title="Kill the remote code-server and drop its SSH forward"
      >
        {state === "stopping" ? "Stopping…" : <><span className="emoji">⏹</span>Stop</>}
      </button>
      {err && <span className="pill err" style={{ fontSize: 10, marginLeft: 4 }} title={err}>error</span>}
    </div>
  );
}

function ClaudeTerminal({ session, fillParent, notesToggle, inputToggle, fileBrowserControls, codeServerControls, onOpenInWorkspace }: {
  session: Session;
  fillParent?: boolean;
  /** LEFT side, between Context and the Keyboard toggle. The 📝 Notes
   * button that opens the floating scratchpad for this session. */
  notesToggle?: React.ReactNode;
  /** Rendered on the LEFT side of the action bar, alongside the Context
   * button. Used by SessionView to pass the Keyboard/input toggle. */
  inputToggle?: React.ReactNode;
  /** LEFT side, right after Keyboard. The File Browser start/open/stop
   * button group. Separated from inputToggle so SessionView can own the
   * filebrowser lifecycle state without touching the terminal. */
  fileBrowserControls?: React.ReactNode;
  /** LEFT side, right after FileBrowser. The VS Code (code-server)
   * start/open/stop button group — same pattern, separate lifecycle. */
  codeServerControls?: React.ReactNode;
  /** When set, a ⇲ Workspace button appears on the RIGHT side of the
   * action bar between + and New tab. SessionView passes this only when
   * the view is mounted as a modal. */
  onOpenInWorkspace?: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  // Changing reloadKey remounts the iframe, which forces ttyd to do a
  // fresh handshake and re-measure its container — useful after modal
  // resizes that left the terminal drawn to stale dimensions.
  const [reloadKey, setReloadKey] = useState(0);
  // ContextPushPopover plumbing. Declared here — ABOVE the isLive /
  // portReady early-return branches further down — because hooks
  // declared after those returns would be skipped on the provisioning
  // render but called on the active render, which blows up with
  // React #310 "Rendered more hooks than during the previous render"
  // the moment the session flips status mid-mount. Bit us in v0.5.9
  // when ContextPushPopover was first wired in; the symptom is a
  // black screen right after "+ New session" that goes away on reload.
  const contextBtnRef = useRef<HTMLButtonElement | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  // CSS zoom on the iframe scales the xterm content. Chrome/Safari/Edge
  // support this; Firefox ignores — acceptable. Persisted globally so
  // the user's preferred zoom sticks across reloads and sessions.
  const [contentZoom, setContentZoomState] = useState<number>(() => loadTerminalZoom());
  const setContentZoom = (updater: number | ((z: number) => number)) => {
    setContentZoomState((prev) => {
      const raw = typeof updater === "function" ? updater(prev) : updater;
      const next = Math.max(0.5, Math.min(2, +raw.toFixed(2)));
      saveTerminalZoom(next);
      return next;
    });
  };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoomed(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  // When the container resizes (modal open, column reflow, full-screen
  // toggle), nudge ttyd to re-measure by dispatching a resize event on
  // the iframe's window. Same-origin via the proxy so this is allowed.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fire = () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      try { win.dispatchEvent(new Event("resize")); } catch {}
    };
    const ro = new ResizeObserver(() => fire());
    ro.observe(el);
    // Fire a couple of delayed pings after mount — the first ttyd handshake
    // can complete after the initial ResizeObserver tick.
    const timers = [120, 400, 900].map((ms) => window.setTimeout(fire, ms));
    return () => {
      ro.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [reloadKey, zoomed]);

  const url = `/api/sessions/${encodeURIComponent(session.id)}/terminal/`;
  const isLive = session.status === "active" || session.status === "provisioning";
  const portReady = !!session.terminal_local_port;

  if (!isLive) {
    return (
      <>
        <h2>Terminal</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Session is {session.status}. Terminal is only embedded while the session is active.
          </div>
        </div>
      </>
    );
  }

  if (!portReady) {
    // status is active/provisioning but we never got a terminal_local_port —
    // either still provisioning (should be brief) or setup failed. Check
    // the event stream for a session-terminal error.
    return (
      <>
        <h2>Terminal</h2>
        <div className="card" style={{ padding: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {session.status === "provisioning"
              ? "Provisioning remote ttyd + tunnel…"
              : "Terminal didn't come up. Check the Events below for the setup error, or ssh in and tmux attach manually."}
          </div>
          <pre className="code" style={{ marginTop: 8, fontSize: 11 }}>
{`ssh ${session.machine === "local" ? "<machine>" : session.machine} \\
  -t tmux attach -t ${session.tmux_session}`}
          </pre>
        </div>
      </>
    );
  }

  const containerStyle: React.CSSProperties = zoomed
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "#0a0c10", display: "flex", flexDirection: "column" }
    : fillParent
      // Fill the surrounding flex column (two-column modal layout).
      ? { flex: 1, minHeight: 320, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "#0a0c10", display: "flex", flexDirection: "column" }
      // Legacy single-column modal: fixed height so the flow below still fits.
      : { height: 420, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "#0a0c10", display: "flex", flexDirection: "column" };

  return (
    <>
      {!zoomed && (
        <div className="row" style={{ justifyContent: "space-between", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
          {/* LEFT: session-scoped input/context affordances. */}
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <button
                ref={contextBtnRef}
                className="secondary action-bar-btn"
                onClick={() => setContextOpen((v) => !v)}
                title="Push resources (git-repos, optionally their deploy keys) into this session's remote workdir"
              >
                <span className="emoji">＋</span>Context
              </button>
              {contextOpen && (
                <ContextPushPopover
                  session={session}
                  anchorEl={contextBtnRef.current}
                  onClose={() => setContextOpen(false)}
                />
              )}
            </div>
            {notesToggle}
            {inputToggle}
            {fileBrowserControls}
            {codeServerControls}
          </div>
          {/* RIGHT: viewport controls — zoom, nav, window. */}
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button
              className="secondary action-bar-btn"
              onClick={() => setContentZoom((z) => z - 0.1)}
              title="Shrink terminal content (CSS zoom; Chromium/Safari only)"
            >−</button>
            <span className="muted mono" style={{ fontSize: 11, minWidth: 32, textAlign: "center", alignSelf: "center" }}>
              {Math.round(contentZoom * 100)}%
            </span>
            <button
              className="secondary action-bar-btn"
              onClick={() => setContentZoom((z) => z + 0.1)}
              title="Enlarge terminal content (CSS zoom; Chromium/Safari only)"
            >+</button>
            {onOpenInWorkspace && (
              <button
                className="secondary action-bar-btn"
                onClick={onOpenInWorkspace}
                title="Close this modal and open the session in the Workspace view"
              ><span className="emoji">⇲</span>Workspace</button>
            )}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="secondary action-bar-btn"
              style={{
                textDecoration: "none",
                background: "#323844", color: "var(--fg)",
                border: "1px solid #3f4754",
              }}
              title="Open in a new browser tab"
            ><span className="emoji">↗</span>New tab</a>
            <button
              className="secondary action-bar-btn"
              onClick={() => setZoomed(true)}
              title="Expand to full screen (Esc to exit)"
            ><span className="emoji">⛶</span>Full screen</button>
            <button
              className="secondary action-bar-btn"
              onClick={() => setReloadKey((k) => k + 1)}
              title="Reload the ttyd iframe (forces tmux to re-measure the pane)"
            >↻</button>
          </div>
        </div>
      )}
      <div ref={containerRef} style={containerStyle}>
        {zoomed && (
          <div className="row" style={{ padding: 6, borderBottom: "1px solid var(--border)", background: "var(--bg-elev)" }}>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
              Session {session.id} · {session.machine} · {session.tmux_session}
            </span>
            <div style={{ flex: 1 }} />
            <button className="secondary" onClick={() => setReloadKey((k) => k + 1)} title="Reload" style={{ marginRight: 6 }}>↻ Reload</button>
            <button className="secondary" onClick={() => setZoomed(false)} title="Exit full screen (Esc) — the session keeps running">× Exit full screen</button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={reloadKey}
          title={`session-${session.id}-terminal`}
          src={url}
          scrolling="no"
          onLoad={() => {
            const win = iframeRef.current?.contentWindow;
            if (!win) return;
            // ttyd sometimes measures before the flex container has its
            // final size. Fire a couple of resizes post-load so it
            // re-fits without the user needing to hit Reload.
            [60, 250, 600].forEach((ms) => setTimeout(() => {
              try { win.dispatchEvent(new Event("resize")); } catch {}
            }, ms));
            // ttyd wires a beforeunload handler so the browser warns about
            // losing the WS session on navigation. We're a single-page app
            // that tears down the iframe on tab-switch; the dialog is just
            // noise. Same-origin via the proxy means we can null it out.
            try {
              win.onbeforeunload = null;
              win.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
                e.stopImmediatePropagation();
                delete (e as unknown as { returnValue?: string }).returnValue;
              }, { capture: true });
            } catch {}
          }}
          style={{
            flex: 1, border: "none", width: "100%", display: "block", overflow: "hidden",
            // `zoom` is webkit-style; Firefox ignores which is fine — the
            // default 1.0 is a no-op. We also cast because React's CSS
            // typings don't include zoom.
            ...(contentZoom !== 1 ? ({ zoom: contentZoom } as React.CSSProperties) : {}),
          }}
        />
      </div>
    </>
  );
}

/**
 * Modal for setting a session's alias + accent color. Writes to the server
 * and calls onSaved with the updated Session so the parent can refresh.
 */
export function SessionConfigDialog({ session, onClose, onSaved }: {
  session: Session;
  onClose: () => void;
  onSaved: (s: Session) => void;
}) {
  const [alias, setAliasText] = useState(session.alias ?? "");
  const [color, setColor] = useState(session.alias_color || "none");
  const [tags, setTags] = useState<string[]>(session.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const addTag = (raw: string) => {
    const n = raw.trim().toLowerCase().slice(0, 32);
    if (!n || tags.includes(n) || tags.length >= 16) return;
    setTags((t) => [...t, n]);
  };
  const removeTag = (t: string) => setTags((cur) => cur.filter((x) => x !== t));

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const next = await api.updateSessionMeta(session.id, {
        alias: alias.trim(),
        alias_color: color === "none" ? "" : color,
        tags,
      });
      onSaved(next);
      onClose();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 20,
          width: 380,
        }}
      >
        <h2 style={{ margin: "0 0 12px", fontSize: 14, color: "var(--fg)" }}>
          Session config — {session.id}
        </h2>
        <label style={{ marginBottom: 12 }}>
          <span>Alias</span>
          <input
            autoFocus
            value={alias}
            placeholder={session.id}
            onChange={(e) => setAliasText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") onClose();
            }}
            style={{ fontSize: 13 }}
          />
        </label>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>Accent color</div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {ALIAS_COLORS.map((c) => {
            const on = color === c.name;
            return (
              <button
                key={c.name}
                type="button"
                onClick={() => setColor(c.name)}
                title={c.label}
                style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: c.bg === "transparent" ? "var(--bg-card)" : c.bg,
                  color: c.fg,
                  border: on ? "2px solid var(--fg)" : "1px solid var(--border)",
                  padding: 0, cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                }}
              >
                {c.name === "none" ? "∅" : "A"}
              </button>
            );
          })}
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Tags <span style={{ opacity: 0.7 }}>(session appears once per tag in the Workspace sidebar)</span>
        </div>
        <div
          className="row"
          style={{
            flexWrap: "wrap", gap: 4, marginBottom: 8,
            minHeight: 28,
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-card)",
          }}
        >
          {tags.map((t) => (
            <span
              key={t}
              className="pill mono"
              style={{ fontSize: 11, padding: "2px 6px", display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              {t}
              <button
                type="button"
                onClick={() => removeTag(t)}
                title="Remove tag"
                style={{
                  padding: 0, fontSize: 11, lineHeight: 1,
                  background: "transparent", color: "inherit",
                  border: "none", cursor: "pointer", opacity: 0.7,
                }}
              >×</button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                if (tagDraft.trim()) { addTag(tagDraft); setTagDraft(""); }
              } else if (e.key === "Backspace" && !tagDraft && tags.length > 0) {
                removeTag(tags[tags.length - 1]!);
              }
            }}
            placeholder={tags.length === 0 ? "type a tag + Enter" : ""}
            style={{
              flex: 1, minWidth: 80, padding: "2px 4px",
              background: "transparent", border: "none", fontSize: 12,
            }}
          />
        </div>
        {err && <div className="error-banner" style={{ marginBottom: 12 }}>{err}</div>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Meta({ s }: { s: Session }) {
  const T = ({ t }: { t?: string }) => (
    <span title={fullTime(t)}>{relativeTime(t)}</span>
  );
  const cmdLabel = isInteractiveAgent(s.agent_kind) ? "prompt" : "cmd";
  return (
    <div className="card" style={{ padding: 12, fontSize: 12.5 }}>
      <Row k="kind"><span className="mono">{s.agent_kind}</span></Row>
      <PromptRow label={cmdLabel} cmd={s.cmd} />
      <Row k="tmux"><span className="mono">{s.tmux_session}</span></Row>
      <Row k="created"><T t={s.created_at} /></Row>
      <Row k="started"><T t={s.started_at} /></Row>
      <Row k="exited">
        <T t={s.exited_at} />
        {s.exit_code !== undefined ? ` (code ${s.exit_code})` : ""}
      </Row>
      {s.cc_session_file && (
        <Row k="cc file"><span className="mono" style={{ wordBreak: "break-all" }}>{s.cc_session_file}</span></Row>
      )}
    </div>
  );
}

/**
 * Prompts / shell commands can be long (a resumed CC session's first user
 * message is sometimes several paragraphs). Collapse it by default so the
 * Meta card stays skinny — click to expand. Empty prompts render inline
 * as "(none)" with no click affordance.
 */
function PromptRow({ label, cmd }: { label: string; cmd: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!cmd) {
    return <Row k={label}><span className="muted">(none)</span></Row>;
  }
  if (!expanded) {
    const oneLine = cmd.replace(/\s+/g, " ").trim();
    const snippet = oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine;
    return (
      <Row k={label}>
        <span
          onClick={() => setExpanded(true)}
          className="mono"
          title="Click to expand"
          style={{
            cursor: "pointer",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "inline-flex",
            alignItems: "baseline",
            gap: 4,
            maxWidth: "100%",
          }}
        >
          <span style={{ opacity: 0.6, fontSize: 11 }}>▸</span>
          <span>{snippet}</span>
        </span>
      </Row>
    );
  }
  return (
    <Row k={label}>
      <div
        onClick={() => setExpanded(false)}
        className="mono"
        title="Click to collapse"
        style={{ cursor: "pointer", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        <span style={{ opacity: 0.6, fontSize: 11, marginRight: 4 }}>▾</span>
        {cmd}
      </div>
    </Row>
  );
}

function SendInput({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  const sendText = async () => {
    if (!text) return;
    setSending(true); setErr("");
    try {
      await api.sendSessionInput(id, { text });
      setText("");
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setSending(false); }
  };

  const sendKey = async (key: string) => {
    setSending(true); setErr("");
    try { await api.sendSessionInput(id, { keys: [key] }); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setSending(false); }
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(); }
  };

  const Key = ({ k, label, title }: { k: string; label: string; title?: string }) => (
    <button
      type="button"
      className="secondary"
      disabled={sending}
      onClick={() => sendKey(k)}
      title={title ?? `send ${k}`}
      style={{ padding: "4px 10px", fontSize: 12 }}
    >{label}</button>
  );

  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Send input to the running pane. <span className="mono">Send</span> delivers the text box
        only — use the <span className="mono">↩ Enter</span> quick key to press Enter separately.
        <span className="mono">{" ⌘/Ctrl+Enter"}</span> in the textarea also sends.
      </div>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <textarea
          className="grow"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="message to the running agent…"
        />
        <button
          disabled={sending || !text}
          onClick={sendText}
          title="send-keys -l <text> (no trailing Enter)"
        >Send</button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>Quick keys:</span>
        <Key k="Enter" label="↩ Enter" title="send Enter" />
        <Key k="Escape" label="Esc" />
        <Key k="Up" label="↑" />
        <Key k="Down" label="↓" />
        <Key k="Left" label="←" />
        <Key k="Right" label="→" />
        <Key k="Tab" label="Tab" />
        <Key k="BSpace" label="⌫ Backspace" />
        <Key k="C-c" label="Ctrl-C" title="interrupt" />
        <Key k="C-d" label="Ctrl-D" title="EOF / exit" />
      </div>
      {err && <div className="error-banner" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 12, marginBottom: 2, alignItems: "flex-start" }}>
      <span
        className="muted"
        style={{ width: 64, fontSize: 11, textTransform: "uppercase", flex: "none", paddingTop: 2 }}
      >{k}</span>
      <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>{children}</span>
    </div>
  );
}

function renderEventPayload(ev: SessionEventRecord): string {
  const { ts: _ts, kind: _kind, ...rest } = ev;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rest)) {
    if (k === "source") continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join("  ");
}

/**
 * Render ANSI-styled pane output. Colors + bold/italic/underline are
 * honored; cursor-move / clear-screen / OSC sequences are stripped because
 * we're rendering to a scrollback div, not a terminal emulator.
 */
function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {spans.map((s, i) =>
        Object.keys(s.style).length === 0
          ? <React.Fragment key={i}>{s.text}</React.Fragment>
          : <span key={i} style={spanStyle(s.style)}>{s.text}</span>
      )}
    </>
  );
}
