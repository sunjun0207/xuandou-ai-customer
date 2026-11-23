import { nextSnowflake } from "./snowflake";

export type UpstreamState = "connecting" | "open" | "down";

export type ChatKind = "chat" | "confirm" | "progress" | "result" | "file";

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  clientMsgId: string;
  conversationId: string;
  role: ChatRole;
  kind: ChatKind;
  text: string;
  time: string;
  projectId: string;
  problemId: string;
  requestId: string;
  stage: string;
  url: string;
  streamId: string;
  decision: "" | "accept" | "reject";
  fileName: string;
  percent: number;
  pending: boolean;
  streaming: boolean;
};

export type ClientFrame =
  | { type: "ping" }
  | {
      type: "send";
      conversationId: string;
      clientMsgId: string;
      text: string;
      projectId: string;
      projectIds: string[];
      problemId: string;
    }
  | {
      type: "confirm";
      conversationId: string;
      clientMsgId: string;
      text: string;
      projectId: string;
      projectIds: string[];
      problemId: string;
      requestId: string;
      decision: "accept" | "reject";
    }
  | {
      type: "file";
      conversationId: string;
      clientMsgId: string;
      text: string;
      projectId: string;
      projectIds: string[];
      problemId: string;
      name: string;
      mime: string;
      dataBase64: string;
    };

export type ServerFrame =
  | {
      type: "ready";
      userId: string;
      username: string;
      displayName: string;
      upstream: UpstreamState;
    }
  | { type: "status"; upstream: UpstreamState }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; message: ChatMessage; done: boolean }
  | { type: "error"; error: string; clientMsgId: string }
  | { type: "pong" };

