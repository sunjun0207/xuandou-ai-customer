"use client";

import { useEffect, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Mark } from "../../mark";

type Menu = { id: string; name: string; path: string; perm: string };
type Row = Record<string, string | number>;

const fields: Record<string, { key: string; label: string; wide?: boolean }[]> = {
  projects: [
    { key: "name", label: "项目名称" },
    { key: "code", label: "项目编码" },
  ],
  tasks: [
    { key: "projectId", label: "所属项目" },
    { key: "title", label: "任务标题", wide: true },
  ],
  problems: [
    { key: "projectId", label: "所属项目" },
    { key: "title", label: "问题标题" },
    { key: "detail", label: "说明", wide: true },
  ],
  users: [
    { key: "username", label: "账号" },
    { key: "password", label: "密码" },
    { key: "displayName", label: "显示名" },
    { key: "roleId", label: "角色编号" },
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

const labels: Record<string, string> = {
  id: "编号",
  name: "名称",
  code: "编码",
  status: "状态",
  createdAt: "创建时间",
  title: "标题",
  projectId: "项目编号",
  taskId: "任务编号",
  detail: "说明",
  username: "账号",
  displayName: "显示名",
  roleId: "角色编号",
  roleName: "角色",
  path: "路径",
  perm: "权限",
  ownerUserId: "负责人",
  assigneeUserId: "执行人",
};

export default function ConsolePage() {
  const router = useRouter();
  const pathname = usePathname();
  const view = pathname.split("/").filter(Boolean)[1] || "projects";
  const [menus, setMenus] = useState<Menu[]>([]);
  const [items, setItems] = useState<Row[]>([]);
  const [projects, setProjects] = useState<Row[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

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
    if (view === "tasks" || view === "problems") {
      api("/api/projects")
        .then((data) => setProjects(data.items || []))
        .catch(() => setProjects([]));
    }
  }, [view, router, pathname]);

  async function createItem(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch(`/api/${view}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setPending(false);
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

  async function removeItem(id: string) {
    const response = await fetch(`/api/${view}/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setError(response.status === 409 ? "这条记录还被引用，不能删除" : await response.text());
      return;
    }
    setItems((prev) => prev.filter((item) => String(item.id) !== id));
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  const title = menus.find((menu) => menu.path.endsWith("/" + view))?.name || "项目";
  const columns = items[0] ? Object.keys(items[0]).filter((key) => key !== "detail" && key !== "ownerUserId" && key !== "assigneeUserId") : [];

  return (
    <div className="console">
      <aside className="console-side">
        <a className="console-brand" href="/">
          <Mark />
          <strong>炫兜</strong>
        </a>
        <a className="console-back" href="/">
          返回对话
        </a>
        <nav>
          {menus.map((menu) => (
            <a key={menu.id} href={menu.path} className={menu.path.endsWith("/" + view) ? "on" : ""}>
              {menu.name}
            </a>
          ))}
        </nav>
        <button type="button" className="console-logout" onClick={logout}>
          退出
        </button>
      </aside>
      <main className="console-main">
        <div className="console-sheet">
        <header>
          <h1>{title}</h1>
          {view === "projects" ? <p>按名称维护项目。编号在创建时生成，对话里直接勾选，不用手填。</p> : null}
        </header>
        <form className="console-form" onSubmit={createItem}>
          {(fields[view] || []).map((field) =>
            field.key === "projectId" && projects.length ? (
              <label key={field.key} className={field.wide ? "wide" : ""}>
                <span>{field.label}</span>
                <select value={form.projectId || ""} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
                  <option value="">选择项目</option>
                  {projects.map((item) => (
                    <option key={String(item.id)} value={String(item.id)}>
                      {String(item.name)} · {String(item.code)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label key={field.key} className={field.wide ? "wide" : ""}>
                <span>{field.label}</span>
                <input value={form[field.key] || ""} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} />
              </label>
            ),
          )}
          <button className="btn-primary" type="submit" disabled={pending}>
            {pending ? "正在保存…" : "添加"}
          </button>
        </form>
        {error ? <p className="toast">{error}</p> : null}
        {view === "projects" ? (
          <div className="record-list">
            <div className="record-head">
              <span>名称</span>
              <span>编码</span>
              <span>编号</span>
              <span>状态</span>
              <span />
            </div>
            {items.length ? (
              items.map((item) => (
                <div key={String(item.id)} className="record-row">
                  <strong>{String(item.name || "未命名")}</strong>
                  <span>{String(item.code || "—")}</span>
                  <span className="record-id" title={String(item.id)}>
                    {String(item.id)}
                  </span>
                  <span className={Number(item.status) === 0 ? "pill off" : "pill"}>{Number(item.status) === 0 ? "已关闭" : "进行中"}</span>
                  <button type="button" className="row-action" onClick={() => removeItem(String(item.id))}>
                    删除
                  </button>
                </div>
              ))
            ) : (
              <p className="project-empty">还没有项目。填写名称和编码后点添加。</p>
            )}
          </div>
        ) : (
          <div className="console-table">
            <table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>{labels[column] || column}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={String(item.id)}>
                    {columns.map((column) => (
                      <td key={column}>{showCell(column, item[column])}</td>
                    ))}
                    <td>
                      <button type="button" className="text-btn" onClick={() => removeItem(String(item.id))}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length ? null : <p className="project-empty">这里还没有记录。</p>}
          </div>
        )}
        </div>
      </main>
    </div>
  );
}

function showCell(column: string, value: string | number | undefined): string {
  if (column === "status") {
    if (value === 1 || value === "1" || value === "open") return "进行中";
    if (value === 0 || value === "0") return "已关闭";
    if (value === "doing") return "处理中";
    if (value === "done" || value === "resolved") return "已完成";
  }
  return String(value ?? "");
}

async function api(path: string) {
  const response = await fetch(path);
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
