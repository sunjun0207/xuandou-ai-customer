import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = process.env.VITE_PROXY_TARGET || env.VITE_PROXY_TARGET || "http://127.0.0.1:4080";
  const wsTarget = target.replace(/^http/, "ws");
  // 公网经域名访问。localhost 和 IP 默认放行，域名要写进名单。
  const allowedHosts = [".xuandou.vip"];
  return {
    plugins: [react()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      host: "0.0.0.0",
      port: 4100,
      allowedHosts,
      proxy: {
        "/api": { target, changeOrigin: true, secure: false },
        "/ws": { target: wsTarget, ws: true, changeOrigin: true, secure: false },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 4100,
      allowedHosts,
      proxy: {
        "/api": { target, changeOrigin: true, secure: false },
        "/ws": { target: wsTarget, ws: true, changeOrigin: true, secure: false },
      },
    },
  };
});
