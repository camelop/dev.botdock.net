/**
 * Generic reverse proxy to a localhost upstream (HTTP + WebSocket).
 *
 * Used to surface per-machine ttyd UIs under the BotDock web server's own
 * port, so a browser talking to the daemon (possibly via ssh port-forward
 * to the daemon's 4717) can reach tunnels bound on the daemon host's
 * localhost without the browser ever needing direct access to those ports.
 */

import type { Server } from "bun";
type BunServer = Server<unknown>;

/** Forward an HTTP request to localhost:<port> and stream the response back. */
export async function proxyHttp(
  req: Request,
  port: number,
  upstreamPath: string,
): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://127.0.0.1:${port}${upstreamPath}${url.search}`;

  // Copy headers except the ones Bun rejects / that make no sense to
  // forward. Also strip `accept-encoding` so the upstream doesn't
  // compress — Bun's fetch would transparently decode on return,
  // creating a mismatch with the (preserved) content-encoding header.
  // Much easier to just not compress in the first place.
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "upgrade") continue;
    if (lk === "accept-encoding") continue;
    headers.set(k, v);
  }
  headers.set("x-forwarded-for", req.headers.get("x-forwarded-for") ?? "127.0.0.1");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const init: RequestInit & { duplex?: string } = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body ?? undefined;
    init.duplex = "half"; // Bun-specific; ignored by stricter typings
  }

  try {
    const upstream = await fetch(target, init);
    // Copy response headers, strip hop-by-hop ones AND anything that would
    // be wrong once Bun's fetch has already consumed/decoded the body:
    //   - content-encoding: fetch() auto-decompresses gzip/deflate/br and
    //     returns a plain-text stream. Keeping the header lies to the
    //     browser, which then tries to decode plain text and fails with
    //     ERR_CONTENT_DECODING_FAILED.
    //   - content-length: the decoded body length doesn't match the
    //     original header. Drop it; Bun will re-chunk on the way out.
    const outHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (lk === "transfer-encoding" || lk === "connection") continue;
      if (lk === "content-encoding" || lk === "content-length") continue;
      // Allow iframe embedding — we need to host ttyd inside our own UI.
      if (lk === "x-frame-options") continue;
      if (lk === "content-security-policy") {
        // Drop frame-ancestors clauses so the CSP doesn't block embedding.
        const stripped = v
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d && !d.toLowerCase().startsWith("frame-ancestors"))
          .join("; ");
        if (stripped) outHeaders.set(k, stripped);
        continue;
      }
      outHeaders.set(k, v);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    return new Response(
      `Proxy error: upstream 127.0.0.1:${port} unreachable. ` +
      `${err instanceof Error ? err.message : String(err)}`,
      { status: 502, headers: { "content-type": "text/plain" } },
    );
  }
}

/**
 * Upgrade an incoming WebSocket and proxy it to `ws://127.0.0.1:<port><path>`.
 * Each pair of sockets is wired bidirectionally; either side closing tears
 * the other down.
 */
export type WsProxyData = {
  kind: "proxy";
  upstream?: WebSocket;
  upstreamReady: boolean;
  pending: Array<string | ArrayBuffer>;
  upstreamUrl: string;
  /** Comma-separated list of subprotocols the client asked for, kept so we
   * can hand the same list to the upstream WebSocket. ttyd specifically
   * requires "tty" — if we don't echo it the terminal silently stays
   * empty because the client's JS aborts the session after the handshake. */
  subprotocols: string[];
};

export function tryUpgradeWsProxy(
  srv: BunServer,
  req: Request,
  port: number,
  upstreamPath: string,
): Response | null {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;

  const url = new URL(req.url);
  const upstreamUrl = `ws://127.0.0.1:${port}${upstreamPath}${url.search}`;

  // Preserve the client's requested WS subprotocol(s) end-to-end.
  // - Echo the first one back in the upgrade response so the browser
  //   doesn't abort the session.
  // - Stash the whole list so we can hand the same list to the upstream
  //   WebSocket constructor.
  const rawProto = req.headers.get("sec-websocket-protocol") ?? "";
  const subprotocols = rawProto
    ? rawProto.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const data: WsProxyData = {
    kind: "proxy",
    upstreamReady: false,
    pending: [],
    upstreamUrl,
    subprotocols,
  };
  const upgradeOpts: { data: WsProxyData; headers?: Record<string, string> } = { data };
  if (subprotocols.length > 0) {
    upgradeOpts.headers = { "Sec-WebSocket-Protocol": subprotocols[0]! };
  }
  if (srv.upgrade(req, upgradeOpts)) return new Response(null);
  return new Response("websocket upgrade failed", { status: 400 });
}

/**
 * Wire the client↔upstream data pump for a proxied WS. Call from the
 * Bun.serve websocket.open handler when ws.data.kind === "proxy".
 */
export function openProxyWs(ws: {
  send: (msg: string | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  data: WsProxyData;
}): void {
  // Forward the same subprotocol list to the upstream — ttyd picks "tty"
  // and will reject the connection if the browser's list doesn't include
  // one it can honor.
  const upstream = ws.data.subprotocols.length > 0
    ? new WebSocket(ws.data.upstreamUrl, ws.data.subprotocols)
    : new WebSocket(ws.data.upstreamUrl);
  ws.data.upstream = upstream;
  upstream.binaryType = "arraybuffer";

  upstream.addEventListener("open", () => {
    ws.data.upstreamReady = true;
    // Flush anything that arrived from the client while we were still
    // establishing the upstream connection.
    for (const msg of ws.data.pending) upstream.send(msg);
    ws.data.pending = [];
  });
  upstream.addEventListener("message", (ev) => {
    const d = ev.data;
    if (typeof d === "string") {
      ws.send(d);
    } else if (d instanceof ArrayBuffer) {
      ws.send(d);
    } else if (ArrayBuffer.isView(d)) {
      // Copy into a fresh ArrayBuffer so the typing matches what our send
      // signature accepts (avoids SharedArrayBuffer-typed views).
      const view = d as ArrayBufferView;
      const ab = new ArrayBuffer(view.byteLength);
      new Uint8Array(ab).set(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
      ws.send(ab);
    }
  });
  upstream.addEventListener("close", (ev) => {
    try { ws.close(ev.code, ev.reason); } catch {}
  });
  upstream.addEventListener("error", () => {
    try { ws.close(1011, "upstream error"); } catch {}
  });
}

/**
 * Relay a client message into the upstream (or buffer it until upstream
 * is ready). Call from Bun.serve websocket.message when kind === "proxy".
 */
export function relayProxyWsMessage(
  data: WsProxyData,
  msg: string | Buffer | ArrayBuffer | Uint8Array,
): void {
  let payload: string | ArrayBuffer;
  if (typeof msg === "string") payload = msg;
  else if (msg instanceof ArrayBuffer) payload = msg;
  else {
    const ab = new ArrayBuffer(msg.byteLength);
    new Uint8Array(ab).set(new Uint8Array(msg.buffer as ArrayBuffer, msg.byteOffset, msg.byteLength));
    payload = ab;
  }
  if (data.upstream && data.upstreamReady) {
    data.upstream.send(payload);
  } else {
    data.pending.push(payload);
  }
}

export function closeProxyWs(data: WsProxyData, code?: number, reason?: string): void {
  try { data.upstream?.close(code, reason); } catch {}
}
