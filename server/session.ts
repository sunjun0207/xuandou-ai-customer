import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

export type Session = {
  userId: string;
  accountId: string;
  username: string;
  displayName: string;
  roleCode: string;
  frpToken: string;
  exp: number;
};

const COOKIE = "xd_customer";
const TTL = 7 * 24 * 3600;
const revoked = new Set<string>();

export function readSession(req: IncomingMessage): Session | undefined {
  const token = cookieValue(req.headers.cookie, COOKIE);
  if (!token) return undefined;
  const session = verify(token);
  if (!session || session.exp * 1000 <= Date.now()) return undefined;
  return session;
}

export function writeSession(req: IncomingMessage, res: ServerResponse, session: Session) {
  const token = sign(session);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TTL}${secureAttribute(req)}`);
}

export function clearSession(req: IncomingMessage, res: ServerResponse) {
  const token = cookieValue(req.headers.cookie, COOKIE);
  const index = token.lastIndexOf(".");
  if (index > 0) revoked.add(token.slice(index + 1));
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttribute(req)}`);
}

function secureAttribute(req: IncomingMessage): string {
  if (process.env.COOKIE_SECURE === "false") return "";
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwarded === "http") return "";
  const https = forwarded === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
  return https ? "; Secure" : "";
}

export function publicUser(session: Session) {
  return {
    userId: session.userId,
    accountId: session.accountId,
    username: session.username,
    displayName: session.displayName,
    roleCode: session.roleCode,
  };
}

function sign(session: Session): string {
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token: string): Session | undefined {
  const index = token.lastIndexOf(".");
  if (index <= 0) return undefined;
  const body = token.slice(0, index);
  const sig = token.slice(index + 1);
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right) || revoked.has(sig)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (!value || typeof value.username !== "string" || typeof value.exp !== "number") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function secret(): string {
  return process.env.CUSTOMER_SECRET || "xuandou-ai-customer-dev-secret";
}

function cookieValue(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

export { TTL };
