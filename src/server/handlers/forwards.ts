import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  deleteForward,
  describeForward,
  forwardExists,
  listForwards,
  readForward,
  writeForward,
  type Forward,
} from "../../domain/forwards.ts";
import type { ForwardManager } from "../../domain/forward-manager.ts";

export function mountForwards(router: Router, dir: DataDir, manager: ForwardManager): void {
  const withStatus = (f: Forward) => ({
    ...f,
    description_line: describeForward(f),
    status: manager.getStatus(f.name),
  });

  router.get("/api/forwards", () => {
    const all = listForwards(dir).map(withStatus);
    return json(all);
  });

  router.get("/api/forwards/:name", ({ params }) => {
    if (!forwardExists(dir, params.name!)) throw new HttpError(404, "not found");
    return json(withStatus(readForward(dir, params.name!)));
  });

  router.post("/api/forwards", async ({ req }) => {
    const body = await parseJsonBody<Forward>(req);
    if (forwardExists(dir, body.name)) throw new HttpError(409, "already exists");
    writeForward(dir, body);
    if (body.auto_start) {
      manager.start(body.name).catch((err) => console.error("[forwards] start failed:", err));
    }
    return json(withStatus(readForward(dir, body.name)), { status: 201 });
  });

  router.put("/api/forwards/:name", async ({ req, params }) => {
    const body = await parseJsonBody<Forward>(req);
    body.name = params.name!;
    if (!forwardExists(dir, body.name)) throw new HttpError(404, "not found");
    writeForward(dir, body);
    return json(withStatus(readForward(dir, body.name)));
  });

  router.delete("/api/forwards/:name", ({ params }) => {
    if (!forwardExists(dir, params.name!)) throw new HttpError(404, "not found");
    manager.stop(params.name!);
    manager.forget(params.name!);
    deleteForward(dir, params.name!);
    return json({ ok: true });
  });

  router.post("/api/forwards/:name/start", async ({ params }) => {
    if (!forwardExists(dir, params.name!)) throw new HttpError(404, "not found");
    const st = await manager.start(params.name!);
    return json(st);
  });

  router.post("/api/forwards/:name/stop", ({ params }) => {
    if (!forwardExists(dir, params.name!)) throw new HttpError(404, "not found");
    return json(manager.stop(params.name!));
  });
}
