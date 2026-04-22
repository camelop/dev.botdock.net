import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  listGitRepos,
  readGitRepo,
  writeGitRepo,
  deleteGitRepo,
  gitRepoExists,
  resourceNameInUse,
  probeGitRepo,
  listMarkdowns,
  readMarkdown,
  createMarkdown,
  updateMarkdown,
  deleteMarkdown,
  markdownExists,
  MARKDOWN_CONTENT_LIMIT,
  type GitRepoResource,
} from "../../domain/resources.ts";

export function mountResources(router: Router, dir: DataDir): void {
  router.get("/api/resources/git-repo", () => json(listGitRepos(dir)));

  // Probe a remote URL (before the user commits to creating a resource) to
  // surface the default branch + full branch list for the Ref dropdown. The
  // heavy lifting is a plain `git ls-remote`; we just select the right
  // deploy key when the caller supplies one.
  router.post("/api/resources/git-repo/probe", async ({ req }) => {
    const body = await parseJsonBody<{ url?: string; deploy_key?: string }>(req);
    if (!body.url) throw new HttpError(400, "url required");
    try {
      const probe = probeGitRepo(dir, body.url, body.deploy_key || undefined);
      return json(probe);
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

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

  // ---- markdown ---------------------------------------------------------

  router.get("/api/resources/markdown", () => json(listMarkdowns(dir)));

  router.get("/api/resources/markdown/:name", ({ params }) => {
    if (!markdownExists(dir, params.name!)) throw new HttpError(404, "not found");
    return json(readMarkdown(dir, params.name!));
  });

  router.post("/api/resources/markdown", async ({ req }) => {
    const body = await parseJsonBody<{
      name?: string;
      tags?: string[];
      content?: string;
    }>(req);
    if (!body.name) throw new HttpError(400, "name required");
    const clash = resourceNameInUse(dir, body.name);
    if (clash) {
      throw new HttpError(409, `name "${body.name}" is already used by a ${clash} resource`);
    }
    if (typeof body.content === "string"
      && Buffer.byteLength(body.content, "utf8") > MARKDOWN_CONTENT_LIMIT) {
      throw new HttpError(413, `content exceeds ${MARKDOWN_CONTENT_LIMIT} bytes`);
    }
    try {
      const meta = createMarkdown(dir, body.name, {
        tags: body.tags,
        content: body.content,
      });
      return json(meta, { status: 201 });
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  router.put("/api/resources/markdown/:name", async ({ req, params }) => {
    if (!markdownExists(dir, params.name!)) throw new HttpError(404, "not found");
    const body = await parseJsonBody<{
      tags?: string[];
      content?: string;
    }>(req);
    if (typeof body.content === "string"
      && Buffer.byteLength(body.content, "utf8") > MARKDOWN_CONTENT_LIMIT) {
      throw new HttpError(413, `content exceeds ${MARKDOWN_CONTENT_LIMIT} bytes`);
    }
    try {
      const meta = updateMarkdown(dir, params.name!, {
        tags: body.tags,
        content: body.content,
      });
      return json(meta);
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  router.delete("/api/resources/markdown/:name", ({ params }) => {
    if (!markdownExists(dir, params.name!)) throw new HttpError(404, "not found");
    deleteMarkdown(dir, params.name!);
    return json({ ok: true });
  });
}
