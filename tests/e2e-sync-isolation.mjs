// 验证复合主键：两个账号使用相同的固定 id（演示数据就是这样）时不应互相覆盖
const BASE = "http://localhost:3000";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

let cookie = "";
async function call(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) } });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

const id = Date.now().toString(36).slice(-6);
const A = `alice${id}`, B = `bob${id}`;
const now = new Date().toISOString();

// 两个账号推送**完全相同的 id**（模拟演示数据的固定 id）
const sameIdsPayload = (owner) => ({
  courses: [{ id: "course-db", name: `${owner} 的数据库课`, semester: "2026 秋季", color: "coral", updatedAt: now }],
  resources: [{ id: "resource-1", courseId: "course-db", title: `${owner} 的资料`, type: "课件", tags: [], status: "待复习", importedAt: "2026-10-01", contentText: `${owner} 的正文内容`, updatedAt: now }],
  tasks: [{ id: "task-1", courseId: "course-db", title: `${owner} 的任务`, type: "DDL", dueAt: "2026-10-09T23:59", status: "未开始", priority: "高", reminder: "", updatedAt: now }],
  conversations: [{ id: "conv-1", title: `${owner} 的对话`, createdAt: now, updatedAt: now, messages: [{ id: "msg-1", role: "user", text: `${owner} 的消息`, createdAt: now }] }],
  profile: { name: owner, studyTime: "", goal: "", notes: [] },
});

// A 注册并推送
await call("/api/auth/register", { method: "POST", body: JSON.stringify({ username: A, displayName: "A", password: "test123456" }) });
await call("/api/sync/push", { method: "POST", body: JSON.stringify(sameIdsPayload("A")) });
let r = await call("/api/sync/pull");
check("A 的数据已保存", r.data?.data?.courses?.[0]?.name === "A 的数据库课", `course=${r.data?.data?.courses?.[0]?.name}`);

// B 注册并推送相同 id
cookie = "";
await call("/api/auth/register", { method: "POST", body: JSON.stringify({ username: B, displayName: "B", password: "test123456" }) });
await call("/api/sync/push", { method: "POST", body: JSON.stringify(sameIdsPayload("B")) });
r = await call("/api/sync/pull");
check("B 看到的是自己的数据", r.data?.data?.courses?.[0]?.name === "B 的数据库课", `course=${r.data?.data?.courses?.[0]?.name}`);
check("B 的任务是自己的", r.data?.data?.tasks?.[0]?.title === "B 的任务", `task=${r.data?.data?.tasks?.[0]?.title}`);
check("B 的消息是自己的", r.data?.data?.conversations?.[0]?.messages?.[0]?.text === "B 的消息", `msg=${r.data?.data?.conversations?.[0]?.messages?.[0]?.text}`);
check("B 的资料正文是自己的", r.data?.data?.resources?.[0]?.contentText === "B 的正文内容");

// 回到 A：数据必须完好无损
cookie = "";
await call("/api/auth/login", { method: "POST", body: JSON.stringify({ username: A, password: "test123456" }) });
r = await call("/api/sync/pull");
check("A 的数据未被 B 覆盖", r.data?.data?.courses?.[0]?.name === "A 的数据库课", `course=${r.data?.data?.courses?.[0]?.name}`);
check("A 的任务未被覆盖", r.data?.data?.tasks?.[0]?.title === "A 的任务", `task=${r.data?.data?.tasks?.[0]?.title}`);
check("A 的消息未被覆盖", r.data?.data?.conversations?.[0]?.messages?.[0]?.text === "A 的消息", `msg=${r.data?.data?.conversations?.[0]?.messages?.[0]?.text}`);

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
