/**
 * Bundle everything another BotDock instance (or another operator) needs
 * to attach to this session into a single .zip. The intent is multi-user
 * / multi-machine collaboration on the same tmux — the recipient imports
 * the zip, their BotDock registers the same machine + key + session,
 * and both sides can then drive the same remote ttyd.
 *
 * What the zip contains (mirrors the data dir layout so import = extract):
 *
 *   machines/<machine>.toml          — machine record; for local, host is
 *                                      swapped for a reachable address
 *   private/keys/<key>/              — full key dir (private, public, meta)
 *   sessions/<id>/                   — full session dir MINUS notes.md
 *                                      (the scratchpad is owner-personal)
 *   export_metadata.toml             — exported_at, exporter, bd version
 *
 * What we do NOT support yet (v1):
 *   - Sessions whose machine uses a jump-host chain. The jump-hop keys
 *     and records would need to ship too; skipped until someone asks.
 *
 * Security: the zip contains a **private SSH key**. This is by design —
 * the whole point is that the recipient can SSH to the shared machine.
 * The frontend's export flow forces the user to tick three ack boxes
 * making this explicit.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DataDir, readToml } from "../storage/index.ts";
import { readMachine, type Machine } from "./machines.ts";
import { readSession } from "./sessions.ts";
import { writeZip, type ZipEntry } from "../lib/zip-write.ts";
import { BOTDOCK_VERSION } from "../version.ts";
import { userInfo } from "node:os";

const NOTES_FILENAME = "notes.md";

export type ExportResult = {
  filename: string;
  bytes: Buffer;
};

/**
 * Build a zip for the given session. `reachableHost` is required and
 * ONLY used when the session's machine is the managed `local` loopback
 * — there we swap 127.0.0.1 for whatever the exporter entered so the
 * recipient can actually route to it. For non-local sessions the
 * parameter is ignored (the machine record already has a real host).
 */
export function exportSession(
  dir: DataDir,
  sessionId: string,
  reachableHost: string | undefined,
): ExportResult {
  const session = readSession(dir, sessionId);
  const machine = readMachine(dir, session.machine);

  if (machine.jump && machine.jump.length > 0) {
    throw new Error(
      "export of sessions on jump-host machines isn't supported yet — "
      + "the zip would need to include every hop's machine + key, and the "
      + "conflict-detection story for multi-hop imports hasn't been built.",
    );
  }

  const isLocal = machine.managed === "local" || machine.name === "local";
  if (isLocal && (!reachableHost || !reachableHost.trim())) {
    throw new Error(
      "a reachable hostname/IP is required when exporting a local-machine "
      + "session — the recipient has no route to 127.0.0.1 on your host",
    );
  }

  // Filename per the spec: `<session_id>_on_<machine>.zip`. For local
  // sessions the machine name is useless ("local" doesn't say whose);
  // rewrite to `<username>_local` so the recipient can tell exports
  // from different hosts apart in their Downloads folder.
  const machineLabel = isLocal ? `${safeSegment(userInfo().username)}_local` : safeSegment(machine.name);
  const filename = `${safeSegment(session.id)}_on_${machineLabel}.zip`;

  const entries: ZipEntry[] = [];

  // --- machine record -----------------------------------------------------
  // For local-machine exports, we need the rewritten record (not the
  // on-disk one) because the on-disk one has host=127.0.0.1 + managed=local
  // + disabled flags that make no sense on the other side. Build a fresh
  // plain-machine record instead.
  if (isLocal) {
    const rewrittenName = `shared_${safeSegment(userInfo().username)}_local`;
    const rewritten: Machine = {
      name: rewrittenName,
      host: reachableHost!.trim(),
      user: machine.user,
      port: machine.port ?? 22,
      key: machine.key,
      tags: machine.tags ? [...machine.tags] : undefined,
      notes:
        "Imported from a BotDock local-machine session. Host swapped from "
        + "127.0.0.1 at export time; adjust if the routing details were "
        + "wrong.",
    };
    entries.push({
      path: `machines/${rewrittenName}.toml`,
      data: stringifyMachine(rewritten),
    });
    // Also rewrite the session's `machine` reference to the new name.
    const sessionRewritten = { ...session, machine: rewrittenName };
    entries.push(...sessionDirEntries(dir, sessionId, sessionRewritten));
  } else {
    const machineTomlPath = dir.machineFile(machine.name);
    entries.push({
      path: `machines/${machine.name}.toml`,
      data: readFileSync(machineTomlPath),
    });
    entries.push(...sessionDirEntries(dir, sessionId));
  }

  // --- key dir ------------------------------------------------------------
  const keyDir = dir.keyDir(machine.key);
  for (const rel of walkRelFiles(keyDir)) {
    entries.push({
      path: `private/keys/${machine.key}/${rel}`,
      data: readFileSync(join(keyDir, rel)),
      // Match on-disk perms: `key` is 600, everything else 644.
      mode: rel === "key" ? 0o600 : 0o644,
    });
  }

  // --- export metadata ----------------------------------------------------
  const meta = {
    format_version: 1,
    session_id: session.id,
    source_machine_name: machine.name,
    target_machine_name: isLocal ? `shared_${safeSegment(userInfo().username)}_local` : machine.name,
    exported_at: new Date().toISOString(),
    exported_by: userInfo().username,
    botdock_version: BOTDOCK_VERSION,
    local_reachable_host: isLocal ? reachableHost : undefined,
  };
  entries.push({
    path: "export_metadata.toml",
    data: stringifyMetadata(meta),
  });

  const bytes = writeZip(entries);
  return { filename, bytes };
}

