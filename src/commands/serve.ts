import { parseArgs } from "node:util";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../server/server.ts";
import { BOTDOCK_VERSION } from "../version.ts";

/** PID-file path inside the data dir. `botdock stop` reads this to find
 *  the running daemon; we also use it on startup to refuse to launch a
 *  second daemon against the same data dir. */
function pidFilePath(home: string): string {
  return join(home, "serve.pid");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runServe(opts: { home: string; args: string[] }): Promise<number> {
  const { values } = parseArgs({
    args: opts.args,
    allowPositionals: true,
    options: {
      dev: { type: "boolean" },
    },
  });

  // If a stale pid-file from a previous run points at a still-living
  // process, that's another daemon — don't start a competing one. If the
  // pid is dead, the file is just leftover; we'll overwrite it.
  const pidFile = pidFilePath(opts.home);
  if (existsSync(pidFile)) {
    const stale = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(stale) && stale > 0 && stale !== process.pid && isAlive(stale)) {
      process.stderr.write(
        `BotDock serve already running (pid ${stale}). ` +
          `Stop it first with \`botdock stop\`.\n`,
      );
      return 1;
    }
  }

  const { server, forwardManager } = startServer({ home: opts.home, dev: !!values.dev });

  // Drop our pid where botdock stop can find it. Best-effort — if the
  // disk write fails we still serve, just without the file-based stop
  // shortcut (port-scanning fallback would still work).
  try {
    writeFileSync(pidFile, String(process.pid));
  } catch (err) {
    process.stderr.write(`(could not write pid file ${pidFile}: ${(err as Error).message})\n`);
  }

  // Version on the first line so in-place self-upgrades are obvious — the
  // same terminal session will print a fresh banner with a new version tag
  // instead of repeating an identical three-line block.
  process.stdout.write(
    `BotDock (v${BOTDOCK_VERSION}) serving at http://${server.hostname}:${server.port}\n` +
    `  data dir: ${opts.home}\n` +
    (values.dev ? `  mode: dev (frontend on Vite, e.g. http://localhost:5173)\n` : `  mode: production\n`),
  );
  // Keep process alive; server is long-running.
  return await new Promise<number>((resolveFn) => {
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stdout.write("\nshutting down\n");
      // Drain forwards before stopping the HTTP server so any UI request
      // mid-flight can still call /api/* if it has to. 3000 ms is plenty
      // for an SSH process to handle SIGTERM gracefully.
      try { await forwardManager.stopAllAsync(3000); } catch {}
      try { server.stop(true); } catch {}
      try { unlinkSync(pidFile); } catch { /* already gone */ }
      resolveFn(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
