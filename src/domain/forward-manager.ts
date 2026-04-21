import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import { buildSshConfig } from "../lib/sshconfig.ts";
import { readForward, type Forward } from "./forwards.ts";

/**
 * - idle:     never been attempted this process lifecycle. Default for a
 *             forward on disk that the manager hasn't touched yet.
 * - starting: spawned, waiting for ssh to settle.
 * - running:  ssh is alive and the forward is wired.
 * - stopped:  we explicitly stopped it (SIGTERM/SIGINT received).
 * - failed:   exited with a non-clean signal; inspect last_error.
 */
export type ForwardState = "idle" | "stopped" | "starting" | "running" | "failed";

export type ForwardStatus = {
  name: string;
  state: ForwardState;
  pid?: number;
  started_at?: string;
  stopped_at?: string;
  exit_code?: number | null;
  exit_signal?: string | null;
  last_error?: string;
  /** The argv we handed to ssh. Shown in the error modal so the user can
   * re-run it manually to debug. */
  last_args?: string[];
};

type Entry = {
  name: string;
  proc?: ChildProcess;
  cfg?: { dispose: () => void };
  status: ForwardStatus;
  args?: string[];
  /** Set by stop() so the close-handler knows an exit was user-initiated,
   * even when ssh catches SIGTERM and exits with a non-zero code (which
   * leaves Node's `signal` as null). Without this, "Stop" showed "failed". */
  stopRequested?: boolean;
};

/**
 * Owns per-forward ssh subprocesses. Each forward runs `ssh -N -L/-R/-D ...`
 * using the same buildSshConfig helper the rest of the app uses so jump host
 * chains and ControlMaster multiplexing still work.
 *
 * We don't auto-restart on failure — if a forward dies, the user sees it
 * flipped to "failed" and can hit Start again. This keeps policy simple and
 * avoids flap loops when e.g. a port is already in use.
 */
export class ForwardManager extends EventEmitter {
  private entries = new Map<string, Entry>();

  constructor(private readonly dir: DataDir) {
    super();
  }

  /** Bring up all auto_start=true forwards. Called by the daemon on boot. */
  startAutoForwards(): void {
    const { listForwards } = require("./forwards.ts") as typeof import("./forwards.ts");
    for (const f of listForwards(this.dir)) {
      if (f.auto_start) {
        this.start(f.name).catch((err) => {
          console.error(`[forwards] auto-start ${f.name} failed:`, err);
        });
      }
    }
  }

  /** Current status for every configured forward (including stopped ones). */
  listStatuses(names: string[]): ForwardStatus[] {
    return names.map((n) => this.entries.get(n)?.status ?? { name: n, state: "idle" });
  }

  getStatus(name: string): ForwardStatus {
    return this.entries.get(name)?.status ?? { name, state: "idle" };
  }

