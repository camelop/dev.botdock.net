import { parseArgs } from "node:util";
import { DataDir } from "../storage/index.ts";
import { createKey, deleteKey, importKey, listKeys, readKey } from "../domain/keys.ts";

const USAGE = `botdock key — manage SSH keys

Usage:
  botdock key create <nickname> [--comment <text>]
  botdock key import <nickname> <path-to-private-key> [--comment <text>]
  botdock key list
  botdock key show <nickname>
  botdock key delete <nickname> --yes
`;

export async function runKey(opts: { home: string; args: string[] }): Promise<number> {
  const [sub, ...rest] = opts.args;
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return sub ? 0 : 2;
  }
  const dir = new DataDir(opts.home);

  switch (sub) {
    case "create": return cmdCreate(dir, rest);
    case "import": return cmdImport(dir, rest);
    case "list":   return cmdList(dir);
    case "show":   return cmdShow(dir, rest);
    case "delete": return cmdDelete(dir, rest);
    default:
      process.stderr.write(`unknown key subcommand: ${sub}\n\n${USAGE}`);
      return 2;
  }
}

function cmdCreate(dir: DataDir, args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { comment: { type: "string" } },
  });
  const nickname = positionals[0];
  if (!nickname) { process.stderr.write("nickname required\n"); return 2; }
  const comment = (values.comment as string | undefined) ?? `botdock:${nickname}`;
  const meta = createKey(dir, nickname, comment);
  process.stdout.write(`created ${meta.nickname}  ${meta.fingerprint}\n`);
  return 0;
}

function cmdImport(dir: DataDir, args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { comment: { type: "string" } },
  });
  const [nickname, path] = positionals;
  if (!nickname || !path) { process.stderr.write("nickname and path required\n"); return 2; }
  const comment = (values.comment as string | undefined) ?? `botdock:${nickname}`;
  const meta = importKey(dir, nickname, path, comment);
  process.stdout.write(`imported ${meta.nickname}  ${meta.fingerprint}\n`);
  return 0;
}

function cmdList(dir: DataDir): number {
  const keys = listKeys(dir);
  if (keys.length === 0) { process.stdout.write("(no keys)\n"); return 0; }
  for (const k of keys) {
    process.stdout.write(`${k.nickname.padEnd(20)} ${k.fingerprint}  ${k.source}\n`);
  }
  return 0;
}

function cmdShow(dir: DataDir, args: string[]): number {
  const nickname = args[0];
  if (!nickname) { process.stderr.write("nickname required\n"); return 2; }
  const { meta, publicKey } = readKey(dir, nickname);
  process.stdout.write(
    `nickname:    ${meta.nickname}\n` +
    `fingerprint: ${meta.fingerprint}\n` +
    `comment:     ${meta.comment}\n` +
    `source:      ${meta.source}\n` +
    `created_at:  ${meta.created_at}\n` +
    `\n${publicKey}`,
  );
  return 0;
}

function cmdDelete(dir: DataDir, args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: "boolean" } },
  });
  const nickname = positionals[0];
  if (!nickname) { process.stderr.write("nickname required\n"); return 2; }
  if (!values.yes) { process.stderr.write("refusing to delete without --yes\n"); return 2; }
  deleteKey(dir, nickname);
  process.stdout.write(`deleted ${nickname}\n`);
  return 0;
}
