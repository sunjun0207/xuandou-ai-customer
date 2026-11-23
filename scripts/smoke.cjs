const http = require("http");

const base = process.env.SMOKE_URL || "http://127.0.0.1:4100";
const username = process.env.SMOKE_USER || "admin";
const password = process.env.SMOKE_PASSWORD || "admin123";

async function request(method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function openSocket(token) {
  const target = new URL(base);
  const path = `/ws?role=external&token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": require("crypto").randomBytes(16).toString("base64"),
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("ws timeout"));
    }, 8000);
    req.on("upgrade", (_res, socket) => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      reject(new Error(`ws ${res.statusCode}`));
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

async function main() {
  const health = await request("GET", "/api/health");
  if (health.status !== 200 || !health.json?.ok) throw new Error(`health ${health.status}`);

  const anon = await request("GET", "/api/auth/status");
  if (anon.status !== 200 || anon.json?.loggedIn !== false) throw new Error(`status anon ${anon.status} ${anon.text}`);

  const login = await request("POST", "/api/auth/login", { body: { username, password } });
  if (login.status !== 200 || !login.json?.accessToken || !login.json?.refreshToken) {
    throw new Error(`login ${login.status} ${login.text}`);
  }
  const token = login.json.accessToken;
  const me = await request("GET", "/api/auth/me", { token });
  if (me.status !== 200 || me.json?.user?.username !== username) throw new Error(`me ${me.status} ${me.text}`);

  await openSocket(token);

  const logout = await request("POST", "/api/auth/logout", { token });
  if (logout.status !== 200) throw new Error(`logout ${logout.status}`);
  const after = await request("GET", "/api/auth/me", { token });
  if (after.status !== 401) throw new Error(`me after logout ${after.status}`);
  console.log("smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
