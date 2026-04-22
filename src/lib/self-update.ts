/**
 * In-process self-upgrade:
 *   1. Check GitHub for the latest release matching this platform.
 *   2. Download the new binary + verify its SHA256 against SHA256SUMS.
 *   3. Preflight (`<new> --version`) so a broken binary can't hard-kill us.
 *   4. Stop in-flight ssh-forward children cleanly (they're not our sub-
 *      process once we exec; orphaned forwards would collide with the new
 *      daemon's ForwardManager).
 *   5. Clear macOS quarantine xattr if present.
 *   6. `mv old → old.bak`, `mv new → old`.
 *   7. execv the same argv — same PID, same stdio, same TTY. User's
 *      frontend detects the instance_id change and reloads.
 *
 * Cross-platform: Linux (x64, arm64) + Darwin (x64, arm64). Windows is
 * not supported by the release pipeline so we bail if asked.
 */

import { existsSync, statSync, createWriteStream, openSync, closeSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync, spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { BOTDOCK_VERSION } from "../version.ts";

export type PlatformAsset =
  | "botdock-linux-x64" | "botdock-linux-arm64"
  | "botdock-darwin-x64" | "botdock-darwin-arm64";

export function currentPlatformAsset(): PlatformAsset {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "linux"  && arch === "x64")    return "botdock-linux-x64";
  if (plat === "linux"  && arch === "arm64")  return "botdock-linux-arm64";
  if (plat === "darwin" && arch === "x64")    return "botdock-darwin-x64";
  if (plat === "darwin" && arch === "arm64")  return "botdock-darwin-arm64";
  throw new Error(`unsupported platform for self-update: ${plat}/${arch}`);
}

const REPO = "camelop/dev.botdock.net";

export type LatestInfo = {
  current: string;
  latest: string;
  tag: string;
  published_at: string;
  newer_available: boolean;
  asset_url: string | null;
  checksums_url: string | null;
  /** Raw release body — markdown, capped at 8 KiB. When the release was
   * published with `generate_release_notes: true` this is an auto-summary
   * of the commits / PRs since the previous tag, which is what the user
   * actually wants to read before clicking Install. */
  notes: string;
};

/**
 * Hit GitHub's /releases/latest endpoint. Unauthenticated — single-user
 * tool, 60/hr/IP is plenty when we only check on button click.
 */
export async function checkLatest(): Promise<LatestInfo> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "Accept": "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text().catch(() => "")}`);
  const body = await r.json() as {
    tag_name?: string;
    published_at?: string;
    body?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const tag = String(body.tag_name ?? "");
  const latest = tag.replace(/^v/, "");
  const asset = currentPlatformAsset();
  const assets = body.assets ?? [];
  const assetUrl = assets.find((a) => a.name === asset)?.browser_download_url ?? null;
  const sumsUrl = assets.find((a) => a.name === "SHA256SUMS")?.browser_download_url ?? null;
  return {
    current: BOTDOCK_VERSION,
    latest,
    tag,
    published_at: body.published_at ?? "",
    newer_available: isNewer(latest, BOTDOCK_VERSION),
    asset_url: assetUrl,
    checksums_url: sumsUrl,
    notes: typeof body.body === "string" ? body.body.slice(0, 8 * 1024) : "",
  };
}

/** Semver-ish compare: "0.4.2" > "0.4.1" etc. Trailing non-numeric suffixes
 *  (like "-rc1") sort before their numeric counterpart, which is the
 *  conventional expectation. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/), pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ax = pa[i] ?? "0", bx = pb[i] ?? "0";
    const an = Number(ax), bn = Number(bx);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an > bn;
    } else {
      if (ax !== bx) return ax > bx;
    }
  }
  return false;
}

// ---- update runner ------------------------------------------------------

export type UpdatePhase =
  | "idle" | "downloading" | "verifying" | "preflight"
  | "stopping-forwards" | "swapping" | "restarting" | "done" | "error";

export type UpdateStatus = {
  phase: UpdatePhase;
  message?: string;
  bytes_downloaded?: number;
  bytes_total?: number;
  target_tag?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
};

let status: UpdateStatus = { phase: "idle" };
let inProgress = false;
export function getUpdateStatus(): UpdateStatus { return status; }

function setStatus(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
}

export type StopForwardsFn = () => Promise<void>;

/**
 * Orchestrate the full update. Throws if another update is in progress.
 * On success, this function does NOT return — it execv's the new binary.
 * The caller should therefore not expect any code after the await to run.
 */
