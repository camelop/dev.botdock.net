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
  last_error?: string;
};

type Entry = {
  name: string;
  proc?: ChildProcess;
  cfg?: { dispose: () => void };
  status: ForwardStatus;
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

    const args = ["-F", cfg.configPath, "-N", ...forwardArgs(forward), cfg.targetAlias];
    const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

    const status: ForwardStatus = {
      name,
      state: "starting",
      pid: proc.pid,
      started_at: new Date().toISOString(),
    };
    const entry: Entry = { name, proc, cfg, status };
    this.entries.set(name, entry);
    this.emit("update", name);

    let stderrBuf = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });

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
      entry.status = {
        name,
        state: cleanlyStopped ? "stopped" : "failed",
        pid: undefined,
        started_at: entry.status.started_at,
        stopped_at: new Date().toISOString(),
        exit_code: code ?? null,
        last_error: stderrBuf.trim() ? stderrBuf.trim().slice(0, 2048) : undefined,
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
