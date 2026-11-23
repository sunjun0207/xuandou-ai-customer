import { createHmac, randomBytes, timingSafeEqual } from "crypto";
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

type TokenKind = "access" | "refresh";

type Claims = Session & { typ: TokenKind; jti: string };

const ACCESS_COOKIE = "xd_access";
const REFRESH_COOKIE = "xd_refresh";
const LEGACY_COOKIE = "xd_customer";
const DEFAULT_ACCESS_MINUTES = 15;
const DEFAULT_REFRESH_MINUTES = 43_200;
const revoked = new Set<string>();

export function accessMinutes(): number {
  return positiveMinutes(process.env.JWT_ACCESS_EXPIRES_IN_MINUTES, DEFAULT_ACCESS_MINUTES);
}

export function refreshMinutes(): number {
  return positiveMinutes(process.env.JWT_REFRESH_EXPIRES_IN_MINUTES, DEFAULT_REFRESH_MINUTES);
}

export function readSession(req: IncomingMessage): Session | undefined {
  return readToken(req, ACCESS_COOKIE, "access");
}

export function readRefreshSession(req: IncomingMessage): Session | undefined {
  return readToken(req, REFRESH_COOKIE, "refresh");
}

export function openSession(req: IncomingMessage, res: ServerResponse, profile: Omit<Session, "exp">): { accessToken: string; refreshToken: string; expiresIn: number } {
  const access = sign(profile, "access", accessMinutes());
  const refresh = sign(profile, "refresh", refreshMinutes());
  res.setHeader("Set-Cookie", [cookie(req, ACCESS_COOKIE, access.token, "/", access.ttl), cookie(req, REFRESH_COOKIE, refresh.token, "/api/auth", refresh.ttl), clearCookie(req, LEGACY_COOKIE, "/")]);
  return { accessToken: access.token, refreshToken: refresh.token, expiresIn: access.ttl };
}

export function clearSession(req: IncomingMessage, res: ServerResponse) {
  const access = cookieValue(req.headers.cookie, ACCESS_COOKIE);
  const refresh = cookieValue(req.headers.cookie, REFRESH_COOKIE);
  revoke(access);
  revoke(refresh);
  res.setHeader("Set-Cookie", [clearCookie(req, ACCESS_COOKIE, "/"), clearCookie(req, REFRESH_COOKIE, "/api/auth"), clearCookie(req, LEGACY_COOKIE, "/")]);
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

export function expiresIn(session: Session): number {
  return Math.max(0, session.exp - Math.floor(Date.now() / 1000));
}

function readToken(req: IncomingMessage, name: string, kind: TokenKind): Session | undefined {
  const token = cookieValue(req.headers.cookie, name);
  if (!token) return undefined;
  const claims = verify(token, kind);
  if (!claims) return undefined;
  return {
    userId: claims.userId,
    accountId: claims.accountId,
    username: claims.username,
    displayName: claims.displayName,
    roleCode: claims.roleCode,
    frpToken: claims.frpToken,
    exp: claims.exp,
  };
}

function sign(profile: Omit<Session, "exp">, kind: TokenKind, minutes: number): { token: string; ttl: number } {
  const ttl = minutes * 60;
  const claims: Claims = {
    ...profile,
    typ: kind,
    jti: randomBytes(16).toString("hex"),
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret(kind)).update(`${header}.${body}`).digest("base64url");
  return { token: `${header}.${body}.${sig}`, ttl };
}

function verify(token: string, kind: TokenKind): Claims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", secret(kind)).update(`${header}.${body}`).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right) || revoked.has(sig)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
    if (!value || value.typ !== kind || typeof value.username !== "string" || typeof value.exp !== "number") return undefined;
    if (value.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function revoke(token: string) {
  const sig = token.split(".")[2];
  if (sig) revoked.add(sig);
}

function secret(kind: TokenKind): string {
  if (kind === "refresh") return process.env.JWT_REFRESH_SECRET?.trim() || `${accessSecret()}:refresh`;
  return accessSecret();
}

function accessSecret(): string {
  return process.env.JWT_ACCESS_SECRET?.trim() || process.env.CUSTOMER_SECRET || "xuandou-ai-customer-dev-secret";
}

function positiveMinutes(raw: string | undefined, fallback: number): number {
  const minutes = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return minutes;
}

function cookie(req: IncomingMessage, name: string, value: string, path: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=${path}; SameSite=Lax; Max-Age=${maxAge}${secureAttribute(req)}`;
}

function clearCookie(req: IncomingMessage, name: string, path: string): string {
  return `${name}=; HttpOnly; Path=${path}; SameSite=Lax; Max-Age=0${secureAttribute(req)}`;
}

function secureAttribute(req: IncomingMessage): string {
  if (process.env.COOKIE_SECURE === "false") return "";
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwarded === "http") return "";
  const https = forwarded === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
  return https ? "; Secure" : "";
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

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