export async function applyUpdate(
  info: LatestInfo,
  opts: { stopForwards: StopForwardsFn },
): Promise<never> {
  if (inProgress) throw new Error("update already in progress");
  inProgress = true;
  status = {
    phase: "downloading",
    target_tag: info.tag,
    started_at: new Date().toISOString(),
    bytes_downloaded: 0,
  };
  try {
    if (!info.asset_url || !info.checksums_url) {
      throw new Error("release is missing a binary or SHA256SUMS for this platform");
    }
    const execPath = process.execPath;
    const newPath = execPath + ".new";
    const bakPath = execPath + ".bak";

    // Download the new binary to <exec>.new, streaming so progress is usable.
    await downloadTo(info.asset_url, newPath, (dl, total) => {
      setStatus({ bytes_downloaded: dl, bytes_total: total });
    });

    setStatus({ phase: "verifying" });
    const sums = await (await fetch(info.checksums_url)).text();
    const expected = sums.split("\n")
      .map((l) => l.trim())
      .find((l) => l.endsWith(currentPlatformAsset()))
      ?.split(/\s+/)[0];
    if (!expected) throw new Error("SHA256SUMS missing our asset entry");
    const actual = await sha256File(newPath);
    if (actual !== expected) {
      throw new Error(`sha256 mismatch: got ${actual}, expected ${expected}`);
    }

    // macOS: clear quarantine so Gatekeeper doesn't kill execv.
    if (process.platform === "darwin") {
      spawnSync("xattr", ["-d", "com.apple.quarantine", newPath], { stdio: "ignore" });
    }
    spawnSync("chmod", ["+x", newPath], { stdio: "ignore" });

    setStatus({ phase: "preflight" });
    // Run the new binary with --version. If it crashes or mismatches we
    // abort before touching anything live.
    const probe = spawnSync(newPath, ["--version"], { timeout: 10_000, encoding: "utf8" });
    if (probe.status !== 0) {
      throw new Error(
        `new binary --version failed (exit ${probe.status}): ${(probe.stderr ?? "").slice(0, 400)}`,
      );
    }
    const probed = (probe.stdout ?? "").trim();
    if (!probed.includes(info.latest)) {
      throw new Error(`probe sanity-check failed: --version printed "${probed}", expected to contain "${info.latest}"`);
    }

    setStatus({ phase: "stopping-forwards" });
    // Drop ssh-forward children before we exec. Their parent PID changes
    // to init otherwise and the new daemon's ForwardManager doesn't know
    // they exist -> duplicate processes.
    await opts.stopForwards();

    setStatus({ phase: "swapping" });
    // Unix rename over the live binary is safe — the running process keeps
    // executing the old inode. Keep the prior binary as .bak so a sudden
    // crash on the new version leaves the user with a manual rollback path.
    try { spawnSync("rm", ["-f", bakPath], { stdio: "ignore" }); } catch {}
    if (existsSync(execPath)) {
      spawnSync("mv", [execPath, bakPath], { stdio: "ignore" });
    }
    const mvRes = spawnSync("mv", [newPath, execPath], { stdio: "ignore" });
    if (mvRes.status !== 0) {
      // Try to restore bak so the daemon isn't gone outright.
      spawnSync("mv", [bakPath, execPath], { stdio: "ignore" });
      throw new Error(`mv ${newPath} ${execPath} failed (exit ${mvRes.status})`);
    }

    setStatus({ phase: "restarting", message: `rolling over to ${info.tag}` });
    // Give anyone polling /api/update/status a moment to see "restarting".
    await new Promise((r) => setTimeout(r, 250));

    // Last act: execv. Same PID, same stdio, same TTY.
    reexec(execPath, process.argv.slice(1));
    // Never reached on success.
  } catch (err) {
    setStatus({
      phase: "error",
      error: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    });
    inProgress = false;
    throw err;
  }
}

async function downloadTo(
  url: string,
  dest: string,
  onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url} → ${r.status}`);
  const total = Number(r.headers.get("content-length") ?? "0") || 0;
  const reader = r.body?.getReader();
  if (!reader) throw new Error("no response body");
  const fd = openSync(dest, "w");
  try {
    let downloaded = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        writeSync(fd, value as Uint8Array);
        downloaded += value.byteLength;
        onProgress(downloaded, total);
      }
    }
    onProgress(downloaded, total);
  } finally {
    closeSync(fd);
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  const file = Bun.file(path);
  const stream = file.stream();
  for await (const chunk of stream) h.update(chunk as Uint8Array);
  return h.digest("hex");
}

// ---- execv via FFI ------------------------------------------------------

/**
 * Load libc's execv. The shared-object name differs by OS, and within an OS
 * the versioned filename is what dlopen actually resolves — plain "libc.so"
 * may or may not exist depending on whether glibc-devel is installed.
 */
function openLibc() {
  const candidates = process.platform === "darwin"
    ? ["libSystem.dylib", "libc.dylib", "/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", "libc.so"];
  let lastErr: unknown = null;
  for (const c of candidates) {
    try {
      return dlopen(c, {
        execv: {
          args: [FFIType.cstring, FFIType.ptr],
          returns: FFIType.i32,
        },
      });
    } catch (e) { lastErr = e; }
  }
  throw new Error(`could not locate libc for execv (tried ${candidates.join(", ")}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function reexec(path: string, argv: string[]): never {
  const lib = openLibc();
  const fullArgv = [path, ...argv];
  // One buffer per argv entry, null-terminated.
  const cstrings = fullArgv.map((s) => Buffer.from(s + "\0", "utf8"));
  // Array of pointer-sized entries + a final NULL. 8 bytes per pointer on
  // every platform we support.
  const ptrSize = 8;
  const arr = Buffer.alloc((fullArgv.length + 1) * ptrSize);
  for (let i = 0; i < fullArgv.length; i++) {
    const p = ptr(cstrings[i]!);
    arr.writeBigUInt64LE(BigInt(p), i * ptrSize);
  }
  arr.writeBigUInt64LE(0n, fullArgv.length * ptrSize);
  const pathBuf = Buffer.from(path + "\0", "utf8");
  // Retain refs so GC can't collect while execv reads them.
  const hold = { cstrings, arr, pathBuf };
  // Bun's FFI bindings accept a typed-array for cstring args (it reads
  // until the first \0) and for raw pointers (it treats as a pointer).
  lib.symbols.execv(pathBuf, ptr(arr));
  // execv only returns on failure.
  void hold;
  throw new Error("execv returned — reexec failed");
}

// Silence unused-imports used only for types.
void dirname; void statSync; void createWriteStream; void spawnChild;
