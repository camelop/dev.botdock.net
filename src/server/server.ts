import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import type { Server } from "bun";
type BunServer = Server<unknown>;
import { DataDir, readToml } from "../storage/index.ts";
import { Router, json, error, HttpError } from "./router.ts";
import { mountKeys } from "./handlers/keys.ts";
import { mountMachines } from "./handlers/machines.ts";
import { mountSecrets } from "./handlers/secrets.ts";
import { embeddedFiles } from "./embedded.ts";

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

  const router = new Router();
  router.get("/api/status", () => json({ home: dir.root, version: "0.0.1", dev: !!opts.dev }));
  mountKeys(router, dir);
  mountMachines(router, dir);
  mountSecrets(router, dir);

  const distDir = resolve(import.meta.dir, "..", "..", "web", "dist");

  const server = Bun.serve({
    hostname: bind,
    port,
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "hello", home: dir.root }));
      },
      message(_ws, _msg) {
        // v1 stub — event push comes once sessions land.
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);

      // API auth gate (if token configured).
      if (url.pathname.startsWith("/api") && token) {
        const hdr = req.headers.get("authorization") ?? "";
        if (hdr !== `Bearer ${token}`) return error(401, "unauthorized");
      }

      // WebSocket upgrade.
      if (url.pathname === "/api/events") {
        if (srv.upgrade(req)) return new Response(null);
        return error(400, "expected websocket");
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
