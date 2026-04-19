import { createServer } from "node:net";

/**
 * Find a free TCP port on 127.0.0.1 in the given range. We bind and
 * immediately release — the returned port is then immediately reusable.
 * (There's a tiny race with any process that binds between our release
 * and the caller's use; not an issue in practice for our scale.)
 */
export function findFreeLocalPort(start = 47000, end = 47999): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen({ port: p, host: "127.0.0.1" }, () => {
        s.close(() => resolve(true));
      });
    });
  return (async () => {
    for (let p = start; p <= end; p++) {
      if (await tryPort(p)) return p;
    }
    throw new Error(`no free local port in [${start}, ${end}]`);
  })();
}
