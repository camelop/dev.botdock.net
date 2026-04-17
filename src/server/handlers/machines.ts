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
