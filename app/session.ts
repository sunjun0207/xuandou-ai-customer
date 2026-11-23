let flight: Promise<boolean> | null = null;
let timer = 0;
let paused = false;

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
  await fetch("/api/auth/logout", { method: "POST" });
}

async function check(): Promise<boolean> {
  try {
    const me = await fetch("/api/auth/me", { cache: "no-store" });
    if (me.ok) {
      const body = (await me.json()) as { expiresIn?: number };
      arm(body.expiresIn);
      return true;
    }
    if (me.status !== 401 || paused) return me.status !== 401;
    const refreshed = await fetch("/api/auth/refresh", { method: "POST", cache: "no-store" });
    if (paused) return false;
    if (refreshed.status === 401) return false;
    if (!refreshed.ok) return true;
    const body = (await refreshed.json()) as { expiresIn?: number };
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
