"use client";

import { useEffect, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";

type Menu = { id: string; name: string; path: string; perm: string };
type Row = Record<string, string | number>;

const fields: Record<string, { key: string; label: string }[]> = {
  projects: [
    { key: "name", label: "名称" },
    { key: "code", label: "编码" },
  ],
  tasks: [
    { key: "projectId", label: "项目 ID" },
    { key: "title", label: "标题" },
  ],
  problems: [
    { key: "projectId", label: "项目 ID" },
    { key: "title", label: "标题" },
    { key: "detail", label: "说明" },
  ],
  users: [
    { key: "username", label: "账号" },
    { key: "password", label: "密码" },
    { key: "displayName", label: "显示名" },
    { key: "roleId", label: "角色 ID" },
  ],
  roles: [
    { key: "code", label: "编码" },
    { key: "name", label: "名称" },
  ],
  menus: [
    { key: "name", label: "名称" },
    { key: "path", label: "路径" },
    { key: "perm", label: "权限" },
  ],
};

export default function ConsolePage() {
  const router = useRouter();
  const pathname = usePathname();
  const view = pathname.split("/").filter(Boolean)[1] || "projects";
  const [menus, setMenus] = useState<Menu[]>([]);
  const [items, setItems] = useState<Row[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/auth/me?menus=1")
      .then((data) => setMenus(data.menus || []))
      .catch(() => router.replace(`/login?next=${encodeURIComponent(pathname)}`));
  }, [router, pathname]);

  useEffect(() => {
    api(`/api/${view}`)
      .then((data) => {
        setItems(data.items || []);
        setError("");
      })
      .catch((reason: Error) => {
        if (reason.message === "unauthorized") {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(reason.message);
      });
  }, [view, router, pathname]);

  async function createItem(event: FormEvent) {
    event.preventDefault();
    setError("");
    const response = await fetch(`/api/${view}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (response.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    setForm({});
    const data = await api(`/api/${view}`);
    setItems(data.items || []);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  const columns = items[0] ? Object.keys(items[0]).filter((key) => key !== "detail") : [];

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside style={{ width: 220, background: "#111827", color: "#fff", padding: 16 }}>
        <strong>功能菜单</strong>
        <nav style={{ display: "grid", gap: 8, marginTop: 16 }}>
          <a href="/" style={{ color: "#fff", textDecoration: "none" }}>
            对话
          </a>
          {menus.map((menu) => (
            <a key={menu.id} href={menu.path} style={{ color: menu.path.endsWith("/" + view) ? "#93c5fd" : "#fff", textDecoration: "none" }}>
              {menu.name}
            </a>
          ))}
        </nav>
        <button onClick={logout} style={{ marginTop: 24, background: "transparent", color: "#fff", border: "1px solid #374151", borderRadius: 8, padding: "6px 10px" }}>
          退出
        </button>
      </aside>
      <main style={{ flex: 1, padding: 24 }}>
        <h1 style={{ marginTop: 0 }}>{menus.find((menu) => menu.path.endsWith("/" + view))?.name || view}</h1>
        <form onSubmit={createItem} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {(fields[view] || []).map((field) => (
            <input
              key={field.key}
              placeholder={field.label}
              value={form[field.key] || ""}
              onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
              style={{ padding: "8px 10px", border: "1px solid #d0d5dd", borderRadius: 8 }}
            />
          ))}
          <button type="submit" style={{ padding: "8px 12px", background: "#1d4ed8", color: "#fff", border: 0, borderRadius: 8 }}>
            新增
          </button>
        </form>
        {error ? <p style={{ color: "#b42318" }}>{error}</p> : null}
        <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff" }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb" }}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={String(item.id)}>
                {columns.map((column) => (
                  <td key={column} style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>
                    {String(item[column] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </div>
  );
}

async function api(path: string) {
  const response = await fetch(path);
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
