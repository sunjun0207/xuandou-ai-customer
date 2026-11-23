"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mark } from "./mark";
import { RichText } from "./rich-text";
import { blankMessage, mergeMessage, newId, type ChatMessage, type ServerFrame, type UpstreamState } from "../shared/protocol";

type User = { userId: string; username: string; displayName: string; roleCode: string };
type Conv = { id: string; title: string; updatedAt: number; messages: ChatMessage[] };
type DraftFile = { name: string; mime: string; dataBase64: string };
type Confirming = { requestId: string; conversationId: string; quote: string };

const SUGGESTIONS = ["我想提一个新需求，先帮我把边界问清楚", "帮我看一下当前需求做到哪一步了", "这个改动如果要跨系统，先列出要确认的点"];

export function ChatApp() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [projectId, setProjectId] = useState("");
  const [problemId, setProblemId] = useState("");
  const [showLink, setShowLink] = useState(false);
  const [upstream, setUpstream] = useState<UpstreamState>("connecting");
  const [nav, setNav] = useState(true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [file, setFile] = useState<DraftFile | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
        try {
          const saved = JSON.parse(localStorage.getItem(storageKey(body.user.username)) || "null") as {
            convs?: Conv[];
            activeId?: string;
            projectId?: string;
            problemId?: string;
          } | null;
          if (saved?.convs) setConvs(saved.convs);
          if (typeof saved?.activeId === "string") setActiveId(saved.activeId);
          if (typeof saved?.projectId === "string") setProjectId(saved.projectId);
          if (typeof saved?.problemId === "string") setProblemId(saved.problemId);
        } catch {
          // 本地没有可用的会话缓存。
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
    localStorage.setItem(storageKey(user.username), JSON.stringify({ convs: trim(convs), activeId, projectId, problemId }));
  }, [user, hydrated, convs, activeId, projectId, problemId]);

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
          if (frame.clientMsgId) setConvs((prev) => removeMessage(prev, frame.clientMsgId));
        }
        if (frame.type === "message") setConvs((prev) => applyMessage(prev, frame.message));
        if (frame.type === "delta") setConvs((prev) => applyDelta(prev, frame.message, frame.done));
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

  const active = convs.find((item) => item.id === activeId);
  const messages = active?.messages || [];
  const hero = messages.length === 0;

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, messages[messages.length - 1]?.text]);

  function send(text = draft.trim(), confirm = confirming) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("连接已断开，这句话还没发出");
      return;
    }
    if (!text && !file) return;
    const conversationId = activeId || newId("c");
    const clientMsgId = newId("m");
    const linked = { projectId: projectId.trim(), problemId: problemId.trim() };
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
    if (boxRef.current) boxRef.current.style.height = "";
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
        clientMsgId: newId("m"),
        requestId: message.requestId,
        decision: "accept",
        text: "同意",
        projectId: projectId.trim(),
        problemId: problemId.trim(),
      }),
    );
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
        <div className="conv-list">
          {convs.map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={conv.id === activeId ? "conv active" : "conv"}
              onClick={() => {
                setActiveId(conv.id);
                setConfirming(null);
                if (window.matchMedia("(max-width: 800px)").matches) setNav(false);
              }}
            >
              {conv.title}
            </button>
          ))}
        </div>
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
              projectId={projectId}
              problemId={problemId}
              setProjectId={setProjectId}
              setProblemId={setProblemId}
              fileRef={fileRef}
              onFile={onFile}
              onSend={() => send()}
            />
            <div className="chips">
              {SUGGESTIONS.map((item) => (
                <button key={item} type="button" className="chip" onClick={() => send(item, null)}>
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
                projectId={projectId}
                problemId={problemId}
                setProjectId={setProjectId}
                setProblemId={setProblemId}
                fileRef={fileRef}
                onFile={onFile}
                onSend={() => send()}
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
  projectId,
  problemId,
  setProjectId,
  setProblemId,
  fileRef,
  onFile,
  onSend,
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
  projectId: string;
  problemId: string;
  setProjectId: (value: string) => void;
  setProblemId: (value: string) => void;
  fileRef: { current: HTMLInputElement | null };
  onFile: (list: FileList | null) => void;
  onSend: () => void;
}) {
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
        <textarea
          ref={boxRef}
          rows={1}
          value={draft}
          placeholder={confirming ? "说说要改哪里" : "给炫兜发消息"}
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
            <button type="button" className={showLink ? "text-btn on" : "text-btn"} onClick={() => setShowLink(!showLink)}>
              关联项目
            </button>
          </div>
          <button className="send" type="button" aria-label="发送" disabled={!draft.trim() && !file} onClick={onSend}>
            <Arrow />
          </button>
        </div>
        {showLink ? (
          <div className="link-row">
            <input value={projectId} placeholder="项目 ID" aria-label="项目 ID" onChange={(event) => setProjectId(event.target.value)} />
            <input value={problemId} placeholder="问题 ID" aria-label="问题 ID" onChange={(event) => setProblemId(event.target.value)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function applyMessage(prev: Conv[], message: ChatMessage): Conv[] {
  const convs = prev.map((item) => ({ ...item, messages: item.messages.slice() }));
  let index = convs.findIndex((item) => item.id === message.conversationId);
  if (index < 0) {
    convs.unshift({ id: message.conversationId, title: "新的对话", updatedAt: Date.now(), messages: [] });
    index = 0;
  }
  const conv = convs[index];
  const found = conv.messages.findIndex((item) => (message.clientMsgId && item.clientMsgId === message.clientMsgId) || item.id === message.id);
  if (found >= 0) conv.messages[found] = mergeMessage(conv.messages[found], message);
  else conv.messages.push(message);
  const firstUser = conv.messages.find((item) => item.role === "user" && item.text);
  conv.title = titleFrom(firstUser?.text || message.text);
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
    convs.unshift({ id: message.conversationId, title: "新的对话", updatedAt: Date.now(), messages: [] });
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

function trim(convs: Conv[]): Conv[] {
  return convs.slice(0, 50).map((conv) => ({ ...conv, messages: conv.messages.slice(-200) }));
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "新的对话";
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean;
}

function storageKey(username: string): string {
  return `xd-customer:${username}`;
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
