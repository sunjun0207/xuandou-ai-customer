"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mark } from "./mark";
import { RichText } from "./rich-text";
import { blankMessage, mergeMessage, newId, type ChatMessage, type ServerFrame, type UpstreamState } from "../shared/protocol";
import { nextSnowflake } from "../shared/snowflake";

type User = { userId: string; username: string; displayName: string; roleCode: string };
type ConvMeta = { id: string; title: string; updatedAt: number; renamed?: boolean; pinned?: boolean; pinnedAt?: number };
type Conv = ConvMeta & { messages: ChatMessage[] };
type DraftFile = { name: string; mime: string; dataBase64: string };
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
  const [file, setFile] = useState<DraftFile | null>(null);
  const [menuId, setMenuId] = useState("");
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [renameId, setRenameId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [hold, setHold] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const threadRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const renameIdRef = useRef("");
  const holdRef = useRef(false);
  renameIdRef.current = renameId;

  useEffect(() => {
    let stop = false;
    fetch("/api/auth/me")
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        const body = (await res.json()) as { user: User };
        if (stop) return;
        setUser(body.user);
        const loaded = await fetch("/api/conversations");
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
      const listed = await fetch("/api/conversations");
      if (stop || listed.status === 401) return;
      if (!listed.ok) return;
      const data = (await listed.json()) as { items?: ConvMeta[] };
      const items = Array.isArray(data.items) ? data.items : [];
      setConvs((prev) => mergeList(prev, items, renameIdRef.current));
      const current = activeIdRef.current;
      if (!current) return;
      const detail = await fetch(`/api/conversations/${encodeURIComponent(current)}`);
      if (stop || !detail.ok) return;
      const body = (await detail.json()) as { item?: ConvMeta & { messages?: ChatMessage[] } };
      const messages = Array.isArray(body.item?.messages) ? body.item.messages : [];
      setConvs((prev) => prev.map((conv) => (conv.id === current ? { ...conv, messages: mergeMessages(conv.messages, messages) } : conv)));
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
  }, [user, hydrated]);

  useEffect(() => {
    if (!user || !hydrated || !activeId) return;
    let stop = false;
    fetch(`/api/conversations/${encodeURIComponent(activeId)}`)
      .then(async (res) => {
        if (stop || !res.ok) return;
        const body = (await res.json()) as { item?: { messages?: ChatMessage[] } };
        const messages = Array.isArray(body.item?.messages) ? body.item.messages : [];
        setConvs((prev) => prev.map((conv) => (conv.id === activeId ? { ...conv, messages: mergeMessages(conv.messages, messages) } : conv)));
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [user, hydrated, activeId]);

  useEffect(() => {
    if (!user) return;
    fetch("/api/projects")
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
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = socket;
      socket.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame;
        } catch {
          return;
        }
        if (frame.type === "ready" || frame.type === "status") setUpstream(frame.upstream);
        if (frame.type === "error") {
          setError(frame.error);
          holdRef.current = false;
          setHold(false);
          if (frame.clientMsgId) setConvs((prev) => removeMessage(prev, frame.clientMsgId));
        }
        if (frame.type === "message") setConvs((prev) => applyMessage(prev, inOpenConversation(frame.message, activeIdRef.current)));
        if (frame.type === "delta") setConvs((prev) => applyDelta(prev, inOpenConversation(frame.message, activeIdRef.current), frame.done));
      };
      socket.onclose = () => {
        if (wsRef.current !== socket) return;
        setUpstream("down");
        if (!stopped) timer = window.setTimeout(connect, 1500);
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
  }, [user, hydrated]);

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

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, messages[messages.length - 1]?.text]);

  function send(text = draft.trim(), confirm = confirming) {
    if ((holdRef.current || awaitingReply(messages)) && !confirm) return;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("连接已断开，这句话还没发出");
      return;
    }
    if (!text && !file) return;
    const conversationId = activeId || newId();
    const clientMsgId = newId();
    const projectIds = pickedIds.filter((id) => {
      const found = projects.find((item) => item.id === id);
      return !found || found.status !== 0;
    });
    const linked = { projectId: projectIds[0] || "", projectIds, problemId: projectIds.length ? nextSnowflake() : "" };
    if (!activeId) setActiveId(conversationId);
    if (file) {
      socket.send(JSON.stringify({ type: "file", conversationId, clientMsgId, text, name: file.name, mime: file.mime, dataBase64: file.dataBase64, ...linked }));
    } else if (confirm) {
      socket.send(
        JSON.stringify({
          type: "confirm",
          conversationId: confirm.conversationId,
          clientMsgId,
          requestId: confirm.requestId,
          decision: "reject",
          text: text || "需要调整",
          projectId: linked.projectId,
          projectIds: linked.projectIds,
          problemId: linked.problemId,
        }),
      );
    } else {
      socket.send(JSON.stringify({ type: "send", conversationId, clientMsgId, text, ...linked }));
    }
    setDraft("");
    setFile(null);
    setConfirming(null);
    setError("");
    holdRef.current = true;
    setHold(true);
    if (boxRef.current) boxRef.current.style.height = "";
  }

  function toggleProject(id: string) {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  function accept(message: ChatMessage) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("连接已断开，确认还没发出");
      return;
    }
    socket.send(
      JSON.stringify({
        type: "confirm",
        conversationId: message.conversationId,
        clientMsgId: newId(),
        requestId: message.requestId,
        decision: "accept",
        text: "同意",
        projectId: pickedIds[0] || "",
        projectIds: pickedIds,
        problemId: pickedIds.length ? nextSnowflake() : "",
      }),
    );
    holdRef.current = true;
    setHold(true);
  }

  function onFile(list: FileList | null) {
    const picked = list?.[0];
    if (!picked) return;
    if (picked.size > 1_500_000) {
      setError("附件不能超过 1.5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const dataBase64 = result.slice(result.indexOf(",") + 1);
      setFile({ name: picked.name, mime: picked.type || "application/octet-stream", dataBase64 });
    };
    reader.readAsDataURL(picked);
    if (fileRef.current) fileRef.current.value = "";
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
    void fetch(`/api/conversations/${encodeURIComponent(id)}`, {
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
    void fetch(`/api/conversations/${encodeURIComponent(id)}`, {
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
    void fetch("/api/conversations/delete", {
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
    wsRef.current?.close();
    await fetch("/api/auth/logout", { method: "POST" });
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
          项目后台
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
              file={file}
              clearFile={() => setFile(null)}
              confirming={confirming}
              clearConfirm={() => setConfirming(null)}
              error={error}
              showLink={showLink}
              setShowLink={setShowLink}
              projects={projects}
              pickedIds={pickedIds}
              onToggle={toggleProject}
              fileRef={fileRef}
              onFile={onFile}
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
            <div className="thread" ref={threadRef}>
              <div className="thread-inner">
                {messages.map((message) => (
                  <MessageView key={message.clientMsgId || message.id} message={message} messages={messages} onAccept={accept} onRevise={setConfirming} />
                ))}
              </div>
            </div>
            <div className="dock">
              <Composer
                draft={draft}
                setDraft={setDraft}
                boxRef={boxRef}
                file={file}
                clearFile={() => setFile(null)}
                confirming={confirming}
                clearConfirm={() => setConfirming(null)}
                error={error}
                showLink={showLink}
                setShowLink={setShowLink}
                projects={projects}
                pickedIds={pickedIds}
                onToggle={toggleProject}
                fileRef={fileRef}
                onFile={onFile}
                onSend={() => send()}
                waiting={waiting}
              />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function MessageView({
  message,
  messages,
  onAccept,
  onRevise,
}: {
  message: ChatMessage;
  messages: ChatMessage[];
  onAccept: (message: ChatMessage) => void;
  onRevise: (value: Confirming) => void;
}) {
  if (message.role === "user") {
    return (
      <article className="msg-user" title={message.time}>
        <div className="bubble">
          <RichText text={message.text} />
          {message.fileName ? <div className="file-chip">{message.fileName}</div> : null}
          {message.pending ? <div className="pending">待送达，通道恢复后会自动发出</div> : null}
        </div>
      </article>
    );
  }
  const decided = message.requestId ? messages.some((item) => item.requestId === message.requestId && item.decision) : false;
  return (
    <article className="msg-ai" title={message.time}>
      <Mark size={28} />
      <div className="ai-body">
        {message.kind === "confirm" ? <div className="card-kicker">需要你确认</div> : null}
        {message.kind === "progress" ? <div className="card-kicker">{message.stage || "进展"}</div> : null}
        {message.kind === "result" ? <div className="card-kicker">结果</div> : null}
        <RichText text={message.text} />
        {message.streaming ? <span className="cursor" /> : null}
        {message.kind === "progress" && message.percent >= 0 ? (
          <div className="bar" aria-valuenow={message.percent} aria-valuemin={0} aria-valuemax={100} role="progressbar">
            <span style={{ width: `${message.percent}%` }} />
          </div>
        ) : null}
        {message.url ? (
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
      </div>
    </article>
  );
}

function Composer({
  draft,
  setDraft,
  boxRef,
  file,
  clearFile,
  confirming,
  clearConfirm,
  error,
  showLink,
  setShowLink,
  projects,
  pickedIds,
  onToggle,
  fileRef,
  onFile,
  onSend,
  waiting,
}: {
  draft: string;
  setDraft: (value: string) => void;
  boxRef: { current: HTMLTextAreaElement | null };
  file: DraftFile | null;
  clearFile: () => void;
  confirming: Confirming | null;
  clearConfirm: () => void;
  error: string;
  showLink: boolean;
  setShowLink: (value: boolean) => void;
  projects: Project[];
  pickedIds: string[];
  onToggle: (id: string) => void;
  fileRef: { current: HTMLInputElement | null };
  onFile: (list: FileList | null) => void;
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
        {file ? (
          <div className="file-chip">
            {file.name}
            <button type="button" onClick={clearFile} aria-label="移除附件">
              ×
            </button>
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
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-tools">
            <button type="button" className="icon-btn" aria-label="添加附件" onClick={() => fileRef.current?.click()}>
              <Clip />
            </button>
            <input ref={fileRef} type="file" hidden onChange={(event) => onFile(event.target.files)} />
            <button type="button" className={showLink || picked.length ? "text-btn on" : "text-btn"} onClick={() => setShowLink(!showLink)}>
              关联项目{picked.length ? ` · ${picked.length}` : ""}
            </button>
          </div>
          <button className="send" type="button" aria-label={waiting ? "等待回复" : "发送"} disabled={waiting || (!draft.trim() && !file)} onClick={onSend}>
            <Arrow />
          </button>
        </div>
        {showLink ? (
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
                还没有可选项目。<a href="/app/projects">去项目后台添加</a>
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
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

function mergeMessages(local: ChatMessage[], remote: ChatMessage[]): ChatMessage[] {
  const merged = remote.map((item) => ({ ...item }));
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
      merged.push(message);
      continue;
    }
    const current = merged[found];
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

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
