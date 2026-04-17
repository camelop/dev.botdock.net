import { existsSync } from "node:fs";
import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  deleteMachine,
  listMachines,
  readMachine,
  writeMachine,
} from "../../domain/machines.ts";
import type { Machine } from "../../domain/machines.ts";
import { buildSshConfig } from "../../lib/sshconfig.ts";
import { run } from "../../lib/ssh.ts";
import { sshExec } from "../../lib/remote.ts";

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function mountMachines(router: Router, dir: DataDir): void {
  router.get("/api/machines", () => json(listMachines(dir)));

  router.get("/api/machines/:name", ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    return json(readMachine(dir, params.name!));
  });

  router.post("/api/machines", async ({ req }) => {
    const m = await parseJsonBody<Machine>(req);
    if (!m.name) throw new HttpError(400, "name required");
    if (existsSync(dir.machineFile(m.name))) throw new HttpError(409, "already exists");
    writeMachine(dir, m);
    return json(m, { status: 201 });
  });

  router.put("/api/machines/:name", async ({ req, params }) => {
    const body = await parseJsonBody<Machine>(req);
    body.name = params.name!;
    if (!existsSync(dir.machineFile(body.name))) throw new HttpError(404, "not found");
    writeMachine(dir, body);
    return json(body);
  });

  router.delete("/api/machines/:name", ({ params }) => {
    if (!existsSync(dir.machineFile(params.name!))) throw new HttpError(404, "not found");
    deleteMachine(dir, params.name!);
    return json({ ok: true });
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
