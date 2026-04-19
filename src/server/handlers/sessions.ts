import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  createSessionRecord,
  deleteSession,
  listSessions,
  readEvents,
  readRawRange,
  readSession,
  sessionExists,
  type AgentKind,
} from "../../domain/sessions.ts";
import { launchSession, stopSession, sendInputToSession } from "../../domain/session-launcher.ts";
import type { SessionPoller } from "../../domain/session-poller.ts";

export function mountSessions(router: Router, dir: DataDir, poller: SessionPoller): void {
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
    }>(req);
    for (const k of ["machine", "workdir", "agent_kind", "cmd"] as const) {
      if (!body[k]) throw new HttpError(400, `${k} required`);
    }
    if (body.agent_kind !== "generic-cmd" && body.agent_kind !== "claude-code") {
      throw new HttpError(400, "unknown agent_kind");
    }
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
    });
    // Launch asynchronously so the HTTP request returns quickly.
    launchSession(dir, s.id)
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

  router.delete("/api/sessions/:id", ({ params }) => {
    if (!sessionExists(dir, params.id!)) throw new HttpError(404, "not found");
    poller.unwatch(params.id!);
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
}
