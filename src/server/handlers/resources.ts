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
import {
  listFileBundles,
  readFileBundle,
  fileBundleExists,
  deleteFileBundle,
  createFileBundleFromFiles,
  createFileBundleFromArchive,
  detectArchiveKind,
  type UploadedEntry,
} from "../../domain/file-bundles.ts";

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

  // ---- file-bundle ------------------------------------------------------

  router.get("/api/resources/file-bundle", () => json(listFileBundles(dir)));

  router.get("/api/resources/file-bundle/:name", ({ params }) => {
    if (!fileBundleExists(dir, params.name!)) throw new HttpError(404, "not found");
    return json(readFileBundle(dir, params.name!));
  });

  // Mode (a): webkitdirectory picker on the client sends many files. The
  // client supplies a parallel `paths` JSON array of relative paths
  // matching the order of the `files` multipart entries — we don't rely
  // on File.name carrying slashes since browsers vary.
  router.post("/api/resources/file-bundle/files", async ({ req }) => {
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await req.formData();
    } catch (e) {
      throw new HttpError(400, `invalid multipart body: ${(e as Error).message}`);
    }
    const name = readFormString(form, "name");
    if (!name) throw new HttpError(400, "name required");
    const clash = resourceNameInUse(dir, name);
    if (clash) {
      throw new HttpError(409, `name "${name}" is already used by a ${clash} resource`);
    }
    const tags = parseFormTags(form);
    const pathsRaw = readFormString(form, "paths");
    let paths: string[];
    try {
      paths = pathsRaw ? JSON.parse(pathsRaw) : [];
    } catch {
      throw new HttpError(400, "`paths` field must be a JSON array of strings");
    }
    const files: UploadedFile[] = [];
    for (const v of form.getAll("files")) {
      if (isUploadedFile(v)) files.push(v);
    }
    if (files.length === 0) throw new HttpError(400, "at least one file required");
    if (paths.length !== files.length) {
      throw new HttpError(400, `paths length (${paths.length}) must match files count (${files.length})`);
    }
    const entries: UploadedEntry[] = [];
    for (let i = 0; i < files.length; i++) {
      const relPath = String(paths[i] ?? "");
      if (!relPath) throw new HttpError(400, `paths[${i}] is empty`);
      const buf = Buffer.from(await files[i]!.arrayBuffer());
      entries.push({ rel_path: relPath, bytes: buf });
    }
    try {
      const meta = createFileBundleFromFiles(dir, name, tags, entries);
      return json(meta, { status: 201 });
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  // Mode (c): single-archive upload. Server extracts with tar / unzip
  // into a staging dir, validates no path escaped, then renames into
  // place.
  router.post("/api/resources/file-bundle/archive", async ({ req }) => {
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await req.formData();
    } catch (e) {
      throw new HttpError(400, `invalid multipart body: ${(e as Error).message}`);
    }
    const name = readFormString(form, "name");
    if (!name) throw new HttpError(400, "name required");
    const clash = resourceNameInUse(dir, name);
    if (clash) {
      throw new HttpError(409, `name "${name}" is already used by a ${clash} resource`);
    }
    const tags = parseFormTags(form);
    const archive = form.get("archive");
    if (!isUploadedFile(archive) || archive.size === 0) {
      throw new HttpError(400, "archive file required");
    }
    const kind = detectArchiveKind(archive.name);
    if (!kind) {
      throw new HttpError(400, `unsupported archive type: ${archive.name} (want .tar/.tar.gz/.tgz/.tar.bz2/.tbz2/.zip)`);
    }
    const buf = Buffer.from(await archive.arrayBuffer());
    try {
      const meta = createFileBundleFromArchive(dir, name, tags, buf, kind);
      return json(meta, { status: 201 });
    } catch (e) {
      throw new HttpError(400, (e as Error).message || String(e));
    }
  });

  router.delete("/api/resources/file-bundle/:name", ({ params }) => {
    if (!fileBundleExists(dir, params.name!)) throw new HttpError(404, "not found");
    deleteFileBundle(dir, params.name!);
    return json({ ok: true });
  });
}

// Form is typed loosely to sidestep the undici/Bun FormData type
// mismatch; the runtime behaviour is standards-compliant either way.
type AnyFormData = Awaited<ReturnType<Request["formData"]>>;
type UploadedFile = {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** Duck-type narrowing for the multipart file-like entries. Covers both
 *  the `File` impl Bun returns and the DOM `File` the ambient types
 *  reference without triggering the undici/Bun type collision. */
function isUploadedFile(v: unknown): v is UploadedFile {
  if (!v || typeof v !== "object") return false;
  const o = v as { name?: unknown; size?: unknown; arrayBuffer?: unknown };
  return typeof o.name === "string"
    && typeof o.size === "number"
    && typeof o.arrayBuffer === "function";
}

function readFormString(form: AnyFormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function parseFormTags(form: AnyFormData): string[] | undefined {
  const raw = readFormString(form, "tags");
  if (!raw) return undefined;
  const tags = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}
