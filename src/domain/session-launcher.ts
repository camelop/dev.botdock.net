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
import {
  startSessionTerminal, sessionTerminalBasePath, stopSessionTerminal,
  startSessionFilebrowser, sessionFilebrowserBasePath, stopSessionFilebrowser,
} from "../lib/remote-install.ts";
import { findFreeLocalPort } from "../lib/free-port.ts";
import {
  deleteForward,
  forwardExists,
  writeForward,
  type Forward,
} from "./forwards.ts";
import type { ForwardManager } from "./forward-manager.ts";

/**
 * Launch a session that was freshly created in `provisioning` status.
 * Ships the shim + user cmd to the remote, kicks off a detached tmux session
 * with pipe-pane capturing output to `workdir/.botdock/session/raw.log`.
 *
 * For claude-code sessions, the per-session ttyd + forward is set up BEFORE
 * the status flips to `active`. That way any UI observer can assume "active
 * ⇒ terminal is ready to embed" and we never strand users on a "Booting…"
 * placeholder while the forward is still starting.
 */
export async function launchSession(
  dir: DataDir,
  id: string,
  forwardManager?: ForwardManager,
): Promise<Session> {
  const s = readSession(dir, id);
  if (s.status !== "provisioning") {
    throw new Error(`session ${id} is in state ${s.status}, cannot launch`);
  }
  appendEvent(dir, id, { ts: new Date().toISOString(), kind: "provisioning" });
  const machine = readMachine(dir, s.machine);

  const cmdB64 = buildCmdB64(s.agent_kind, s.cmd, {
    skipTrust: s.cc_skip_trust,
    resumeUuid: s.cc_resume_uuid,
    launchCommand: s.launch_command,
    agentTeams: s.cc_agent_teams,
  });
  const bootstrap = provisioningScript({
    workdir: s.workdir,
    tmuxSession: s.tmux_session,
    cmdB64,
    agentKind: s.agent_kind,
  });

  // Bypass ControlMaster for the bootstrap: it's a 60s-capped heredoc that
  // would otherwise hold the shared SSH mux and stall pollers/forwards for
  // other sessions on the same machine, making them appear unreachable.
  const r = sshExec(dir, machine, "bash -s", bootstrap, 60_000, { noControlMaster: true });
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

  // Stand up the per-session ttyd + forward BEFORE flipping status. If this
  // fails we still flip to active (the session container is alive) but
  // record the error in the event stream so the UI can flag it.
  if (s.agent_kind === "claude-code" && forwardManager) {
    await setupSessionTerminal(dir, forwardManager, id).catch((err) => {
      console.error(`[launch ${id}] terminal setup failed:`, err);
    });
  }

  const nowActive = updateSession(dir, id, {
    status: "active",
    started_at: new Date().toISOString(),
  });
  return nowActive;
}

/**
 * Spawn a per-session ttyd attached to the session's tmux, create a
 * system-managed local forward, and record both on the session record.
 * Best-effort: errors are recorded but don't fail the session launch.
 */