const CONV_RE = /^[A-Za-z0-9_-]{4,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const LOOSE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function newId(): string {
  return nextSnowflake();
}

export function shanghaiNow(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

export function blankMessage(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "conversationId" | "role" | "text">): ChatMessage {
  return {
    clientMsgId: partial.id,
    kind: "chat",
    time: "",
    projectId: "",
    problemId: "",
    requestId: "",
    stage: "",
    url: "",
    streamId: "",
    decision: "",
    fileName: "",
    percent: -1,
    pending: false,
    streaming: false,
    ...partial,
  };
}

export function parseClientFrame(value: unknown): ClientFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Record<string, unknown>;
  if (frame.type === "ping") return { type: "ping" };
  const conversationId = clipId(frame.conversationId, CONV_RE);
  const clientMsgId = clipId(frame.clientMsgId, ID_RE);
  if (!conversationId || !clientMsgId) return undefined;
  const projectIds = projectList(frame);
  const projectId = projectIds[0] || clip(frame.projectId, 64);
  const problemId = clip(frame.problemId, 64);
  if (frame.type === "send") {
    const text = clip(frame.text, 8000);
    if (!text) return undefined;
    return { type: "send", conversationId, clientMsgId, text, projectId, projectIds: projectIds.length ? projectIds : projectId ? [projectId] : [], problemId };
  }
  if (frame.type === "confirm") {
    const decision = frame.decision === "accept" || frame.decision === "reject" ? frame.decision : "";
    const requestId = clipId(frame.requestId, LOOSE_RE);
    const text = clip(frame.text, 8000) || (decision === "accept" ? "同意" : "");
    if (!decision || !requestId || !text) return undefined;
    return { type: "confirm", conversationId, clientMsgId, text, projectId, projectIds: projectIds.length ? projectIds : projectId ? [projectId] : [], problemId, requestId, decision };
  }
  if (frame.type === "file") {
    const name = clip(frame.name, 120);
    const mime = clip(frame.mime, 120) || "application/octet-stream";
    const dataBase64 = typeof frame.dataBase64 === "string" ? frame.dataBase64 : "";
    const text = clip(frame.text, 8000);
    if (!name || !dataBase64) return undefined;
    return { type: "file", conversationId, clientMsgId, text, projectId, projectIds: projectIds.length ? projectIds : projectId ? [projectId] : [], problemId, name, mime, dataBase64 };
  }
  return undefined;
}

export function buildFrpPayload(input: {
  kind: "user" | "confirm" | "file";
  conversationId: string;
  clientMsgId: string;
  body: string;
  projectId: string;
  projectIds?: string[];
  problemId: string;
  accountId: string;
  requestId?: string;
  decision?: string;
  fileName?: string;
}): string {
  // frp 遇到 text 或字符串 content 时只保存那一段，kind、conversationId 会丢掉。这两个字段名不能出现。
  return JSON.stringify({
    msgType: "json",
    kind: input.kind,
    conversationId: input.conversationId,
    clientMsgId: input.clientMsgId,
    body: input.body,
    projectId: input.projectId,
    projectIds: input.projectIds && input.projectIds.length ? input.projectIds : input.projectId ? [input.projectId] : [],
    problemId: input.problemId,
    accountId: input.accountId,
    requestId: input.requestId || "",
    decision: input.decision || "",
    fileName: input.fileName || "",
    toUserId: "internal",
  });
}

type Saved = {
  id?: unknown;
  msgType?: unknown;
  content?: unknown;
  userId?: unknown;
  projectId?: unknown;
  problemId?: unknown;
  time?: unknown;
};

export function fromFrpSaved(saved: Saved, selfUserId: string): { type: "message"; message: ChatMessage } | { type: "delta"; message: ChatMessage; done: boolean } | undefined {
  const id = clip(saved.id, 32);
  const msgType = clip(saved.msgType, 16);
  const content = typeof saved.content === "string" ? saved.content : "";
  const self = clip(saved.userId, 64) === selfUserId;
  const time = clip(saved.time, 32);
  const projectId = clip(saved.projectId, 64);
  const problemId = clip(saved.problemId, 64);
  if (!id && !content) return undefined;

  if (msgType === "file") {
    return {
      type: "message",
      message: blankMessage({
        id: id || newId(),
        conversationId: "",
        role: self ? "user" : "assistant",
        kind: "file",
        text: "文件",
        time,
        projectId,
        problemId,
        url: content,
      }),
    };
  }

  const payload = parsePayload(content);
  if (!payload) {
    const text = content.trim();
    if (!text) return undefined;
    return {
      type: "message",
      message: blankMessage({
        id: id || newId(),
        conversationId: "",
        role: self ? "user" : "assistant",
        text,
        time,
        projectId,
        problemId,
      }),
    };
  }

  const kindRaw = clip(payload.kind, 16) || "chat";
  const conversationId = conversationOf(payload.conversationId);
  const clientMsgId = clipId(payload.clientMsgId, ID_RE) || id || newId();
  const text = clip(payload.body, 8000) || clip(payload.text, 8000);
  const requestId = clipId(payload.requestId, LOOSE_RE);
  const streamId = clipId(payload.streamId, LOOSE_RE);
  const decision = payload.decision === "accept" || payload.decision === "reject" ? payload.decision : "";
  const stage = clip(payload.stage, 40);
  const url = clip(payload.url, 512);
  const fileName = clip(payload.fileName, 120);
  const percent = percentOf(payload.percent);
  const message = blankMessage({
    id: id || clientMsgId,
    clientMsgId,
    conversationId,
    role: roleOf(kindRaw, self, decision),
    kind: normalizeKind(kindRaw),
    text,
    time,
    projectId: projectId || clip(payload.projectId, 64),
    problemId: problemId || clip(payload.problemId, 64),
    requestId,
    stage,
    url,
    streamId,
    decision,
    fileName,
    percent,
  });

  if (kindRaw === "delta" || kindRaw === "done") {
    message.role = "assistant";
    message.kind = "chat";
    message.streamId = streamId || message.streamId;
    message.streaming = kindRaw === "delta";
    return { type: "delta", message, done: kindRaw === "done" };
  }
  return { type: "message", message };
}

export function mergeMessage(prev: ChatMessage, incoming: ChatMessage): ChatMessage {
  return {
    ...prev,
    ...incoming,
    id: preferId(prev.id, incoming.id),
    text: incoming.text || prev.text,
    decision: incoming.decision || prev.decision,
    url: incoming.url || prev.url,
    fileName: incoming.fileName || prev.fileName,
    stage: incoming.stage || prev.stage,
    percent: incoming.percent >= 0 ? incoming.percent : prev.percent,
    pending: incoming.pending && prev.pending,
    streaming: incoming.streaming,
  };
}

function roleOf(kindRaw: string, self: boolean, decision: "" | "accept" | "reject"): ChatRole {
  if (kindRaw === "system") return "system";
  if (self || kindRaw === "user") return "user";
  if (decision) return "user";
  return "assistant";
}

function normalizeKind(kind: string): ChatKind {
  if (kind === "confirm" || kind === "progress" || kind === "result" || kind === "file") return kind;
  return "chat";
}

function parsePayload(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function percentOf(value: unknown): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return -1;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function preferId(prev: string, next: string): string {
  if (/^\d{10,}$/.test(next)) return next;
  if (/^\d{10,}$/.test(prev)) return prev;
  return next || prev;
}

function conversationOf(value: unknown): string {
  const id = clipId(value, CONV_RE);
  return id === "inbox" ? "" : id;
}

function projectList(frame: Record<string, unknown>): string[] {
  const raw = Array.isArray(frame.projectIds) ? frame.projectIds : [];
  const ids = raw.map((item) => clip(item, 64)).filter((item) => item.length > 0);
  return [...new Set(ids)].slice(0, 20);
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clipId(value: unknown, re: RegExp): string {
  const text = typeof value === "string" ? value.trim() : "";
  return re.test(text) ? text : "";
}
