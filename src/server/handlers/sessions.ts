import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  createSessionRecord,
  deleteSession,
  listSessions,
  readEvents,
  readRawRange,
  readRecentTranscriptLines,
  readSessionNotes,
  readTranscriptPage,
  readTranscriptRange,
  writeSessionNotes,
  readSession,
  sessionExists,
  updateSession,
  type AgentKind,
} from "../../domain/sessions.ts";
import {
  launchSession,
  stopSession,
  sendInputToSession,
  setupSessionTerminal,
  teardownSessionTerminal,
  setupSessionFilebrowser,
  teardownSessionFilebrowser,
  setupSessionCodeServer,
  teardownSessionCodeServer,
} from "../../domain/session-launcher.ts";
import type { SessionPoller } from "../../domain/session-poller.ts";
import type { ForwardManager } from "../../domain/forward-manager.ts";
import { pushContext, type GitRepoPick, type MarkdownPick, type FileBundlePick } from "../../domain/context-push.ts";
import { getSkillStatus, installSkill } from "../../domain/skill-install.ts";
import { exportSession } from "../../domain/session-export.ts";
import { inspectImport, applyImport } from "../../domain/session-import.ts";

/**
 * Pull the uploaded zip bytes out of either a `multipart/form-data`
 * payload (with a single `file` field — normal browser form submission)
 * or a raw `application/zip` body (curl / scripted uploads). Kept here
 * rather than in the router helpers module because import is currently
 * the only endpoint that needs it.
 */
async function readUploadedZip(req: Request): Promise<Buffer> {
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
      throw new Error("multipart body must include a `file` field with the zip");
    }
    return Buffer.from(await (file as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer());
  }
  // Raw body — accept any content-type, but refuse empty.
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) throw new Error("empty request body");
  return buf;
}