function sessionDirEntries(
  dir: DataDir,
  sessionId: string,
  overrideSessionMeta?: Record<string, unknown>,
): ZipEntry[] {
  const sessionDir = join(dir.sessionsDir(), sessionId);
  if (!existsSync(sessionDir)) {
    throw new Error(`session dir missing on disk: ${sessionDir}`);
  }
  const out: ZipEntry[] = [];
  for (const rel of walkRelFiles(sessionDir)) {
    // Skip notes.md — the scratchpad is personal to the exporter. Anything
    // else we ship (meta, events, raw.log, transcript.jsonl mirror, etc.)
    if (rel === NOTES_FILENAME) continue;
    if (rel === "meta.toml" && overrideSessionMeta) {
      // Rewrite the session's machine reference to match the rewritten
      // machine name on the import side.
      out.push({
        path: `sessions/${sessionId}/meta.toml`,
        data: stringifyMetadata(overrideSessionMeta),
      });
      continue;
    }
    out.push({
      path: `sessions/${sessionId}/${rel}`,
      data: readFileSync(join(sessionDir, rel)),
    });
  }
  return out;
}

function walkRelFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) out.push(relative(root, p).split("\\").join("/"));
    }
  }
  out.sort();
  return out;
}

/** Conservative sanitisation for filename segments so the downloaded name
 *  can't contain path separators or surprising unicode. Safe-names are
 *  [a-zA-Z0-9._-]; anything else is collapsed to underscore. */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
}

/** Tiny TOML emitter — we only need string/number/bool/array-of-string
 *  for the fields we export, so not worth pulling the full @iarna/toml
 *  dependency through for a write. Keep it matching readToml's shape. */
function stringifyMetadata(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k} = ${formatToml(v)}`);
  }
  return lines.join("\n") + "\n";
}

function stringifyMachine(m: Machine): string {
  const lines: string[] = [];
  lines.push(`name = ${formatToml(m.name)}`);
  lines.push(`host = ${formatToml(m.host)}`);
  lines.push(`user = ${formatToml(m.user)}`);
  lines.push(`port = ${formatToml(m.port ?? 22)}`);
  lines.push(`key = ${formatToml(m.key)}`);
  if (m.tags && m.tags.length) lines.push(`tags = ${formatToml(m.tags)}`);
  if (m.notes) lines.push(`notes = ${formatToml(m.notes)}`);
  return lines.join("\n") + "\n";
}

function formatToml(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v); // TOML strings are JSON-compatible for BMP chars
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map(formatToml).join(", ")}]`;
  return JSON.stringify(String(v));
}

// Re-exported readToml just to keep the import surface tight in handlers.
export { readToml };
