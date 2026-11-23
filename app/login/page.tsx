"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Mark } from "../mark";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me").then((res) => {
      if (res.ok) router.replace(destination());
    });
  }, [router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error || "登录失败");
        return;
      }
      router.replace(destination());
    } catch {
      setError("网络异常，请重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <Mark size={42} />
        <h1>玄斗</h1>
        <p>把需求说清楚，研发管线会接着做。</p>
        <label className="field">
          <span>账号</span>
          <input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <div className="toast">{error}</div> : null}
        <button className="btn-primary login-submit" type="submit" disabled={pending || !username || !password}>
          {pending ? "正在进入…" : "进入"}
        </button>
      </form>
    </main>
  );
}

function destination(): string {
  const next = new URLSearchParams(window.location.search).get("next") || "";
  return next.startsWith("/app") ? next : "/";
}
