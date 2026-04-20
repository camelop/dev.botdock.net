import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { Server } from "bun";
type BunServer = Server<unknown>;
import { DataDir, readToml } from "../storage/index.ts";
import { Router, json, error, HttpError } from "./router.ts";
import { mountKeys } from "./handlers/keys.ts";
import { mountMachines } from "./handlers/machines.ts";
import { mountSecrets } from "./handlers/secrets.ts";
import { mountSessions } from "./handlers/sessions.ts";
import { mountForwards } from "./handlers/forwards.ts";
import { mountCredits } from "./handlers/credits.ts";
import { proxyHttp, tryUpgradeWsProxy, openProxyWs, relayProxyWsMessage, closeProxyWs, type WsProxyData } from "./proxy.ts";
import { forwardExists, readForward } from "../domain/forwards.ts";
import { embeddedFiles } from "./embedded.ts";
import { SessionPoller } from "../domain/session-poller.ts";
import { readEvents, readRawRange, sessionExists } from "../domain/sessions.ts";
import { ForwardManager } from "../domain/forward-manager.ts";

type ServerConfig = {
  server?: { bind?: string; port?: number };
  auth?: { bearer_token?: string };
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff2": "font/woff2",
};

export function startServer(opts: { home: string; dev?: boolean }): BunServer {
  const dir = new DataDir(opts.home);
  if (!existsSync(dir.configFile())) {
    throw new Error(`${opts.home} is not a BotDock data dir (missing config.toml). Run \`botdock init\` first.`);
  }
  const cfg = readToml<ServerConfig>(dir.configFile());
  const bind = cfg.server?.bind ?? "127.0.0.1";
  const port = cfg.server?.port ?? 4717;
  const token = cfg.auth?.bearer_token?.trim() || undefined;

  const poller = new SessionPoller(dir);
  poller.resumeAll();

  const forwardManager = new ForwardManager(dir);
  forwardManager.startAutoForwards();

  const router = new Router();
  router.get("/api/status", () => json({ home: dir.root, version: "0.0.1", dev: !!opts.dev }));
  mountKeys(router, dir);
  mountMachines(router, dir, forwardManager);
  mountSecrets(router, dir);
  mountSessions(router, dir, poller);
  mountForwards(router, dir, forwardManager);
  mountCredits(router, dir);

  // Per-session WebSocket subscriptions: { sessionId → set of ws }
  type SessionWatchData = { kind: "session-watch"; sessionId: string; evOffset: number; rawOffset: number };
  type LobbyData        = { kind: "lobby"; sessionId: "" };
  type WsData = SessionWatchData | LobbyData | WsProxyData;
  const subs = new Map<string, Set<Bun.ServerWebSocket<SessionWatchData>>>();

  function terminalForwardPort(machineName: string): number | null {
    const fname = `terminal-${machineName}`;
    if (!forwardExists(dir, fname)) return null;
    return readForward(dir, fname).local_port;
  }

  poller.on("update", (sessionId: string) => {
    const set = subs.get(sessionId);
    if (!set || set.size === 0) return;
    for (const ws of set) pushDelta(ws);
  });

  function pushDelta(ws: Bun.ServerWebSocket<SessionWatchData>): void {
    const { sessionId } = ws.data;
    if (!sessionExists(dir, sessionId)) return;
    const ev = readEvents(dir, sessionId, ws.data.evOffset);
    if (ev.records.length > 0) {
      ws.send(JSON.stringify({ type: "events", records: ev.records, nextOffset: ev.nextOffset }));
      ws.data.evOffset = ev.nextOffset;
    }
    const raw = readRawRange(dir, sessionId, ws.data.rawOffset, 131072);
    if (raw.data.length > 0) {
      ws.send(JSON.stringify({ type: "raw", data: raw.data, nextOffset: raw.nextOffset }));
      ws.data.rawOffset = raw.nextOffset;
    }
  }

  const distDir = resolve(import.meta.dir, "..", "..", "web", "dist");

  const server = Bun.serve({
    hostname: bind,
    port,
    websocket: {
      open(ws: Bun.ServerWebSocket<WsData>) {
        if (ws.data.kind === "proxy") {
          openProxyWs({
            send: (m) => ws.send(m as string),
            close: (code, reason) => ws.close(code, reason),
            data: ws.data,
          });
          return;
        }
        if (ws.data.kind === "lobby") {
          ws.send(JSON.stringify({ type: "hello", home: dir.root }));
          return;
        }
        // session-watch
        const set = subs.get(ws.data.sessionId) ?? new Set();
        set.add(ws as Bun.ServerWebSocket<SessionWatchData>);
        subs.set(ws.data.sessionId, set);
        ws.send(JSON.stringify({ type: "hello", session: ws.data.sessionId }));
        pushDelta(ws as Bun.ServerWebSocket<SessionWatchData>);
      },
      close(ws: Bun.ServerWebSocket<WsData>) {
        if (ws.data.kind === "proxy") {
          closeProxyWs(ws.data);
          return;
        }
        if (ws.data.kind === "session-watch") {
          const set = subs.get(ws.data.sessionId);
          set?.delete(ws as Bun.ServerWebSocket<SessionWatchData>);
          if (set && set.size === 0) subs.delete(ws.data.sessionId);
        }
      },
      message(ws: Bun.ServerWebSocket<WsData>, msg) {
        if (ws.data.kind === "proxy") {
          relayProxyWsMessage(ws.data, msg);
        }
        // Non-proxy clients don't currently send anything.
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);

      // API auth gate (if token configured).
      if (url.pathname.startsWith("/api") && token) {
        const hdr = req.headers.get("authorization") ?? "";
        if (hdr !== `Bearer ${token}`) return error(401, "unauthorized");
      }

      // WebSocket upgrades: /api/events (lobby) and /api/sessions/:id/watch
      if (url.pathname === "/api/events") {
        if (srv.upgrade(req, { data: { kind: "lobby", sessionId: "" } satisfies LobbyData })) {
          return new Response(null);
        }
        return error(400, "expected websocket");
      }
      const watchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/watch$/);
      if (watchMatch) {
        const sessionId = decodeURIComponent(watchMatch[1]!);
        if (!sessionExists(dir, sessionId)) return error(404, "session not found");
        if (srv.upgrade(req, {
          data: { kind: "session-watch", sessionId, evOffset: 0, rawOffset: 0 } satisfies SessionWatchData,
        })) {
          return new Response(null);
        }
        return error(400, "expected websocket");
      }

      // Reverse proxy for per-machine terminals (ttyd under --base-path).
      // Matches /api/machines/:name/terminal and /api/machines/:name/terminal/*
      // for both HTTP and WebSocket traffic.
      const termMatch = url.pathname.match(/^\/api\/machines\/([^/]+)\/terminal(\/.*)?$/);
      if (termMatch) {
        const machineName = decodeURIComponent(termMatch[1]!);
        const remainingPath = termMatch[2] ?? "/";
        const port = terminalForwardPort(machineName);
        if (port === null) {
          return new Response(
            `No terminal forward for machine "${machineName}" — start it from the Machines page first.`,
            { status: 503, headers: { "content-type": "text/plain" } },
          );
        }
        // ttyd was started with --base-path=/api/machines/<name>/terminal,
        // so it expects its own paths to arrive with that prefix intact.
        const upstreamPath = `/api/machines/${encodeURIComponent(machineName)}/terminal${remainingPath === "/" ? "" : remainingPath}`;

        // WebSocket?
        const wsResp = tryUpgradeWsProxy(srv, req, port, upstreamPath);
        if (wsResp) return wsResp;

        return proxyHttp(req, port, upstreamPath);
      }

      // REST routes.
      if (url.pathname.startsWith("/api/")) {
        try {
          const m = router.match(req);
          if (!m) return error(404, "no such route");
          return await m.handler({ req, params: m.params, url: m.url });
        } catch (e) {
          if (e instanceof HttpError) return error(e.status, e.message);
          const msg = e instanceof Error ? e.message : String(e);
          return error(500, msg);
        }
      }

      // Dev mode: frontend is on Vite. Return a hint for accidental / hits.
      if (opts.dev) {
        return new Response(
          `BotDock API on :${port}. Start the Vite dev server (bun web:dev) for the UI.\n`,
          { headers: { "content-type": "text/plain" } },
        );
      }

      // Production: prefer embedded bundle (compiled binary), fall back to disk
      // (when running via `bun src/cli.ts serve` without --dev).
      return serveStatic(distDir, url.pathname);
    },
  });

  return server;
}

