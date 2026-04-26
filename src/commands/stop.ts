import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultClientHome } from "./start.ts";

/** Path to the pid-file written by `botdock serve` on startup. Stop reads
 *  this; if it's missing or stale we fall through to a port-scan and
 *  finally to "nothing to stop". */
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

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * `botdock stop` — flip side of `start`.
 *
 * Reads the pid-file from the resolved data dir, sends SIGTERM, and
 * waits for the daemon to exit cleanly (its shutdown hook drains SSH
 * forwards before letting go of the HTTP server). Falls back to SIGKILL
 * if the daemon ignores SIGTERM for too long.
 */
export async function runStop(opts: {
  home: string;
  homeWasExplicit: boolean;
  args: string[];
}): Promise<number> {
  const target = opts.homeWasExplicit ? resolve(opts.home) : defaultClientHome();
  const pidFile = pidFilePath(target);

  if (!existsSync(pidFile)) {
    process.stdout.write(
      `No BotDock daemon registered for ${target} (no pid file).\n`,
    );
    return 0;
  }

  const pidText = readFileSync(pidFile, "utf8").trim();
  const pid = parseInt(pidText, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    process.stderr.write(`Bad pid file ${pidFile} (contents: ${pidText.slice(0, 64)})\n`);
    try { unlinkSync(pidFile); } catch {}
    return 1;
  }

  if (!isAlive(pid)) {
    process.stdout.write(
      `BotDock daemon (pid ${pid}) is not running; cleaning up stale pid file.\n`,
    );
    try { unlinkSync(pidFile); } catch {}
    return 0;
  }

  // SIGTERM lets serve.ts's shutdown hook stop ssh-forwards cleanly.
  process.stdout.write(`Stopping BotDock daemon (pid ${pid})…\n`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    process.stderr.write(`SIGTERM failed: ${(err as Error).message}\n`);
    return 1;
  }

  // 8s covers the forward-manager's 3s drain plus normal HTTP-server
  // teardown. If the daemon ignores SIGTERM past that window something
  // is wedged; fall back to SIGKILL so the user isn't stuck.
  if (await waitForExit(pid, 8_000)) {
    process.stdout.write("Daemon stopped.\n");
    try { unlinkSync(pidFile); } catch {}
    return 0;
  }

  process.stderr.write("Daemon ignored SIGTERM for 8s; sending SIGKILL.\n");
  try { process.kill(pid, "SIGKILL"); } catch {}
  if (await waitForExit(pid, 2_000)) {
    process.stdout.write("Daemon force-killed.\n");
    try { unlinkSync(pidFile); } catch {}
    return 0;
  }

  process.stderr.write(`Daemon (pid ${pid}) still alive after SIGKILL; giving up.\n`);
  return 1;
}
