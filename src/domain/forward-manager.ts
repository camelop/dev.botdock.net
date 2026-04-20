import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import { buildSshConfig } from "../lib/sshconfig.ts";
import { readForward, type Forward } from "./forwards.ts";

export type ForwardState = "stopped" | "starting" | "running" | "failed";

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
    return names.map((n) => this.entries.get(n)?.status ?? { name: n, state: "stopped" });
  }

  getStatus(name: string): ForwardStatus {
    return this.entries.get(name)?.status ?? { name, state: "stopped" };
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
    const startupTimer = setTimeout(() => {
      if (entry.status.state === "starting") {
        entry.status.state = "running";
        this.emit("update", name);
      }
    }, 800);

    // Wait for `close` rather than `exit` — exit fires as soon as the process
    // terminates, but the stderr stream may still have buffered data. close
    // fires only after all stdio streams have been fully drained, so
    // stderrBuf is guaranteed to have everything ssh printed.
    proc.on("close", (code, signal) => {
      clearTimeout(startupTimer);
      try { cfg.dispose(); } catch {}
      const cleanlyStopped = entry.status.state === "starting" || entry.status.state === "running"
        ? (signal === "SIGTERM" || signal === "SIGINT")
        : true;

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
        last_error: cleanlyStopped && !stderrBuf.trim() ? undefined : last_error,
      };
      entry.proc = undefined;
      entry.cfg = undefined;
      this.emit("update", name);
    });

    return entry.status;
  }

  stop(name: string): ForwardStatus {
    const entry = this.entries.get(name);
    if (!entry || !entry.proc) {
      const status: ForwardStatus = { name, state: "stopped" };
      return status;
    }
    entry.proc.kill("SIGTERM");
    return entry.status;
  }

  stopAll(): void {
    for (const e of this.entries.values()) e.proc?.kill("SIGTERM");
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
