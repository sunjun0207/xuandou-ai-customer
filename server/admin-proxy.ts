import type { IncomingMessage, ServerResponse } from "http";
import { sendJson } from "./auth";
import { readSession } from "./session";

const PREFIXES = ["/api/projects", "/api/tasks", "/api/problems", "/api/users", "/api/roles", "/api/menus", "/api/conversations"];

export function isAdminApi(pathname: string): boolean {
  return PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function proxyAdmin(req: IncomingMessage, res: ServerResponse) {
  const session = readSession(req);
  if (!session) return sendJson(res, 401, { error: "未登录" });
  if (!session.frpToken) return sendJson(res, 503, { error: "登录服务暂时不可用" });
  const base = (process.env.FRP_HTTP_URL || "http://127.0.0.1:4080").replace(/\/$/, "");
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  try {
    const upstream = await fetch(`${base}${url.pathname}${url.search}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.frpToken}`,
        ...(body && body.length ? { "Content-Type": String(req.headers["content-type"] || "application/json") } : {}),
      },
      body: body && body.length ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const raw = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get("content-type") || "text/plain; charset=utf-8";
    res.writeHead(upstream.status, {
      "Content-Type": type,
      "Content-Length": raw.length,
      "Cache-Control": "no-store",
    });
    res.end(raw);
  } catch {
    sendJson(res, 503, { error: "登录服务暂时不可用" });
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
