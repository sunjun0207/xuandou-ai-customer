import type { IncomingMessage, ServerResponse } from "http";
import { sendJson } from "./auth";
import { issueUpload, qiniuConfig, uploadLimit } from "./qiniu";
import { readSession } from "./session";

export async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname !== "/api/upload/config" && pathname !== "/api/upload/token") return false;
  if (!readSession(req)) {
    sendJson(res, 401, { error: "未登录" });
    return true;
  }
  if (pathname === "/api/upload/config" && req.method === "GET") {
    const cfg = qiniuConfig();
    const limit = uploadLimit();
    sendJson(res, 200, { ...limit, ready: Boolean(cfg) });
    return true;
  }
  if (pathname === "/api/upload/token" && req.method === "POST") {
    const body = await readJson(req);
    const fileName = text(body.fileName);
    const mime = text(body.mime);
    const fileSize = typeof body.fileSize === "number" ? body.fileSize : Number.NaN;
    const issued = issueUpload(fileName, mime, fileSize);
    if ("error" in issued) {
      sendJson(res, issued.status, { error: issued.error });
      return true;
    }
    console.log(`qiniu token ${issued.key} ${fileSize}`);
    sendJson(res, 200, issued);
    return true;
  }
  sendJson(res, 405, { error: "不支持的请求" });
  return true;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 64_000) throw new Error("body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
