import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DataDir, assertSafeName, readToml, writeToml } from "../storage/index.ts";
import { existsSync as machineExists } from "node:fs";

export type ForwardDirection = "local" | "remote" | "dynamic";

/**
 * Port forward definition.
 *
 *   direction = local   → ssh -L local_port:remote_host:remote_port
 *                         Connect locally on local_port, traffic ends up at
 *                         remote_host:remote_port reached from the remote box.
 *
 *   direction = remote  → ssh -R remote_port:local_host:local_port
 *                         Port on the remote box tunnels back to a local
 *                         address. Used for reverse callbacks.
 *
 *   direction = dynamic → ssh -D local_port
 *                         SOCKS proxy; clients using this proxy reach the
 *                         remote box's network.
 */
export type Forward = {
  name: string;
  machine: string;
  direction: ForwardDirection;
  local_port: number;
  remote_host?: string;   // local / remote only
  remote_port?: number;   // local / remote only
  local_host?: string;    // remote only; defaults to "localhost"
  auto_start?: boolean;
  description?: string;
};

function forwardsDir(dir: DataDir): string {
  return dir.path("forwards");
}

function forwardFile(dir: DataDir, name: string): string {
  assertSafeName(name, "forward name");
  return join(forwardsDir(dir), `${name}.toml`);
}

export function listForwards(dir: DataDir): Forward[] {
  const root = forwardsDir(dir);
  if (!existsSync(root)) return [];
  const out: Forward[] = [];
  for (const f of readdirSync(root)) {
    if (!f.endsWith(".toml")) continue;
    const name = f.slice(0, -5);
    try { assertSafeName(name, "forward name"); } catch { continue; }
    out.push(readToml<Forward>(join(root, f)));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function forwardExists(dir: DataDir, name: string): boolean {
  try { return existsSync(forwardFile(dir, name)); } catch { return false; }
}

export function readForward(dir: DataDir, name: string): Forward {
  const path = forwardFile(dir, name);
  if (!existsSync(path)) throw new Error(`forward not found: ${name}`);
  return readToml<Forward>(path);
}

/**
 * Validate + persist. Throws on bad input so handlers can surface a clear
 * 400 instead of writing garbage to disk.
 */
export function writeForward(dir: DataDir, f: Forward): void {
  assertSafeName(f.name, "forward name");
  if (!f.machine) throw new Error("machine required");
  if (!machineExists(dir.machineFile(f.machine))) {
    throw new Error(`referenced machine not found: ${f.machine}`);
  }
  if (!Number.isInteger(f.local_port) || f.local_port <= 0 || f.local_port > 65535) {
    throw new Error("local_port must be an integer in [1, 65535]");
  }
  if (f.direction === "local" || f.direction === "remote") {
    if (!f.remote_host) throw new Error("remote_host required for local/remote direction");
    if (!Number.isInteger(f.remote_port) || f.remote_port! <= 0 || f.remote_port! > 65535) {
      throw new Error("remote_port must be an integer in [1, 65535]");
    }
  }

  const data: Record<string, unknown> = {
    name: f.name,
    machine: f.machine,
    direction: f.direction,
    local_port: f.local_port,
  };
  if (f.remote_host) data.remote_host = f.remote_host;
  if (f.remote_port !== undefined) data.remote_port = f.remote_port;
  if (f.local_host) data.local_host = f.local_host;
  if (f.auto_start !== undefined) data.auto_start = f.auto_start;
  if (f.description) data.description = f.description;

  dir.ensureDir("forwards");
  writeToml(forwardFile(dir, f.name), data);
}

export function deleteForward(dir: DataDir, name: string): void {
  const path = forwardFile(dir, name);
  if (!existsSync(path)) throw new Error(`forward not found: ${name}`);
  rmSync(path);
}

/**
 * Human-readable one-liner describing the tunnel shape. Used by the UI.
 */
export function describeForward(f: Forward): string {
  switch (f.direction) {
    case "local":
      return `localhost:${f.local_port} → ${f.remote_host}:${f.remote_port} via ${f.machine}`;
    case "remote":
      return `${f.machine}:${f.local_port} → ${f.local_host ?? "localhost"}:${f.remote_port}`;
    case "dynamic":
      return `SOCKS5 localhost:${f.local_port} via ${f.machine}`;
  }
}
