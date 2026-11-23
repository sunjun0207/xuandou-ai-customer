import fs from "fs";
import http from "http";
import https from "https";
import type { Duplex } from "stream";
import next from "next";
import { WebSocketServer } from "ws";
import { isAdminApi, proxyAdmin } from "./admin-proxy";
import { handleLogin, handleLogout, handleMe, sendJson } from "./auth";
import { attachBridge } from "./bridge";
import { readSession } from "./session";
import { handleUpload } from "./upload";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const sockets = new WebSocketServer({ noServer: true, maxPayload: 2_500_000 });

async function main() {
  process.env.TZ = process.env.TZ || "Asia/Shanghai";
  await app.prepare();
  const handleUpgrade = app.getUpgradeHandler();
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "xuandou-ai-customer" });
    if (pathname === "/api/auth/login" && req.method === "POST") {
      handleLogin(req, res).catch(() => sendJson(res, 400, { error: "请求无法识别" }));
      return;
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      handleLogout(req, res).catch(() => sendJson(res, 500, { error: "注销失败" }));
      return;
    }
    if (pathname === "/api/auth/me" && req.method === "GET") {
      handleMe(req, res).catch(() => sendJson(res, 500, { error: "暂时无法确认登录状态" }));
      return;
    }
    if (pathname === "/api/upload/config" || pathname === "/api/upload/token") {
      handleUpload(req, res).catch(() => sendJson(res, 400, { error: "请求无法识别" }));
      return;
    }
    if (isAdminApi(pathname)) {
      proxyAdmin(req, res).catch(() => sendJson(res, 503, { error: "登录服务暂时不可用" }));
      return;
    }
    handle(req, res).catch(() => sendJson(res, 500, { error: "页面暂时打不开" }));
  };
  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname !== "/ws") {
      handleUpgrade(req, socket, head);
      return;
    }
    const session = readSession(req);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => attachBridge(ws, session));
  };

  const httpServer = http.createServer(onRequest);
  httpServer.on("upgrade", onUpgrade);
  const httpAddr = process.env.HTTP_ADDR || "0.0.0.0:4100";
  await listen(httpServer, httpAddr);
  console.log(`http listen on ${httpAddr}`);

  if (process.env.TLS_ENABLE !== "true") return;
  const httpsServer = https.createServer(
    {
      cert: fs.readFileSync(process.env.TLS_CERT || "/certs/fullchain.pem"),
      key: fs.readFileSync(process.env.TLS_KEY || "/certs/privkey.pem"),
    },
    onRequest,
  );
  httpsServer.on("upgrade", onUpgrade);
  const httpsAddr = process.env.HTTPS_ADDR || "0.0.0.0:4443";
  await listen(httpsServer, httpsAddr);
  console.log(`https listen on ${httpsAddr}`);
}

function listen(server: http.Server | https.Server, addr: string) {
  const index = addr.lastIndexOf(":");
  const host = addr.slice(0, index);
  const port = Number(addr.slice(index + 1));
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
