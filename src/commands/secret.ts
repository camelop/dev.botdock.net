import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { DataDir } from "../storage/index.ts";
import { deleteSecret, listSecrets, readSecretMeta, readSecretValue, writeSecret } from "../domain/secrets.ts";

const USAGE = `botdock secret — manage secrets

Usage:
  botdock secret set <name> [--from-file <path>] [--description <text>]
                            reads value from stdin unless --from-file given
  botdock secret list
  botdock secret show <name> [--value]    meta-only by default; --value prints bytes
  botdock secret remove <name> --yes
`;

export async function runSecret(opts: { home: string; args: string[] }): Promise<number> {
  const [sub, ...rest] = opts.args;
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return sub ? 0 : 2;
  }
  const dir = new DataDir(opts.home);
  switch (sub) {
    case "set":    return cmdSet(dir, rest);
    case "list":   return cmdList(dir);
    case "show":   return cmdShow(dir, rest);
    case "remove": return cmdRemove(dir, rest);
    default:
      process.stderr.write(`unknown secret subcommand: ${sub}\n\n${USAGE}`);
      return 2;
  }
}

async function cmdSet(dir: DataDir, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "from-file": { type: "string" },
      description: { type: "string" },
    },
  });
  const name = positionals[0];
  if (!name) { process.stderr.write("name required\n"); return 2; }
  let value: Buffer;
  const fromFile = values["from-file"] as string | undefined;
  if (fromFile) {
    value = readFileSync(fromFile);
  } else {
    if (process.stdin.isTTY) {
      process.stderr.write("reading value from stdin (ctrl-d to end)…\n");
    }
    value = await readAllStdin();
  }
  const meta = writeSecret(dir, name, value, (values.description as string | undefined) ?? "");
  process.stdout.write(`saved ${meta.name} (${meta.byte_length} bytes)\n`);
  return 0;
}

function cmdList(dir: DataDir): number {
  const ss = listSecrets(dir);
  if (ss.length === 0) { process.stdout.write("(no secrets)\n"); return 0; }
  for (const s of ss) {
    process.stdout.write(`${s.name.padEnd(24)} ${s.byte_length}B  updated=${s.updated_at}\n`);
  }
  return 0;
}

function cmdShow(dir: DataDir, args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { value: { type: "boolean" } },
  });
  const name = positionals[0];
  if (!name) { process.stderr.write("name required\n"); return 2; }
  const meta = readSecretMeta(dir, name);
  process.stdout.write(
    `name:         ${meta.name}\n` +
    `bytes:        ${meta.byte_length}\n` +
    `description:  ${meta.description}\n` +
    `created_at:   ${meta.created_at}\n` +
    `updated_at:   ${meta.updated_at}\n`,
  );
  if (values.value) {
    if (process.stdout.isTTY) {
      process.stderr.write("\n-- value (sensitive) --\n");
    }
    process.stdout.write(readSecretValue(dir, name));
    if (process.stdout.isTTY) process.stderr.write("\n");
  }
  return 0;
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
  deleteSecret(dir, name);
  process.stdout.write(`removed ${name}\n`);
  return 0;
}

async function readAllStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
