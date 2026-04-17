import { runInit } from "./commands/init.ts";
import { runKey } from "./commands/key.ts";
import { runMachine } from "./commands/machine.ts";
import { runSecret } from "./commands/secret.ts";
import { runServe } from "./commands/serve.ts";
import { BOTDOCK_VERSION } from "./version.ts";

const USAGE = `botdock — local agent command center

Usage:
  botdock [--home <dir>] <command> [...]

Commands:
  init [dir]                 scaffold a BotDock data directory
  key <cmd> [...]            manage SSH keys
  machine <cmd> [...]        manage machines
  secret <cmd> [...]         manage secrets
  serve [--dev]              run the web API + UI server

Global options:
  --home <dir>               BotDock data directory (default: $BOTDOCK_HOME or cwd)
  -h, --help                 show this message
  -v, --version              print version

Run \`botdock <cmd> --help\` for details on a subcommand.
`;

/**
 * Walk argv ourselves so that unknown flags after the subcommand are passed through
 * verbatim. parseArgs at the top level consumes unknown flags, which breaks per-
 * command flag parsing.
 */
function splitArgs(argv: string[]): { home?: string; help: boolean; version: boolean; cmd?: string; rest: string[] } {
  let home: string | undefined;
  let help = false;
  let version = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") { help = true; i++; continue; }
    if (a === "-v" || a === "--version") { version = true; i++; continue; }
    if (a === "--home") { home = argv[++i]; i++; continue; }
    if (a.startsWith("--home=")) { home = a.slice("--home=".length); i++; continue; }
    break;
  }
  if (i >= argv.length) return { home, help, version, rest: [] };
  const cmd = argv[i]!;
  return { home, help, version, cmd, rest: argv.slice(i + 1) };
}

async function main(argv: string[]): Promise<number> {
  const { home, help, version, cmd, rest } = splitArgs(argv);

  if (version) {
    process.stdout.write(`botdock ${BOTDOCK_VERSION}\n`);
    return 0;
  }

  if (!cmd || help) {
    process.stdout.write(USAGE);
    return cmd ? 0 : (help ? 0 : 2);
  }

  const resolvedHome = home ?? process.env.BOTDOCK_HOME ?? process.cwd();

  switch (cmd) {
    case "init":    return runInit({ home: resolvedHome, args: rest });
    case "key":     return runKey({ home: resolvedHome, args: rest });
    case "machine": return runMachine({ home: resolvedHome, args: rest });
    case "secret":  return runSecret({ home: resolvedHome, args: rest });
    case "serve":   return runServe({ home: resolvedHome, args: rest });
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

try {
  const code = await main(process.argv.slice(2));
  process.exit(code);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
