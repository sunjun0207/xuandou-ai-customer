import { timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { clearSession, expiresIn, openSession, publicUser, readRefreshSession, readSession, type Session } from "./session";

export async function handleLogin(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const username = text(body.username).slice(0, 64);
  const password = text(body.password);
  if (!username || !password) return sendJson(res, 400, { error: "请填写账号和密码" });
  const remote = await loginFrp(username, password);
  if (remote === "down") {
    const dev = devSession(username, password);
    if (!dev) return sendJson(res, 503, { error: "登录服务暂时不可用" });
    return sendJson(res, 200, { ...openSession(req, res, dev), user: publicUser(dev) });
  }
  if (!remote.session) return sendJson(res, remote.status, { error: remote.error || "登录失败" });
  const { exp: _exp, ...profile } = remote.session;
  sendJson(res, 200, { ...openSession(req, res, profile), user: publicUser(remote.session) });
}

export async function handleLogout(req: IncomingMessage, res: ServerResponse) {
  const session = readSession(req) || readRefreshSession(req);
  clearSession(req, res);
  if (session?.frpToken) await logoutFrp(session.frpToken);
  sendJson(res, 200, { ok: true });
}

export async function handleRefresh(req: IncomingMessage, res: ServerResponse) {
  const session = readRefreshSession(req);
  if (!session) {
    clearSession(req, res);
    return sendJson(res, 401, { error: "登录已过期" });
  }
  const { exp: _exp, ...profile } = session;
  sendJson(res, 200, { ...openSession(req, res, profile), user: publicUser(session) });
}

export async function handleMe(req: IncomingMessage, res: ServerResponse) {
  const session = readSession(req);
  if (!session) return sendJson(res, 401, { error: "未登录" });
  const wantMenus = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("menus") === "1";
  const body = { user: publicUser(session), expiresIn: expiresIn(session) };
  if (!wantMenus) return sendJson(res, 200, body);
  sendJson(res, 200, { ...body, menus: await menusFor(session.frpToken) });
}

async function menusFor(token: string): Promise<unknown[]> {
  if (!token) return [];
  const base = (process.env.FRP_HTTP_URL || "http://127.0.0.1:4080").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { menus?: unknown };
    return Array.isArray(body.menus) ? body.menus : [];
  } catch {
    return [];
  }
}

async function loginFrp(username: string, password: string): Promise<"down" | { status: number; error?: string; session?: Session }> {
  const base = (process.env.FRP_HTTP_URL || "http://127.0.0.1:4080").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { status: res.status === 401 ? 401 : 502, error: res.status === 401 ? "账号或密码不正确" : "登录服务暂时不可用" };
    }
    const body = (await res.json()) as { token?: unknown; user?: { id?: unknown; username?: unknown; displayName?: unknown; roleCode?: unknown } };
    const user = body.user || {};
    const name = text(user.username) || username;
    const session: Session = {
      userId: name,
      accountId: text(user.id),
      username: name,
      displayName: text(user.displayName) || name,
      roleCode: text(user.roleCode),
      frpToken: text(body.token),
      exp: 0,
    };
    return { status: 200, session };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unreachable";
    console.error(`frp login unreachable ${base}: ${reason}`);
    return "down";
  }
}

async function logoutFrp(token: string) {
  const base = (process.env.FRP_HTTP_URL || "http://127.0.0.1:4080").replace(/\/$/, "");
  try {
    await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // 通道不通时本地 cookie 仍然清掉。
  }
}

function devSession(username: string, password: string): Session | undefined {
  if (!devAuthEnabled()) return undefined;
  const expectUser = process.env.DEV_USERNAME || "admin";
  const expectPassword = process.env.DEV_PASSWORD || "admin123";
  if (username !== expectUser || !safeEqual(password, expectPassword)) return undefined;
  return {
    userId: expectUser,
    accountId: "dev",
    username: expectUser,
    displayName: "管理员",
    roleCode: "admin",
    frpToken: "",
    exp: 0,
  };
}

function devAuthEnabled(): boolean {
  if (process.env.DEV_AUTH === "true") return true;
  if (process.env.DEV_AUTH === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function safeEqual(leftText: string, rightText: string): boolean {
  const left = Buffer.from(leftText);
  const right = Buffer.from(rightText);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("body too large");
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

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": raw.length, "Cache-Control": "no-store" });
  res.end(raw);
}
