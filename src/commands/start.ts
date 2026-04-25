import { existsSync } from "node:fs";
import { open as openFs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { DataDir, readToml } from "../storage/index.ts";
import { runInit } from "./init.ts";

/** Single source of truth for the client-default home so other code (CLI
 *  help text, future "where am I?" diagnostics) can reference the same
 *  path without re-deriving it. */
export function defaultClientHome(): string {
  return join(homedir(), ".botdock", "client-default");
}

/**
 * `botdock start` — one-shot "fire it up" entry point.
 *
 * Resolves a data dir (--home wins, then $BOTDOCK_HOME, then
 * `~/.botdock/client-default` as the start-specific default), inits it
 * if missing, then either tells the user a daemon is already running or
 * spawns a detached `botdock serve` and waits for it to come up.
 * Either way, opens the browser to the daemon's URL last.
 */
export async function runStart(opts: {
  home: string;
  homeWasExplicit: boolean;
  args: string[];
}): Promise<number> {
  const target = opts.homeWasExplicit ? resolve(opts.home) : defaultClientHome();
  const dir = new DataDir(target);

  if (!existsSync(dir.configFile())) {
    const code = await runInit({ home: target, args: [] });
    if (code !== 0) return code;
  }

  const cfg = readToml(dir.configFile()) as {
    server?: { bind?: string; port?: number };
  };
  const bind = cfg?.server?.bind ?? "127.0.0.1";
  const port = cfg?.server?.port ?? 4717;
  const url = `http://${bind}:${port}`;

  if (await isServerAlive(url)) {
    process.stdout.write(`BotDock already running at ${url}\n`);
    openBrowser(url);
    return 0;
  }

  const logPath = dir.path("serve.log");
  const logFd = await openFs(logPath, "a");
  // node:child_process.spawn with detached + ignored stdin and a real
  // file descriptor for stdout/stderr lets the child outlive us. unref
  // releases the parent's reference so `botdock start` exits as soon as
  // we've confirmed the daemon is up.
  const child = spawn(
    process.execPath,
    ["--home", target, "serve"],
    {
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
    },
  );
  child.on("error", () => {});
  child.unref();
  // Closing the file handle in the parent is fine — the kernel keeps the
  // underlying file open as long as the child holds an fd.
  await logFd.close();

  // Poll the port up to 15s so a slow disk on first boot doesn't lose us
  // the race. 15s also covers the embedded-asset extraction Bun does on
  // a fresh binary.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isServerAlive(url)) {
      process.stdout.write(
        `BotDock serving in background at ${url}\n` +
          `  data dir: ${target}\n` +
          `  log: ${logPath}\n`,
      );
      openBrowser(url);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stderr.write(
    `BotDock did not become ready within 15s. Check ${logPath} for details.\n`,
  );
  return 1;
}

async function isServerAlive(url: string): Promise<boolean> {
  // Any HTTP response — even a 404 — proves the port is held by a
  // listening server. ECONNREFUSED / DNS errors throw; that's our
  // "nothing listening" signal.
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(800) });
    return r.status > 0;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.on("error", () => {
      process.stdout.write(`(could not open browser; visit ${url} manually)\n`);
    });
    p.unref();
  } catch {
    process.stdout.write(`(could not open browser; visit ${url} manually)\n`);
  }
}