  async start(name: string): Promise<ForwardStatus> {
    const existing = this.entries.get(name);
    if (existing && (existing.status.state === "running" || existing.status.state === "starting")) {
      return existing.status;
    }
    const forward = readForward(this.dir, name);
    const machine = readMachine(this.dir, forward.machine);
    const cfg = buildSshConfig(this.dir, machine);

    // Critical: disable ControlMaster for forward processes. Our ssh config
    // enables auto-mux (great for poller's many short commands), but when a
    // forward is submitted through an existing master the submitting client
    // exits immediately after registering the -L — we'd lose the ability to
    // start/stop/kill per-forward, and the exit-on-starting-state heuristic
    // would wrongly mark the tunnel as "failed".
    //
    // A dedicated ssh process per forward owns its own TCP session and
    // lifecycle. Slight overhead (extra handshake) but unambiguous state.
    const args = [
      "-F", cfg.configPath,
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-N",
      ...forwardArgs(forward),
      cfg.targetAlias,
    ];
    // Turn on ssh's own verbose logging (-v) during startup so even in
    // "nothing on stderr" failure modes we get something in the buffer.
    const argsWithVerbose = [...args.slice(0, 2), "-v", ...args.slice(2)];
    const proc = spawn("ssh", argsWithVerbose, { stdio: ["ignore", "pipe", "pipe"] });

    const status: ForwardStatus = {
      name,
      state: "starting",
      pid: proc.pid,
      started_at: new Date().toISOString(),
      last_args: argsWithVerbose,
    };
    const entry: Entry = { name, proc, cfg, status, args: argsWithVerbose };
    this.entries.set(name, entry);
    this.emit("update", name);

    let stderrBuf = "";
    let stdoutBuf = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });
    proc.stdout?.on("data", (chunk: Buffer) => { stdoutBuf += chunk.toString("utf8"); });

    // Flip to running after a short delay — ssh -N stays silent once the
    // forward is up. If it dies during that window, the exit handler below
    // takes over and marks it failed.
    //
    // Wrap the startup in a promise so `await start(name)` actually waits
    // for the forward to be wired up before returning. Otherwise callers
    // (e.g. the machine-terminal endpoint) return to the UI before the
    // local port is bound, and the browser's next request races the
    // forward and hits a "connection refused".
    let resolveSettled: ((s: ForwardStatus) => void) | null = null;
    const settled = new Promise<ForwardStatus>((resolve) => { resolveSettled = resolve; });
    const settle = (s: ForwardStatus) => {
      if (resolveSettled) { resolveSettled(s); resolveSettled = null; }
    };
    const startupTimer = setTimeout(() => {
      if (entry.status.state === "starting") {
        entry.status.state = "running";
        this.emit("update", name);
      }
      settle(entry.status);
    }, 800);

    // Wait for `close` rather than `exit` — exit fires as soon as the process
    // terminates, but the stderr stream may still have buffered data. close
    // fires only after all stdio streams have been fully drained, so
    // stderrBuf is guaranteed to have everything ssh printed.
    proc.on("close", (code, signal) => {
      clearTimeout(startupTimer);
      try { cfg.dispose(); } catch {}
      // A forward is "cleanly stopped" if:
      //   (a) the user explicitly called stop() — tracked via stopRequested,
      //       which covers the case where ssh catches SIGTERM and exits with
      //       a non-zero code (Node then reports signal=null);
      //   (b) the process died from SIGTERM/SIGINT directly; or
      //   (c) the entry was already in a terminal state (stopped/failed/idle)
      //       before the close event fired.
      const wasLive = entry.status.state === "starting" || entry.status.state === "running";
      const cleanlyStopped = !wasLive
        || entry.stopRequested === true
        || signal === "SIGTERM"
        || signal === "SIGINT";

      // Always populate last_error with SOMETHING. If ssh was silent, at
      // least include the exit code, signal, and the argv we used so the
      // user can reproduce by hand. This was the "view error button doesn't
      // appear" bug — stderr was empty and we stored undefined.
      const parts: string[] = [];
      if (stderrBuf.trim())  parts.push("[ssh stderr]\n" + stderrBuf.trim());
      if (stdoutBuf.trim())  parts.push("[ssh stdout]\n" + stdoutBuf.trim());
      const meta: string[] = [];
      meta.push(`exit_code: ${code ?? "null"}`);
      if (signal) meta.push(`signal: ${signal}`);
      meta.push(`argv: ssh ${entry.args?.join(" ") ?? ""}`);
      parts.push("[process]\n" + meta.join("\n"));
      const last_error = parts.join("\n\n").slice(0, 8192);

      entry.status = {
        name,
        state: cleanlyStopped ? "stopped" : "failed",
        pid: undefined,
        started_at: entry.status.started_at,
        stopped_at: new Date().toISOString(),
        exit_code: code ?? null,
        exit_signal: signal ?? null,
        last_args: entry.args,
        // Clear last_error on a user-requested stop — the exit was expected,
        // showing the "view error" button would be misleading.
        last_error: cleanlyStopped ? undefined : last_error,
      };
      entry.proc = undefined;
      entry.cfg = undefined;
      this.emit("update", name);
      // If the process died before the 800ms settle timer, resolve now so
      // callers don't hang for a forward that's already failed.
      settle(entry.status);
    });

    return await settled;
  }

  stop(name: string): ForwardStatus {
    const entry = this.entries.get(name);
    if (!entry || !entry.proc) {
      const status: ForwardStatus = { name, state: "stopped" };
      return status;
    }
    entry.stopRequested = true;
    entry.proc.kill("SIGTERM");
    return entry.status;
  }

  stopAll(): void {
    for (const e of this.entries.values()) {
      if (e.proc) { e.stopRequested = true; e.proc.kill("SIGTERM"); }
    }
  }

  /**
   * Like stopAll but waits for every child ssh to actually exit (or a
   * timeout, whichever comes first). Used by the self-update flow so we
   * don't orphan ssh processes across the execv boundary.
   */
  async stopAllAsync(timeoutMs = 3000): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      const proc = e.proc;
      if (!proc) continue;
      e.stopRequested = true;
      waits.push(new Promise<void>((resolve) => {
        let done = false;
        const onClose = () => { if (done) return; done = true; resolve(); };
        proc.once("close", onClose);
        setTimeout(() => {
          if (done) return; done = true;
          proc.removeListener("close", onClose);
          // Escalate — if SIGTERM didn't take, SIGKILL before giving up.
          try { proc.kill("SIGKILL"); } catch {}
          resolve();
        }, timeoutMs);
        try { proc.kill("SIGTERM"); } catch { resolve(); }
      }));
    }
    await Promise.all(waits);
  }

  /** Drop an entry after the forward is deleted from disk. */
  forget(name: string): void {
    this.entries.delete(name);
  }
}

function forwardArgs(f: Forward): string[] {
  switch (f.direction) {
    case "local":
      return ["-L", `${f.local_port}:${f.remote_host}:${f.remote_port}`,
              "-o", "ExitOnForwardFailure=yes"];
    case "remote":
      return ["-R", `${f.local_port}:${f.local_host ?? "localhost"}:${f.remote_port}`,
              "-o", "ExitOnForwardFailure=yes"];
    case "dynamic":
      return ["-D", String(f.local_port),
              "-o", "ExitOnForwardFailure=yes"];
  }
}
