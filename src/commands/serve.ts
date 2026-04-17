import { parseArgs } from "node:util";
import { startServer } from "../server/server.ts";

export async function runServe(opts: { home: string; args: string[] }): Promise<number> {
  const { values } = parseArgs({
    args: opts.args,
    allowPositionals: true,
    options: {
      dev: { type: "boolean" },
    },
  });
  const server = startServer({ home: opts.home, dev: !!values.dev });
  process.stdout.write(
    `BotDock serving at http://${server.hostname}:${server.port}\n` +
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
