import { DataDir } from "../storage/index.ts";
import { readMachine } from "./machines.ts";
import {
  type Session,
  appendEvent,
  readSession,
  updateSession,
} from "./sessions.ts";
import { sshExec } from "../lib/remote.ts";
import { provisioningScript, buildCmdB64 } from "../lib/shim.ts";

/**
 * Launch a session that was freshly created in `provisioning` status.
 * Ships the shim + user cmd to the remote, kicks off a detached tmux session
 * with pipe-pane capturing output to `workdir/.botdock/session/raw.log`.
 */
export async function launchSession(dir: DataDir, id: string): Promise<Session> {
  const s = readSession(dir, id);
  if (s.status !== "provisioning") {
    throw new Error(`session ${id} is in state ${s.status}, cannot launch`);
  }
  appendEvent(dir, id, { ts: new Date().toISOString(), kind: "provisioning" });
  const machine = readMachine(dir, s.machine);

  const cmdB64 = buildCmdB64(s.agent_kind, s.cmd);
  const bootstrap = provisioningScript({
    workdir: s.workdir,
    tmuxSession: s.tmux_session,
    cmdB64,
    agentKind: s.agent_kind,
  });

  const r = sshExec(dir, machine, "bash -s", bootstrap, 60_000);
  if (r.code !== 0 || !r.stdout.includes("BOTDOCK_PROVISIONED")) {
    appendEvent(dir, id, {
      ts: new Date().toISOString(),
      kind: "failed_to_start",
      ssh_exit: r.code,
      stderr: r.stderr.slice(0, 4096),
      stdout: r.stdout.slice(0, 4096),
    });
    return updateSession(dir, id, { status: "failed_to_start" });
  }
  return updateSession(dir, id, {
    status: "running",
    started_at: new Date().toISOString(),
  });
}

/**
 * Send a user task into the running session's tmux pane via send-keys + Enter.
 * Records a `user_input` event locally for the timeline.
 */
export async function sendInputToSession(dir: DataDir, id: string, text: string): Promise<void> {
  const s = readSession(dir, id);
  if (s.status !== "running") throw new Error(`session ${id} is not running`);
  const machine = readMachine(dir, s.machine);
  // Send-keys does the right thing with multi-line text if we quote it;
  // Literal mode (-l) avoids meta-key interpretation.
  const script = [
    `tmux send-keys -l -t ${shQ(s.tmux_session)} ${shQ(text)}`,
    `tmux send-keys -t ${shQ(s.tmux_session)} Enter`,
    `echo BOTDOCK_SENT`,
  ].join("\n");
  const r = sshExec(dir, machine, "bash -s", script, 10_000);
  if (r.code !== 0 || !r.stdout.includes("BOTDOCK_SENT")) {
    throw new Error(`send-keys failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  appendEvent(dir, id, {
    ts: new Date().toISOString(),
    kind: "user_input",
    channel: "tmux",
    text,
  });
}

/**
 * Best-effort stop: send Ctrl-C into the tmux pane, then kill the session.
 */
export async function stopSession(dir: DataDir, id: string): Promise<Session> {
  const s = readSession(dir, id);
  if (s.status === "exited" || s.status === "failed_to_start") return s;
  appendEvent(dir, id, { ts: new Date().toISOString(), kind: "stopping" });
  const machine = readMachine(dir, s.machine);
  // Try Ctrl-C first, then kill the session outright.
  const script = [
    `tmux send-keys -t ${shQ(s.tmux_session)} C-c 2>/dev/null || true`,
    `sleep 0.5`,
    `tmux kill-session -t ${shQ(s.tmux_session)} 2>/dev/null || true`,
    `echo BOTDOCK_STOPPED`,
  ].join("\n");
  sshExec(dir, machine, "bash -s", script, 15_000);
  appendEvent(dir, id, { ts: new Date().toISOString(), kind: "stopped" });
  // The poller will flip status to exited once it observes tmux gone.
  return readSession(dir, id);
}

function shQ(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
