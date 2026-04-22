import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  listGitRepos,
  readGitRepo,
  writeGitRepo,
  deleteGitRepo,
  gitRepoExists,
  resourceNameInUse,
  type GitRepoResource,
} from "../../domain/resources.ts";

export function mountResources(router: Router, dir: DataDir): void {
  router.get("/api/resources/git-repo", () => json(listGitRepos(dir)));

  router.get("/api/resources/git-repo/:name", ({ params }) => {
    if (!gitRepoExists(dir, params.name!)) throw new HttpError(404, "not found");
    return json(readGitRepo(dir, params.name!));
  });

  router.post("/api/resources/git-repo", async ({ req }) => {
    const body = await parseJsonBody<Partial<GitRepoResource>>(req);
    if (!body.name) throw new HttpError(400, "name required");
    if (!body.url)  throw new HttpError(400, "url required");
    const clash = resourceNameInUse(dir, body.name);
    if (clash) {
      throw new HttpError(409, `name "${body.name}" is already used by a ${clash} resource`);
    }
    const now = new Date().toISOString();
    const r: GitRepoResource = {
      name: body.name,
      url: body.url,
      ref: body.ref?.trim() || undefined,
      deploy_key: body.deploy_key?.trim() || undefined,
      tags: body.tags?.length ? body.tags : undefined,
      created_at: now,
      updated_at: now,
    };
    writeGitRepo(dir, r);
    return json(r, { status: 201 });
  });

  router.put("/api/resources/git-repo/:name", async ({ req, params }) => {
    const body = await parseJsonBody<Partial<GitRepoResource>>(req);
    const name = params.name!;
    if (!gitRepoExists(dir, name)) throw new HttpError(404, "not found");
    const prev = readGitRepo(dir, name);
    const r: GitRepoResource = {
      name,
      url: body.url ?? prev.url,
      ref: (body.ref !== undefined ? body.ref.trim() : prev.ref) || undefined,
      deploy_key: (body.deploy_key !== undefined ? body.deploy_key.trim() : prev.deploy_key) || undefined,
      tags: body.tags !== undefined ? (body.tags.length ? body.tags : undefined) : prev.tags,
      created_at: prev.created_at,
      updated_at: new Date().toISOString(),
    };
    writeGitRepo(dir, r);
    return json(r);
  });

  router.delete("/api/resources/git-repo/:name", ({ params }) => {
    if (!gitRepoExists(dir, params.name!)) throw new HttpError(404, "not found");
    deleteGitRepo(dir, params.name!);
    return json({ ok: true });
  });
}
