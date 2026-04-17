import { existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { DataDir, writeToml } from "../storage/index.ts";

const DEFAULT_CONFIG: Record<string, unknown> = {
  server: {
    bind: "127.0.0.1",
    port: 4717,
  },
  auth: {
    // v1 single-user; token is optional. Left empty by default.
    bearer_token: "",
  },
};

export async function runInit(opts: { home: string; args: string[] }): Promise<number> {
  const target = opts.args[0] ? resolve(opts.args[0]) : resolve(opts.home);
  const dir = new DataDir(target);

  dir.ensureDir();
  dir.ensureDir("private");
  chmodSync(dir.path("private"), 0o700);
  dir.ensureDir("private", "keys");
  dir.ensureDir("private", "secrets");
  dir.ensureDir("machines");
  dir.ensureDir("resources", "git-repo");
  dir.ensureDir("resources", "markdown");
  dir.ensureDir("resources", "file-bundle");
  dir.ensureDir("sessions");

  const cfg = dir.configFile();
  if (existsSync(cfg)) {
    process.stdout.write(`BotDock data dir already initialized at ${dir.root}\n`);
  } else {
    writeToml(cfg, DEFAULT_CONFIG);
    process.stdout.write(`Initialized BotDock data dir at ${dir.root}\n`);
  }
  return 0;
}