export function mountSessions(router: Router, dir: DataDir, poller: SessionPoller, forwardManager: ForwardManager): void {
  router.get("/api/sessions", () => json(listSessions(dir)));

  router.get("/api/sessions/:id", ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    return json(readSession(dir, params.id!));
  });

  router.post("/api/sessions", async ({ req }) => {
    const body = await parseJsonBody<{
      machine: string;
      workdir: string;
      agent_kind: AgentKind;
      cmd: string;
      cc_skip_trust?: boolean;
      cc_resume_uuid?: string;
      launch_command?: string;
      cc_agent_teams?: boolean;
      codex_skip_trust?: boolean;
      codex_resume_uuid?: string;
    }>(req);
    for (const k of ["machine", "workdir", "agent_kind"] as const) {
      if (!body[k]) throw new HttpError(400, `${k} required`);
    }
    if (body.agent_kind !== "generic-cmd"
        && body.agent_kind !== "claude-code"
        && body.agent_kind !== "codex") {
      throw new HttpError(400, "unknown agent_kind");
    }
    // cmd is the shell command for generic-cmd (required) and the initial
    // prompt for claude-code / codex (optional — empty means open the TUI
    // with no preloaded message; fully optional when a resume UUID is set).
    if (body.agent_kind === "generic-cmd" && !body.cmd) {
      throw new HttpError(400, "cmd required");
    }
    if (typeof body.cmd !== "string") body.cmd = "";
    // Accept either an absolute path or a "~/..." style path that will be
    // expanded on the remote against $HOME.
    if (!body.workdir.startsWith("/") && !body.workdir.startsWith("~/") && body.workdir !== "~") {
      throw new HttpError(400, "workdir must be an absolute path or start with ~/");
    }
    const s = createSessionRecord(dir, {
      machine: body.machine,
      workdir: body.workdir,
      agent_kind: body.agent_kind,
      cmd: body.cmd,
      cc_skip_trust: !!body.cc_skip_trust,
      cc_resume_uuid: body.cc_resume_uuid || undefined,
      launch_command: body.launch_command || undefined,
      cc_agent_teams: !!body.cc_agent_teams,
      codex_skip_trust: !!body.codex_skip_trust,
      codex_resume_uuid: body.codex_resume_uuid || undefined,
    });
    // Launch asynchronously so the HTTP request returns quickly. The
    // launcher itself now stands up the per-session ttyd + forward
    // before flipping status to "active", so UI observers can rely on
    // "status=active ⇒ terminal ready".
    //
    // The setTimeout wrap is load-bearing: `launchSession` is `async`
    // but has no `await` before its first `sshExec` (spawnSync), so
    // calling it synchronously from here would block the event loop
    // — and therefore this handler's response — for the full ssh
    // bootstrap (up to 60s). Deferring to a macrotask lets us return
    // the 201 first, so the frontend's POST completes immediately and
    // the new-session modal doesn't freeze while the remote tmux is
    // being set up.
    setTimeout(() => {
      launchSession(dir, s.id, forwardManager)
        .then(() => poller.watch(s.id))
        .catch((err) => console.error(`[sessions] launch ${s.id} failed:`, err));
    }, 0);
    return json(s, { status: 201 });
  });

  // Mutate user-facing metadata (alias, alias color). Scoped intentionally
  // narrow — anything else should go through a dedicated endpoint so we
  // don't accidentally let the client rewrite status/offsets via PATCH.
  router.post("/api/sessions/:id/meta", async ({ req, params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const body = await parseJsonBody<{
      alias?: string | null;
      alias_color?: string | null;
      tags?: string[] | null;
    }>(req);
    const patch: { alias?: string; alias_color?: string; tags?: string[] } = {};
    if (body.alias !== undefined) {
      const trimmed = typeof body.alias === "string" ? body.alias.trim() : "";
      if (trimmed) patch.alias = trimmed.slice(0, 64);
      else         patch.alias = "";
    }
    if (body.alias_color !== undefined) {
      const c = typeof body.alias_color === "string" ? body.alias_color.trim() : "";
      if (c) patch.alias_color = c.slice(0, 32);
      else   patch.alias_color = "";
    }
    if (body.tags !== undefined) {
      // Normalize: trim, lowercase, dedupe, drop empties, cap per-tag + total.
      const raw = Array.isArray(body.tags) ? body.tags : [];
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const t of raw) {
        if (typeof t !== "string") continue;
        const n = t.trim().toLowerCase().slice(0, 32);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        cleaned.push(n);
        if (cleaned.length >= 16) break;
      }
      patch.tags = cleaned;
    }
    const next = updateSession(dir, params.id!, patch);
    return json(next);
  });

  router.post("/api/sessions/:id/stop", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const s = await stopSession(dir, params.id!);
    return json(s);
  });

  router.post("/api/sessions/:id/input", async ({ req, params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const body = await parseJsonBody<{ text?: string; keys?: string[]; press_enter?: boolean }>(req);
    const hasText = typeof body.text === "string";
    const hasKeys = Array.isArray(body.keys) && body.keys.length > 0;
    if (!hasText && !hasKeys) {
      throw new HttpError(400, "text or keys required");
    }
    await sendInputToSession(dir, params.id!, {
      text: hasText ? body.text : undefined,
      keys: hasKeys ? body.keys : undefined,
      press_enter: !!body.press_enter,
    });
    return json({ ok: true });
  });

  router.delete("/api/sessions/:id", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    poller.unwatch(params.id!);
    await teardownSessionTerminal(dir, forwardManager, params.id!).catch(() => {});
    await teardownSessionFilebrowser(dir, forwardManager, params.id!).catch(() => {});
    await teardownSessionCodeServer(dir, forwardManager, params.id!).catch(() => {});
    deleteSession(dir, params.id!);
    return json({ ok: true });
  });

  // Filebrowser per-session lifecycle. Opt-in (the UI has a dedicated Start
  // button) rather than auto-provisioning on launch like the terminal.
  router.post("/api/sessions/:id/filebrowser/start", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    try {
      const res = await setupSessionFilebrowser(dir, forwardManager, params.id!);
      return json({
        ok: true,
        url: `${res.base_path}/`,
        local_port: res.local_port,
        remote_port: res.remote_port,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(500, msg);
    }
  });
  router.post("/api/sessions/:id/filebrowser/stop", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    await teardownSessionFilebrowser(dir, forwardManager, params.id!);
    return json({ ok: true });
  });

  // code-server lifecycle (browser-hosted VS Code), mirrors the
  // filebrowser pattern.
  router.post("/api/sessions/:id/code-server/start", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    try {
      const res = await setupSessionCodeServer(dir, forwardManager, params.id!);
      return json({
        ok: true,
        url: `${res.base_path}/`,
        local_port: res.local_port,
        remote_port: res.remote_port,
        workdir: res.resolved_workdir,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(500, msg);
    }
  });
  router.post("/api/sessions/:id/code-server/stop", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    await teardownSessionCodeServer(dir, forwardManager, params.id!);
    return json({ ok: true });
  });

  // Per-session scratchpad notes (plain text, saved as notes.md next to the
  // session's meta.toml). Debounced autosave from the floating notepad UI.
  router.get("/api/sessions/:id/notes", ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    return json({ text: readSessionNotes(dir, params.id!) });
  });
  router.put("/api/sessions/:id/notes", async ({ req, params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const body = await parseJsonBody<{ text?: string }>(req);
    // Cap at 1 MiB so an accidentally pasted megabyte of binary doesn't
    // fill the disk. Notes are for scratch, not archival.
    const text = typeof body.text === "string" ? body.text.slice(0, 1024 * 1024) : "";
    writeSessionNotes(dir, params.id!, text);
    return json({ ok: true, bytes: Buffer.byteLength(text, "utf8") });
  });

  // Push curated context (currently: git-repos, with opt-in deploy key
  // attached) from the root-folder registry into the session's remote
  // workdir. The remote tree mirrors the root-folder layout 1:1 under
  // `<workdir>/.botdock/context/` so the agent-side skill doesn't need
  // any mapping logic. Writes a context_push audit event.
  router.post("/api/sessions/:id/context/push", async ({ req, params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const body = await parseJsonBody<{
      git_repos?: GitRepoPick[];
      markdowns?: MarkdownPick[];
      file_bundles?: FileBundlePick[];
    }>(req);
    const repoPicks = Array.isArray(body.git_repos) ? body.git_repos : [];
    const mdPicks = Array.isArray(body.markdowns) ? body.markdowns : [];
    const bundlePicks = Array.isArray(body.file_bundles) ? body.file_bundles : [];
    if (repoPicks.length + mdPicks.length + bundlePicks.length === 0) {
      throw new HttpError(400, "at least one git_repos[] / markdowns[] / file_bundles[] item required");
    }
    for (const p of repoPicks) {
      if (!p.name || typeof p.name !== "string") {
        throw new HttpError(400, "each git_repos[] item needs a name");
      }
    }
    for (const p of mdPicks) {
      if (!p.name || typeof p.name !== "string") {
        throw new HttpError(400, "each markdowns[] item needs a name");
      }
    }
    for (const p of bundlePicks) {
      if (!p.name || typeof p.name !== "string") {
        throw new HttpError(400, "each file_bundles[] item needs a name");
      }
    }
    try {
      const result = await pushContext(dir, params.id!, {
        git_repos: repoPicks.map((p) => ({
          name: p.name,
          include_deploy_key: !!p.include_deploy_key,
        })),
        markdowns: mdPicks.map((p) => ({ name: p.name })),
        file_bundles: bundlePicks.map((p) => ({ name: p.name })),
      });
      return json(result);
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  // Export a session as a zip — bundles machine + key + session files
  // (minus notes.md) so another BotDock instance can attach to the same
  // tmux. For local-machine sessions the caller must pass ?host=<addr>
  // since 127.0.0.1 is meaningless to the recipient. Jump-host machines
  // are rejected.
  router.get("/api/sessions/:id/export", async ({ params, url }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const host = url.searchParams.get("host")?.trim() || undefined;
    try {
      const result = exportSession(dir, params.id!, host);
      return new Response(result.bytes, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${result.filename}"`,
          "content-length": String(result.bytes.length),
        },
      });
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  // Inspect an import zip — extract to a temp dir, summarise contents,
  // detect conflicts against existing machines/keys/sessions. Does NOT
  // write anything. Frontend uses this to render the confirmation modal.
  router.post("/api/sessions/import/inspect", async ({ req }) => {
    let buf: Buffer;
    try {
      buf = await readUploadedZip(req);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    try {
      return json(inspectImport(dir, buf));
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  // Apply the import. Rejects if conflicts exist (caller should've
  // resolved them before calling). On success, registers the session
  // with the poller so updates stream in like any other live session.
  router.post("/api/sessions/import/apply", async ({ req }) => {
    let buf: Buffer;
    try {
      buf = await readUploadedZip(req);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    try {
      const result = applyImport(dir, buf);
      // Kick the poller so the imported session behaves like a live one
      // from the UI's perspective — transcript / raw / events stream in
      // on the WebSocket, same as any locally-launched session.
      try { poller.watch(result.session_id); } catch { /* non-fatal */ }
      // Stand up our own local SSH -L forward for the remote ttyd. The
      // exporter's local port info was stripped at export time (it was
      // pinned to their network namespace and would point at nothing
      // on our side), so without this step the session's terminal iframe
      // opens a dead port. The remote ttyd supervisor is already running
      // — startSessionTerminal is idempotent and reuses it.
      //
      // We also flip the session's status active → provisioning while
      // the forward comes up. Without that, the SessionView sees an
      // "active session with no terminal_local_port" and immediately
      // renders the hard "Terminal didn't come up" error for the few
      // seconds between apply and setupSessionTerminal completing. Using
      // the existing provisioning UI state gives the user "Provisioning
      // remote ttyd + tunnel…" which is truthful, then flips back to
      // active once the port lands. On failure we also flip back so the
      // existing error path kicks in instead of the session looking stuck.
      try {
        const imported = readSession(dir, result.session_id);
        if (imported.agent_kind === "claude-code" && imported.status === "active") {
          const originalStatus = imported.status;
          updateSession(dir, result.session_id, { status: "provisioning" });
          // Nudge the WS subscribers now so the UI sees the
          // provisioning flip immediately (rather than waiting for the
          // next poll tick, which can be 2-5s and leaves the user
          // staring at a stale "Terminal didn't come up" error).
          poller.emit("update", result.session_id);
          setupSessionTerminal(dir, forwardManager, result.session_id)
            .then(() => {
              try {
                updateSession(dir, result.session_id, { status: originalStatus });
                poller.emit("update", result.session_id);
              } catch (e) { console.error(`[import ${result.session_id}] status restore failed:`, e); }
            })
            .catch((err) => {
              console.error(`[import ${result.session_id}] terminal setup failed:`, err);
              try {
                updateSession(dir, result.session_id, { status: originalStatus });
                poller.emit("update", result.session_id);
              } catch (e) { console.error(`[import ${result.session_id}] status restore failed:`, e); }
            });
        }
      } catch (e) {
        console.error(`[import] post-apply terminal setup skipped:`, e);
      }
      return json(result);
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  // Inspect the botdock-context skill's install state inside the session's
  // workdir. Used by the ＋Context popover to decide whether to prompt
  // the user to install / update.
  router.get("/api/sessions/:id/context/skill-status", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    try {
      const status = await getSkillStatus(dir, params.id!);
      return json(status);
    } catch (e) {
      throw new HttpError(500, (e as Error).message || String(e));
    }
  });

  // Install (or update) the botdock-context skill via git clone over ssh.
  // Idempotent: `installed` on first run, `updated` on subsequent runs
  // when the remote branch has new commits.
  router.post("/api/sessions/:id/context/skill-install", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    try {
      const result = await installSkill(dir, params.id!);
      return json(result);
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  router.get("/api/sessions/:id/events", ({ params, url }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const r = readEvents(dir, params.id!, offset);
    return json({ records: r.records, nextOffset: r.nextOffset });
  });

  router.get("/api/sessions/:id/raw", ({ params, url }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const max = Number(url.searchParams.get("max") ?? 65536);
    return json(readRawRange(dir, params.id!, offset, max));
  });

  router.get("/api/sessions/:id/transcript", ({ params, url }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const max = Number(url.searchParams.get("max") ?? 262144);
    return json(readTranscriptRange(dir, params.id!, offset, max));
  });

  // Paginated transcript view. Pass `page=-1` (or any out-of-range large
  // number) to get the newest page — the server clamps and returns the
  // resolved page_index so the client doesn't need to pre-fetch stats.
  router.get("/api/sessions/:id/transcript/page", ({ params, url }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const pageRaw = Number(url.searchParams.get("page") ?? -1);
    const pageSize = Number(url.searchParams.get("size") ?? 20);
    // A negative page means "give me the last page" — treat as Infinity
    // before clamping inside readTranscriptPage.
    const page = pageRaw < 0 ? Number.MAX_SAFE_INTEGER : pageRaw;
    return json(readTranscriptPage(dir, params.id!, { page, pageSize }));
  });

  // War-room summary: last N parsed JSONL entries. Cheap per-session
  // endpoint — the server reads just the tail, not the whole file.
  router.get("/api/sessions/:id/recent-turns", ({ params, url }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 12)));
    const turns = readRecentTranscriptLines(dir, params.id!, limit);
    return json({ turns });
  });
}
