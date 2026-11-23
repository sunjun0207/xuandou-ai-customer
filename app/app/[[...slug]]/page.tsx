"use client";

import { useEffect, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Mark } from "../../mark";

type Menu = { id: string; name: string; menuCode?: string; path: string; perm: string; parentId?: string; status?: number; sortNo?: number };
type Role = { id: string; code: string; name: string; description?: string; status?: number; menuIds?: string[] };
type Row = Record<string, unknown>;

const PAGE_SIZE = 10;

export default function ConsolePage() {
  const router = useRouter();
  const pathname = usePathname();
  const view = pathname.split("/").filter(Boolean)[1] || "projects";
  const [menus, setMenus] = useState<Menu[]>([]);
  const [catalog, setCatalog] = useState<Menu[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [items, setItems] = useState<Row[]>([]);
  const [projects, setProjects] = useState<Row[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [menuIds, setMenuIds] = useState<string[]>([]);
  const [menusTouched, setMenusTouched] = useState(false);
  const [editing, setEditing] = useState("");
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (view === "tasks") router.replace("/app/projects");
  }, [view, router]);

  useEffect(() => {
    api("/api/auth/me?menus=1")
      .then((data) => setMenus((data.menus || []).filter((menu: Menu) => menu.path !== "/app/tasks" && menu.perm !== "task" && menu.menuCode !== "task")))
      .catch(() => router.replace(`/login?next=${encodeURIComponent(pathname)}`));
  }, [router, pathname]);

  useEffect(() => {
    if (view === "tasks") return;
    setEditing("");
    setForm({});
    setMenuIds([]);
    setMenusTouched(false);
    const load = view === "problems" ? loadQuestions(keyword, page) : api(`/api/${view}`).then((data) => ({ items: data.items || [], total: (data.items || []).length }));
    load
      .then((data) => {
        setItems(data.items || []);
        setTotal(Number(data.total ?? (data.items || []).length));
        setError("");
      })
      .catch((reason: Error) => {
        if (reason.message === "unauthorized") {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(reason.message);
      });
    if (view === "problems") {
      api("/api/projects")
        .then((data) => setProjects(data.items || []))
        .catch(() => setProjects([]));
    }
    if (view === "users" || view === "roles" || view === "menus") {
      api("/api/roles")
        .then((data) => setRoles(data.items || []))
        .catch(() => setRoles([]));
      api("/api/menus")
        .then((data) => setCatalog(data.items || []))
        .catch(() => setCatalog([]));
    }
  }, [view, router, pathname, keyword, page]);

  function beginEdit(item: Row) {
    setEditing(String(item.id || ""));
    setMenusTouched(false);
    setError("");
    if (view === "users") {
      const role = roles.find((entry) => entry.id === String(item.roleId || ""));
      setForm({
        username: String(item.username || ""),
        displayName: String(item.displayName || ""),
        roleId: String(item.roleId || ""),
        status: String(item.status ?? 1),
        password: "",
      });
      setMenuIds(role?.menuIds || []);
      return;
    }
    if (view === "roles") {
      setForm({
        code: String(item.code || ""),
        name: String(item.name || ""),
        description: String(item.description || ""),
        status: String(item.status ?? 1),
      });
      setMenuIds(Array.isArray(item.menuIds) ? item.menuIds.map(String) : []);
      return;
    }
    setForm({
      name: String(item.name || ""),
      menuCode: String(item.menuCode || item.perm || ""),
      path: String(item.path || ""),
      parentId: String(item.parentId || "0"),
      sortNo: String(item.sortNo ?? 0),
      status: String(item.status ?? 1),
    });
  }

  function chooseRole(roleId: string) {
    const role = roles.find((entry) => entry.id === roleId);
    setForm({ ...form, roleId });
    setMenuIds(role?.menuIds || []);
  }

  async function saveItem(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const path = editing ? `/api/${view}/${editing}` : `/api/${view}`;
    const response = await fetch(path, {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (response.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (!response.ok) {
      setPending(false);
      setError(await response.text());
      return;
    }
    const roleId = view === "roles" ? editing || String((await response.json()).id || "") : form.roleId;
    if ((view === "users" || view === "roles") && roleId && (menusTouched || menuIds.length > 0)) {
      const grant = await fetch(`/api/roles/${roleId}/menus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuIds }),
      });
      if (!grant.ok) {
        setPending(false);
        setError(await grant.text());
        return;
      }
    }
    setPending(false);
    setForm({});
    setMenuIds([]);
    setMenusTouched(false);
    setEditing("");
    const data = view === "problems" ? await loadQuestions(keyword, page) : await api(`/api/${view}`);
    setItems(data.items || []);
    setTotal(Number(data.total ?? (data.items || []).length));
    if (view === "users" || view === "roles") {
      const nextRoles = await api("/api/roles");
      setRoles(nextRoles.items || []);
    }
  }

  async function removeItem(id: string) {
    const response = await fetch(`/api/${view}/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const text = await response.text();
      setError(text.includes("admin account") ? "管理员账号不能删除" : response.status === 409 ? "这条记录还被引用，不能删除" : text);
      return;
    }
    setItems((prev) => prev.filter((item) => String(item.id) !== id));
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  const title = menus.find((menu) => menu.path.endsWith("/" + view))?.name || "项目";
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
            {view === "projects" ? <p>按名称维护项目。编号在创建时生成，对话里直接勾选。</p> : null}
            {view === "problems" ? <p>这里是用户在对话里提出的问题，按时间从新到旧排列。</p> : null}
            {view === "users" ? <p>管理员账号不能删除。菜单权限挂在角色上，同一角色的用户一起生效。</p> : null}
          </header>
          {view === "problems" ? (
            <form
              className="console-search"
              onSubmit={(event) => {
                event.preventDefault();
                setPage(1);
                setKeyword(query.trim());
              }}
            >
              <input value={query} placeholder="搜索问题内容、提问人或编号" onChange={(event) => setQuery(event.target.value)} />
              <button className="btn-primary" type="submit">
                搜索
              </button>
            </form>
          ) : (
            <form className="console-form" onSubmit={saveItem}>
              {view === "projects" ? (
                <>
                  <Field label="项目名称" value={form.name || ""} onChange={(value) => setForm({ ...form, name: value })} />
                  <Field label="项目编码" value={form.code || ""} onChange={(value) => setForm({ ...form, code: value })} />
                </>
              ) : null}
              {view === "users" ? (
                <>
                  <Field label="账号" value={form.username || ""} disabled={Boolean(editing)} onChange={(value) => setForm({ ...form, username: value })} />
                  <Field label={editing ? "新密码，留空不改" : "密码"} value={form.password || ""} onChange={(value) => setForm({ ...form, password: value })} />
                  <Field label="显示名" value={form.displayName || ""} onChange={(value) => setForm({ ...form, displayName: value })} />
                  <label>
                    <span>角色</span>
                    <select value={form.roleId || ""} disabled={form.username === "admin"} onChange={(event) => chooseRole(event.target.value)}>
                      <option value="">选择角色</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name} · {role.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <StatusField value={form.status || "1"} disabled={form.username === "admin"} onChange={(value) => setForm({ ...form, status: value })} />
                </>
              ) : null}
              {view === "roles" ? (
                <>
                  <Field label="角色编码" value={form.code || ""} disabled={editing === "" ? false : form.code === "admin"} onChange={(value) => setForm({ ...form, code: value })} />
                  <Field label="角色名称" value={form.name || ""} onChange={(value) => setForm({ ...form, name: value })} />
                  <Field label="说明" value={form.description || ""} wide onChange={(value) => setForm({ ...form, description: value })} />
                  <StatusField value={form.status || "1"} disabled={form.code === "admin"} onChange={(value) => setForm({ ...form, status: value })} />
                </>
              ) : null}
              {view === "menus" ? (
                <>
                  <Field label="菜单名称" value={form.name || ""} onChange={(value) => setForm({ ...form, name: value })} />
                  <Field label="菜单编码" value={form.menuCode || ""} onChange={(value) => setForm({ ...form, menuCode: value })} />
                  <Field label="路径" value={form.path || ""} onChange={(value) => setForm({ ...form, path: value })} />
                  <label>
                    <span>上级菜单</span>
                    <select value={form.parentId || "0"} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
                      <option value="0">顶级</option>
                      {catalog
                        .filter((menu) => menu.id !== editing)
                        .map((menu) => (
                          <option key={menu.id} value={menu.id}>
                            {menu.name} · {menu.menuCode || menu.perm}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Field label="排序" value={form.sortNo || ""} onChange={(value) => setForm({ ...form, sortNo: value })} />
                  <StatusField value={form.status || "1"} onChange={(value) => setForm({ ...form, status: value })} />
                </>
              ) : null}
              {view === "users" || view === "roles" ? (
                <div className="menu-picks">
                  <span>菜单权限</span>
                  <div>
                    {catalog.filter((menu) => menu.path !== "/app/tasks").map((menu) => (
                      <label key={menu.id}>
                        <input
                          type="checkbox"
                          checked={menuIds.includes(menu.id)}
                          onChange={() => {
                            setMenusTouched(true);
                            setMenuIds((prev) => (prev.includes(menu.id) ? prev.filter((id) => id !== menu.id) : [...prev, menu.id]));
                          }}
                        />
                        <b>{menu.name}</b>
                        <small>{menu.menuCode || menu.perm}</small>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
              {view === "projects" || view === "users" || view === "roles" || view === "menus" ? (
                <div className="form-actions">
                  <button className="btn-primary" type="submit" disabled={pending}>
                    {pending ? "正在保存…" : editing ? "保存" : "添加"}
                  </button>
                  {editing ? (
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => {
                        setEditing("");
                        setForm({});
                        setMenuIds([]);
                        setMenusTouched(false);
                      }}
                    >
                      取消
                    </button>
                  ) : null}
                </div>
              ) : null}
            </form>
          )}
          {error ? <p className="toast">{error}</p> : null}
          {view === "projects" ? <ProjectTable items={items} onDelete={removeItem} /> : null}
          {view === "problems" ? <QuestionTable items={items} projects={projects} /> : null}
          {view === "users" ? <UserTable items={items} onEdit={beginEdit} onDelete={removeItem} /> : null}
          {view === "roles" ? <RoleTable items={items} onEdit={beginEdit} onDelete={removeItem} /> : null}
          {view === "menus" ? <MenuTable items={items} onEdit={beginEdit} onDelete={removeItem} /> : null}
          {view === "problems" ? (
            <div className="pager">
              <button type="button" className="btn-ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                上一页
              </button>
              <span>
                {page} / {pages} · 共 {total} 条
              </span>
              <button type="button" className="btn-ghost" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
                下一页
              </button>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  wide,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "wide" : ""}>
      <span>{label}</span>
      <input value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function StatusField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label>
      <span>状态</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="1">启用</option>
        <option value="0">停用</option>
      </select>
    </label>
  );
}

function ProjectTable({ items, onDelete }: { items: Row[]; onDelete: (id: string) => void }) {
  return (
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
            <button type="button" className="row-action" onClick={() => onDelete(String(item.id))}>
              删除
            </button>
          </div>
        ))
      ) : (
        <p className="project-empty">还没有项目。填写名称和编码后点添加。</p>
      )}
    </div>
  );
}

function QuestionTable({ items, projects }: { items: Row[]; projects: Row[] }) {
  const nameOf = (id: string) => projects.find((item) => String(item.id) === id);
  return (
    <div className="console-table">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>提问人</th>
            <th>问题</th>
            <th>项目</th>
            <th>问题编号</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const project = nameOf(String(item.projectId || ""));
            return (
              <tr key={String(item.id)}>
                <td className="nowrap">{String(item.createdAt || "")}</td>
                <td>{String(item.username || "")}</td>
                <td className="question-text">{String(item.text || item.title || "")}</td>
                <td>{project ? `${String(project.name)} · ${String(project.code)}` : String(item.projectId || "—")}</td>
                <td className="record-id">{String(item.problemId || "—")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">没有匹配的问题。</p>}
    </div>
  );
}

function UserTable({ items, onEdit, onDelete }: { items: Row[]; onEdit: (item: Row) => void; onDelete: (id: string) => void }) {
  return (
    <div className="console-table">
      <table>
        <thead>
          <tr>
            <th>账号</th>
            <th>显示名</th>
            <th>角色</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={String(item.id)}>
              <td>{String(item.username || "")}</td>
              <td>{String(item.displayName || "")}</td>
              <td>{String(item.roleName || item.roleCode || "")}</td>
              <td>{Number(item.status) === 0 ? "停用" : "启用"}</td>
              <td className="row-actions">
                <button type="button" className="btn-ghost" onClick={() => onEdit(item)}>
                  编辑
                </button>
                {String(item.username) === "admin" ? null : (
                  <button type="button" className="row-action" onClick={() => onDelete(String(item.id))}>
                    删除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">这里还没有用户。</p>}
    </div>
  );
}

function RoleTable({ items, onEdit, onDelete }: { items: Row[]; onEdit: (item: Row) => void; onDelete: (id: string) => void }) {
  return (
    <div className="console-table">
      <table>
        <thead>
          <tr>
            <th>编码</th>
            <th>名称</th>
            <th>说明</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={String(item.id)}>
              <td>{String(item.code || "")}</td>
              <td>{String(item.name || "")}</td>
              <td>{String(item.description || "—")}</td>
              <td>{Number(item.status) === 0 ? "停用" : "启用"}</td>
              <td className="row-actions">
                <button type="button" className="btn-ghost" onClick={() => onEdit(item)}>
                  编辑
                </button>
                {String(item.code) === "admin" ? null : (
                  <button type="button" className="row-action" onClick={() => onDelete(String(item.id))}>
                    删除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">这里还没有角色。</p>}
    </div>
  );
}

function MenuTable({ items, onEdit, onDelete }: { items: Row[]; onEdit: (item: Row) => void; onDelete: (id: string) => void }) {
  return (
    <div className="console-table">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>编码</th>
            <th>路径</th>
            <th>排序</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={String(item.id)}>
              <td>{String(item.name || "")}</td>
              <td>{String(item.menuCode || item.perm || "")}</td>
              <td>{String(item.path || "—")}</td>
              <td>{String(item.sortNo ?? 0)}</td>
              <td>{Number(item.status) === 0 ? "停用" : "启用"}</td>
              <td className="row-actions">
                <button type="button" className="btn-ghost" onClick={() => onEdit(item)}>
                  编辑
                </button>
                <button type="button" className="row-action" onClick={() => onDelete(String(item.id))}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">这里还没有菜单。</p>}
    </div>
  );
}

async function loadQuestions(keyword: string, page: number) {
  return api(`/api/problems?q=${encodeURIComponent(keyword)}&page=${page}&pageSize=${PAGE_SIZE}`);
}

async function api(path: string) {
  const response = await fetch(path);
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
