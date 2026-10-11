import { cleanupTestAccounts } from "./lib/cleanup.mjs";
// 服务端接口测试：账号 / 会话 / 云备份 / 账号隔离
// 说明：同步相关断言使用**每次新注册的账号**，避免历史数据累积影响断言；
// 认证相关断言仍使用预置的管理员账号。
const BASE = "http://localhost:3000";
const RUN_ID = Date.now().toString(36).slice(-6);
const NEW_USER = `tester${RUN_ID}`;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

let cookie = "";
async function call(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

// 1) 未登录访问同步接口应被拒
let r = await call("/api/sync/pull");
check("未登录时同步接口返回 401", r.status === 401, `status=${r.status}`);

// 2) 错误密码
r = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "wrong" }) });
check("错误密码被拒绝", r.status === 401, `status=${r.status}`);

// 3) 管理员登录 + 会话
r = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin123" }) });
check("管理员登录成功", r.status === 200 && r.data?.user?.role === "admin", `user=${r.data?.user?.username}`);
check("登录后下发了会话 Cookie", cookie.startsWith("qianqian_session="));
r = await call("/api/auth/me");
check("会话有效（/api/auth/me）", r.data?.user?.username === "admin");

// 4) 注册全新账号（用于同步测试，保证数据干净）
r = await call("/api/auth/register", { method: "POST", body: JSON.stringify({ username: NEW_USER, displayName: "同步测试", password: "test123456" }) });
check("注册新账号成功", r.status === 201 && r.data?.user?.username === NEW_USER, `status=${r.status}`);
r = await call("/api/sync/pull");
check("新账号初始云端数据为空", (r.data?.data?.courses?.length ?? -1) === 0, `courses=${r.data?.data?.courses?.length}`);

// 5) 推送数据
const now = new Date().toISOString();
r = await call("/api/sync/push", {
  method: "POST",
  body: JSON.stringify({
    courses: [{ id: "course-1", name: "数据库系统", semester: "2026 秋季", color: "coral", updatedAt: now }],
    resources: [{ id: "res-1", courseId: "course-1", title: "第一章 关系模型", type: "课件", tags: ["关系模型"], status: "待复习", importedAt: "2026-10-01", contentText: "关系代数包含选择、投影、并、差。", updatedAt: now }],
    tasks: [{ id: "task-1", courseId: "course-1", title: "实验二报告", type: "DDL", dueAt: "2026-10-09T23:59", status: "未开始", priority: "高", reminder: "提前3天", updatedAt: now }],
    conversations: [{ id: "conv-1", title: "帮我看看任务", createdAt: now, updatedAt: now, messages: [{ id: "msg-1", role: "user", text: "帮我看看任务", createdAt: now }, { id: "msg-2", role: "assistant", text: "你有一条实验报告 DDL。", createdAt: now }] }],
    profile: { name: "小王", studyTime: "工作日晚上", goal: "期末 90 分", notes: ["数据库第三章薄弱"] },
  }),
});
check("推送数据成功", r.status === 200 && r.data?.ok, `stats=${JSON.stringify(r.data?.stats ?? {})}`);

// 6) 拉取验证
r = await call("/api/sync/pull");
const d = r.data?.data;
check("拉取到课程", d?.courses?.length === 1, `courses=${d?.courses?.length}`);
check("拉取到资料（含正文）", (d?.resources?.[0]?.contentText ?? "").includes("关系代数"));
check("拉取到任务", d?.tasks?.[0]?.title === "实验二报告");
check("拉取到对话与消息", d?.conversations?.[0]?.messages?.length === 2, `messages=${d?.conversations?.[0]?.messages?.length}`);
check("拉取到用户画像与记忆笔记", d?.profile?.notes?.[0] === "数据库第三章薄弱");

// 7) 按 updatedAt 合并：旧数据不应覆盖新数据
r = await call("/api/sync/push", {
  method: "POST",
  body: JSON.stringify({
    tasks: [{ id: "task-1", courseId: "course-1", title: "旧标题（不应覆盖）", type: "DDL", dueAt: "2026-10-09T23:59", status: "未开始", priority: "高", reminder: "", updatedAt: "2020-01-01T00:00:00.000Z" }],
  }),
});
r = await call("/api/sync/pull");
check("较旧的记录不会覆盖较新的", r.data?.data?.tasks?.[0]?.title === "实验二报告", `title=${r.data?.data?.tasks?.[0]?.title}`);

// 8) 删除传播
r = await call("/api/sync/delete", { method: "POST", body: JSON.stringify({ entity: "conversations", ids: ["conv-1"] }) });
check("删除上报成功", r.status === 200 && r.data?.ok, `deleted=${r.data?.deleted}`);
r = await call("/api/sync/pull");
check("删除后不再返回该对话", (r.data?.data?.conversations?.length ?? -1) === 0, `conversations=${r.data?.data?.conversations?.length}`);
// 8b) 删除记录（墓碑）必须随拉取一起返回，否则其它设备会把已删记录重新推上来
const marks = r.data?.data?.deletions ?? [];
check("拉取返回删除记录", marks.some((mark) => mark.entity === "conversations" && mark.id === "conv-1"), JSON.stringify(marks).slice(0, 90));
// 再删一条任务，确认任务类型也会记墓碑
r = await call("/api/sync/delete", { method: "POST", body: JSON.stringify({ entity: "tasks", ids: ["task-1"] }) });
r = await call("/api/sync/pull");
check("任务删后不再返回", (r.data?.data?.tasks?.length ?? -1) === 0, `tasks=${r.data?.data?.tasks?.length}`);
check("任务删除也有墓碑", (r.data?.data?.deletions ?? []).some((mark) => mark.entity === "tasks" && mark.id === "task-1"));
check("不会把别的实体的删除混进来", !(r.data?.data?.deletions ?? []).some((mark) => mark.entity === "courses"));

// 9) 登出后会话失效
r = await call("/api/auth/logout", { method: "POST" });
check("登出成功", r.status === 200);
cookie = "";
r = await call("/api/auth/me");
check("登出后会话失效", r.data?.user === null);

// 10) 重复用户名被拒
r = await call("/api/auth/register", { method: "POST", body: JSON.stringify({ username: NEW_USER, password: "test123456" }) });
check("重复用户名被拒绝", r.status === 400, `status=${r.status}`);

await cleanupTestAccounts();
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