export async function setupSessionTerminal(
  dir: DataDir,
  manager: ForwardManager,
  id: string,
): Promise<void> {
  const s = readSession(dir, id);
  if (s.agent_kind !== "claude-code") return; // only claude-code gets an embedded terminal for now
  if (s.terminal_local_port) return;          // already set up

  try {
    const machine = readMachine(dir, s.machine);
    const basePath = sessionTerminalBasePath(id);
    const res = startSessionTerminal(dir, machine, {
      sessionId: id,
      tmuxSession: s.tmux_session,
      basePath,
    });
    const localPort = await findFreeLocalPort(47000, 47999);
    const fname = `session-${id}-terminal`;
    const forward: Forward = {
      name: fname,
      machine: s.machine,
      direction: "local",
      local_port: localPort,
      remote_host: "127.0.0.1",
      remote_port: res.remote_port,
      auto_start: true,
      managed_by: "system:session-terminal",
      description: `Managed terminal for session ${id}`,
    };
    if (forwardExists(dir, fname)) {
      manager.stop(fname);
      manager.forget(fname);
      deleteForward(dir, fname);
    }
    writeForward(dir, forward);
    await manager.start(fname);
    updateSession(dir, id, {
      terminal_local_port: localPort,
      terminal_remote_port: res.remote_port,
    });
    appendEvent(dir, id, {
      ts: new Date().toISOString(),
      kind: "error",   // reusing "error" slot for informational; fine for now
      message: `terminal ready at ${basePath}/`,
    });
  } catch (err) {
    appendEvent(dir, id, {
      ts: new Date().toISOString(),
      kind: "error",
      message: `session terminal setup failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** Tear down the ttyd + forward for a session (called on stop/delete). */
export async function teardownSessionTerminal(
  dir: DataDir,
  manager: ForwardManager,
  id: string,
): Promise<void> {
  const s = readSession(dir, id);
  const fname = `session-${id}-terminal`;
  if (forwardExists(dir, fname)) {
    manager.stop(fname);
    manager.forget(fname);
    deleteForward(dir, fname);
  }
  try {
    const machine = readMachine(dir, s.machine);
    stopSessionTerminal(dir, machine, id);
  } catch { /* best effort */ }
}

/**
 * Spawn a per-session filebrowser bound to the session's workdir, bind a
 * local forward, and record the ports on the session. Opt-in: only runs
 * when the UI explicitly calls the start endpoint. Returns an error
 * message on failure so the API can surface it (we don't swallow like
 * the terminal helper does because the button is an explicit action).
 */
export async function setupSessionFilebrowser(
  dir: DataDir,
  manager: ForwardManager,
  id: string,
): Promise<{ local_port: number; remote_port: number; base_path: string }> {
  const s = readSession(dir, id);
  const machine = readMachine(dir, s.machine);
  const basePath = sessionFilebrowserBasePath(id);
  const res = startSessionFilebrowser(dir, machine, {
    sessionId: id,
    workdir: s.workdir,
    basePath,
  });
  // If we already had a forward for this session (start → stop → start),
  // wipe it clean so we don't leak an old local port.
  const fname = `session-${id}-filebrowser`;
  if (forwardExists(dir, fname)) {
    manager.stop(fname);
    manager.forget(fname);
    deleteForward(dir, fname);
  }
  const localPort = await findFreeLocalPort(48000, 48999);
  const forward: Forward = {
    name: fname,
    machine: s.machine,
    direction: "local",
    local_port: localPort,
    remote_host: "127.0.0.1",
    remote_port: res.remote_port,
    auto_start: false,
    managed_by: "system:session-filebrowser",
    description: `Managed filebrowser for session ${id}`,
  };
  writeForward(dir, forward);
  await manager.start(fname);
  updateSession(dir, id, {
    filebrowser_local_port: localPort,
    filebrowser_remote_port: res.remote_port,
  });
  appendEvent(dir, id, {
    ts: new Date().toISOString(),
    kind: "error",
    message: `filebrowser ready at ${basePath}/`,
  });
  return { local_port: localPort, remote_port: res.remote_port, base_path: basePath };
}

export async function teardownSessionFilebrowser(
  dir: DataDir,
  manager: ForwardManager,
  id: string,
): Promise<void> {
  const s = readSession(dir, id);
  const fname = `session-${id}-filebrowser`;
  if (forwardExists(dir, fname)) {
    manager.stop(fname);
    manager.forget(fname);
    deleteForward(dir, fname);
  }
  try {
    const machine = readMachine(dir, s.machine);
    stopSessionFilebrowser(dir, machine, id);
  } catch { /* best effort */ }
  updateSession(dir, id, {
    filebrowser_local_port: undefined,
    filebrowser_remote_port: undefined,
  });
  appendEvent(dir, id, {
    ts: new Date().toISOString(),
    kind: "error",
    message: `filebrowser stopped`,
  });
}

/**
 * Send a user task into the running session's tmux pane.
 *
 * Two modes:
 *   - text mode: send-keys -l (literal) followed by Enter. Any text, even
 *     empty, results in a bare Enter being delivered — useful for default
 *     "press Enter to confirm" prompts.
 *   - keys mode: a list of tmux key names (e.g. "Enter", "Escape", "C-c",
 *     "Up", "BSpace"). Sent with send-keys WITHOUT -l so tmux's key-name
 *     parser is active.
 *
 * The two are mutually exclusive per call.
 */
export async function sendInputToSession(
  dir: DataDir,
  id: string,
  payload: { text?: string; keys?: string[] },
): Promise<void> {
  const s = readSession(dir, id);
  if (s.status !== "active") throw new Error(`session ${id} is not active (state=${s.status})`);
  const machine = readMachine(dir, s.machine);
  const lines: string[] = [];
  let summaryKind: "text" | "keys";
  let summary: unknown;

  if (payload.keys && payload.keys.length > 0) {
    summaryKind = "keys";
    summary = payload.keys;
    for (const k of payload.keys) {
      lines.push(`tmux send-keys -t ${shQ(s.tmux_session)} ${shQ(k)}`);
    }
  } else {
    summaryKind = "text";
    summary = payload.text ?? "";
    const text = payload.text ?? "";
    if (text.length > 0) {
      lines.push(`tmux send-keys -l -t ${shQ(s.tmux_session)} ${shQ(text)}`);
    }
    lines.push(`tmux send-keys -t ${shQ(s.tmux_session)} Enter`);
  }
  lines.push(`echo BOTDOCK_SENT`);

  const r = sshExec(dir, machine, "bash -s", lines.join("\n"), 10_000);
  if (r.code !== 0 || !r.stdout.includes("BOTDOCK_SENT")) {
    throw new Error(`send-keys failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  appendEvent(dir, id, {
    ts: new Date().toISOString(),
    kind: "user_input",
    channel: "tmux",
    ...(summaryKind === "keys" ? { keys: summary as string[] } : { text: summary as string }),
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
