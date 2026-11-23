import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Mark } from "@/components/mark";
import { RichText } from "@/components/rich-text";
import { apiFetch, saveSession, userFrom, wsUrl, endSession, ensureSession, sessionLeaving, watchSession } from "@/api/session";
import { fetchUploadCredential, postQiniu } from "@/api/upload";
import { blankMessage, buildFrpPayload, fromFrpSaved, mergeMessage, newId, shanghaiNow, type ChatAttachment, type ChatMessage, type ServerFrame, type UpstreamState } from "@/shared/protocol";
import { nextSnowflake } from "@/shared/snowflake";
import { DEFAULT_MAX_BYTES, displayFileName, extensionOf, formatBytes, formatMaxLabel, isImageFile, MAX_ATTACHMENTS } from "@/shared/upload";
import { useRouter } from "@/router";

type User = { userId: string; accountId: string; username: string; displayName: string; roleCode: string };
type ConvMeta = { id: string; title: string; updatedAt: number; renamed?: boolean; pinned?: boolean; pinnedAt?: number };
type Conv = ConvMeta & { messages: ChatMessage[] };
type DraftFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: "uploading" | "ready" | "error";
  percent: number;
  url: string;
  preview: string;
  error: string;
};
type Confirming = { requestId: string; conversationId: string; quote: string };
type Project = { id: string; name: string; code: string; status: number };

const SUGGESTIONS = ["我想提一个新需求，先帮我把边界问清楚", "帮我看一下当前需求做到哪一步了", "这个改动如果要跨系统，先列出要确认的点"];

