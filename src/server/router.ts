export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type Ctx = {
  req: Request;
  params: Record<string, string>;
  url: URL;
};

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

type Route = {
  method: Method;
  segments: Array<{ literal: string } | { param: string }>;
  handler: Handler;
};

export class Router {
  private routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler): void {
    const segments = pattern.split("/").filter(Boolean).map((s) =>
      s.startsWith(":") ? { param: s.slice(1) } : { literal: s },
    );
    this.routes.push({ method, segments, handler });
  }

  get(p: string, h: Handler) { this.add("GET", p, h); }
  post(p: string, h: Handler) { this.add("POST", p, h); }
  put(p: string, h: Handler) { this.add("PUT", p, h); }
  delete(p: string, h: Handler) { this.add("DELETE", p, h); }

  match(req: Request): { handler: Handler; params: Record<string, string>; url: URL } | undefined {
    const url = new URL(req.url);
    const segs = url.pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      if (r.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.segments.length; i++) {
        const rs = r.segments[i]!;
        const ps = segs[i]!;
        if ("literal" in rs) {
          if (rs.literal !== ps) { ok = false; break; }
        } else {
          params[rs.param] = decodeURIComponent(ps);
        }
      }
      if (ok) return { handler: r.handler, params, url };
    }
    return undefined;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export async function parseJsonBody<T = unknown>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
