import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  createSessionRecord,
  deleteSession,
  listSessions,
  readEvents,
  readRawRange,
  readRecentTranscriptLines,
  readTranscriptRange,
  readSession,
  sessionExists,
  type AgentKind,
} from "../../domain/sessions.ts";
import {
  launchSession,
  stopSession,
  sendInputToSession,
  setupSessionTerminal,
  teardownSessionTerminal,
} from "../../domain/session-launcher.ts";
import type { SessionPoller } from "../../domain/session-poller.ts";
import type { ForwardManager } from "../../domain/forward-manager.ts";

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
    }>(req);
    for (const k of ["machine", "workdir", "agent_kind"] as const) {
      if (!body[k]) throw new HttpError(400, `${k} required`);
    }
    if (body.agent_kind !== "generic-cmd" && body.agent_kind !== "claude-code") {
      throw new HttpError(400, "unknown agent_kind");
    }
    // cmd is the shell command for generic-cmd (required) and the initial
    // prompt for claude-code (optional — empty means open claude with no
    // preloaded message; fully optional when cc_resume_uuid is set).
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
    });
    // Launch asynchronously so the HTTP request returns quickly. The
    // launcher itself now stands up the per-session ttyd + forward
    // before flipping status to "active", so UI observers can rely on
    // "status=active ⇒ terminal ready".
    launchSession(dir, s.id, forwardManager)
      .then(() => poller.watch(s.id))
      .catch((err) => console.error(`[sessions] launch ${s.id} failed:`, err));
    return json(s, { status: 201 });
  });

  router.post("/api/sessions/:id/stop", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const s = await stopSession(dir, params.id!);
    return json(s);
  });

  router.post("/api/sessions/:id/input", async ({ req, params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const body = await parseJsonBody<{ text?: string; keys?: string[] }>(req);
    const hasText = typeof body.text === "string";
    const hasKeys = Array.isArray(body.keys) && body.keys.length > 0;
    if (!hasText && !hasKeys) {
      throw new HttpError(400, "text or keys required");
    }
    await sendInputToSession(dir, params.id!, {
      text: hasText ? body.text : undefined,
      keys: hasKeys ? body.keys : undefined,
    });
    return json({ ok: true });
  });

  router.delete("/api/sessions/:id", async ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    poller.unwatch(params.id!);
    await teardownSessionTerminal(dir, forwardManager, params.id!).catch(() => {});
    deleteSession(dir, params.id!);
    return json({ ok: true });
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

  // War-room summary: last N parsed JSONL entries. Cheap per-session
  // endpoint — the server reads just the tail, not the whole file.
  router.get("/api/sessions/:id/recent-turns", ({ params, url }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 12)));
    const turns = readRecentTranscriptLines(dir, params.id!, limit);
    return json({ turns });
  });
}
