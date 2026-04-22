/**
 * File-bundle resources: a directory tree the user maintains in the
 * root-folder and can ship into a session's context. Import is either
 *   (a) a folder picked via webkitdirectory in the browser → multipart
 *       upload with one formData entry per file, and
 *   (c) an archive (tar / tar.gz / zip) → single multipart upload,
 *       extracted server-side with `tar` / `unzip`.
 *
 * Layout on disk mirrors what the push flow will write into a session:
 *   resources/file-bundle/<name>/
 *   ├── meta.toml              — { name, tags?, file_count, bytes, created_at, updated_at }
 *   └── content/               — the actual tree, preserved as uploaded
 *
 * No size or file-count caps per user direction. Individual file names
 * must not contain "..", absolute paths, or colons — anything that
 * could escape the bundle dir on write gets rejected.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { DataDir, assertSafeName, readToml, writeToml } from "../storage/index.ts";

export type FileBundleMeta = {
  name: string;
  tags?: string[];
  file_count: number;
  bytes: number;
  created_at: string;
  updated_at: string;
};

export type UploadedEntry = {
  /** Path relative to the bundle root, using forward slashes. May contain
   *  subdirectories; "../" segments and leading "/" are rejected upstream. */
  rel_path: string;
  /** File contents. For small files we get a Buffer in memory; the
   *  endpoint handles streaming outside this module. */
  bytes: Buffer;
};

