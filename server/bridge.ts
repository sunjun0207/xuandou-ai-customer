import { WebSocket } from "ws";
import {
  blankMessage,
  buildFrpPayload,
  fromFrpSaved,
  parseClientFrame,
  shanghaiNow,
  type ChatMessage,
  type ClientFrame,
  type ServerFrame,
  type UpstreamState,
} from "../shared/protocol";
import type { Session } from "./session";

const QUEUE_LIMIT = 20;

export function attachBridge(browser: WebSocket, session: Session) {
  let upstream: WebSocket | undefined;
  let upstreamState: UpstreamState = "connecting";
  let closed = false;
  let retry = 0;
  let attempt = 0;
  let conversationId = "";
  const queue: Array<{ echo: ChatMessage; parts: Array<string | Buffer> }> = [];

  const sendBrowser = (frame: ServerFrame) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(frame));
  };

  const setStatus = (state: UpstreamState) => {
    upstreamState = state;
    sendBrowser({ type: "status", upstream: state });
  };

  const connect = () => {
    if (closed) return;
    const current = ++attempt;
    setStatus("connecting");
    const ws = new WebSocket(upstreamUrl(session.userId));
    upstream = ws;
    const timeout = setTimeout(() => {
      ws.terminate();
    }, Number(process.env.FRP_CONNECT_TIMEOUT_MS || 8000));
    ws.on("open", () => {
      if (current !== attempt) return;
      clearTimeout(timeout);
      retry = 0;
      setStatus("open");
      console.log(`upstream open ${session.userId}`);
      while (queue.length && ws.readyState === WebSocket.OPEN) {
        const item = queue.shift();
        if (!item) continue;
        for (const part of item.parts) ws.send(part);
        sendBrowser({ type: "message", message: { ...item.echo, pending: false } });
      }
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let saved: unknown;
      try {
        saved = JSON.parse(raw);
      } catch {
        return;
      }
      if (!saved || typeof saved !== "object") return;
      const id = (saved as { id?: unknown }).id;
      if (typeof id === "string" && /^[0-9]{1,20}$/.test(id) && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ack", id }));
      }
      const inbound = fromFrpSaved(saved, session.userId);
      if (!inbound) return;
      if ((!inbound.message.conversationId || inbound.message.conversationId === "inbox") && conversationId) {
        inbound.message.conversationId = conversationId;
      }
      if (inbound.type === "delta") sendBrowser({ type: "delta", message: inbound.message, done: inbound.done });
      else sendBrowser({ type: "message", message: inbound.message });
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      if (upstream === ws) upstream = undefined;
      if (closed || current !== attempt) return;
      setStatus("down");
      const wait = Math.min(15000, 1000 * 2 ** retry);
      retry += 1;
      setTimeout(connect, wait);
    });
    ws.on("error", () => {
      ws.close();
    });
  };

  browser.on("message", (data) => {
    let parsed: unknown;
    try {
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (raw.length > 2_200_000) {
        sendBrowser({ type: "error", error: "消息太大", clientMsgId: "" });
        return;
      }
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = parseClientFrame(parsed);
    if (!frame) return;
    if (frame.type === "ping") {
      sendBrowser({ type: "pong" });
      return;
    }
    conversationId = frame.conversationId;
    const parts = outbound(frame, session);
    if (!parts) {
      sendBrowser({ type: "error", error: "附件不能超过 1.5MB", clientMsgId: frame.clientMsgId });
      return;
    }
    const open = Boolean(upstream && upstream.readyState === WebSocket.OPEN);
    if (!open && queue.length >= QUEUE_LIMIT) {
      sendBrowser({ type: "error", error: "通道排队已满，请稍后再发", clientMsgId: frame.clientMsgId });
      return;
    }
    const echo = { ...parts.echo, pending: !open };
    sendBrowser({ type: "message", message: echo });
    if (open && upstream) {
      for (const item of parts.wire) upstream.send(item);
      return;
    }
    queue.push({ echo, parts: parts.wire });
  });

  browser.on("close", () => {
    closed = true;
    attempt += 1;
    upstream?.close();
  });

  sendBrowser({
    type: "ready",
    userId: session.userId,
    username: session.username,
    displayName: session.displayName,
    upstream: "connecting",
  });
  connect();
}

function outbound(frame: Exclude<ClientFrame, { type: "ping" }>, session: Session): { echo: ReturnType<typeof blankMessage>; wire: Array<string | Buffer> } | undefined {
  const time = shanghaiNow();
  if (frame.type === "file") {
    const bytes = decodeFile(frame.dataBase64);
    if (!bytes) return undefined;
    const text = frame.text || `请看附件 ${frame.name}`;
    return {
      echo: blankMessage({
        id: frame.clientMsgId,
        clientMsgId: frame.clientMsgId,
        conversationId: frame.conversationId,
        role: "user",
        kind: "file",
        text,
        time,
        projectId: frame.projectId,
        problemId: frame.problemId,
        fileName: frame.name,
        pending: true,
      }),
      wire: [
        buildFrpPayload({
          kind: "file",
          conversationId: frame.conversationId,
          clientMsgId: frame.clientMsgId,
          body: text,
          projectId: frame.projectId,
          projectIds: frame.projectIds,
          problemId: frame.problemId,
          accountId: session.accountId,
          fileName: frame.name,
        }),
        bytes,
      ],
    };
  }
  const kind = frame.type === "confirm" ? "confirm" : "user";
  return {
    echo: blankMessage({
      id: frame.clientMsgId,
      clientMsgId: frame.clientMsgId,
      conversationId: frame.conversationId,
      role: "user",
      kind: frame.type === "confirm" ? "confirm" : "chat",
      text: frame.text,
      time,
      projectId: frame.projectId,
      problemId: frame.problemId,
      requestId: frame.type === "confirm" ? frame.requestId : "",
      decision: frame.type === "confirm" ? frame.decision : "",
      pending: true,
    }),
    wire: [
      buildFrpPayload({
        kind,
        conversationId: frame.conversationId,
        clientMsgId: frame.clientMsgId,
        body: frame.text,
        projectId: frame.projectId,
        projectIds: frame.projectIds,
        problemId: frame.problemId,
        accountId: session.accountId,
        requestId: frame.type === "confirm" ? frame.requestId : "",
        decision: frame.type === "confirm" ? frame.decision : "",
      }),
    ],
  };
}

function decodeFile(dataBase64: string): Buffer | undefined {
  if (dataBase64.length > 2_100_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(dataBase64)) return undefined;
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0 || bytes.length > 1_500_000) return undefined;
  return bytes;
}

function upstreamUrl(userId: string): string {
  const base = process.env.FRP_WS_URL || "ws://127.0.0.1:4080/ws";
  const url = new URL(base);
  url.searchParams.set("role", "external");
  url.searchParams.set("userId", userId);
  const token = process.env.FRP_WS_TOKEN || process.env.WS_TOKEN || "";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
