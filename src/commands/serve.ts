import { parseArgs } from "node:util";
import { startServer } from "../server/server.ts";
import { BOTDOCK_VERSION } from "../version.ts";

export async function runServe(opts: { home: string; args: string[] }): Promise<number> {
  const { values } = parseArgs({
    args: opts.args,
    allowPositionals: true,
    options: {
      dev: { type: "boolean" },
    },
  });
  const server = startServer({ home: opts.home, dev: !!values.dev });
  // Version on the first line so in-place self-upgrades are obvious — the
  // same terminal session will print a fresh banner with a new version tag
  // instead of repeating an identical three-line block.
  process.stdout.write(
    `BotDock (v${BOTDOCK_VERSION}) serving at http://${server.hostname}:${server.port}\n` +
    `  data dir: ${opts.home}\n` +
    (values.dev ? `  mode: dev (frontend on Vite, e.g. http://localhost:5173)\n` : `  mode: production\n`),
  );
  // Keep process alive; server is long-running.
  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      process.stdout.write("\nshutting down\n");
      server.stop(true);
      resolve(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
