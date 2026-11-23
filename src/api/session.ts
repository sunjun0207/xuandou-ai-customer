const ACCESS = "xd-access";
const REFRESH = "xd-refresh";

let flight: Promise<boolean> | null = null;
let timer = 0;
let paused = false;

export type SessionUser = {
  userId: string;
  accountId: string;
  username: string;
  displayName: string;
  roleCode: string;
};

type TokenBody = {
  accessToken?: string;
  refreshToken?: string;
  token?: string;
  expiresIn?: number;
  user?: { id?: string; username?: string; displayName?: string; roleCode?: string; userId?: string; accountId?: string };
};

export function getAccess(): string {
  return localStorage.getItem(ACCESS) || "";
}

export function saveSession(body: TokenBody) {
  const access = body.accessToken || body.token || "";
  if (access) localStorage.setItem(ACCESS, access);
  if (body.refreshToken) localStorage.setItem(REFRESH, body.refreshToken);
}

export function clearStoredSession() {
  localStorage.removeItem(ACCESS);
  localStorage.removeItem(REFRESH);
}

export function userFrom(body: TokenBody): SessionUser | null {
  const user = body.user;
  if (!user?.username && !user?.userId) return null;
  const username = user.username || user.userId || "";
  return {
    userId: username,
    accountId: String(user.accountId || user.id || ""),
    username,
    displayName: user.displayName || username,
    roleCode: user.roleCode || "",
  };
}

export function ensureSession(): Promise<boolean> {
  if (paused) return Promise.resolve(false);
  if (!flight) flight = check().finally(() => {
    flight = null;
  });
  return flight;
}

export function watchSession(onLogout: () => void) {
  let stop = false;
  const tick = () => {
    if (stop || paused) return;
    void ensureSession().then((ok) => {
      if (!stop && !paused && !ok) onLogout();
    });
  };
  tick();
  const onVisible = () => {
    if (document.visibilityState === "visible") tick();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stop = true;
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function resumeSessionWatch() {
  paused = false;
}

export function sessionLeaving(): boolean {
  return paused;
}

export async function endSession() {
  paused = true;
  window.clearTimeout(timer);
  if (flight) await flight.catch(() => undefined);
  const access = getAccess();
  clearStoredSession();
  if (access) {
    await fetch(apiUrl("/api/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${access}` } }).catch(() => undefined);
  }
}

export function apiUrl(path: string): string {
  const base = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function wsUrl(): string {
  const configured = String(import.meta.env.VITE_WS_URL || "/ws");
  const url = /^wss?:\/\//i.test(configured)
    ? new URL(configured)
    : new URL(configured, `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
  url.searchParams.set("role", "external");
  const token = getAccess();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export async function apiFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getAccess();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(apiUrl(path), { ...init, headers });
  if (response.status !== 401 || !retry || path.startsWith("/api/auth/")) return response;
  const ok = await ensureSession();
  if (!ok) return response;
  const again = new Headers(init.headers);
  const next = getAccess();
  if (next) again.set("Authorization", `Bearer ${next}`);
  return fetch(apiUrl(path), { ...init, headers: again });
}

async function check(): Promise<boolean> {
  try {
    if (!getAccess() && !localStorage.getItem(REFRESH)) return false;
    if (getAccess()) {
      const status = await fetch(apiUrl("/api/auth/status"), {
        cache: "no-store",
        headers: { Authorization: `Bearer ${getAccess()}` },
      });
      if (status.ok) {
        const body = (await status.json()) as { loggedIn?: boolean; expiresIn?: number };
        if (body.loggedIn) {
          arm(body.expiresIn);
          return true;
        }
      }
    }
    const refreshToken = localStorage.getItem(REFRESH) || "";
    if (!refreshToken || paused) return false;
    const refreshed = await fetch(apiUrl("/api/auth/refresh"), {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (paused || refreshed.status === 401) {
      clearStoredSession();
      return false;
    }
    if (!refreshed.ok) return true;
    const body = (await refreshed.json()) as TokenBody;
    saveSession(body);
    arm(body.expiresIn);
    return true;
  } catch {
    return true;
  }
}

function arm(expiresIn?: number) {
  window.clearTimeout(timer);
  if (paused) return;
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 60;
  timer = window.setTimeout(() => {
    void ensureSession().then((ok) => {
      if (!ok && !paused) window.location.assign("/login");
    });
  }, Math.max(5, seconds - 30) * 1000);
}
