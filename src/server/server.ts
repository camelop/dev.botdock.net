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
import { mountUpdate } from "./handlers/update.ts";
import { proxyHttp, tryUpgradeWsProxy, openProxyWs, relayProxyWsMessage, closeProxyWs, type WsProxyData } from "./proxy.ts";
import { forwardExists, readForward, listForwards } from "../domain/forwards.ts";
import { embeddedFiles } from "./embedded.ts";
import { SessionPoller } from "../domain/session-poller.ts";
import { readEvents, readRawRange, sessionExists, readSession, listSessions, updateSession } from "../domain/sessions.ts";
import { deleteForward } from "../domain/forwards.ts";
import { ForwardManager } from "../domain/forward-manager.ts";
import { randomBytes } from "node:crypto";
import { BOTDOCK_VERSION } from "../version.ts";

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

  // Daemon restart: filebrowser / code-server state from a previous process
  // is stale — the remote supervisor tmux *might* still be alive on the
  // target machine, but our local SSH -L is gone so the UI's "Open" link
  // would point at a dead tunnel. Easier + clearer to default both off on
  // boot; the user clicks Start again and we either reattach to the existing
  // supervisor (startSession{Filebrowser,CodeServer} is idempotent) or spin
  // up a fresh one.
  try {
    for (const s of listSessions(dir)) {
      const clear: Record<string, undefined> = {};
      if (s.filebrowser_local_port !== undefined || s.filebrowser_remote_port !== undefined) {
        clear.filebrowser_local_port = undefined;
        clear.filebrowser_remote_port = undefined;
      }
      if (s.codeserver_local_port !== undefined || s.codeserver_remote_port !== undefined) {
        clear.codeserver_local_port = undefined;
        clear.codeserver_remote_port = undefined;
      }
      if (Object.keys(clear).length > 0) updateSession(dir, s.id, clear);
    }
    // Also prune stale per-session embedded-tool forwards — they never had
    // auto_start=true, so they're just disk clutter accumulating ports that
    // the next Start would have overwritten anyway.
    for (const f of listForwards(dir)) {
      if (f.managed_by === "system:session-filebrowser" ||
          f.managed_by === "system:session-codeserver") {
        forwardManager.forget(f.name);
        deleteForward(dir, f.name);
      }
    }
  } catch (err) {
    console.error("[boot] session tool cleanup failed:", err);
  }

  // Unique per-process ID. Surfaced in /api/status so the frontend can detect
  // daemon restarts (instance changes → page forces a full reload instead of
  // clinging to stale websockets / local state).
  const instanceId = randomBytes(8).toString("hex");

  const router = new Router();
  router.get("/api/status", () => json({
    home: dir.root,
    version: BOTDOCK_VERSION,
    dev: !!opts.dev,
    instance_id: instanceId,
  }));
  mountKeys(router, dir);
  mountMachines(router, dir, forwardManager);
  mountSecrets(router, dir);
  mountSessions(router, dir, poller, forwardManager);
  mountForwards(router, dir, forwardManager);
  mountCredits(router, dir);
  mountUpdate(router, forwardManager);

  // Per-session WebSocket subscriptions: { sessionId → set of ws }
  type SessionWatchData = {
    kind: "session-watch";
    sessionId: string;
    evOffset: number;
    rawOffset: number;
    txOffset: number;
  };
  type LobbyData = { kind: "lobby"; sessionId: "" };
  type WsData = SessionWatchData | LobbyData | WsProxyData;
  const subs = new Map<string, Set<Bun.ServerWebSocket<SessionWatchData>>>();

  function terminalForwardPort(machineName: string): number | null {
    const fname = `terminal-${machineName}`;
    if (!forwardExists(dir, fname)) return null;
    return readForward(dir, fname).local_port;
  }

  function sessionTerminalForwardPort(sessionId: string): number | null {
    const fname = `session-${sessionId}-terminal`;
    if (!forwardExists(dir, fname)) return null;
    return readForward(dir, fname).local_port;
  }

  function sessionFilebrowserForwardPort(sessionId: string): number | null {
    const fname = `session-${sessionId}-filebrowser`;
    if (!forwardExists(dir, fname)) return null;
    return readForward(dir, fname).local_port;
  }

  function sessionCodeServerForwardPort(sessionId: string): number | null {
    const fname = `session-${sessionId}-codeserver`;
    if (!forwardExists(dir, fname)) return null;
    return readForward(dir, fname).local_port;
  }

  /**
   * Lookup for the generic /api/forwards/:name/proxy/* route. Returns the
   * local port if the named forward exists, is direction=local, and is
   * currently running; otherwise an error string explaining why.
   */
  function userForwardProxyPort(name: string):
    | { port: number }
    | { error: string } {
    if (!forwardExists(dir, name)) return { error: `forward "${name}" not found` };
    const f = readForward(dir, name);
    if (f.direction !== "local") {
      return {
        error: `forward "${name}" is direction=${f.direction}; only local (-L) forwards can be proxied through the web server`,
      };
    }
    const status = forwardManager.getStatus(name);
    if (status.state !== "running") {
      return { error: `forward "${name}" is not running (state=${status.state}); start it first` };
    }
    return { port: f.local_port };
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
    // Transcript is NOT pushed through the WS anymore — the client pulls
    // pages via /api/sessions/:id/transcript/page on demand and only
    // re-fetches the latest page when session meta reports growth. This
    // keeps initial session open snappy even for multi-MB CC transcripts.
    // Also push the current session meta so the client can react to
    // activity transitions (running ↔ waiting) without re-polling HTTP.
    try {
      ws.send(JSON.stringify({ type: "session", session: readSession(dir, sessionId) }));
    } catch { /* session may have been deleted mid-flight */ }
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
        // Clients may pass starting offsets to skip bytes they've already
        // cached locally — avoids re-transferring a multi-MB transcript
        // every time the user switches sessions or reloads. Parsed as
        // unsigned integers; anything else falls back to 0 (full send).
        const parseOff = (k: string) => {
          const n = Number(url.searchParams.get(k) ?? 0);
          return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
        };
        const evOffset = parseOff("events_offset");
        const rawOffset = parseOff("raw_offset");
        const txOffset = parseOff("tx_offset");
        if (srv.upgrade(req, {
          data: { kind: "session-watch", sessionId, evOffset, rawOffset, txOffset } satisfies SessionWatchData,
        })) {
          return new Response(null);
        }
        return error(400, "expected websocket");
      }

      // REST routes get first dibs — our own endpoints like
      // /api/machines/:name/terminal/start must not be eaten by the ttyd
      // proxy. If no route matches, we fall through to the proxy check.
      if (url.pathname.startsWith("/api/")) {
        try {
          const m = router.match(req);
          if (m) return await m.handler({ req, params: m.params, url: m.url });
        } catch (e) {
          if (e instanceof HttpError) return error(e.status, e.message);
          const msg = e instanceof Error ? e.message : String(e);
          return error(500, msg);
        }
      }

      // Reverse proxy for per-machine terminals (ttyd under --base-path).
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
        const upstreamPath = `/api/machines/${encodeURIComponent(machineName)}/terminal${remainingPath === "/" ? "" : remainingPath}`;
        const wsResp = tryUpgradeWsProxy(srv, req, port, upstreamPath);
        if (wsResp) return wsResp;
        return proxyHttp(req, port, upstreamPath);
      }

      // Reverse proxy for per-session terminals (claude-code). Same pattern
      // as machines, scoped per session-id.
      const sessTermMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/terminal(\/.*)?$/);
      if (sessTermMatch) {
        const sessionId = decodeURIComponent(sessTermMatch[1]!);
        const remainingPath = sessTermMatch[2] ?? "/";
        const port = sessionTerminalForwardPort(sessionId);
        if (port === null) {
          return new Response(
            `No terminal forward for session "${sessionId}" — it may still be booting, or it's a generic-cmd session without a terminal.`,
            { status: 503, headers: { "content-type": "text/plain" } },
          );
        }
        const upstreamPath = `/api/sessions/${encodeURIComponent(sessionId)}/terminal${remainingPath === "/" ? "" : remainingPath}`;
        const wsResp = tryUpgradeWsProxy(srv, req, port, upstreamPath);
        if (wsResp) return wsResp;
        return proxyHttp(req, port, upstreamPath);
      }

      // Reverse proxy for per-session filebrowser. filebrowser serves its
      // SPA + API under the configured --baseURL (matching our path), so we
      // don't need to strip the prefix — just forward verbatim. WS upgrades
      // are forwarded for the (currently rarely used) command runner.
      const sessFbMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files(\/.*)?$/);
      if (sessFbMatch) {
        const sessionId = decodeURIComponent(sessFbMatch[1]!);
        const remainingPath = sessFbMatch[2] ?? "/";
        const port = sessionFilebrowserForwardPort(sessionId);
        if (port === null) {
          return new Response(
            `Filebrowser isn't running for session "${sessionId}". Start it from the session's action bar.`,
            { status: 503, headers: { "content-type": "text/plain" } },
          );
        }
        const upstreamPath = `/api/sessions/${encodeURIComponent(sessionId)}/files${remainingPath === "/" ? "" : remainingPath}`;
        const wsResp = tryUpgradeWsProxy(srv, req, port, upstreamPath);
        if (wsResp) return wsResp;
        return proxyHttp(req, port, upstreamPath);
      }

      // Reverse proxy for per-session code-server. Unlike filebrowser/ttyd,
      // code-server has no --base-path flag — the recommended deployment is
      // nginx "location /code/ proxy_pass /". So we STRIP the prefix and
      // forward the remainder to root. WS upgrades are critical (terminals,
      // LSP, live extensions).
      const sessCodeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/code(\/.*)?$/);
      if (sessCodeMatch) {
        const sessionId = decodeURIComponent(sessCodeMatch[1]!);
        const remainingPath = sessCodeMatch[2] ?? "/";
        const port = sessionCodeServerForwardPort(sessionId);
        if (port === null) {
          return new Response(
            `VS Code isn't running for session "${sessionId}". Start it from the session's action bar.`,
            { status: 503, headers: { "content-type": "text/plain" } },
          );
        }
        // STRIP the /api/sessions/<id>/code prefix — code-server expects /.
        const upstreamPath = remainingPath;
        const wsResp = tryUpgradeWsProxy(srv, req, port, upstreamPath);
        if (wsResp) return wsResp;
        return proxyHttp(req, port, upstreamPath);
      }

      // Generic reverse proxy for any user-managed local (-L) forward.
      // Unlike the terminal proxies above, we STRIP the prefix before
      // forwarding upstream — user apps generally assume they're at /
      // and don't support a base-path. Relative URLs work; absolute URLs
      // that don't honor a base path will break. That's the trade-off
      // to make most dev servers embed-ready out of the box.
      const fwdProxyMatch = url.pathname.match(/^\/api\/forwards\/([^/]+)\/proxy(\/.*)?$/);
      if (fwdProxyMatch) {
        const name = decodeURIComponent(fwdProxyMatch[1]!);
        const remainingPath = fwdProxyMatch[2] ?? "/";
        const resolved = userForwardProxyPort(name);
        if ("error" in resolved) {
          return new Response(`${resolved.error}\n`, {
            status: 503,
            headers: { "content-type": "text/plain" },
          });
        }
        const upstreamPath = remainingPath;  // no prefix carried upstream
        const wsResp = tryUpgradeWsProxy(srv, req, resolved.port, upstreamPath);
        if (wsResp) return wsResp;
        return proxyHttp(req, resolved.port, upstreamPath);
      }

      // Nothing matched under /api/ — return 404 rather than serving the SPA.
      if (url.pathname.startsWith("/api/")) {
        return error(404, "no such route");
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
