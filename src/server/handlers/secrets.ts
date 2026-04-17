import { existsSync } from "node:fs";
import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  deleteSecret,
  listSecrets,
  readSecretMeta,
  readSecretValue,
  writeSecret,
} from "../../domain/secrets.ts";

export function mountSecrets(router: Router, dir: DataDir): void {
  router.get("/api/secrets", () => json(listSecrets(dir)));

  router.get("/api/secrets/:name", ({ params }) => {
    if (!existsSync(dir.secretDir(params.name!))) throw new HttpError(404, "not found");
    return json(readSecretMeta(dir, params.name!));
  });

  router.get("/api/secrets/:name/value", ({ params }) => {
    if (!existsSync(dir.secretDir(params.name!))) throw new HttpError(404, "not found");
    return json({ value: readSecretValue(dir, params.name!).toString("utf8") });
  });

  router.post("/api/secrets", async ({ req }) => {
    const body = await parseJsonBody<{ name: string; value: string; description?: string }>(req);
    if (!body.name || typeof body.value !== "string") {
      throw new HttpError(400, "name and value required");
    }
    const meta = writeSecret(dir, body.name, Buffer.from(body.value, "utf8"), body.description ?? "");
    return json(meta, { status: 201 });
  });

  router.put("/api/secrets/:name", async ({ req, params }) => {
    const body = await parseJsonBody<{ value: string; description?: string }>(req);
    if (typeof body.value !== "string") throw new HttpError(400, "value required");
    const meta = writeSecret(dir, params.name!, Buffer.from(body.value, "utf8"), body.description ?? "");
    return json(meta);
  });

  router.delete("/api/secrets/:name", ({ params }) => {
    if (!existsSync(dir.secretDir(params.name!))) throw new HttpError(404, "not found");
    deleteSecret(dir, params.name!);
    return json({ ok: true });
  });
}