export function ChatApp() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showLink, setShowLink] = useState(false);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");
  const [nav, setNav] = useState(true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [maxBytes, setMaxBytes] = useState(DEFAULT_MAX_BYTES);
  const [maxLabel, setMaxLabel] = useState(formatMaxLabel(DEFAULT_MAX_BYTES));
  const [menuId, setMenuId] = useState("");
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [renameId, setRenameId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [hold, setHold] = useState(false);
  const [editingKey, setEditingKey] = useState("");
  const [gallery, setGallery] = useState<{ items: ChatAttachment[]; index: number } | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const threadRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const pinningRef = useRef(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const maxBytesRef = useRef(maxBytes);
  maxBytesRef.current = maxBytes;
  const maxLabelRef = useRef(maxLabel);
  maxLabelRef.current = maxLabel;
  const renameIdRef = useRef("");
  const holdRef = useRef(false);
  const copiedTimer = useRef(0);
  renameIdRef.current = renameId;

  useEffect(() => {
    return watchSession(() => router.replace("/login"));
  }, [router]);

  useEffect(() => {
    let stop = false;
    ensureSession()
      .then(async (ok) => {
        if (!ok) {
          router.replace("/login");
          return;
        }
        const res = await apiFetch("/api/auth/me");
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        const body = (await res.json()) as { user?: { id?: string; username?: string; displayName?: string; roleCode?: string } };
        const nextUser = userFrom({ user: body.user });
        if (stop || !nextUser) {
          if (!stop) router.replace("/login");
          return;
        }
        setUser(nextUser);
        const loaded = await apiFetch("/api/conversations");
        if (stop) return;
        if (loaded.status === 401) {
          router.replace("/login");
          return;
        }
        if (loaded.ok) {
          const data = (await loaded.json()) as { items?: ConvMeta[] };
          setConvs(mergeList([], Array.isArray(data.items) ? data.items : [], ""));
        } else {
          setError("会话列表暂时读不出来");
        }
        setHydrated(true);
        setReady(true);
      })
      .catch(() => setError("暂时无法确认登录状态"));
    return () => {
      stop = true;
    };
  }, [router]);

  useEffect(() => {
    if (!user || !hydrated) return;
    let stop = false;
    const pull = async () => {
      if (stop || document.visibilityState === "hidden") return;
      const listed = await apiFetch("/api/conversations");
      if (stop) return;
      if (listed.status === 401) {
        const ok = await ensureSession();
        if (!stop && !ok) router.replace("/login");
        return;
      }
      if (!listed.ok) return;
      const data = (await listed.json()) as { items?: ConvMeta[] };
      const items = Array.isArray(data.items) ? data.items : [];
      setConvs((prev) => mergeList(prev, items, renameIdRef.current));
      const current = activeIdRef.current;
      if (!current) return;
      const detail = await apiFetch(`/api/conversations/${encodeURIComponent(current)}`);
      if (stop || !detail.ok) return;
      const body = (await detail.json()) as { item?: ConvMeta & { messages?: ChatMessage[] } };
      const incoming = Array.isArray(body.item?.messages) ? body.item.messages : [];
      setConvs((prev) => replaceMessages(prev, current, incoming));
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 4000);
    const onFocus = () => void pull();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stop = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [user, hydrated, router]);

  useEffect(() => {
    if (!user || !hydrated || !activeId) return;
    let stop = false;
    apiFetch(`/api/conversations/${encodeURIComponent(activeId)}`)
      .then(async (res) => {
        if (stop || !res.ok) return;
        const body = (await res.json()) as { item?: { messages?: ChatMessage[] } };
        const incoming = Array.isArray(body.item?.messages) ? body.item.messages : [];
        setConvs((prev) => replaceMessages(prev, activeId, incoming));
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [user, hydrated, activeId]);

  useEffect(() => {
    if (!user) return;
    apiFetch("/api/upload/config")
      .then(async (res) => (res.ok ? ((await res.json()) as { maxBytes?: number; maxLabel?: string }) : null))
      .then((data) => {
        if (!data || typeof data.maxBytes !== "number" || data.maxBytes <= 0) return;
        setMaxBytes(data.maxBytes);
        setMaxLabel(data.maxLabel || formatMaxLabel(data.maxBytes));
      })
      .catch(() => undefined);
    apiFetch("/api/projects")
      .then(async (res) => (res.ok ? ((await res.json()) as { items?: Project[] }) : { items: [] }))
      .then((data) => setProjects(Array.isArray(data.items) ? data.items.filter((item) => item.status !== 0) : []))
      .catch(() => setProjects([]));
  }, [user]);

  useEffect(() => {
    if (!user || !hydrated) return;
    let stopped = false;
    let timer = 0;
    const connect = () => {
      if (stopped) return;
      const socket = new WebSocket(wsUrl());
      wsRef.current = socket;
      socket.onopen = () => setUpstream("open");
      socket.onmessage = (event) => {
        let frame: ServerFrame & Record<string, unknown>;
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame & Record<string, unknown>;
        } catch {
          return;
        }
        if (frame.type === "ready" || frame.type === "status") setUpstream(frame.upstream);
        if (frame.type === "error") {
          setError(frame.error);
          holdRef.current = false;
          setHold(false);
          if (frame.clientMsgId) setConvs((prev) => removeMessage(prev, frame.clientMsgId));
          return;
        }
        if (frame.type === "message") {
          setConvs((prev) => applyMessage(prev, inOpenConversation(frame.message, activeIdRef.current)));
          return;
        }
        if (frame.type === "delta") {
          setConvs((prev) => applyDelta(prev, inOpenConversation(frame.message, activeIdRef.current), frame.done));
          return;
        }
        const raw = frame as Record<string, unknown>;
        const inbound = fromFrpSaved(raw, user.userId);
        const savedId = typeof raw.id === "string" ? raw.id : "";
        if (/^\d{10,}$/.test(savedId)) socket.send(JSON.stringify({ type: "ack", id: savedId }));
        if (inbound?.type === "message") setConvs((prev) => applyMessage(prev, inOpenConversation(inbound.message, activeIdRef.current)));
        if (inbound?.type === "delta") setConvs((prev) => applyDelta(prev, inOpenConversation(inbound.message, activeIdRef.current), inbound.done));
      };
      socket.onclose = () => {
        if (wsRef.current !== socket) return;
        setUpstream("down");
        if (stopped || sessionLeaving()) return;
        void ensureSession().then((ok) => {
          if (stopped) return;
          if (!ok) {
            router.replace("/login");
            return;
          }
          timer = window.setTimeout(connect, 400);
        });
      };
    };
    const ping = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "ping" }));
    }, 25000);
    connect();
    const media = window.matchMedia("(max-width: 800px)");
    const onMedia = () => {
      if (media.matches) setNav(false);
    };
    if (media.matches) setNav(false);
    media.addEventListener("change", onMedia);
    return () => {
      stopped = true;
      media.removeEventListener("change", onMedia);
      window.clearTimeout(timer);
      window.clearInterval(ping);
      wsRef.current?.close();
    };
  }, [user, hydrated, router]);

  useEffect(() => {
    if (!menuId) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".conv-menu, .conv-more")) return;
      setMenuId("");
    };
    const hide = () => setMenuId("");
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", hide, true);
    };
  }, [menuId]);

  const active = convs.find((item) => item.id === activeId);
  const listed = sortConvs(convs);
  const messages = active?.messages || [];
  const hero = messages.length === 0;
  const waiting = hold || awaitingReply(messages);

  const waitingRef = useRef(false);
  useEffect(() => {
    const pending = awaitingReply(messages);
    if (waitingRef.current && !pending) {
      holdRef.current = false;
      setHold(false);
    }
    waitingRef.current = pending || holdRef.current;
  }, [messages]);

  useLayoutEffect(() => {
    stickRef.current = true;
    pinThreadToBottom();
  }, [activeId]);

  useLayoutEffect(() => {
    if (!stickRef.current) return;
    pinThreadToBottom();
  }, [messages, messages[messages.length - 1]?.text]);

  useEffect(() => {
    setEditingKey("");
  }, [activeId]);

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el || pinningRef.current) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function pinThreadToBottom() {
    const el = threadRef.current;
    if (!el) return;
    pinningRef.current = true;
    el.scrollTop = el.scrollHeight;
    pinningRef.current = false;
  }

  function publish(input: {
    conversationId: string;
    clientMsgId: string;
    text: string;
    kind: "user" | "confirm" | "file";
    projectId: string;
    projectIds: string[];
    problemId: string;
    attachments: ChatAttachment[];
    requestId?: string;
    decision?: "" | "accept" | "reject";
  }) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !user) return false;
    const names = input.attachments.map((item) => item.name).join("、");
    const body = input.text || names;
    const first = input.attachments[0];
    const echo = blankMessage({
      id: input.clientMsgId,
      clientMsgId: input.clientMsgId,
      conversationId: input.conversationId,
      role: "user",
      kind: input.kind === "confirm" ? "confirm" : input.text ? "chat" : "file",
      text: body,
      time: shanghaiNow(),
      projectId: input.projectId,
      problemId: input.problemId,
      requestId: input.requestId || "",
      decision: input.decision || "",
      fileName: first?.name || "",
      url: first?.url || "",
      attachments: input.attachments,
    });
    setConvs((prev) => applyMessage(prev, echo));
    socket.send(
      buildFrpPayload({
        kind: input.kind,
        conversationId: input.conversationId,
        clientMsgId: input.clientMsgId,
        body,
        projectId: input.projectId,
        projectIds: input.projectIds,
        problemId: input.problemId,
        accountId: user.accountId,
        requestId: input.requestId,
        decision: input.decision,
        attachments: input.attachments,
      }),
    );
    return true;
  }

  function send(text = draft.trim(), confirm = confirming, reuse?: ChatAttachment[], linkedIds?: string[]) {
    const fromComposer = reuse === undefined;
    if ((holdRef.current || awaitingReply(messages)) && !confirm) return;
    if (fromComposer && files.some((item) => item.status === "uploading")) {
      setError("附件还在上传");
      return;
    }
    if (fromComposer && files.some((item) => item.status === "error")) {
      setError("有附件上传失败，请移除后再发");
      return;
    }
    const attachments = reuse ?? files.filter((item) => item.status === "ready" && item.url).map((item) => ({ name: item.name, mime: item.mime, url: item.url, size: item.size }));
    if (!text && !attachments.length) return;
    const conversationId = activeId || newId();
    const clientMsgId = newId();
    const projectIds = (linkedIds ?? pickedIds).filter((id) => {
      const found = projects.find((item) => item.id === id);
      return !found || found.status !== 0;
    });
    const linked = { projectId: projectIds[0] || "", projectIds, problemId: projectIds.length ? nextSnowflake() : "", attachments };
    if (!activeId) setActiveId(conversationId);
    const kind = confirm ? "confirm" : text ? "user" : "file";
    const sent = publish({
      conversationId: confirm ? confirm.conversationId : conversationId,
      clientMsgId,
      text: confirm ? text || "需要调整" : text,
      kind,
      projectId: linked.projectId,
      projectIds: linked.projectIds,
      problemId: linked.problemId,
      attachments,
      requestId: confirm?.requestId,
      decision: confirm ? "reject" : "",
    });
    if (!sent) {
      setError("连接已断开，这句话还没发出");
      return;
    }
    stickRef.current = true;
    if (fromComposer) {
      setDraft("");
      releaseFiles(files);
      setFiles([]);
      setConfirming(null);
      if (boxRef.current) boxRef.current.style.height = "";
    }
    setEditingKey("");
    setError("");
    holdRef.current = true;
    setHold(true);
  }

  function priorUser(message: ChatMessage): ChatMessage | undefined {
    const index = messages.findIndex((item) => messageKey(item) === messageKey(message));
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const item = messages[cursor];
      if (item.role === "user" && (captionOf(item).trim() || listedAttachments(item).length)) return item;
    }
    return undefined;
  }

  async function copyMessage(message: ChatMessage) {
    const text = messagePlain(message);
    if (!text) return;
    const copied = await writeClipboard(text);
    if (!copied) {
      setError("复制失败，请允许剪贴板权限后再试");
      return;
    }
    const key = messageKey(message);
    setCopiedKey(key);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedKey((current) => (current === key ? "" : current)), 1600);
  }

  function resendEdited(text: string, attachments: ChatAttachment[], projectIds: string[]) {
    send(text.trim(), null, attachments, projectIds);
  }

  function openGallery(url: string) {
    const items = userImages(messages);
    const index = items.findIndex((item) => item.url === url);
    if (index < 0) return;
    setGallery({ items, index });
  }

  function regenerate(message: ChatMessage) {
    const source = priorUser(message);
    if (!source) return;
    send(captionOf(source).trim(), null, listedAttachments(source));
  }

  function toggleProject(id: string) {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  function accept(message: ChatMessage) {
    const clientMsgId = newId();
    const projectIds = pickedIds;
    const sent = publish({
      conversationId: message.conversationId,
      clientMsgId,
      text: "同意",
      kind: "confirm",
      projectId: projectIds[0] || "",
      projectIds,
      problemId: projectIds.length ? nextSnowflake() : "",
      attachments: [],
      requestId: message.requestId,
      decision: "accept",
    });
    if (!sent) {
      setError("连接已断开，确认还没发出");
      return;
    }
    stickRef.current = true;
    holdRef.current = true;
    setHold(true);
  }

  function addFiles(list: File[]) {
    const room = MAX_ATTACHMENTS - filesRef.current.length;
    if (room <= 0) {
      setError(`一次最多 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const incoming = list.slice(0, room);
    if (list.length > room) setError(`一次最多 ${MAX_ATTACHMENTS} 个附件`);
    const accepted: Array<{ draft: DraftFile; file: File }> = [];
    for (const file of incoming) {
      const ext = extensionOf(file.name, file.type);
      const label = file.name || "这个文件";
      if (!ext) {
        setError(`不支持的文件类型：${label}`);
        continue;
      }
      if (file.size <= 0) {
        setError("文件是空的");
        continue;
      }
      if (file.size > maxBytesRef.current) {
        setError(`文件不能超过 ${maxLabelRef.current}`);
        continue;
      }
      const name = displayFileName(file.name, ext);
      const preview = file.type.startsWith("image/") || isImageFile(file.type, name) ? URL.createObjectURL(file) : "";
      accepted.push({
        file,
        draft: {
          id: newId(),
          name,
          mime: file.type || "application/octet-stream",
          size: file.size,
          status: "uploading",
          percent: 0,
          url: "",
          preview,
          error: "",
        },
      });
    }
    if (!accepted.length) return;
    setFiles((prev) => [...prev, ...accepted.map((item) => item.draft)]);
    for (const item of accepted) void uploadDraft(item.draft.id, item.file);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function uploadDraft(id: string, file: File) {
    try {
      const creds = await fetchUploadCredential(file);
      await postQiniu(file, creds, (percent) => {
        setFiles((prev) => prev.map((item) => (item.id === id ? { ...item, percent } : item)));
      });
      setFiles((prev) => prev.map((item) => (item.id === id ? { ...item, status: "ready", percent: 100, url: creds.publicUrl } : item)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传失败，请稍后重试";
      setFiles((prev) => prev.map((item) => (item.id === id ? { ...item, status: "error", error: message } : item)));
      setError(message);
    }
  }

  function removeFile(id: string) {
    setFiles((prev) => {
      const found = prev.find((item) => item.id === id);
      if (found?.preview) URL.revokeObjectURL(found.preview);
      return prev.filter((item) => item.id !== id);
    });
  }

  function openMenu(event: { stopPropagation: () => void; currentTarget: HTMLButtonElement }, id: string) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 168;
    setMenuPos({ top: Math.min(rect.bottom + 6, window.innerHeight - 230), left: Math.max(8, rect.right - width) });
    setMenuId(id);
  }

  function renameConv(id: string) {
    const title = renameDraft.replace(/\s+/g, " ").trim().slice(0, 40);
    setRenameId("");
    if (!title) return;
    setConvs((prev) => prev.map((conv) => (conv.id === id ? { ...conv, title, renamed: true } : conv)));
    void apiFetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).then((res) => {
      if (!res.ok) setHint("重命名没有保存");
    });
  }

  function pinConv(id: string) {
    setMenuId("");
    const current = convs.find((conv) => conv.id === id);
    const pinned = !current?.pinned;
    setConvs((prev) => prev.map((conv) => (conv.id === id ? { ...conv, pinned, pinnedAt: pinned ? Date.now() : 0 } : conv)));
    void apiFetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    }).then((res) => {
      if (!res.ok) setHint("置顶没有保存");
    });
  }

  async function shareConv(conv: Conv) {
    setMenuId("");
    const lines = [conv.title, ...conv.messages.map((message) => `${message.role === "user" ? "我" : "炫兜"}：${message.text}`)];
    const text = lines.filter(Boolean).join("\n");
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand("copy");
      area.remove();
    }
    setHint(copied ? "对话内容已复制，可以粘贴分享" : "复制失败，请允许剪贴板权限后再分享");
    window.setTimeout(() => setHint(""), 2500);
  }

  function beginSelect(id: string) {
    setMenuId("");
    setSelecting(true);
    setChecked((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function toggleChecked(id: string) {
    setChecked((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  function deleteConvs(ids: string[]) {
    setMenuId("");
    void apiFetch("/api/conversations/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((res) => {
      if (!res.ok) {
        setHint("删除没有保存");
        return;
      }
      setConvs((prev) => prev.filter((conv) => !ids.includes(conv.id)));
      if (ids.includes(activeIdRef.current)) {
        setActiveId("");
        setConfirming(null);
      }
      setChecked((prev) => {
        const next = prev.filter((id) => !ids.includes(id));
        if (next.length === 0) setSelecting(false);
        return next;
      });
    });
  }

  async function logout() {
    await endSession();
    wsRef.current?.close();
    router.replace("/login");
  }

  if (!ready || !user) {
    return <main className="boot">{error || "正在进入…"}</main>;
  }

  return (
    <div className={nav ? "app nav" : "app"}>
      <aside className="sidebar">
        <div className="side-head">
          <Mark />
          <strong>炫兜</strong>
        </div>
        <button className="new-chat" type="button" onClick={() => { setActiveId(""); setConfirming(null); setNav(false); }}>
          <Plus />
          开启新对话
        </button>
        {hint ? <div className="conv-hint">{hint}</div> : null}
        <div className="conv-list">
          {listed.map((conv) => (
            <div key={conv.id} className={conv.id === activeId ? "conv-row active" : menuId === conv.id ? "conv-row open" : "conv-row"}>
              {selecting ? (
                <input
                  className="conv-check"
                  type="checkbox"
                  checked={checked.includes(conv.id)}
                  aria-label={`选择${conv.title}`}
                  onChange={() => toggleChecked(conv.id)}
                />
              ) : null}
              {renameId === conv.id ? (
                <input
                  className="conv-rename"
                  value={renameDraft}
                  aria-label="会话名称"
                  autoFocus
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") renameConv(conv.id);
                    if (event.key === "Escape") setRenameId("");
                  }}
                  onBlur={() => renameConv(conv.id)}
                />
              ) : (
                <button
                  type="button"
                  className="conv"
                  onClick={() => {
                    if (selecting) {
                      toggleChecked(conv.id);
                      return;
                    }
                    setActiveId(conv.id);
                    setConfirming(null);
                    if (window.matchMedia("(max-width: 800px)").matches) setNav(false);
                  }}
                >
                  {conv.pinned ? <PinMark /> : null}
                  <span>{conv.title}</span>
                </button>
              )}
              <button type="button" className="conv-more" aria-label={`${conv.title}的更多操作`} onClick={(event) => openMenu(event, conv.id)}>
                ···
              </button>
            </div>
          ))}
        </div>
        {selecting ? (
          <div className="conv-select-bar">
            <span>已选 {checked.length}</span>
            <button type="button" disabled={!checked.length} onClick={() => deleteConvs(checked)}>
              删除
            </button>
            <button
              type="button"
              onClick={() => {
                setSelecting(false);
                setChecked([]);
              }}
            >
              取消
            </button>
          </div>
        ) : null}
        {menuId ? (
          <div className="conv-menu" style={{ top: menuPos.top, left: menuPos.left }} role="menu">
            <button type="button" onClick={() => { const conv = convs.find((item) => item.id === menuId); setMenuId(""); setRenameDraft(conv?.title || ""); setRenameId(menuId); }}>
              <Pencil /> 重命名
            </button>
            <button type="button" onClick={() => pinConv(menuId)}>
              <PinIcon /> {convs.find((item) => item.id === menuId)?.pinned ? "取消置顶" : "置顶"}
            </button>
            <button type="button" onClick={() => { const conv = convs.find((item) => item.id === menuId); if (conv) void shareConv(conv); }}>
              <ShareIcon /> 分享
            </button>
            <button type="button" onClick={() => beginSelect(menuId)}>
              <Checks /> 多选
            </button>
            <button type="button" className="danger" onClick={() => deleteConvs([menuId])}>
              <Trash /> 删除
            </button>
          </div>
        ) : null}
        <a className="console-link" href="/app/projects">
          管理后台
        </a>
        <div className="side-user">
          <span className="avatar">{(user.displayName || user.username).slice(0, 1)}</span>
          <span className="who">
            <b>{user.displayName || user.username}</b>
            <small>{user.username}</small>
          </span>
          <button type="button" className="text-btn" onClick={logout}>
            退出
          </button>
        </div>
      </aside>
      {nav ? <button className="scrim" type="button" aria-label="关闭会话列表" onClick={() => setNav(false)} /> : null}
      <main className="main">
        <header className="topbar">
          <button className="icon-btn" type="button" aria-label={nav ? "收起会话列表" : "打开会话列表"} onClick={() => setNav((value) => !value)}>
            <MenuIcon />
          </button>
          <div className="top-title">{active?.title || "新的对话"}</div>
          <div className={`link-state ${upstream}`}>
            <i />
            {upstream === "open" ? "通道已连接" : upstream === "connecting" ? "正在连接通道" : "通道未连接"}
          </div>
        </header>
        {hero ? (
          <section className="hero">
            <div className="hero-copy">
              <Mark size={48} />
              <h1>今天想推进什么？</h1>
            </div>
            <Composer
              draft={draft}
              setDraft={setDraft}
              boxRef={boxRef}
              files={files}
              maxLabel={maxLabel}
              removeFile={removeFile}
              confirming={confirming}
              clearConfirm={() => setConfirming(null)}
              error={error}
              showLink={showLink}
              setShowLink={setShowLink}
              projects={projects}
              pickedIds={pickedIds}
              onToggle={toggleProject}
              fileRef={fileRef}
              onAddFiles={addFiles}
              onSend={() => send()}
              waiting={waiting}
            />
            <div className="chips">
              {SUGGESTIONS.map((item) => (
                <button key={item} type="button" className="chip" disabled={waiting} onClick={() => send(item, null)}>
                  {item}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="stage">
            <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
              <div className="thread-inner">
                {messages.map((message) => (
                  <MessageView
                    key={message.clientMsgId || message.id}
                    message={message}
                    messages={messages}
                    busy={waiting}
                    editing={editingKey === messageKey(message)}
                    copied={copiedKey === messageKey(message)}
                    canRegenerate={Boolean(priorUser(message))}
                    onAccept={accept}
                    onRevise={setConfirming}
                    onCopy={() => void copyMessage(message)}
                    onEdit={() => setEditingKey(messageKey(message))}
                    onCancelEdit={() => setEditingKey("")}
                    onOpenImage={openGallery}
                    maxBytes={maxBytes}
                    maxLabel={maxLabel}
                    projects={projects}
                    onSubmitEdit={(text, attachments, projectIds) => resendEdited(text, attachments, projectIds)}
                    onRegenerate={() => regenerate(message)}
                  />
                ))}
              </div>
            </div>
            <div className="dock">
              <Composer
                draft={draft}
                setDraft={setDraft}
                boxRef={boxRef}
                files={files}
                maxLabel={maxLabel}
                removeFile={removeFile}
                confirming={confirming}
                clearConfirm={() => setConfirming(null)}
                error={error}
                showLink={showLink}
                setShowLink={setShowLink}
                projects={projects}
                pickedIds={pickedIds}
                onToggle={toggleProject}
                fileRef={fileRef}
                onAddFiles={addFiles}
                onSend={() => send()}
                waiting={waiting}
              />
            </div>
          </section>
        )}
      </main>
      {gallery ? (
        <ImageViewer
          items={gallery.items}
          index={gallery.index}
          onIndex={(index) => setGallery((current) => (current ? { ...current, index } : current))}
          onClose={() => setGallery(null)}
        />
      ) : null}
    </div>
  );
}

function MessageView({
  message,
  messages,
  busy,
  editing,
  copied,
  canRegenerate,
  onAccept,
  onRevise,
  onCopy,
  onEdit,
  onCancelEdit,
  onOpenImage,
  maxBytes,
  maxLabel,
  projects,
  onSubmitEdit,
  onRegenerate,
}: {
  message: ChatMessage;
  messages: ChatMessage[];
  busy: boolean;
  editing: boolean;
  copied: boolean;
  canRegenerate: boolean;
  onAccept: (message: ChatMessage) => void;
  onRevise: (value: Confirming) => void;
  onCopy: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onOpenImage: (url: string) => void;
  maxBytes: number;
  maxLabel: string;
  projects: Project[];
  onSubmitEdit: (text: string, attachments: ChatAttachment[], projectIds: string[]) => void;
  onRegenerate: () => void;
}) {
  if (message.role === "user") {
    const attachments = listedAttachments(message);
    const canEdit = Boolean(captionOf(message).trim() || attachments.length);
    return (
      <article className={editing ? "msg-user editing" : "msg-user"}>
        <div className="msg-col">
          {editing ? (
            <MessageEditor
              initial={captionOf(message)}
              attachments={attachments}
              busy={busy}
              maxBytes={maxBytes}
              maxLabel={maxLabel}
              projects={projects}
              initialProjectIds={message.projectId ? [message.projectId] : []}
              onCancel={onCancelEdit}
              onSubmit={onSubmitEdit}
            />
          ) : (
            <div className="bubble">
              {captionOf(message) ? <RichText text={captionOf(message)} /> : null}
              <AttachmentList message={message} onOpenImage={onOpenImage} />
              {message.pending ? <div className="pending">待送达，通道恢复后会自动发出</div> : null}
            </div>
          )}
          <MessageTime time={message.time} />
          {editing ? null : (
            <div className="msg-actions end">
              {messagePlain(message) ? <CopyButton copied={copied} onCopy={onCopy} /> : null}
              {canEdit ? (
                <button type="button" className="msg-tool" aria-label="修改后重新发送" title="修改" disabled={busy} onClick={onEdit}>
                  <PencilIcon />
                </button>
              ) : null}
            </div>
          )}
        </div>
      </article>
    );
  }
  const decided = message.requestId ? messages.some((item) => item.requestId === message.requestId && item.decision) : false;
  const showRegenerate = message.kind !== "progress" && !message.streaming;
  return (
    <article className="msg-ai">
      <Mark size={28} />
      <div className="ai-body">
        {message.kind === "confirm" ? <div className="card-kicker">需要你确认</div> : null}
        {message.kind === "progress" ? <div className="card-kicker">{message.stage || "进展"}</div> : null}
        {message.kind === "result" ? <div className="card-kicker">结果</div> : null}
        {captionOf(message) ? <RichText text={captionOf(message)} /> : null}
        <AttachmentList message={message} onOpenImage={onOpenImage} />
        {message.streaming ? <span className="cursor" /> : null}
        {message.kind === "progress" && message.percent >= 0 ? (
          <div className="bar" aria-valuenow={message.percent} aria-valuemin={0} aria-valuemax={100} role="progressbar">
            <span style={{ width: `${message.percent}%` }} />
          </div>
        ) : null}
        {message.url && !listedAttachments(message).some((item) => item.url === message.url) ? (
          <a className="result-link" href={message.url} target="_blank" rel="noreferrer">
            {message.kind === "file" ? "打开文件" : "打开结果"}
          </a>
        ) : null}
        {message.kind === "confirm" && message.requestId && !decided ? (
          <div className="card-actions">
            <button type="button" className="btn-primary" onClick={() => onAccept(message)}>
              同意
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onRevise({ requestId: message.requestId, conversationId: message.conversationId, quote: message.text })}
            >
              需要调整
            </button>
          </div>
        ) : null}
        <MessageTime time={message.time} />
        {messagePlain(message) || showRegenerate ? (
          <div className="msg-actions">
            {messagePlain(message) ? <CopyButton copied={copied} onCopy={onCopy} /> : null}
            {showRegenerate ? (
              <button type="button" className="msg-tool" aria-label="重新生成" title="重新生成" disabled={busy || !canRegenerate} onClick={onRegenerate}>
                <RefreshIcon />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function CopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" className="msg-tool" aria-label={copied ? "已复制" : "复制"} title={copied ? "已复制" : "复制"} onClick={onCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function MessageEditor({
  initial,
  attachments,
  busy,
  maxBytes,
  maxLabel,
  projects,
  initialProjectIds,
  onCancel,
  onSubmit,
}: {
  initial: string;
  attachments: ChatAttachment[];
  busy: boolean;
  maxBytes: number;
  maxLabel: string;
  projects: Project[];
  initialProjectIds: string[];
  onCancel: () => void;
  onSubmit: (text: string, attachments: ChatAttachment[], projectIds: string[]) => void;
}) {
  const [value, setValue] = useState(initial);
  const [pickedIds, setPickedIds] = useState(initialProjectIds);
  const [showLink, setShowLink] = useState(false);
  const [items, setItems] = useState<DraftFile[]>(() =>
    attachments.map((item) => ({
      id: item.url || newId(),
      name: item.name,
      mime: item.mime,
      size: item.size,
      status: "ready" as const,
      percent: 100,
      url: item.url,
      preview: imageAttachment(item) ? item.url : "",
      error: "",
    })),
  );
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const ready = items.filter((item) => item.status === "ready" && item.url);
  const picked = projects.filter((item) => pickedIds.includes(item.id));
  const canSend = !busy && !items.some((item) => item.status === "uploading") && (Boolean(value.trim()) || ready.length > 0);
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    fitEditor(area);
  }, []);
  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        if (item.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
      }
    };
  }, []);

  function submit() {
    if (!canSend) return;
    onSubmit(
      value,
      ready.map((item) => ({ name: item.name, mime: item.mime, url: item.url, size: item.size })),
      pickedIds.filter((id) => {
        const found = projects.find((item) => item.id === id);
        return !found || found.status !== 0;
      }),
    );
  }

  function toggleProject(id: string) {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  function addPicked(list: File[]) {
    const room = MAX_ATTACHMENTS - itemsRef.current.length;
    if (room <= 0) return;
    const accepted: Array<{ draft: DraftFile; file: File }> = [];
    for (const file of list.slice(0, room)) {
      const ext = extensionOf(file.name, file.type);
      if (!ext || file.size <= 0 || file.size > maxBytes) continue;
      const name = displayFileName(file.name, ext);
      const preview = file.type.startsWith("image/") || isImageFile(file.type, name) ? URL.createObjectURL(file) : "";
      accepted.push({
        file,
        draft: {
          id: newId(),
          name,
          mime: file.type || "application/octet-stream",
          size: file.size,
          status: "uploading",
          percent: 0,
          url: "",
          preview,
          error: "",
        },
      });
    }
    if (!accepted.length) return;
    setItems((prev) => [...prev, ...accepted.map((item) => item.draft)]);
    for (const item of accepted) void uploadEditorFile(item.draft.id, item.file);
  }

  async function uploadEditorFile(id: string, file: File) {
    try {
      const creds = await fetchUploadCredential(file);
      await postQiniu(file, creds, (percent) => {
        setItems((prev) => prev.map((item) => (item.id === id ? { ...item, percent } : item)));
      });
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "ready", percent: 100, url: creds.publicUrl } : item)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传失败，请稍后重试";
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "error", error: message } : item)));
    }
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const found = prev.find((item) => item.id === id);
      if (found?.preview.startsWith("blob:")) URL.revokeObjectURL(found.preview);
      return prev.filter((item) => item.id !== id);
    });
  }

  return (
    <form
      className="msg-edit"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {items.length ? (
        <div className="attach-row">
          {items.map((item) =>
            item.preview ? (
              <div key={item.id} className={item.status === "error" ? "attach-thumb bad" : "attach-thumb"} title={item.error || item.name}>
                <img src={item.preview} alt={item.name} />
                {item.status === "uploading" ? (
                  <i className="progress" aria-hidden="true">
                    <span style={{ width: `${item.percent}%` }} />
                  </i>
                ) : null}
                <button type="button" className="remove" onClick={() => removeItem(item.id)} aria-label={`移除${item.name}`}>
                  ×
                </button>
              </div>
            ) : (
              <div key={item.id} className={item.status === "error" ? "file-chip bad" : "file-chip"} title={item.error || item.name}>
                <span>{item.name}</span>
                <small>{item.status === "uploading" ? `${item.percent}%` : formatBytes(item.size)}</small>
                <button type="button" onClick={() => removeItem(item.id)} aria-label={`移除${item.name}`}>
                  ×
                </button>
              </div>
            ),
          )}
        </div>
      ) : null}
      {picked.length ? (
        <div className="picked">
          {picked.map((item) => (
            <button key={item.id} type="button" className="picked-chip" onClick={() => toggleProject(item.id)}>
              {item.name}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={ref}
        value={value}
        aria-label="修改消息"
        onChange={(event) => {
          setValue(event.target.value);
          fitEditor(event.target);
        }}
        onPaste={(event) => {
          const picked = filesFromClipboard(event.clipboardData);
          if (!picked.length) return;
          event.preventDefault();
          const pasted = event.clipboardData?.getData("text/plain") || "";
          if (pasted) insertText(event.currentTarget, pasted, setValue);
          addPicked(picked);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="msg-edit-bar">
        <div className="composer-tools">
          <button type="button" className="icon-btn" aria-label={`添加附件，单个不超过 ${maxLabel}`} title={`单个文件不超过 ${maxLabel}`} onClick={() => fileRef.current?.click()}>
            <Clip />
          </button>
          <span className="size-limit">{maxLabel}</span>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addPicked(filesFromList(event.target.files));
              event.target.value = "";
            }}
          />
          <button type="button" className={showLink || picked.length ? "link-project on" : "link-project"} onClick={() => setShowLink((open) => !open)}>
            关联项目{picked.length ? ` · ${picked.length}` : ""}
          </button>
        </div>
        <div className="msg-edit-actions">
          <button type="button" className="msg-edit-cancel" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="msg-edit-send" disabled={!canSend}>
            发送
          </button>
        </div>
      </div>
      {showLink ? <ProjectMenu projects={projects} pickedIds={pickedIds} onToggle={toggleProject} /> : null}
    </form>
  );
}

function fitEditor(area: HTMLTextAreaElement) {
  area.style.height = "0px";
  area.style.height = `${Math.min(220, Math.max(52, area.scrollHeight))}px`;
}

function MessageTime({ time }: { time: string }) {
  const text = displayTime(time);
  if (!text) return null;
  return <time className="msg-time" dateTime={text}>{text}</time>;
}

function displayTime(value: string): string {
  const matched = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return matched ? `${matched[1]} ${matched[2]}` : "";
}

function AttachmentList({ message, onOpenImage }: { message: ChatMessage; onOpenImage: (url: string) => void }) {
  const items = listedAttachments(message);
  if (!items.length) return null;
  return (
    <div className="attach-list">
      {items.map((item) =>
        imageAttachment(item) ? (
          <button key={item.url} type="button" className="attach-shot" aria-label={`预览${item.name || "图片"}`} onClick={() => onOpenImage(item.url)}>
            <img src={item.url} alt={item.name || "图片"} />
          </button>
        ) : (
          <a key={item.url} className="file-chip" href={item.url} target="_blank" rel="noreferrer">
            <span>{item.name}</span>
            {item.size > 0 ? <small>{formatBytes(item.size)}</small> : null}
          </a>
        ),
      )}
    </div>
  );
}

function ImageViewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: ChatAttachment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && items.length > 1) onIndex((index - 1 + items.length) % items.length);
      if (event.key === "ArrowRight" && items.length > 1) onIndex((index + 1) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, onIndex]);
  if (!item) return null;
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="图片预览" onClick={onClose}>
      <button type="button" className="viewer-close" aria-label="关闭预览" onClick={onClose}>
        ×
      </button>
      {items.length > 1 ? (
        <button
          type="button"
          className="viewer-nav prev"
          aria-label="上一张"
          onClick={(event) => {
            event.stopPropagation();
            onIndex((index - 1 + items.length) % items.length);
          }}
        >
          ‹
        </button>
      ) : null}
      <figure onClick={(event) => event.stopPropagation()}>
        <img src={item.url} alt={item.name || "图片"} />
        {items.length > 1 ? (
          <figcaption>
            {index + 1} / {items.length}
          </figcaption>
        ) : null}
      </figure>
      {items.length > 1 ? (
        <button
          type="button"
          className="viewer-nav next"
          aria-label="下一张"
          onClick={(event) => {
            event.stopPropagation();
            onIndex((index + 1) % items.length);
          }}
        >
          ›
        </button>
      ) : null}
    </div>
  );
}

function ProjectMenu({ projects, pickedIds, onToggle }: { projects: Project[]; pickedIds: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="project-menu" role="group" aria-label="选择项目">
      {projects.length ? (
        projects.map((item) => {
          const on = pickedIds.includes(item.id);
          return (
            <label key={item.id} className={on ? "project-option on" : "project-option"}>
              <input type="checkbox" checked={on} onChange={() => onToggle(item.id)} />
              <span>
                <b>{item.name}</b>
                <small>{item.code}</small>
              </span>
            </label>
          );
        })
      ) : (
        <p className="project-empty">
          还没有可选项目。<a href="/app/projects">去管理后台添加</a>
        </p>
      )}
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  boxRef,
  files,
  maxLabel,
  removeFile,
  confirming,
  clearConfirm,
  error,
  showLink,
  setShowLink,
  projects,
  pickedIds,
  onToggle,
  fileRef,
  onAddFiles,
  onSend,
  waiting,
}: {
  draft: string;
  setDraft: (value: string) => void;
  boxRef: { current: HTMLTextAreaElement | null };
  files: DraftFile[];
  maxLabel: string;
  removeFile: (id: string) => void;
  confirming: Confirming | null;
  clearConfirm: () => void;
  error: string;
  showLink: boolean;
  setShowLink: (value: boolean) => void;
  projects: Project[];
  pickedIds: string[];
  onToggle: (id: string) => void;
  fileRef: { current: HTMLInputElement | null };
  onAddFiles: (files: File[]) => void;
  onSend: () => void;
  waiting: boolean;
}) {
  const picked = projects.filter((item) => pickedIds.includes(item.id));
  return (
    <div className="composer-wrap">
      {error ? <div className="toast">{error}</div> : null}
      {confirming ? (
        <div className="replying">
          <span>正在回复确认</span>
          <button type="button" className="text-btn" onClick={clearConfirm}>
            取消
          </button>
        </div>
      ) : null}
      <div className="composer">
        {files.length ? (
          <div className="attach-row">
            {files.map((item) =>
              item.preview ? (
                <div key={item.id} className={item.status === "error" ? "attach-thumb bad" : "attach-thumb"} title={item.error || item.name}>
                  <img src={item.preview} alt={item.name} />
                  {item.status === "uploading" ? (
                    <i className="progress" aria-hidden="true">
                      <span style={{ width: `${item.percent}%` }} />
                    </i>
                  ) : null}
                  <button type="button" className="remove" onClick={() => removeFile(item.id)} aria-label={`移除${item.name}`}>
                    ×
                  </button>
                </div>
              ) : (
                <div key={item.id} className={item.status === "error" ? "file-chip bad" : "file-chip"} title={item.error || ""}>
                  <span>{item.name}</span>
                  <small>{item.status === "uploading" ? `${item.percent}%` : formatBytes(item.size)}</small>
                  <button type="button" onClick={() => removeFile(item.id)} aria-label={`移除${item.name}`}>
                    ×
                  </button>
                </div>
              ),
            )}
          </div>
        ) : null}
        {picked.length ? (
          <div className="picked">
            {picked.map((item) => (
              <button key={item.id} type="button" className="picked-chip" onClick={() => onToggle(item.id)}>
                {item.name}
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={boxRef}
          rows={1}
          value={draft}
          placeholder={confirming ? "说说要改哪里" : waiting ? "等待回复后再继续提问" : "给炫兜发消息"}
          aria-label="给炫兜发消息"
          onChange={(event) => {
            setDraft(event.target.value);
            event.target.style.height = "0px";
            event.target.style.height = `${Math.min(180, event.target.scrollHeight)}px`;
          }}
          onPaste={(event) => {
            const picked = filesFromClipboard(event.clipboardData);
            if (!picked.length) return;
            event.preventDefault();
            const pasted = event.clipboardData?.getData("text/plain") || "";
            if (pasted) insertText(event.currentTarget, pasted, setDraft);
            onAddFiles(picked);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-tools">
            <button type="button" className="icon-btn" aria-label={`添加附件，单个不超过 ${maxLabel}`} title={`单个文件不超过 ${maxLabel}`} onClick={() => fileRef.current?.click()}>
              <Clip />
            </button>
            <span className="size-limit">{maxLabel}</span>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                onAddFiles(filesFromList(event.target.files));
                event.target.value = "";
              }}
            />
            <button type="button" className={showLink || picked.length ? "link-project on" : "link-project"} onClick={() => setShowLink(!showLink)}>
              关联项目{picked.length ? ` · ${picked.length}` : ""}
            </button>
          </div>
          <button className="send" type="button" aria-label={waiting ? "等待回复" : "发送"} disabled={waiting || files.some((item) => item.status === "uploading") || (!draft.trim() && !files.some((item) => item.status === "ready"))} onClick={onSend}>
            <Arrow />
          </button>
        </div>
        {showLink ? <ProjectMenu projects={projects} pickedIds={pickedIds} onToggle={onToggle} /> : null}
      </div>
    </div>
  );
}

function releaseFiles(items: DraftFile[]) {
  for (const item of items) {
    if (item.preview) URL.revokeObjectURL(item.preview);
  }
}

function filesFromList(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

function filesFromClipboard(data: DataTransfer | null): File[] {
  const fromFiles = filesFromList(data?.files);
  if (fromFiles.length) return fromFiles;
  if (!data) return [];
  const list: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) list.push(file);
  }
  return list;
}

function insertText(box: HTMLTextAreaElement, extra: string, setDraft: (value: string) => void) {
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? box.value.length;
  const next = `${box.value.slice(0, start)}${extra}${box.value.slice(end)}`;
  setDraft(next);
  window.requestAnimationFrame(() => {
    box.selectionStart = start + extra.length;
    box.selectionEnd = start + extra.length;
    box.style.height = "0px";
    box.style.height = `${Math.min(180, box.scrollHeight)}px`;
  });
}

function messageKey(message: ChatMessage): string {
  return message.clientMsgId || message.id;
}

function messagePlain(message: ChatMessage): string {
  const text = (message.role === "user" ? captionOf(message) : message.text).trim();
  const lines = text ? [text] : [];
  if (message.role !== "user" && message.url && !text.includes(message.url)) lines.push(message.url);
  if (message.role === "user") {
    for (const item of listedAttachments(message)) {
      const line = item.url || item.name;
      if (line && !lines.includes(line)) lines.push(line);
    }
  }
  return lines.join("\n");
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

function captionOf(message: ChatMessage): string {
  const text = message.text.trim();
  const items = listedAttachments(message);
  if (!text || !items.length) return message.text;
  const names = items.map((item) => item.name).join("、");
  if (text === names || (items.length === 1 && text === items[0].name)) return "";
  return message.text;
}

function imageAttachment(item: ChatAttachment): boolean {
  if (isImageFile(item.mime, item.name)) return true;
  const path = item.url.split("?")[0].split("#")[0];
  return isImageFile("", path);
}

function userImages(messages: ChatMessage[]): ChatAttachment[] {
  const list: ChatAttachment[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const item of listedAttachments(message)) {
      if (imageAttachment(item) && item.url && !list.some((have) => have.url === item.url)) list.push(item);
    }
  }
  return list;
}

function listedAttachments(message: ChatMessage): ChatAttachment[] {
  if (Array.isArray(message.attachments) && message.attachments.length) return message.attachments;
  if (message.url && (message.role === "user" || message.kind === "file")) {
    return [{ name: message.fileName || "附件", mime: "", url: message.url, size: 0 }];
  }
  return [];
}

function normalizeMessage(message: ChatMessage): ChatMessage {
  return { ...message, attachments: Array.isArray(message.attachments) ? message.attachments : [] };
}

function inOpenConversation(message: ChatMessage, activeId: string): ChatMessage {
  const missing = !message.conversationId || message.conversationId === "inbox";
  if (!missing) return message;
  return { ...message, conversationId: activeId || newId() };
}

function applyMessage(prev: Conv[], message: ChatMessage): Conv[] {
  const convs = prev.map((item) => ({ ...item, messages: item.messages.slice() }));
  let index = convs.findIndex((item) => item.id === message.conversationId);
  if (index < 0) {
    convs.unshift({ id: message.conversationId, title: "新的对话", updatedAt: Date.now(), messages: [], renamed: false, pinned: false });
    index = 0;
  }
  const conv = convs[index];
  const found = conv.messages.findIndex((item) => (message.clientMsgId && item.clientMsgId === message.clientMsgId) || item.id === message.id);
  if (found >= 0) conv.messages[found] = mergeMessage(conv.messages[found], message);
  else conv.messages.push(message);
  const firstUser = conv.messages.find((item) => item.role === "user" && item.text);
  if (!conv.renamed) conv.title = titleFrom(firstUser?.text || message.text);
  conv.updatedAt = Date.now();
  const [item] = convs.splice(index, 1);
  convs.unshift(item);
  return trim(convs);
}

function applyDelta(prev: Conv[], message: ChatMessage, done: boolean): Conv[] {
  const streamId = message.streamId || message.clientMsgId;
  if (!streamId) return prev;
  const convs = prev.map((item) => ({ ...item, messages: item.messages.slice() }));
  let index = convs.findIndex((item) => item.id === message.conversationId);
  if (index < 0) {
    if (done) return prev;
    convs.unshift({ id: message.conversationId, title: "新的对话", updatedAt: Date.now(), messages: [], renamed: false, pinned: false });
    index = 0;
  }
  const messages = convs[index].messages;
  const found = messages.findIndex((item) => item.streamId === streamId);
  if (found < 0) {
    if (done) return prev;
    messages.push(blankMessage({ ...message, id: message.id || streamId, clientMsgId: streamId, streamId, kind: "chat", role: "assistant", streaming: true }));
  } else {
    const current = messages[found];
    messages[found] = {
      ...current,
      text: done && message.text ? message.text : current.text + message.text,
      streaming: !done,
      time: message.time || current.time,
      id: /^\d{10,}$/.test(message.id) ? message.id : current.id,
    };
  }
  convs[index].updatedAt = Date.now();
  return convs;
}

function removeMessage(prev: Conv[], clientMsgId: string): Conv[] {
  return prev
    .map((conv) => ({ ...conv, messages: conv.messages.filter((item) => item.clientMsgId !== clientMsgId) }))
    .filter((conv) => conv.messages.length > 0);
}

function sortConvs(convs: Conv[]): Conv[] {
  return [...convs].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
    return b.updatedAt - a.updatedAt;
  });
}

function trim(convs: Conv[]): Conv[] {
  return sortConvs(convs).slice(0, 50).map((conv) => ({ ...conv, messages: conv.messages.slice(-200) }));
}

function awaitingReply(messages: ChatMessage[]): boolean {
  if (messages.some((message) => message.streaming)) return true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "system") continue;
    return message.role === "user";
  }
  return false;
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "新的对话";
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean;
}

function mergeList(prev: Conv[], items: ConvMeta[], renaming: string): Conv[] {
  const local = new Map(prev.map((conv) => [conv.id, conv]));
  const ids = new Set(items.map((item) => item.id));
  const merged = items.map((item) => {
    const old = local.get(item.id);
    if (!old) return { ...item, messages: [] };
    return {
      ...old,
      title: renaming === item.id ? old.title : item.title,
      renamed: item.renamed,
      pinned: item.pinned,
      pinnedAt: item.pinnedAt || 0,
      updatedAt: item.updatedAt,
    };
  });
  const fresh = prev.filter((conv) => !ids.has(conv.id) && Date.now() - conv.updatedAt < 15000);
  return sortConvs([...fresh, ...merged]);
}

function replaceMessages(prev: Conv[], conversationId: string, incoming: ChatMessage[]): Conv[] {
  let changed = false;
  const next = prev.map((conv) => {
    if (conv.id !== conversationId) return conv;
    const messages = mergeMessages(conv.messages, incoming);
    if (messagesEqual(conv.messages, messages)) return conv;
    changed = true;
    return { ...conv, messages };
  });
  return changed ? next : prev;
}

function messagesEqual(local: ChatMessage[], next: ChatMessage[]): boolean {
  if (local.length !== next.length) return false;
  for (let index = 0; index < local.length; index += 1) {
    const left = local[index];
    const right = next[index];
    if (left === right) continue;
    if (
      left.id !== right.id ||
      left.clientMsgId !== right.clientMsgId ||
      left.role !== right.role ||
      left.kind !== right.kind ||
      left.text !== right.text ||
      left.time !== right.time ||
      left.streaming !== right.streaming ||
      left.pending !== right.pending ||
      left.projectId !== right.projectId ||
      left.url !== right.url ||
      left.fileName !== right.fileName ||
      left.decision !== right.decision ||
      left.percent !== right.percent ||
      left.stage !== right.stage ||
      attachmentKey(left) !== attachmentKey(right)
    ) {
      return false;
    }
  }
  return true;
}

function attachmentKey(message: ChatMessage): string {
  const items = Array.isArray(message.attachments) ? message.attachments : [];
  return items.map((item) => `${item.url}|${item.name}|${item.size}`).join("\n");
}

function mergeMessages(local: ChatMessage[], remote: ChatMessage[]): ChatMessage[] {
  const merged = remote.map((item) => normalizeMessage(item));
  const indexOf = (message: ChatMessage) =>
    merged.findIndex(
      (item) =>
        (message.streamId && item.streamId === message.streamId) ||
        (message.clientMsgId && item.clientMsgId === message.clientMsgId) ||
        item.id === message.id,
    );
  for (const message of local) {
    const found = indexOf(message);
    if (found < 0) {
      merged.push(normalizeMessage(message));
      continue;
    }
    const current = merged[found];
    const remoteItems = Array.isArray(current.attachments) ? current.attachments : [];
    const localItems = Array.isArray(message.attachments) ? message.attachments : [];
    if (!remoteItems.length && localItems.length) current.attachments = localItems;
    if (!current.url && message.url) current.url = message.url;
    if (!current.fileName && message.fileName) current.fileName = message.fileName;
    if ((message.pending || message.streaming) && message.text.length > current.text.length) {
      merged[found] = { ...current, text: message.text, pending: message.pending, streaming: message.streaming };
    }
  }
  return merged.slice(-200);
}

function PinMark() {
  return (
    <svg className="pin-mark" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 2.5h4l-.6 3.2 2.1 2.1H8.8V13L8 14l-.8-1V7.8H4.5l2.1-2.1L6 2.5z" fill="currentColor" />
    </svg>
  );
}

function Pencil() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.2 3.2l3.6 3.6L5.4 14H1.8v-3.6L9.2 3.2zM8.2 4.2l-5.2 5.2V13h3.6l5.2-5.2-3.6-3.6z" fill="currentColor" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 1.8h4l-.7 3.4 2.4 2.3H8.9V13L8 14.2 7.1 13V7.5H4.3l2.4-2.3L6 1.8z" fill="currentColor" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.2 5.2L8 3.4 9.8 5.2M8 3.8V9.6M4.2 8.2v4.2h7.6V8.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Checks() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 4.5h2.2M6.2 4.5H14M2 8h2.2M6.2 8H14M2 11.5h2.2M6.2 11.5H14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function Trash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 4.2h9.6M6.2 4.1V2.8h3.6v1.3M4.4 4.2l.6 9h5.9l.6-9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Plus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Clip() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M7 9.5l4.2-4.2a2.4 2.4 0 0 1 3.4 3.4L8.2 15a3.6 3.6 0 0 1-5.1-5.1L8.6 4.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.4" y="5.4" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.4 5.2V3.7A1.5 1.5 0 0 0 8.9 2.2H3.7A1.5 1.5 0 0 0 2.2 3.7V8.9A1.5 1.5 0 0 0 3.7 10.4H5.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.3l3 3 6.6-6.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.4 3.1l3.5 3.5-7.2 7.2-3.6.6.6-3.6 6.7-7.7z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8.2 4.3l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.52-3.68" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13.5 2.5v3.3H10.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