export function listFileBundles(dir: DataDir): FileBundleMeta[] {
  const root = dir.fileBundlesDir();
  if (!existsSync(root)) return [];
  const out: FileBundleMeta[] = [];
  for (const name of readdirSync(root)) {
    try { assertSafeName(name, "file-bundle name"); } catch { continue; }
    const meta = join(root, name, "meta.toml");
    if (!existsSync(meta)) continue;
    out.push(readToml<FileBundleMeta>(meta));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function fileBundleExists(dir: DataDir, name: string): boolean {
  try {
    return existsSync(join(dir.fileBundleDir(name), "meta.toml"));
  } catch {
    return false;
  }
}

/** Read meta + a flat listing of the bundle's content tree. We deliberately
 *  don't return file bodies; even without an enforced cap, a bundle could
 *  be many MB and the Edit page only needs to show names + sizes. */
export function readFileBundle(dir: DataDir, name: string): {
  meta: FileBundleMeta;
  entries: Array<{ rel_path: string; bytes: number }>;
} {
  const metaPath = join(dir.fileBundleDir(name), "meta.toml");
  if (!existsSync(metaPath)) throw new Error(`file-bundle not found: ${name}`);
  const meta = readToml<FileBundleMeta>(metaPath);
  const contentRoot = join(dir.fileBundleDir(name), "content");
  const entries: Array<{ rel_path: string; bytes: number }> = [];
  if (existsSync(contentRoot)) walk(contentRoot, "", entries);
  entries.sort((a, b) => a.rel_path.localeCompare(b.rel_path));
  return { meta, entries };
}

export function deleteFileBundle(dir: DataDir, name: string): void {
  const path = dir.fileBundleDir(name);
  if (!existsSync(path)) throw new Error(`file-bundle not found: ${name}`);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Create a bundle from a batch of uploaded files (mode a). Writes into
 * a temp dir first, then renames atomically into place so a failure
 * halfway through doesn't leave a half-populated resource.
 */
export function createFileBundleFromFiles(
  dir: DataDir,
  name: string,
  tags: string[] | undefined,
  entries: UploadedEntry[],
): FileBundleMeta {
  assertSafeName(name, "file-bundle name");
  if (fileBundleExists(dir, name)) {
    throw new Error(`file-bundle already exists: ${name}`);
  }
  if (entries.length === 0) {
    throw new Error("at least one file is required");
  }

  const staging = mkdtempishIn(dir.fileBundlesDir(), `.${name}.tmp-`);
  try {
    const contentDir = join(staging, "content");
    mkdirSync(contentDir, { recursive: true });

    let totalBytes = 0;
    let fileCount = 0;
    for (const entry of entries) {
      const safe = sanitizeRelPath(entry.rel_path);
      const dest = join(contentDir, safe);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.bytes);
      totalBytes += entry.bytes.length;
      fileCount += 1;
    }

    const now = new Date().toISOString();
    const meta: FileBundleMeta = {
      name,
      tags: tags?.length ? tags : undefined,
      file_count: fileCount,
      bytes: totalBytes,
      created_at: now,
      updated_at: now,
    };
    writeToml(join(staging, "meta.toml"), toTomlable(meta));

    // Atomic-ish swap: rename staging → final. If rename fails the temp
    // still gets cleaned up by finally.
    const final = dir.fileBundleDir(name);
    try { rmSync(final, { recursive: true, force: true }); } catch { /* ignore */ }
    (require("node:fs") as typeof import("node:fs")).renameSync(staging, final);
    return meta;
  } catch (err) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export type ArchiveKind = "tar" | "tar.gz" | "tar.bz2" | "zip";

export function detectArchiveKind(filename: string): ArchiveKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

/**
 * Create a bundle from a single uploaded archive (mode c). Writes the
 * archive bytes to a temp file, extracts with `tar` / `unzip`, validates
 * no path escaped the extraction root, then renames into place.
 */
export function createFileBundleFromArchive(
  dir: DataDir,
  name: string,
  tags: string[] | undefined,
  archiveBytes: Buffer,
  kind: ArchiveKind,
): FileBundleMeta {
  assertSafeName(name, "file-bundle name");
  if (fileBundleExists(dir, name)) {
    throw new Error(`file-bundle already exists: ${name}`);
  }

  const staging = mkdtempishIn(dir.fileBundlesDir(), `.${name}.tmp-`);
  const archivePath = join(tmpdir(), `botdock-archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const contentDir = join(staging, "content");
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(archivePath, archiveBytes);

    extractArchive(archivePath, contentDir, kind);
    assertNoPathEscape(contentDir);

    const { totalBytes, fileCount } = measureTree(contentDir);
    if (fileCount === 0) {
      throw new Error("archive contained no files");
    }

    const now = new Date().toISOString();
    const meta: FileBundleMeta = {
      name,
      tags: tags?.length ? tags : undefined,
      file_count: fileCount,
      bytes: totalBytes,
      created_at: now,
      updated_at: now,
    };
    writeToml(join(staging, "meta.toml"), toTomlable(meta));

    const final = dir.fileBundleDir(name);
    try { rmSync(final, { recursive: true, force: true }); } catch { /* ignore */ }
    (require("node:fs") as typeof import("node:fs")).renameSync(staging, final);
    return meta;
  } catch (err) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  } finally {
    try { rmSync(archivePath, { force: true }); } catch { /* ignore */ }
  }
}

/** Reject path components that would escape the bundle's content root.
 *  Allows subdirectories, normalises slashes, and enforces relative. */
function sanitizeRelPath(rel: string): string {
  if (!rel) throw new Error("empty relative path");
  // Normalize separators to POSIX then remove any leading "./" — browsers
  // sometimes prefix webkitRelativePath with it.
  let p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("/")) throw new Error(`absolute path not allowed: ${rel}`);
  const norm = normalize(p);
  if (norm === ".." || norm.startsWith("..") || norm.split(sep).includes("..")) {
    throw new Error(`path escapes bundle root: ${rel}`);
  }
  return norm;
}

/** After archive extraction, walk the tree and confirm everything is
 *  still inside `root`. Belt-and-braces against tar/zip entries that
 *  smuggled symlinks or absolute paths past the extractor. */
function assertNoPathEscape(root: string): void {
  const resolved = require("node:path").resolve(root);
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const real = (require("node:fs") as typeof import("node:fs")).realpathSync.native(p);
      const realRoot = (require("node:fs") as typeof import("node:fs")).realpathSync.native(resolved);
      if (!real.startsWith(realRoot + sep) && real !== realRoot) {
        throw new Error(`archive contained a path outside the bundle root: ${name}`);
      }
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
    }
  }
}

function extractArchive(archivePath: string, destDir: string, kind: ArchiveKind): void {
  let cmd: string;
  let args: string[];
  if (kind === "zip") {
    cmd = "unzip";
    // -o: overwrite without prompt (should be empty anyway)
    // -q: quiet
    args = ["-o", "-q", archivePath, "-d", destDir];
  } else {
    // tar -xf handles .tar transparently; -z / -j switches aren't needed on
    // modern GNU tar (autodetection). We pass them explicitly for safety
    // on older busybox-style tars.
    const flag =
      kind === "tar.gz" ? "-xzf"
      : kind === "tar.bz2" ? "-xjf"
      : "-xf";
    cmd = "tar";
    args = [flag, archivePath, "-C", destDir];
  }
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000 });
  if (res.status !== 0) {
    const why = (res.stderr ?? "").trim() || `${cmd} exited ${res.status}`;
    throw new Error(`archive extraction failed: ${why}`);
  }
}

function measureTree(root: string): { totalBytes: number; fileCount: number } {
  let totalBytes = 0;
  let fileCount = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) {
        totalBytes += st.size;
        fileCount += 1;
      }
    }
  }
  return { totalBytes, fileCount };
}

function walk(
  root: string,
  rel: string,
  out: Array<{ rel_path: string; bytes: number }>,
): void {
  const dir = rel ? join(root, rel) : root;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const relNext = rel ? `${rel}/${name}` : name;
    const st = statSync(p);
    if (st.isDirectory()) walk(root, relNext, out);
    else if (st.isFile()) out.push({ rel_path: relNext, bytes: st.size });
  }
}

function toTomlable(meta: FileBundleMeta): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: meta.name,
    file_count: meta.file_count,
    bytes: meta.bytes,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
  if (meta.tags && meta.tags.length) data.tags = meta.tags;
  return data;
}

/** mkdtemp-like but under a specific parent dir so the staging area
 *  sits next to the final dir (cross-fs rename avoided). */
function mkdtempishIn(parent: string, prefix: string): string {
  mkdirSync(parent, { recursive: true });
  const path = join(parent, `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path, { recursive: true });
  return path;
}
