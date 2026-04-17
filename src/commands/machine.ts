import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DataDir } from "../storage/index.ts";
import { deleteMachine, listMachines, readMachine, writeMachine } from "../domain/machines.ts";
import type { Machine } from "../domain/machines.ts";
import { buildSshConfig } from "../lib/sshconfig.ts";
import { run } from "../lib/ssh.ts";

const USAGE = `botdock machine — manage machines

Usage:
  botdock machine add <name> --host H --user U --key K [--port N] [--tag T ...] [--notes T]
  botdock machine list
  botdock machine show <name>
  botdock machine edit <name>            open the TOML in $EDITOR (for jump chains, notes)
  botdock machine test <name>            run \`echo botdock-ok\` through the full jump chain
  botdock machine remove <name> --yes
`;

export async function runMachine(opts: { home: string; args: string[] }): Promise<number> {
  const [sub, ...rest] = opts.args;
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return sub ? 0 : 2;
  }
  const dir = new DataDir(opts.home);

  switch (sub) {
    case "add":    return cmdAdd(dir, rest);
    case "list":   return cmdList(dir);
    case "show":   return cmdShow(dir, rest);
    case "edit":   return cmdEdit(dir, rest);
    case "test":   return cmdTest(dir, rest);
    case "remove": return cmdRemove(dir, rest);
    default:
      process.stderr.write(`unknown machine subcommand: ${sub}\n\n${USAGE}`);
      return 2;
  }
}

function cmdAdd(dir: DataDir, args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      host:  { type: "string" },
      user:  { type: "string" },
      port:  { type: "string" },
      key:   { type: "string" },
      tag:   { type: "string", multiple: true },
      notes: { type: "string" },
    },
  });
  const name = positionals[0];
  if (!name) { process.stderr.write("name required\n"); return 2; }
  const host = values.host as string | undefined;
  const user = values.user as string | undefined;
  const key = values.key as string | undefined;
  if (!host || !user || !key) {
    process.stderr.write("--host, --user, --key are required\n");
    return 2;
  }
  const machine: Machine = {
    name,
    host,
    user,
    key,
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.tag ? { tags: values.tag as string[] } : {}),
    ...(values.notes ? { notes: values.notes as string } : {}),
  };
  if (existsSync(dir.machineFile(name))) {
    process.stderr.write(`machine already exists: ${name}\n`);
    return 1;
  }
  writeMachine(dir, machine);
  process.stdout.write(`added ${name}\n`);
  return 0;
}

function cmdList(dir: DataDir): number {
  const ms = listMachines(dir);
  if (ms.length === 0) { process.stdout.write("(no machines)\n"); return 0; }
  for (const m of ms) {
    const jumps = m.jump?.length ? `  via ${m.jump.length} hop(s)` : "";
    process.stdout.write(`${m.name.padEnd(20)} ${m.user}@${m.host}:${m.port ?? 22}  key=${m.key}${jumps}\n`);
  }
  return 0;
}

function cmdShow(dir: DataDir, args: string[]): number {
  const name = args[0];
  if (!name) { process.stderr.write("name required\n"); return 2; }
  const m = readMachine(dir, name);
  process.stdout.write(JSON.stringify(m, null, 2) + "\n");
  return 0;
}

function cmdEdit(dir: DataDir, args: string[]): number {
  const name = args[0];
  if (!name) { process.stderr.write("name required\n"); return 2; }
  const path = dir.machineFile(name);
  if (!existsSync(path)) { process.stderr.write(`machine not found: ${name}\n`); return 1; }
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const r = spawnSync(editor, [path], { stdio: "inherit" });
  if (r.status !== 0) return r.status ?? 1;
  // Re-read to validate after edit.
  const m = readMachine(dir, name);
  writeMachine(dir, m);
  return 0;
}

function cmdTest(dir: DataDir, args: string[]): number {
  const name = args[0];
  if (!name) { process.stderr.write("name required\n"); return 2; }
  const m = readMachine(dir, name);
  const cfg = buildSshConfig(dir, m);
  try {
    const r = run("ssh", ["-F", cfg.configPath, cfg.targetAlias, "echo", "botdock-ok"]);
    if (r.code === 0 && r.stdout.trim() === "botdock-ok") {
      const hops = m.jump?.length ?? 0;
      process.stdout.write(`ok: ${name} reachable (${hops} hop${hops === 1 ? "" : "s"})\n`);
      return 0;
    }
    process.stderr.write(
      `FAIL: ssh exit ${r.code}\n` +
      (r.stderr ? `stderr:\n${r.stderr}` : "") +
      (r.stdout && r.stdout.trim() !== "botdock-ok" ? `stdout:\n${r.stdout}` : ""),
    );
    return 1;
  } finally {
    cfg.dispose();
  }
}

function cmdRemove(dir: DataDir, args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: "boolean" } },
  });
  const name = positionals[0];
  if (!name) { process.stderr.write("name required\n"); return 2; }
  if (!values.yes) { process.stderr.write("refusing to delete without --yes\n"); return 2; }
  deleteMachine(dir, name);
  process.stdout.write(`removed ${name}\n`);
  return 0;
}