function serveStatic(distDir: string, pathname: string): Response {
  const safe = pathname.replace(/\.\.+/g, "");
  // Try embedded bundle first.
  const embeddedResp = serveEmbedded(safe);
  if (embeddedResp) return embeddedResp;

  // Fall back to disk (useful when iterating without recompiling the binary).
  let fsPath = join(distDir, safe === "/" ? "/index.html" : safe);
  try {
    const st = statSync(fsPath);
    if (st.isDirectory()) fsPath = join(fsPath, "index.html");
  } catch {
    fsPath = join(distDir, "index.html"); // SPA fallback
  }
  if (!existsSync(fsPath)) {
    return new Response(
      "Frontend not bundled. Build with `bun run build` or use `botdock serve --dev`.\n",
      { status: 503, headers: { "content-type": "text/plain" } },
    );
  }
  const body = readFileSync(fsPath);
  const ext = extname(fsPath);
  return new Response(body, {
    headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
  });
}

function serveEmbedded(pathname: string): Response | null {
  const keys = Object.keys(embeddedFiles);
  if (keys.length === 0) return null;
  const lookup = pathname === "/" ? "/index.html" : pathname.replace(/\/$/, "");
  const hit = embeddedFiles[lookup] ?? embeddedFiles["/index.html"]; // SPA fallback
  if (!hit) return null;
  return new Response(hit.data, { headers: { "content-type": hit.mime } });
}
