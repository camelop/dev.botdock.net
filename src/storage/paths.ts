import { resolve, relative, join, sep } from "node:path";
import { mkdirSync, statSync } from "node:fs";

export class PathEscapeError extends Error {
  constructor(attempted: string, base: string) {
    super(`path ${attempted} escapes data dir ${base}`);
    this.name = "PathEscapeError";
  }
}

/**
 * Tracks the BotDock data directory and resolves subpaths safely.
 * Any resolved path that escapes the data directory throws PathEscapeError.
 */
export class DataDir {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolve a path relative to the data dir, rejecting escapes. */
  path(...parts: string[]): string {
    const target = resolve(this.root, ...parts);
    const rel = relative(this.root, target);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
      throw new PathEscapeError(target, this.root);
    }
    return target;
  }

  exists(): boolean {
    try {
      return statSync(this.root).isDirectory();
    } catch {
      return false;
    }
  }

  /** Create a subdirectory (recursive, ok if exists). */
  ensureDir(...parts: string[]): string {
    const p = this.path(...parts);
    mkdirSync(p, { recursive: true });
    return p;
  }

  // Convenience accessors mirroring the layout in design/overview.md.
  configFile(): string { return this.path("config.toml"); }
  keysDir(): string { return this.path("private", "keys"); }
  secretsDir(): string { return this.path("private", "secrets"); }
  machinesDir(): string { return this.path("machines"); }
  resourcesDir(): string { return this.path("resources"); }
  sessionsDir(): string { return this.path("sessions"); }

  keyDir(nickname: string): string {
    assertSafeName(nickname, "key nickname");
    return join(this.keysDir(), nickname);
  }
  secretDir(name: string): string {
    assertSafeName(name, "secret name");
    return join(this.secretsDir(), name);
  }
  machineFile(name: string): string {
    assertSafeName(name, "machine name");
    return join(this.machinesDir(), `${name}.toml`);
  }
}

/** Names are used as path segments; enforce a strict charset. */
export function assertSafeName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      `invalid ${label}: ${JSON.stringify(name)} — must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`,
    );
  }
}
