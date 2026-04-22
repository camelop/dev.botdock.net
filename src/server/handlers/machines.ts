import { existsSync } from "node:fs";
import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  deleteMachine,
  listMachines,
  readMachine,
  writeMachine,
  LOCAL_MACHINE_NAME,
} from "../../domain/machines.ts";
import type { Machine } from "../../domain/machines.ts";
import { enableLocalMachine, disableLocalMachine } from "../../domain/local-machine.ts";
import { buildSshConfig } from "../../lib/sshconfig.ts";
import { run } from "../../lib/ssh.ts";
import { sshExec } from "../../lib/remote.ts";
import { startTerminal, stopTerminal, readInstalledState } from "../../lib/remote-install.ts";
import { findFreeLocalPort } from "../../lib/free-port.ts";
import {
  deleteForward,
  forwardExists,
  readForward,
  writeForward,
  type Forward,
} from "../../domain/forwards.ts";
import type { ForwardManager } from "../../domain/forward-manager.ts";

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const TERMINAL_FORWARD_NAME = (machine: string) => `terminal-${machine}`;
const TERMINAL_MANAGED_BY = "system:machine-terminal";

export function mountMachines(router: Router, dir: DataDir, forwardManager: ForwardManager): void {
  router.get("/api/machines", () => json(listMachines(dir)));

  router.get("/api/machines/:name", ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    return json(readMachine(dir, params.name!));
  });

  router.post("/api/machines", async ({ req }) => {
    const m = await parseJsonBody<Machine>(req);
    if (!m.name) throw new HttpError(400, "name required");
    if (m.name === LOCAL_MACHINE_NAME) {
      throw new HttpError(409, `"${LOCAL_MACHINE_NAME}" is reserved — use POST /api/machines/local/enable instead`);
    }
    if (existsSync(dir.machineFile(m.name))) throw new HttpError(409, "already exists");
    writeMachine(dir, m);
    return json(m, { status: 201 });
  });

  router.put("/api/machines/:name", async ({ req, params }) => {
    const body = await parseJsonBody<Machine>(req);
    body.name = params.name!;
    if (body.name === LOCAL_MACHINE_NAME) {
      throw new HttpError(409, `"${LOCAL_MACHINE_NAME}" is managed — use enable/disable endpoints instead of PUT`);
    }
    if (!existsSync(dir.machineFile(body.name))) throw new HttpError(404, "not found");
    writeMachine(dir, body);
    return json(body);
  });

  router.delete("/api/machines/:name", ({ params }) => {
    if (params.name === LOCAL_MACHINE_NAME) {
      throw new HttpError(409, `"${LOCAL_MACHINE_NAME}" cannot be removed — use Disable in the Machines page`);
    }
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    deleteMachine(dir, params.name!);
    return json({ ok: true });
  });

  // Enable / disable for the reserved `local` pseudo-machine. Enable is
  // idempotent — it sets up the key + machine file + authorized_keys
  // entry only as needed, and also clears any prior `disabled` flag.
  router.post("/api/machines/local/enable", () => {
    try {
      const m = enableLocalMachine(dir);
      return json(m);
    } catch (err) {
      throw new HttpError(500, err instanceof Error ? err.message : String(err));
    }
  });
  router.post("/api/machines/local/disable", () => {
    if (!existsSync(dir.machineFile(LOCAL_MACHINE_NAME))) {
      throw new HttpError(404, "local machine is not enabled");
    }
    const m = disableLocalMachine(dir);
    return json(m);
  });

  router.get("/api/machines/:name/browse", ({ params, url }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    const m = readMachine(dir, params.name!);
    const rawPath = url.searchParams.get("path") ?? "~/";
    // Ask the remote shell to expand ~ and list the directory. If the target
    // isn't a directory, list its parent instead so autocomplete still works
    // while the user is typing.
    const script = `
set -u
P=${shq(rawPath)}
EXPANDED=$(eval echo "$P")
# If the path is a directory, list it. Else, list its parent.
if [ -d "$EXPANDED" ]; then
  LS_DIR="$EXPANDED"
elif [ -d "$(dirname "$EXPANDED")" ]; then
  LS_DIR="$(dirname "$EXPANDED")"
else
  echo "EXPANDED=$EXPANDED"
  echo "ENTRIES="
  exit 0
fi
echo "EXPANDED=$EXPANDED"
echo "LS_DIR=$LS_DIR"
echo "ENTRIES_BEGIN"
ls -1A --color=never "$LS_DIR" 2>/dev/null | while IFS= read -r name; do
  if [ -d "$LS_DIR/$name" ]; then
    printf 'd %s\\n' "$name"
  else
    printf 'f %s\\n' "$name"
  fi
done
echo "ENTRIES_END"
`;
    const r = sshExec(dir, m, "bash -s", script, 10_000);
    if (r.code !== 0) {
      // Silently degrade — the UI will just show no suggestions.
      return json({ expanded: rawPath, dir: "", entries: [], error: r.stderr.slice(0, 200) });
    }
    const expanded = /EXPANDED=(.*)/.exec(r.stdout)?.[1]?.trim() ?? rawPath;
    const lsDir = /LS_DIR=(.*)/.exec(r.stdout)?.[1]?.trim() ?? "";
    const beginIdx = r.stdout.indexOf("ENTRIES_BEGIN");
    const endIdx = r.stdout.indexOf("ENTRIES_END");
    const entries: Array<{ name: string; kind: "dir" | "file" }> = [];
    if (beginIdx >= 0 && endIdx > beginIdx) {
      const chunk = r.stdout.slice(beginIdx + "ENTRIES_BEGIN\n".length, endIdx);
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        const kind = line[0] === "d" ? "dir" : "file";
        entries.push({ kind, name: line.slice(2) });
      }
    }
    return json({ expanded, dir: lsDir, entries });
  });

  /**
   * List every Claude Code transcript jsonl under ~/.claude/projects/ on the
   * remote and, for each one, flag whether a `claude` process is currently
   * running with that same cwd (so we can warn the user before they try to
   * --resume a session that another process still holds).
   *
   * The remote work is a single python3 script piped over ssh — we need
   * per-file parsing anyway (the first few JSONL lines carry `cwd` and a
   * user-message preview), and python is the same dep we already rely on
   * for the trust-dialog skip.
   */
  router.get("/api/machines/:name/cc-sessions", ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    const machine = readMachine(dir, params.name!);
    const script = `
python3 - <<'PY'
import json, os, sys
home = os.path.expanduser("~")
cc_root = os.path.join(home, ".claude", "projects")

active_cwds = set()
try:
    pid_entries = os.listdir("/proc")
except Exception:
    pid_entries = []
for pid in pid_entries:
    if not pid.isdigit(): continue
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().replace(b"\\0", b" ").decode(errors="replace")
    except Exception:
        continue
    if "claude" not in cmd: continue
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
    except Exception:
        continue
    active_cwds.add(cwd)

out = []
if os.path.isdir(cc_root):
    for folder in os.listdir(cc_root):
        fpath = os.path.join(cc_root, folder)
        if not os.path.isdir(fpath): continue
        for name in os.listdir(fpath):
            if not name.endswith(".jsonl"): continue
            full = os.path.join(fpath, name)
            try:
                st = os.stat(full)
            except Exception:
                continue
            uuid = name[:-6]
            cwd = None
            preview = None
            try:
                with open(full, "r", errors="replace") as fh:
                    for i, line in enumerate(fh):
                        if i > 200: break  # prompt can sit well past the
                                           # permission-mode / file-history
                                           # scaffolding that CC writes first
                        line = line.strip()
                        if not line: continue
                        try:
                            rec = json.loads(line)
                        except Exception:
                            continue
                        if not cwd and isinstance(rec.get("cwd"), str):
                            cwd = rec["cwd"]
                        if not preview:
                            # Classify like the frontend's parseTranscript: a
                            # "real" user message has message.role == "user"
                            # AND content blocks that aren't all tool_result
                            # (tool replies get wrapped as user messages too).
                            msg = rec.get("message")
                            role = msg.get("role") if isinstance(msg, dict) else None
                            top_type = rec.get("type")
                            # Accept either signal — different CC versions set
                            # message.role or just the top-level type.
                            if role == "user" or (top_type == "user" and isinstance(msg, dict)):
                                content = msg.get("content") if isinstance(msg, dict) else None
                                if isinstance(content, str) and content.strip():
                                    preview = content.strip()
                                elif isinstance(content, list):
                                    # Skip entries that are only tool_result
                                    # blocks — those aren't the user's prompt.
                                    texts = [
                                        c.get("text", "") for c in content
                                        if isinstance(c, dict) and c.get("type") == "text"
                                           and isinstance(c.get("text"), str)
                                    ]
                                    first = next((t for t in texts if t.strip()), None)
                                    if first:
                                        preview = first.strip()
                        if cwd and preview:
                            break
            except Exception:
                pass
            out.append({
                "uuid": uuid,
                "workdir": cwd or "",
                "mtime": int(st.st_mtime),
                "size": st.st_size,
                "preview": (preview or "")[:160],
                "has_active_process": bool(cwd and cwd in active_cwds),
            })

out.sort(key=lambda x: -x["mtime"])
print(json.dumps(out))
PY
`;
    const r = sshExec(dir, machine, "bash -s", script, 15_000);
    if (r.code !== 0) {
      // Degrade silently — UI will show an empty list.
      return json({ sessions: [], error: r.stderr.slice(0, 400) || `exit ${r.code}` });
    }
    try {
      const sessions = JSON.parse(r.stdout.trim() || "[]") as unknown[];
      return json({ sessions });
    } catch (e) {
      return json({ sessions: [], error: `parse: ${(e as Error).message}` });
    }
  });

  router.get("/api/machines/:name/installed", ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    const m = readMachine(dir, params.name!);
    try {
      return json(readInstalledState(dir, m));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/machines/:name/terminal/start", async ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    const machine = readMachine(dir, params.name!);
    const fname = TERMINAL_FORWARD_NAME(machine.name);

    // Idempotent: if a forward exists and is already running, just return
    // its current status. Otherwise (re)provision and (re)bind.
    if (forwardExists(dir, fname)) {
      const cur = readForward(dir, fname);
      const status = forwardManager.getStatus(fname);
      if (status.state === "running") {
        return json({
          forward: cur,
          status,
          installed: readInstalledState(dir, machine),
          url: `/api/machines/${encodeURIComponent(machine.name)}/terminal/`,
        });
      }
    }

    const res = startTerminal(dir, machine);
    const localPort = await findFreeLocalPort(47000, 47999);

    const forward: Forward = {
      name: fname,
      machine: machine.name,
      direction: "local",
      local_port: localPort,
      remote_host: "127.0.0.1",
      remote_port: res.remote_port,
      auto_start: true,
      managed_by: TERMINAL_MANAGED_BY,
      description: `Managed terminal for ${machine.name}`,
    };
    if (forwardExists(dir, fname)) {
      forwardManager.stop(fname);
      forwardManager.forget(fname);
      deleteForward(dir, fname);
    }
    writeForward(dir, forward);
    await forwardManager.start(fname);
    return json({
      forward,
      status: forwardManager.getStatus(fname),
      installed: res.installed,
      url: `/api/machines/${encodeURIComponent(machine.name)}/terminal/`,
    });
  });

  router.post("/api/machines/:name/terminal/stop", ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    const machine = readMachine(dir, params.name!);
    const fname = TERMINAL_FORWARD_NAME(machine.name);
    if (forwardExists(dir, fname)) {
      forwardManager.stop(fname);
    }
    try { stopTerminal(dir, machine); } catch { /* best effort */ }
    return json({ ok: true });
  });

  router.post("/api/machines/:name/test", ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    const m = readMachine(dir, params.name!);
    const cfg = buildSshConfig(dir, m);
    try {
      const r = run("ssh", ["-F", cfg.configPath, cfg.targetAlias, "echo", "botdock-ok"]);
      const ok = r.code === 0 && r.stdout.trim() === "botdock-ok";
      return json({
        ok,
        hops: m.jump?.length ?? 0,
        exit_code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    } finally {
      cfg.dispose();
    }
  });
}
