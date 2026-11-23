import { useEffect, useState, type FormEvent } from "react";
import { Mark } from "@/components/mark";
import { apiFetch, endSession, ensureSession, watchSession } from "@/api/session";
import { usePathname, useRouter } from "@/router";

type Menu = { id: string; name: string; menuCode?: string; path: string; perm: string; parentId?: string; status?: number; sortNo?: number };
type Role = { id: string; code: string; name: string; description?: string; status?: number; menuIds?: string[] };
type Row = Record<string, unknown>;
type Dialog = "form" | "delete" | "";

const PAGE_SIZES = [10, 20, 50];
const NAMES: Record<string, string> = { projects: "项目", problems: "问题", users: "用户", roles: "角色", menus: "菜单" };
const SEARCH: Record<string, string> = {
  projects: "搜索名称、编码或编号",
  problems: "搜索问题内容、提问人或编号",
  users: "搜索账号、显示名或角色",
  roles: "搜索编码、名称或说明",
  menus: "搜索名称、编码或路径",
};

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
  const [target, setTarget] = useState<Row | null>(null);
  const [dialog, setDialog] = useState<Dialog>("");
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (view === "tasks") router.replace("/app/projects");
  }, [view, router]);

  useEffect(() => {
    return watchSession(() => router.replace(`/login?next=${encodeURIComponent(pathname)}`));
  }, [router, pathname]);

  useEffect(() => {
    let stop = false;
    ensureSession()
      .then((ok) => {
        if (!ok) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return null;
        }
        if (stop) return null;
        return api("/api/auth/me?menus=1");
      })
      .then((data) => {
        if (stop || !data) return;
        setMenus((data.menus || []).filter((menu: Menu) => menu.path !== "/app/tasks" && menu.perm !== "task" && menu.menuCode !== "task"));
      })
      .catch(() => {
        if (!stop) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      });
    return () => {
      stop = true;
    };
  }, [router, pathname]);

  useEffect(() => {
    if (view === "tasks" || view === "problems") return;
    let stop = false;
    api(`/api/${view}`)
      .then((data) => {
        if (stop) return;
        setItems(data.items || []);
        setTotal((data.items || []).length);
        setError("");
      })
      .catch((reason: Error) => {
        if (stop) return;
        if (reason.message === "unauthorized") {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(reason.message);
      });
    return () => {
      stop = true;
    };
  }, [view, router, pathname]);

  useEffect(() => {
    if (view !== "problems") return;
    let stop = false;
    loadQuestions(keyword, page, pageSize)
      .then((data) => {
        if (stop) return;
        setItems(data.items || []);
        setTotal(Number(data.total ?? (data.items || []).length));
        setError("");
      })
      .catch((reason: Error) => {
        if (stop) return;
        if (reason.message === "unauthorized") {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(reason.message);
      });
    api("/api/projects")
      .then((data) => {
        if (!stop) setProjects(data.items || []);
      })
      .catch(() => {
        if (!stop) setProjects([]);
      });
    return () => {
      stop = true;
    };
  }, [view, router, pathname, keyword, page, pageSize]);

  useEffect(() => {
    if (view !== "users" && view !== "roles" && view !== "menus") return;
    let stop = false;
    api("/api/roles")
      .then((data) => {
        if (!stop) setRoles(data.items || []);
      })
      .catch(() => {
        if (!stop) setRoles([]);
      });
    api("/api/menus")
      .then((data) => {
        if (!stop) setCatalog(data.items || []);
      })
      .catch(() => {
        if (!stop) setCatalog([]);
      });
    return () => {
      stop = true;
    };
  }, [view]);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) closeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, pending]);

  function closeDialog() {
    setDialog("");
    setEditing("");
    setTarget(null);
    setForm({});
    setMenuIds([]);
    setMenusTouched(false);
    setError("");
  }

  function openCreate() {
    setEditing("");
    setTarget(null);
    setMenusTouched(false);
    setMenuIds([]);
    setError("");
    setForm(blankForm(view));
    setDialog("form");
  }

  function beginEdit(item: Row) {
    setEditing(String(item.id || ""));
    setTarget(item);
    setMenusTouched(false);
    setError("");
    if (view === "projects") {
      setForm({
        name: String(item.name || ""),
        code: String(item.code || ""),
        status: String(item.status ?? 1),
      });
    } else if (view === "problems") {
      setForm({
        projectId: String(item.projectId || ""),
        title: String(item.title || item.text || ""),
        detail: String(item.detail || ""),
      });
    } else if (view === "users") {
      const role = roles.find((entry) => entry.id === String(item.roleId || ""));
      setForm({
        username: String(item.username || ""),
        displayName: String(item.displayName || ""),
        roleId: String(item.roleId || ""),
        status: String(item.status ?? 1),
        password: "",
      });
      setMenuIds(role?.menuIds || []);
    } else if (view === "roles") {
      setForm({
        code: String(item.code || ""),
        name: String(item.name || ""),
        description: String(item.description || ""),
        status: String(item.status ?? 1),
      });
      setMenuIds(Array.isArray(item.menuIds) ? item.menuIds.map(String) : []);
    } else {
      setForm({
        name: String(item.name || ""),
        menuCode: String(item.menuCode || item.perm || ""),
        path: String(item.path || ""),
        parentId: String(item.parentId || "0"),
        sortNo: String(item.sortNo ?? 0),
        status: String(item.status ?? 1),
      });
    }
    setDialog("form");
  }

  function openDelete(item: Row) {
    setTarget(item);
    setError("");
    setDialog("delete");
  }

  function chooseRole(roleId: string) {
    const role = roles.find((entry) => entry.id === roleId);
    setForm({ ...form, roleId });
    setMenuIds(role?.menuIds || []);
  }

  async function reload() {
    if (view === "problems") {
      const data = await loadQuestions(keyword, page, pageSize);
      setItems(data.items || []);
      setTotal(Number(data.total ?? (data.items || []).length));
      return;
    }
    const data = await api(`/api/${view}`);
    setItems(data.items || []);
    setTotal((data.items || []).length);
  }

  async function saveItem(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const path = editing ? `/api/${view}/${editing}` : `/api/${view}`;
    const payload = view === "problems" ? { projectId: form.projectId || "", title: form.title || "", text: form.title || "", detail: form.detail || "" } : form;
    const response = await apiFetch(path, {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
      const grant = await apiFetch(`/api/roles/${roleId}/menus`, {
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
    closeDialog();
    await reload();
    if (view === "users" || view === "roles") {
      const nextRoles = await api("/api/roles");
      setRoles(nextRoles.items || []);
    }
  }

  async function confirmDelete() {
    if (!target) return;
    setPending(true);
    setError("");
    const response = await apiFetch(`/api/${view}/${target.id}`, { method: "DELETE" });
    if (!response.ok) {
      setPending(false);
      const text = await response.text();
      setError(text.includes("admin account") ? "管理员账号不能删除" : response.status === 409 ? "这条记录还被引用，不能删除" : text);
      return;
    }
    setPending(false);
    closeDialog();
    await reload();
  }

  async function logout() {
    await endSession();
    router.replace("/login");
  }

  const noun = NAMES[view] || "记录";
  const needle = keyword.trim().toLowerCase();
  const filtered = view === "problems" ? items : items.filter((item) => !needle || rowText(view, item).includes(needle));
  const shownTotal = view === "problems" ? total : filtered.length;
  const pages = Math.max(1, Math.ceil(shownTotal / pageSize));
  const pageItems = view === "problems" ? items : filtered.slice((page - 1) * pageSize, page * pageSize);
  const title = menus.find((menu) => menu.path.endsWith("/" + view))?.name || noun;

  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);

  return (
    <div className="console">
      <aside className="console-side">
        <a className="console-brand" href="/">
          <Mark />
          <strong>炫兜</strong>
        </a>
        <a className="console-back" href="/">
          <span aria-hidden="true">←</span>
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
          <div className="console-toolbar">
            <form
              className="console-search"
              onSubmit={(event) => {
                event.preventDefault();
                setPage(1);
                setKeyword(query.trim());
              }}
            >
              <input value={query} placeholder={SEARCH[view] || "搜索"} aria-label="搜索" onChange={(event) => setQuery(event.target.value)} />
              <button className="btn-primary" type="submit">
                搜索
              </button>
            </form>
            <button className="btn-primary" type="button" onClick={openCreate}>
              添加
            </button>
          </div>
          {error && !dialog ? <p className="toast">{error}</p> : null}
          {view === "projects" ? <ProjectTable items={pageItems} keyword={keyword} onEdit={beginEdit} onDelete={openDelete} /> : null}
          {view === "problems" ? <QuestionTable items={pageItems} projects={projects} onEdit={beginEdit} onDelete={openDelete} /> : null}
          {view === "users" ? <UserTable items={pageItems} keyword={keyword} onEdit={beginEdit} onDelete={openDelete} /> : null}
          {view === "roles" ? <RoleTable items={pageItems} keyword={keyword} onEdit={beginEdit} onDelete={openDelete} /> : null}
          {view === "menus" ? <MenuTable items={pageItems} keyword={keyword} onEdit={beginEdit} onDelete={openDelete} /> : null}
          <div className="pager">
            <label>
              每页
              <select
                value={pageSize}
                aria-label="每页条数"
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}条
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn-ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </button>
            <span>
              {Math.min(page, pages)} / {pages} · 共 {shownTotal} 条
            </span>
            <button type="button" className="btn-ghost" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
              下一页
            </button>
          </div>
        </div>
      </main>
      {dialog ? (
        <div
          className="modal-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending) closeDialog();
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="console-dialog-title">
            <h2 id="console-dialog-title">{dialog === "delete" ? `删除${noun}` : editing ? `编辑${noun}` : `添加${noun}`}</h2>
            {dialog === "delete" ? (
              <>
                <p className="hint">确定删除「{recordName(view, target)}」吗？删除后不能恢复。</p>
                {error ? <p className="toast">{error}</p> : null}
                <div className="form-actions">
                  <button className="btn-ghost" type="button" disabled={pending} onClick={closeDialog}>
                    取消
                  </button>
                  <button className="row-action" type="button" disabled={pending} onClick={() => void confirmDelete()}>
                    {pending ? "正在删除…" : "删除"}
                  </button>
                </div>
              </>
            ) : (
              <form className="console-form" onSubmit={saveItem}>
                {view === "projects" ? (
                  <>
                    <Field label="项目名称" value={form.name || ""} onChange={(value) => setForm({ ...form, name: value })} />
                    <Field label="项目编码" value={form.code || ""} onChange={(value) => setForm({ ...form, code: value })} />
                    <StatusField
                      value={form.status || "1"}
                      options={[
                        { value: "1", label: "进行中" },
                        { value: "0", label: "已关闭" },
                      ]}
                      onChange={(value) => setForm({ ...form, status: value })}
                    />
                  </>
                ) : null}
                {view === "problems" ? (
                  <>
                    <label className="wide">
                      <span>所属项目</span>
                      <select value={form.projectId || ""} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
                        <option value="">选择项目</option>
                        {projects.map((item) => (
                          <option key={String(item.id)} value={String(item.id)}>
                            {String(item.name)} · {String(item.code)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Field label="问题" wide value={form.title || ""} onChange={(value) => setForm({ ...form, title: value })} />
                    <Field label="说明" wide value={form.detail || ""} onChange={(value) => setForm({ ...form, detail: value })} />
                  </>
                ) : null}
                {view === "users" ? (
                  <>
                    <Field label="账号" value={form.username || ""} disabled={Boolean(editing)} onChange={(value) => setForm({ ...form, username: value })} />
                    <Field label={editing ? "新密码，留空不改" : "密码"} type="password" value={form.password || ""} onChange={(value) => setForm({ ...form, password: value })} />
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
                    <Field label="角色编码" value={form.code || ""} disabled={Boolean(editing) && form.code === "admin"} onChange={(value) => setForm({ ...form, code: value })} />
                    <Field label="角色名称" value={form.name || ""} onChange={(value) => setForm({ ...form, name: value })} />
                    <Field label="说明" wide value={form.description || ""} onChange={(value) => setForm({ ...form, description: value })} />
                    <StatusField value={form.status || "1"} disabled={form.code === "admin"} onChange={(value) => setForm({ ...form, status: value })} />
                  </>
                ) : null}
                {view === "menus" ? (
                  <>
                    <Field label="菜单名称" value={form.name || ""} onChange={(value) => setForm({ ...form, name: value })} />
                    <Field label="菜单编码" value={form.menuCode || ""} onChange={(value) => setForm({ ...form, menuCode: value })} />
                    <Field label="路径" wide value={form.path || ""} onChange={(value) => setForm({ ...form, path: value })} />
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
                      {catalog
                        .filter((menu) => menu.path !== "/app/tasks")
                        .map((menu) => (
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
                {error ? <p className="toast">{error}</p> : null}
                <div className="form-actions">
                  <button className="btn-ghost" type="button" disabled={pending} onClick={closeDialog}>
                    取消
                  </button>
                  <button className="btn-primary" type="submit" disabled={pending}>
                    {pending ? "正在保存…" : "提交"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  wide,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  wide?: boolean;
  type?: string;
}) {
  return (
    <label className={wide ? "wide" : ""}>
      <span>{label}</span>
      <input type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function StatusField({
  value,
  onChange,
  disabled,
  options = [
    { value: "1", label: "启用" },
    { value: "0", label: "停用" },
  ],
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  options?: { value: string; label: string }[];
}) {
  return (
    <label>
      <span>状态</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProjectTable({ items, keyword, onEdit, onDelete }: { items: Row[]; keyword: string; onEdit: (item: Row) => void; onDelete: (item: Row) => void }) {
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
            <div className="row-actions">
              <button type="button" className="btn-ghost" onClick={() => onEdit(item)}>
                编辑
              </button>
              <button type="button" className="row-action" onClick={() => onDelete(item)}>
                删除
              </button>
            </div>
          </div>
        ))
      ) : (
        <p className="project-empty">{keyword ? "没有匹配的项目。" : "还没有项目。点添加填写名称和编码。"}</p>
      )}
    </div>
  );
}

function QuestionTable({
  items,
  projects,
  onEdit,
  onDelete,
}: {
  items: Row[];
  projects: Row[];
  onEdit: (item: Row) => void;
  onDelete: (item: Row) => void;
}) {
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
            <th />
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
                <td className="row-actions">
                  <button type="button" className="btn-ghost" onClick={() => onEdit(item)}>
                    编辑
                  </button>
                  <button type="button" className="row-action" onClick={() => onDelete(item)}>
                    删除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">没有匹配的问题。</p>}
    </div>
  );
}

function UserTable({ items, keyword, onEdit, onDelete }: { items: Row[]; keyword: string; onEdit: (item: Row) => void; onDelete: (item: Row) => void }) {
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
                  <button type="button" className="row-action" onClick={() => onDelete(item)}>
                    删除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">{keyword ? "没有匹配的用户。" : "这里还没有用户。"}</p>}
    </div>
  );
}

function RoleTable({ items, keyword, onEdit, onDelete }: { items: Row[]; keyword: string; onEdit: (item: Row) => void; onDelete: (item: Row) => void }) {
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
                  <button type="button" className="row-action" onClick={() => onDelete(item)}>
                    删除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">{keyword ? "没有匹配的角色。" : "这里还没有角色。"}</p>}
    </div>
  );
}

function MenuTable({ items, keyword, onEdit, onDelete }: { items: Row[]; keyword: string; onEdit: (item: Row) => void; onDelete: (item: Row) => void }) {
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
                <button type="button" className="row-action" onClick={() => onDelete(item)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length ? null : <p className="project-empty">{keyword ? "没有匹配的菜单。" : "这里还没有菜单。"}</p>}
    </div>
  );
}

function blankForm(view: string): Record<string, string> {
  if (view === "projects") return { name: "", code: "", status: "1" };
  if (view === "problems") return { projectId: "", title: "", detail: "" };
  if (view === "users") return { username: "", password: "", displayName: "", roleId: "", status: "1" };
  if (view === "roles") return { code: "", name: "", description: "", status: "1" };
  return { name: "", menuCode: "", path: "", parentId: "0", sortNo: "0", status: "1" };
}

function rowText(view: string, item: Row): string {
  const parts =
    view === "projects"
      ? [item.name, item.code, item.id]
      : view === "users"
        ? [item.username, item.displayName, item.roleName, item.roleCode]
        : view === "roles"
          ? [item.code, item.name, item.description]
          : [item.name, item.menuCode, item.perm, item.path];
  return parts.map((part) => String(part || "")).join(" ").toLowerCase();
}

function recordName(view: string, item: Row | null): string {
  if (!item) return "这条记录";
  if (view === "projects") return String(item.name || "未命名");
  if (view === "problems") return String(item.text || item.title || "这条问题").slice(0, 24);
  if (view === "users") return String(item.username || "这个用户");
  if (view === "roles") return String(item.name || "这个角色");
  return String(item.name || "这个菜单");
}

async function loadQuestions(keyword: string, page: number, pageSize: number) {
  return api(`/api/problems?q=${encodeURIComponent(keyword)}&page=${page}&pageSize=${pageSize}`);
}

async function api(path: string, allowRefresh = true) {
  const response = await apiFetch(path);
  if (response.status === 401 && allowRefresh) {
    const ok = await ensureSession();
    if (!ok) throw new Error("unauthorized");
    return api(path, false);
  }
  if (response.status === 401) throw new Error("unauthorized");
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
