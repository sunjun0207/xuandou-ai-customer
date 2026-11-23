const http = require("http");
const WebSocket = require("ws");

const base = process.env.SMOKE_URL || "http://127.0.0.1:4100";
const username = process.env.SMOKE_USER || "admin";
const password = process.env.SMOKE_PASSWORD || "admin123";

function request(method, path, { cookie, body } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const raw = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(raw ? { "Content-Type": "application/json", "Content-Length": raw.length } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function cookieOf(headers) {
  const raw = headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error("missing cookie");
  return first.split(";")[0];
}

async function main() {
  const health = await request("GET", "/api/health");
  if (health.status !== 200 || !health.json.ok) throw new Error(`health ${health.status}`);
  const anon = await request("GET", "/api/auth/me");
  if (anon.status !== 401) throw new Error(`me anon ${anon.status}`);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode !== 401) reject(new Error(`ws anon ${res.statusCode}`));
      else resolve();
    });
    ws.on("open", () => reject(new Error("ws anon opened")));
    ws.on("error", () => {});
  });

  const login = await request("POST", "/api/auth/login", { body: { username, password } });
  if (login.status !== 200) throw new Error(`login ${login.status} ${login.text}`);
  const cookie = cookieOf(login.headers);
  const me = await request("GET", "/api/auth/me", { cookie });
  if (me.status !== 200 || me.json.user.username !== username) throw new Error("me mismatch");

  const echoed = await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { Cookie: cookie } });
    const timer = setTimeout(() => reject(new Error("ws timeout")), 8000);
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "ready") {
        ws.send(JSON.stringify({
          type: "send",
          conversationId: "c_smoke01",
          clientMsgId: "m_smoke0001",
          text: "卫星项目需要一个导出",
          projectId: "satellite",
          problemId: "",
        }));
      }
      if (frame.type === "message" && frame.message && frame.message.clientMsgId === "m_smoke0001") {
        clearTimeout(timer);
        ws.close();
        resolve(frame.message);
      }
    });
    ws.on("error", reject);
  });
  if (echoed.text !== "卫星项目需要一个导出" || echoed.conversationId !== "c_smoke01") {
    throw new Error(`echo ${JSON.stringify(echoed)}`);
  }

  const logout = await request("POST", "/api/auth/logout", { cookie });
  if (logout.status !== 200) throw new Error(`logout ${logout.status}`);
  const after = await request("GET", "/api/auth/me", { cookie });
  if (after.status !== 401) throw new Error(`me after logout ${after.status}`);
  console.log("smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
