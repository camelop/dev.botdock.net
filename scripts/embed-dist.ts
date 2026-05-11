#!/usr/bin/env bun
/**
 * Walk web/dist/ and emit src/server/embedded.ts with the frontend bundle
 * serialized as base64 keyed by URL path. Invoked by scripts/build.sh just
 * before `bun build --compile`.
 *
 * Reachability filter: only files referenced (transitively) from
 * `index.html` get embedded. Vite emits orphan chunks for monaco-editor's
 * language modes / language-service workers that our runtime never loads
 * — without the filter they were inflating the binary by ~10 MB of pure
 * dead weight. The filter is a plain substring-BFS over file relpaths:
 * starting from index.html, scan its text for occurrences of any other
 * dist file's relpath; recurse on each hit. If a file's path string never
 * appears in any already-reachable file, it's not referenced and gets
 * dropped from the embed.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".map":  "application/json",
};

/** Seed URLs (relative to dist root, leading slash). index.html is the
 *  entry; favicon and logo are referenced by the React layer at runtime
 *  but also covered by the HTML's link/href tags, so they'll be picked
 *  up by reachability either way. Listed explicitly here as a safety net
 *  in case a future build pipeline names them differently. */
const ALWAYS_KEEP = ["/index.html", "/favicon.png", "/logo.png"];

/** Monaco bundles 80+ "basic language" mode chunks plus four giant
 *  language-service workers (ts/css/html/json — ts.worker alone is ~7
 *  MB). All four workers + every language mode get emitted by Vite
 *  because monaco-editor's index references them via dynamic import,
 *  but our markdown-only editor never actually loads any of them. The
 *  reachability BFS therefore can't tell them apart from real lazy-
 *  loaded routes. Hardcode the drop-list — losing 10+ MB of dead
 *  weight is worth a tiny static list to maintain. Adjust if BotDock
 *  ever starts opening a non-markdown Monaco buffer.
 *
 *  Each entry matches a chunk basename's leading "name-" segment, e.g.
 *  "abap" matches "abap-DLDM7-KI.js". */
const MONACO_DROP_PREFIXES = [
  // Language-service workers (the biggest savings).
  "ts.worker", "css.worker", "html.worker", "json.worker",
  // Language-service modes that pair with the workers above.
  "tsMode", "cssMode", "htmlMode", "jsonMode",
  "lspLanguageFeatures",
  // basic-languages — every entry monaco-editor ships under
  // `esm/vs/basic-languages/` *except* markdown. Keeping this list in
  // sync with Monaco upstream is a five-minute job at most and only
  // necessary when Monaco adds a new language.
  "abap", "apex", "azcli", "bat", "bicep", "cameligo", "clojure",
  "coffee", "cpp", "csharp", "csp", "css", "cypher", "dart",
  "dockerfile", "ecl", "elixir", "flow9", "freemarker2", "fsharp",
  "go", "graphql", "handlebars", "hcl", "html", "ini", "java",
  "javascript", "julia", "kotlin", "less", "lexon", "liquid", "lua",
  "m3", "mdx", "mips", "msdax", "mysql", "objective-c", "pascal",
  "pascaligo", "perl", "pgsql", "php", "pla", "postiats", "powerquery",
  "powershell", "protobuf", "pug", "python", "qsharp", "r", "razor",
  "redis", "redshift", "restructuredtext", "ruby", "rust", "sb",
  "scala", "scheme", "scss", "shell", "solidity", "sophia", "sparql",
  "sql", "st", "swift", "systemverilog", "tcl", "twig", "typescript",
  "typespec", "vb", "wgsl", "xml", "yaml",
];

function isMonacoOrphan(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? "";
  for (const prefix of MONACO_DROP_PREFIXES) {
    // Match "<prefix>-<hash>.<ext>" — basename must START with the
    // prefix followed by a literal dash (so "css" doesn't match
    // "cssMode" by accident, and "ts.worker" matches exactly).
    if (base.startsWith(`${prefix}-`)) return true;
  }
  return false;
}

