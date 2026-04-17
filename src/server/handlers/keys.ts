import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  createKey,
  deleteKey,
  importKey,
  keyExists,
  listKeys,
  readKey,
} from "../../domain/keys.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function mountKeys(router: Router, dir: DataDir): void {
  router.get("/api/keys", () => json(listKeys(dir)));

  router.get("/api/keys/:nickname", ({ params }) => {
    if (!keyExists(dir, params.nickname!)) throw new HttpError(404, "not found");
    return json(readKey(dir, params.nickname!));
  });

  router.post("/api/keys", async ({ req }) => {
    const body = await parseJsonBody<{
      nickname: string;
      comment?: string;
      private_key?: string;
    }>(req);
    if (!body.nickname) throw new HttpError(400, "nickname required");
    const comment = body.comment ?? `botdock:${body.nickname}`;
    if (body.private_key) {
      // Write to a tmp file so our importer (ssh-keygen) can read it.
      const tmp = mkdtempSync(join(tmpdir(), "bd-import-"));
      const path = join(tmp, "key");
      try {
        writeFileSync(path, body.private_key, { mode: 0o600 });
        const meta = importKey(dir, body.nickname, path, comment);
        return json(meta, { status: 201 });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const meta = createKey(dir, body.nickname, comment);
    return json(meta, { status: 201 });
  });

  router.delete("/api/keys/:nickname", ({ params }) => {
    if (!keyExists(dir, params.nickname!)) throw new HttpError(404, "not found");
    deleteKey(dir, params.nickname!);
    return json({ ok: true });
  });
}