const root = resolve(import.meta.dir, "..");
const dist = join(root, "web", "dist");
const out = join(root, "src", "server", "embedded.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Treat these extensions as text for the reachability scan. Anything
 *  else (images, fonts) can't reference other assets, so we don't even
 *  try to readFileSync it as utf8. */
const TEXT_EXTS = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);

function reachableSet(allRelPaths: string[], distRoot: string): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const seed of ALWAYS_KEEP) {
    if (allRelPaths.includes(seed)) {
      reachable.add(seed);
      queue.push(seed);
    }
  }
  // Cache file contents per relpath so we don't read the same chunk N
  // times (each /assets/X is potentially scanned for every candidate Y).
  const textCache = new Map<string, string | null>();
  const textOf = (relPath: string): string | null => {
    if (textCache.has(relPath)) return textCache.get(relPath)!;
    if (!TEXT_EXTS.has(extname(relPath))) {
      textCache.set(relPath, null);
      return null;
    }
    try {
      const abs = join(distRoot, relPath.replace(/^\//, ""));
      const txt = readFileSync(abs, "utf8");
      textCache.set(relPath, txt);
      return txt;
    } catch {
      textCache.set(relPath, null);
      return null;
    }
  };
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const txt = textOf(cur);
    if (txt === null) continue;
    for (const candidate of allRelPaths) {
      if (reachable.has(candidate)) continue;
      // Two-pass match: Vite emits full paths ("/assets/X-Y.js") in
      // index.html but resolves dynamic imports inside chunks to bare
      // basenames ("X-Y.js"). Both forms count as a reference. The
      // basename guard (> 4 chars) avoids the unlikely false match of
      // a chunk literally named e.g. "ok.js" appearing as a substring.
      const basename = candidate.split("/").pop()!;
      const referenced = txt.includes(candidate)
        || (basename.length > 4 && txt.includes(basename));
      if (referenced) {
        reachable.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return reachable;
}

function main() {
  let files: string[];
  try {
    files = walk(dist);
  } catch (_) {
    console.error(`web/dist/ not found. Run \`bun run web:build\` first.`);
    process.exit(1);
  }

  const allRel = files.map((abs) => "/" + relative(dist, abs).split(/[\\/]/).join("/"));
  const reachable = reachableSet(allRel, dist);
  // Second pass: drop Monaco's orphan language chunks. They were
  // "reachable" via dynamic import strings inside Monaco's main chunk
  // (e.g. `import("./abap-...js")`) but our runtime only ever opens
  // markdown buffers, so none of them are actually loaded.
  const keep = new Set<string>();
  for (const r of reachable) {
    if (!isMonacoOrphan(r)) keep.add(r);
  }

  const entries: string[] = [];
  let total = 0;
  let dropped = 0;
  let droppedBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const abs = files[i]!;
    const rel = allRel[i]!;
    const data = readFileSync(abs);
    if (!keep.has(rel)) {
      dropped++;
      droppedBytes += data.length;
      continue;
    }
    total += data.length;
    const mime = MIME[extname(abs)] ?? "application/octet-stream";
    entries.push(
      `  ${JSON.stringify(rel)}: { mime: ${JSON.stringify(mime)}, data: _b64(${JSON.stringify(data.toString("base64"))}) },`,
    );
  }

  const src = [
    `// AUTO-GENERATED by scripts/embed-dist.ts — do not edit by hand.`,
    `// Populated at build time with ${entries.length} files (${total} bytes).`,
    `// Dropped ${dropped} unreachable files (${droppedBytes} bytes).`,
    `export type EmbeddedFile = { mime: string; data: Uint8Array };`,
    `const _b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));`,
    `export const embeddedFiles: Record<string, EmbeddedFile> = {`,
    ...entries,
    `};`,
    ``,
  ].join("\n");

  writeFileSync(out, src);
  console.log(
    `embedded ${entries.length} files (${total} bytes), dropped ${dropped} unreachable (${droppedBytes} bytes) → ${relative(root, out)}`,
  );
}

main();
