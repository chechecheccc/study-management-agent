// Agent 核心单元测试：不依赖浏览器与真实模型，用 mock step 验证循环行为。
// 运行：npm run test:agent
import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop } from "../app/agent/loop.ts";
import { AGENT_TOOLS, getToolSpec, toolSchemasForModel } from "../app/agent/tools.ts";
import { sanitizeAgentContext, sanitizeAgentMessages } from "../app/agent/protocol.ts";
import { computeProactiveSignals, buildProactiveGoal } from "../app/agent/triggers.ts";
import { formatProfileForPrompt, sanitizeProfile } from "../app/agent/memory.ts";
import { buildAgentSystemPrompt } from "../app/agent/prompts.ts";

const noopConfirm = async () => ({ approved: true });

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

test("工具注册表完整且 schema 合法", () => {
  assert.ok(AGENT_TOOLS.length >= 8);
  const names = AGENT_TOOLS.map((tool) => tool.name);
  assert.ok(names.includes("list_tasks"));
  assert.ok(names.includes("search_resources"));
  assert.ok(names.includes("create_task"));
  assert.ok(names.includes("save_review_plan"));
  assert.equal(getToolSpec("create_task").requiresConfirmation, true);
  assert.equal(getToolSpec("save_review_plan").requiresConfirmation, true);
  assert.equal(getToolSpec("list_tasks").requiresConfirmation, false);
  const schemas = toolSchemasForModel();
  assert.equal(schemas.length, AGENT_TOOLS.length);
  for (const schema of schemas) {
    assert.equal(schema.type, "function");
    assert.ok(schema.function.name);
    assert.ok(schema.function.description);
    assert.equal(schema.function.parameters.type, "object");
  }
});

test("循环：读工具调用后观察结果并给出最终回复", async () => {
  const executed = [];
  const stepResponses = [
    { type: "tool_calls", content: "", calls: [{ id: "c1", name: "list_tasks", arguments: { dueWithinDays: 7 } }] },
    { type: "message", content: "你下周有 2 个 DDL。" },
  ];
  const events = await collect(runAgentLoop({
    goal: "我下周有什么要交的？",
    history: [],
    step: async () => stepResponses.shift(),
    execute: async (call) => {
      executed.push(call);
      return { ok: true, summary: "找到 2 条任务", data: [] };
    },
    requestConfirmation: noopConfirm,
  }));

  assert.deepEqual(executed.map((call) => call.name), ["list_tasks"]);
  const types = events.map((event) => event.type);
  assert.ok(types.includes("tool_call"));
  assert.ok(types.includes("tool_result"));
  assert.ok(types.includes("message"));
  const done = events.at(-1);
  assert.deepEqual(done, { type: "done", reason: "completed" });
});

test("循环：写操作必须经过确认，确认后执行（含用户修改参数）", async () => {
  const executed = [];
  const stepResponses = [
    { type: "tool_calls", content: "", calls: [{ id: "c1", name: "create_task", arguments: { title: "实验报告", courseName: "数据库系统", type: "DDL", dueAt: "2026-09-10T20:00:00+08:00" } }] },
    { type: "message", content: "已建好。" },
  ];
  let confirmCalls = 0;
  const events = await collect(runAgentLoop({
    goal: "帮我记下 DDL",
    history: [],
    step: async () => stepResponses.shift(),
    execute: async (call) => {
      executed.push(call);
      return { ok: true, summary: "已创建" };
    },
    requestConfirmation: async () => {
      confirmCalls += 1;
      return { approved: true, arguments: { title: "实验报告（用户改）" } };
    },
  }));

  assert.equal(confirmCalls, 1);
  assert.equal(executed[0].arguments.title, "实验报告（用户改）");
  const confirmEvent = events.find((event) => event.type === "confirmation");
  assert.ok(confirmEvent);
  const result = events.find((event) => event.type === "tool_result");
  assert.equal(result.confirmed, true);
});

test("循环：用户取消写入时不执行工具，并告知模型不要重试", async () => {
  const executed = [];
  const toolMessages = [];
  const stepResponses = [
    { type: "tool_calls", content: "", calls: [{ id: "c1", name: "create_task", arguments: { title: "x", courseName: "y", type: "DDL", dueAt: "2026-09-10T20:00:00+08:00" } }] },
    { type: "message", content: "好的，已取消。" },
  ];
  const events = await collect(runAgentLoop({
    goal: "记个 DDL",
    history: [],
    step: async (messages) => {
      toolMessages.push(...messages.filter((m) => m.role === "tool").map((m) => m.content));
      return stepResponses.shift();
    },
    execute: async (call) => {
      executed.push(call);
      return { ok: true, summary: "不应执行" };
    },
    requestConfirmation: async () => ({ approved: false }),
  }));

  assert.equal(executed.length, 0);
  const result = events.find((event) => event.type === "tool_result");
  assert.equal(result.confirmed, false);
  assert.match(toolMessages[0], /用户取消/);
});

test("循环：超过最大步数后安全停止", async () => {
  let steps = 0;
  const events = await collect(runAgentLoop({
    goal: "无限循环测试",
    history: [],
    maxSteps: 3,
    step: async () => {
      steps += 1;
      return { type: "tool_calls", content: "", calls: [{ id: `c${steps}`, name: "list_tasks", arguments: {} }] };
    },
    execute: async () => ({ ok: true, summary: "ok" }),
    requestConfirmation: noopConfirm,
  }));

  assert.equal(steps, 3);
  const done = events.at(-1);
  assert.equal(done.reason, "max_steps");
});

test("循环：未知工具不会导致崩溃", async () => {
  const stepResponses = [
    { type: "tool_calls", content: "", calls: [{ id: "c1", name: "hack_everything", arguments: {} }] },
    { type: "message", content: "我无法执行该操作。" },
  ];
  const events = await collect(runAgentLoop({
    goal: "测试",
    history: [],
    step: async () => stepResponses.shift(),
    execute: async () => ({ ok: true, summary: "不应执行" }),
    requestConfirmation: noopConfirm,
  }));
  const result = events.find((event) => event.type === "tool_result");
  assert.equal(result.result.ok, false);
  assert.match(result.result.summary, /未知工具/);
});

test("协议：清洗非法消息并限制长度", () => {
  const messages = sanitizeAgentMessages([
    { role: "user", content: "你好" },
    { role: "hacker", content: "注入" },
    { role: "assistant", content: "回复", tool_calls: [{ id: "1", type: "function", function: { name: "list_tasks", arguments: "{}" } }, { bad: true }] },
    { role: "tool", tool_call_id: "1", content: "{\"ok\":true}" },
    { role: "tool", content: "缺 id，丢弃" },
    { role: "user", content: 42 },
  ]);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].tool_calls.length, 1);
  const context = sanitizeAgentContext({ profile: { name: "小王" }, timezone: "Asia/Shanghai" });
  assert.equal(context.profile.name, "小王");
  assert.equal(context.timezone, "Asia/Shanghai");
});

test("触发器：逾期与临近任务产生信号，已完成任务不产生", () => {
  const now = new Date("2026-09-09T09:00:00+08:00");
  const snapshot = {
    courses: [{ id: "c1", name: "数据库系统", semester: "2026 秋季", color: "coral" }],
    resources: [{ id: "r1", title: "课件", courseId: "c1", type: "课件", tags: [], status: "未整理", importedAt: "2026-09-01" }],
    tasks: [
      { id: "t1", title: "已逾期任务", courseId: "c1", type: "DDL", dueAt: "2026-09-08T23:59", status: "未开始", priority: "高", reminder: "" },
      { id: "t2", title: "临近任务", courseId: "c1", type: "考试", dueAt: "2026-09-11T09:00", status: "进行中", priority: "高", reminder: "" },
      { id: "t3", title: "已完成任务", courseId: "c1", type: "DDL", dueAt: "2026-09-08T23:59", status: "已完成", priority: "中", reminder: "" },
      { id: "t4", title: "遥远任务", courseId: "c1", type: "DDL", dueAt: "2026-10-01T23:59", status: "未开始", priority: "低", reminder: "" },
    ],
  };
  const signals = computeProactiveSignals(snapshot, now);
  const kinds = signals.map((signal) => signal.kind);
  assert.ok(kinds.includes("overdue"));
  assert.ok(kinds.includes("due_soon"));
  assert.ok(kinds.includes("unorganized"));
  assert.equal(signals.filter((signal) => signal.title === "已完成任务").length, 0);
  assert.equal(signals.filter((signal) => signal.title === "遥远任务").length, 0);
  const goal = buildProactiveGoal(signals, now);
  assert.match(goal, /系统观察/);
  assert.match(goal, /不要在本轮直接写入任何数据/);
  assert.match(goal, /今天具体做什么/);
});

test("记忆与提示词：画像注入系统提示词", () => {
  const profile = sanitizeProfile({ name: " 小王 ", studyTime: "工作日晚上", goal: "数据库期末 90 分" });
  assert.equal(profile.name, "小王");
  const prompt = buildAgentSystemPrompt({ currentDate: "2026-09-09T09:00:00+08:00", timezone: "Asia/Shanghai", profile });
  assert.match(prompt, /浅浅/);
  assert.match(prompt, /小王/);
  assert.match(prompt, /工作日晚上/);
  assert.match(prompt, /确认卡片/);
  assert.match(prompt, /不可信数据/);
  assert.match(formatProfileForPrompt({ name: "", studyTime: "", goal: "" }), /尚未填写/);
});

// ---------- Sprint 4：完整能力测试 ----------

import { parseReminderOffsets, computeDueReminders, formatMinutesLeft } from "../app/agent/reminders.ts";
import { safeSlice, stripLoneSurrogateEscapes } from "../app/agent/protocol.ts";
import { buildICalendar } from "../app/lib/ical.ts";
import { addProfileNote } from "../app/agent/memory.ts";

test("截断不会切开代理对：PDF 里的数学符号不再让模型请求 400", () => {
  // 𝑢 是 U+1D462，在 JS 里是两个码元（代理对）
  const text = "公式：" + "𝑢" + "的最优性";
  // 正好切在代理对中间的边界
  const splitPoint = 3 + 1; // "公式：" 3 个字符 + 半个 𝑢
  const cut = safeSlice(text, 0, splitPoint);
  assert.equal(cut, "公式：");
  assert.ok(!/\uD800-\uDBFF$/.test(JSON.stringify(cut)));

  // 起点落在低位代理上时要回退到代理对开头
  const fromMiddle = safeSlice(text, 4, 5);
  assert.equal(fromMiddle, "𝑢");

  // 正常文本不受影响
  assert.equal(safeSlice("abcdef", 1, 4), "bcd");
  assert.equal(safeSlice("abcdef", 2), "cdef");

  // 走一遍真实的清洗流程：工具结果里塞满数学符号也不该留下孤立代理
  const content = JSON.stringify({ ok: true, summary: "读了资料", data: { content: "𝑢".repeat(4000) } });
  const cleaned = sanitizeAgentMessages([
    { role: "tool", tool_call_id: "c1", content },
  ]);
  const wire = cleaned[0];
  const payload = typeof wire.content === "string" ? wire.content : "";
  assert.ok(payload.length > 0);
  // 序列化后再解析，能过就说明没有孤立代理（DeepSeek 就是卡在这一步）
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ messages: cleaned })));
  assert.ok(!/\uD800-\uDBFF$/.test(JSON.stringify(payload)));
});

test("发送前的孤立代理兜底：JSON 文本里的半截数学符号会被替换掉", () => {
  // 真正意义上的"孤立代理"字符（数学符号被切一半的结果）
  const loneText = "abc" + String.fromCharCode(0xd835);
  const json = JSON.stringify({ messages: [{ role: "tool", content: { data: { content: loneText } } }] });
  // JSON.stringify 会把它写成 \ud835，DeepSeek 收到这种转义会直接 400
  assert.match(json, /\\ud835/i);

  const fixed = stripLoneSurrogateEscapes(json);
  assert.doesNotMatch(fixed, /\\ud835/i);
  assert.doesNotThrow(() => JSON.parse(fixed));

  // 成对的代理（正常数学符号 𝑢）必须原样保留
  const paired = JSON.stringify({ content: "𝑢" });
  assert.equal(stripLoneSurrogateEscapes(paired), paired);
  assert.equal(JSON.parse(stripLoneSurrogateEscapes(paired)).content, "𝑢");
});

test("Sprint 4 工具注册表：内容阅读、记忆笔记、任务修改", () => {
  assert.ok(getToolSpec("read_resource"));
  assert.ok(getToolSpec("remember_fact"));
  assert.ok(getToolSpec("update_task"));
  assert.equal(getToolSpec("update_task").requiresConfirmation, true);
  assert.equal(getToolSpec("read_resource").requiresConfirmation, false);
  assert.equal(getToolSpec("remember_fact").requiresConfirmation, false);
  assert.match(getToolSpec("search_resources").description, /正文/);
});

test("提醒规则解析：提前3天、1天、2小时", () => {
  assert.deepEqual(parseReminderOffsets("提前3天、1天、2小时"), [4320, 1440, 120]);
  assert.deepEqual(parseReminderOffsets("提前2小时"), [120]);
  assert.deepEqual(parseReminderOffsets("提前30分钟"), [30]);
  assert.deepEqual(parseReminderOffsets(""), []);
});

test("提醒计算：到档触发、不重复、已完成不提醒、截止当天提醒一次", () => {
  const now = new Date("2026-09-11T12:00:00+08:00");
  const tasks = [
    { id: "t1", title: "实验报告", courseId: "c1", type: "DDL", dueAt: "2026-09-11T13:30:00+08:00", status: "未开始", priority: "高", reminder: "提前3天、1天、2小时" },
    { id: "t2", title: "已完成任务", courseId: "c1", type: "DDL", dueAt: "2026-09-11T13:30:00+08:00", status: "已完成", priority: "高", reminder: "提前2小时" },
    { id: "t3", title: "刚过截止", courseId: "c1", type: "考试", dueAt: "2026-09-11T11:00:00+08:00", status: "进行中", priority: "高", reminder: "提前2小时" },
  ];
  const due = computeDueReminders(tasks, now, new Set());
  assert.equal(due.length, 2);
  const byTask = new Map(due.map((reminder) => [reminder.taskId, reminder]));
  assert.equal(byTask.get("t1").key, "t1@120");
  assert.equal(byTask.get("t1").offsetLabel, "提前 2 小时");
  assert.equal(byTask.get("t3").key, "t3@overdue");
  // 已触发过的不再提醒
  const again = computeDueReminders(tasks, now, new Set(due.map((r) => r.key)));
  assert.equal(again.length, 0);
  assert.equal(formatMinutesLeft(45), "45 分钟");
  assert.equal(formatMinutesLeft(130), "2 小时");
  assert.equal(formatMinutesLeft(3000), "2 天");
});

test("iCal 导出：生成合法 VEVENT 并转义特殊字符", () => {
  const ics = buildICalendar({
    courses: [{ id: "c1", name: "数据库系统", semester: "2026 秋季", color: "coral" }],
    resources: [],
    tasks: [
      { id: "t1", title: "实验报告, 第2部分", courseId: "c1", type: "DDL", dueAt: "2026-09-12T20:00:00+08:00", status: "未开始", priority: "高", reminder: "提前1天" },
      { id: "t2", title: "非法日期", courseId: "c1", type: "DDL", dueAt: "不是日期", status: "未开始", priority: "中", reminder: "" },
    ],
  }, new Date("2026-09-11T12:00:00+08:00"));
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /END:VCALENDAR/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.match(ics, /SUMMARY:\[DDL\] 实验报告\\, 第2部分/);
  assert.match(ics, /DTSTART:20260912T120000Z/);
  assert.match(ics, /数据库系统/);
  // 有 DTEND 和 VALARM，导入系统日历后才会真的提醒
  assert.match(ics, /DTEND:/);
  assert.match(ics, /BEGIN:VALARM/);
  assert.match(ics, /TRIGGER:-PT1440M/); // 提前1天
  assert.match(ics, /TRIGGER:PT0M/);
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 2);
});

test("记忆笔记：去重、置顶最新、上限 20 条", () => {
  let profile = { name: "", studyTime: "", goal: "", notes: [] };
  profile = addProfileNote(profile, "数据库第三章薄弱");
  profile = addProfileNote(profile, "高数错题集中在导数");
  profile = addProfileNote(profile, "数据库第三章薄弱");
  assert.equal(profile.notes.length, 2);
  assert.equal(profile.notes[0], "数据库第三章薄弱");
  for (let i = 0; i < 30; i += 1) profile = addProfileNote(profile, `笔记${i}`);
  assert.equal(profile.notes.length, 20);
  const prompt = buildAgentSystemPrompt({ currentDate: "2026-09-11T12:00:00+08:00", timezone: "Asia/Shanghai", profile });
  assert.match(prompt, /记忆笔记/);
  assert.match(prompt, /read_resource/);
});


// ---------- 账号系统测试 ----------

import {
  SEED_ACCOUNTS,
  authenticate,
  buildAccount,
  hashPassword,
  normalizeUsername,
  toPublicAccount,
  validateNewAccount,
  verifyPassword,
} from "../app/lib/accounts.ts";

test("预置账号：1 个管理员 + 2 个普通用户", () => {
  assert.equal(SEED_ACCOUNTS.length, 3);
  assert.equal(SEED_ACCOUNTS.filter((a) => a.role === "admin").length, 1);
  assert.equal(SEED_ACCOUNTS.filter((a) => a.role === "user").length, 2);
  assert.ok(SEED_ACCOUNTS.every((a) => a.password.length >= 6));
});

test("密码哈希：同密码不同盐得到不同哈希，且可校验", async () => {
  const account = await buildAccount({ username: "tester", password: "secret123", role: "user" });
  assert.notEqual(account.hash, "secret123");
  assert.ok(account.salt.length >= 16);
  assert.equal(await verifyPassword("secret123", account), true);
  assert.equal(await verifyPassword("wrong-pass", account), false);

  const same = await buildAccount({ username: "tester2", password: "secret123", role: "user" });
  assert.notEqual(same.hash, account.hash); // 盐不同 → 哈希不同
  const again = await hashPassword("secret123", account.salt, account.iterations);
  assert.equal(again, account.hash);
});

test("对外结构不泄露盐与哈希", async () => {
  const account = await buildAccount({ username: "tester", password: "secret123", role: "admin" });
  const publicView = toPublicAccount(account);
  assert.equal("salt" in publicView, false);
  assert.equal("hash" in publicView, false);
  assert.equal(publicView.username, "tester");
  assert.equal(publicView.role, "admin");
});

test("登录认证：正确密码通过、错误密码失败、停用账号拒绝", async () => {
  const account = await buildAccount({ username: "student", password: "goodpass", role: "user" });
  const ok = await authenticate([account], "student", "goodpass");
  assert.equal(ok.ok, true);
  const wrong = await authenticate([account], "student", "badpass");
  assert.equal(wrong.ok, false);
  const missing = await authenticate([account], "nobody", "goodpass");
  assert.equal(missing.ok, false);
  const disabled = await authenticate([{ ...account, disabled: true }], "student", "goodpass");
  assert.equal(disabled.ok, false);
  assert.match(disabled.message, /停用/);
});

test("用户名规范化与唯一性校验", async () => {
  assert.equal(normalizeUsername("  Student1  "), "student1");
  const existing = [await buildAccount({ username: "student1", password: "123456", role: "user" })];
  assert.equal(validateNewAccount({ username: "ab", password: "123456", accounts: existing }).ok, false);
  assert.equal(validateNewAccount({ username: "student1", password: "123456", accounts: existing }).ok, false);
  assert.equal(validateNewAccount({ username: "student1", password: "123", accounts: existing }).ok, false);
  const ok = validateNewAccount({ username: "Student2", password: "123456", accounts: existing });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.username, "student2");
});

// ---------- 多模态输入测试 ----------

import { MAX_IMAGES_PER_MESSAGE } from "../app/agent/protocol.ts";

test("协议：用户消息可携带图片（多模态片段）", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const messages = sanitizeAgentMessages([
    { role: "user", content: [{ type: "text", text: "这张图写了什么？" }, { type: "image_url", image_url: { url: png } }] },
  ]);
  assert.equal(messages.length, 1);
  const content = messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, png);
});

test("协议：图片校验（非法来源/超量/非用户角色都要拦掉）", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  // 非图片 data URL 被丢弃
  const wrongScheme = sanitizeAgentMessages([
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://evil.example/x.png" } }] },
  ]);
  assert.equal(wrongScheme[0].content.filter((p) => p.type === "image_url").length, 0);
  // assistant 不允许带图片：图片被剔除后若无正文，整条消息丢弃
  const assistantImages = sanitizeAgentMessages([
    { role: "assistant", content: [{ type: "image_url", image_url: { url: png } }] },
  ]);
  assert.equal(assistantImages.length, 0);
  // assistant 有正文时保留正文、丢弃图片
  const assistantWithText = sanitizeAgentMessages([
    { role: "assistant", content: [{ type: "text", text: "看这张" }, { type: "image_url", image_url: { url: png } }] },
  ]);
  assert.equal(assistantWithText.length, 1);
  assert.equal(assistantWithText[0].content, "看这张");
  // 数量上限
  const many = sanitizeAgentMessages([
    { role: "user", content: [{ type: "text", text: "图" }, ...Array.from({ length: 8 }, () => ({ type: "image_url", image_url: { url: png } }))] },
  ]);
  assert.equal(many[0].content.filter((p) => p.type === "image_url").length, MAX_IMAGES_PER_MESSAGE);
});

test("循环：goalImages 会作为多模态输入传给模型", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  let seen = null;
  const events = await collect(runAgentLoop({
    goal: "这张图是什么？",
    goalImages: [png],
    history: [],
    step: async (messages) => {
      seen = messages;
      return { type: "message", content: "是一张课程通知截图。" };
    },
    execute: async () => ({ ok: true, summary: "noop" }),
    requestConfirmation: noopConfirm,
  }));
  assert.ok(seen);
  const userMessage = seen.find((m) => m.role === "user");
  assert.ok(Array.isArray(userMessage.content));
  assert.equal(userMessage.content[1].type, "image_url");
  assert.equal(userMessage.content[1].image_url.url, png);
  assert.ok(events.some((e) => e.type === "message"));
});

test("循环：历史消息里的图片也会保留（支持对同一张图追问）", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  let seen = null;
  await collect(runAgentLoop({
    goal: "那截止时间呢？",
    history: [{ role: "user", content: "这张图写了什么？", images: [png] }],
    step: async (messages) => { seen = messages; return { type: "message", content: "是 10 月 16 日。" }; },
    execute: async () => ({ ok: true, summary: "noop" }),
    requestConfirmation: noopConfirm,
  }));
  const historic = seen[0];
  assert.ok(Array.isArray(historic.content));
  assert.equal(historic.content[1].image_url.url, png);
});



// ---------- 对话会话测试 ----------

import { deriveConversationTitle, groupConversationsByDate, formatConversationStamp } from "../app/agent/conversations.ts";

test("会话标题：取自首条用户消息并截断", () => {
  assert.equal(deriveConversationTitle("帮我看看任务"), "帮我看看任务");
  assert.equal(deriveConversationTitle("  换行\n和   多余空格  "), "换行 和 多余空格");
  assert.equal(deriveConversationTitle(""), "新对话");
  const long = deriveConversationTitle("这是一条特别长的消息用来验证标题截断逻辑是否正确处理");
  assert.ok(long.length <= 19);
  assert.ok(long.endsWith("…"));
});

test("会话按日期分组：今天 / 昨天 / 最近 7 天 / 更早", () => {
  const now = new Date("2026-10-02T15:00:00+08:00");
  const make = (id, daysAgo, hour = 10) => {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    d.setHours(hour, 0, 0, 0);
    return { id, title: id, createdAt: d.toISOString(), updatedAt: d.toISOString() };
  };
  const groups = groupConversationsByDate([
    make("今天A", 0, 9),
    make("今天B", 0, 14),
    make("昨天", 1),
    make("三天前", 3),
    make("一个月前", 30),
  ], now);

  assert.deepEqual(groups.map((g) => g.label), ["今天", "昨天", "最近 7 天", "更早"]);
  assert.deepEqual(groups[0].items.map((i) => i.id), ["今天B", "今天A"]); // 组内按更新时间倒序
  assert.equal(groups[1].items[0].id, "昨天");
  assert.equal(groups[2].items[0].id, "三天前");
  assert.equal(groups[3].items[0].id, "一个月前");
  // 空分组不返回
  const single = groupConversationsByDate([make("只有今天", 0)], now);
  assert.equal(single.length, 1);
  assert.equal(single[0].label, "今天");
});

test("会话时间标注：今天显示时分，昨天显示昨天，更早显示日期", () => {
  const now = new Date("2026-10-02T15:00:00+08:00");
  const today = new Date("2026-10-02T09:05:00+08:00").toISOString();
  const yesterday = new Date("2026-10-01T09:05:00+08:00").toISOString();
  const older = new Date("2026-09-20T09:05:00+08:00").toISOString();
  assert.equal(formatConversationStamp(today, now), "09:05");
  assert.equal(formatConversationStamp(yesterday, now), "昨天");
  assert.equal(formatConversationStamp(older, now), "9/20");
  assert.equal(formatConversationStamp("不是日期", now), "");
});


// ---------- 任务中心逻辑测试 ----------

import {
  deriveTaskStatus,
  groupTasks,
  isDueToday,
  buildReminderText,
  parseReminderText,
  formatReminderMinutes,
  isOverdueGroup,
  isPresetReminder,
} from "../app/lib/task-utils.ts";

const makeTask = (over) => ({
  id: over.id ?? "t", title: over.title ?? "任务", courseId: "c1",
  type: over.type ?? "DDL", dueAt: over.dueAt ?? "2026-10-08T20:00",
  status: over.status ?? "未开始", priority: "中", reminder: "提前1天",
});

test("逾期自动判定：过截止未完成算逾期，已完成不受影响", () => {
  const now = new Date("2026-10-08T12:00:00+08:00");
  assert.equal(deriveTaskStatus(makeTask({ dueAt: "2026-10-08T20:00" }), now), "未开始");
  assert.equal(deriveTaskStatus(makeTask({ dueAt: "2026-10-07T20:00" }), now), "已逾期");
  // 已完成的任务不因为过期而被标成逾期
  assert.equal(deriveTaskStatus(makeTask({ dueAt: "2026-10-07T20:00", status: "已完成" }), now), "已完成");
  // 进行中的过期任务也要标成逾期
  assert.equal(deriveTaskStatus(makeTask({ dueAt: "2026-10-01T09:00", status: "进行中" }), now), "已逾期");
  // 非法日期不误判
  assert.equal(deriveTaskStatus(makeTask({ dueAt: "不是日期" }), now), "未开始");
});

test("任务分组：未逾期在前（今天/明天/本周/更晚），已逾期与已完成沉到最后", () => {
  const now = new Date("2026-10-08T12:00:00+08:00");
  const groups = groupTasks([
    makeTask({ id: "overdue", dueAt: "2026-10-01T09:00" }),
    makeTask({ id: "today", dueAt: "2026-10-08T20:00" }),
    makeTask({ id: "tomorrow", dueAt: "2026-10-09T09:00" }),
    makeTask({ id: "week", dueAt: "2026-10-12T09:00" }),
    makeTask({ id: "later", dueAt: "2026-11-01T09:00" }),
    makeTask({ id: "done", dueAt: "2026-09-01T09:00", status: "已完成" }),
  ], now);
  assert.deepEqual(groups.map((g) => g.label), ["今天", "明天", "本周", "更晚", "已逾期", "已完成"]);
  assert.equal(groups[0].items[0].id, "today");
  assert.deepEqual(groups[4].items.map((t) => t.id), ["overdue"]);
  assert.deepEqual(groups[5].items.map((t) => t.id), ["done"]);
  // 未逾期的一律排在已逾期之前
  const labels = groups.map((g) => g.label);
  assert.ok(labels.indexOf("已逾期") > labels.indexOf("更晚"));
  // 没有截止时间的任务算"无截止时间"，也不进逾期组
  const noDue = groupTasks([makeTask({ id: "nodue", dueAt: "" })], now);
  assert.deepEqual(noDue.map((g) => g.label), ["无截止时间"]);
  assert.equal(isOverdueGroup("已逾期"), true);
  assert.equal(isOverdueGroup("今天"), false);
});

import {
  parseAvailability,
  fitSessionsToAvailability,
} from "../app/lib/availability.ts";
import {
  formatSessionDetail,
  hasSessionDetail,
  parsePlanTimestamp,
  sanitizePlanSessions,
  planSummary,
  formatPlanDate,
} from "../app/lib/review-plan.ts";

test("复习计划：模型写的中文/简写日期都能解析", () => {
  const now = new Date("2026-10-10T09:00:00+08:00");
  // 标准 ISO 直接用
  assert.equal(parsePlanTimestamp("2026-10-12T19:00:00+08:00"), new Date("2026-10-12T19:00:00+08:00").getTime());
  // 10/10 这种以前是 NaN，导致整份计划被判成空
  const shortDate = new Date(parsePlanTimestamp("10/12", now));
  assert.equal(shortDate.getFullYear(), 2026);
  assert.equal(shortDate.getMonth(), 9);
  assert.equal(shortDate.getDate(), 12);
  assert.equal(shortDate.getHours(), 19); // 只给日期时按晚上 19:00 算，避免当天就显示逾期
  // 「10/10 今晚」这种带口语的说法
  const tonight = new Date(parsePlanTimestamp("10/10 今晚", now));
  assert.equal(tonight.getDate(), 10);
  assert.equal(tonight.getHours(), 19);
  // 相对日期
  const tomorrow = new Date(parsePlanTimestamp("明天", now));
  assert.equal(tomorrow.getDate(), 11);
  // 带具体时间的写法
  const withTime = new Date(parsePlanTimestamp("2026年10月15日下午 20:30", now));
  assert.equal(withTime.getDate(), 15);
  assert.equal(withTime.getHours(), 20);
  // 完全看不懂的返回 NaN，交给上层丢弃
  assert.ok(Number.isNaN(parsePlanTimestamp("下周找个时间", now)));
});

test("复习计划：草案会排序去重、兜住时长", () => {
  const sessions = sanitizePlanSessions([
    { date: "10/14", title: "第三章", durationMinutes: 60 },
    { date: "10/12", title: "第一章", durationMinutes: 60 },
    { date: "10/12", title: "第一章", durationMinutes: 60 }, // 重复
    { date: "10/13", title: "第二章", durationMinutes: 9999 }, // 时长越界
    { date: "看不懂", title: "无效", durationMinutes: 30 }, // 日期无效
    { title: "没有日期", durationMinutes: 30 },
  ]);
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions.map((item) => item.title), ["第一章", "第二章", "第三章"]);
  assert.equal(sessions[1].durationMinutes, 240);
  assert.match(planSummary(sessions), /共 3 次/);
  assert.match(formatPlanDate(sessions[0].date), /10\/12/);
  // 非数组直接当空计划
  assert.deepEqual(sanitizePlanSessions("不是数组"), []);
});

test("空闲时间解析：周末上午 / 工作日晚上 / 每天 N 分钟", () => {
  const weekend = parseAvailability("周末上午 09:00–12:00");
  assert.deepEqual(weekend.days, [0, 6]);
  assert.equal(weekend.startMinutes, 9 * 60);
  assert.equal(weekend.endMinutes, 12 * 60);

  const workday = parseAvailability("工作日晚上 19:00–21:00");
  assert.deepEqual(workday.days, [1, 2, 3, 4, 5]);
  assert.equal(workday.startMinutes, 19 * 60);

  const range = parseAvailability("周一到周五晚上");
  assert.deepEqual(range.days, [1, 2, 3, 4, 5]);
  assert.equal(range.startMinutes, 19 * 60);

  const daily = parseAvailability("每天 60 分钟");
  assert.deepEqual(daily.days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(daily.minutesPerSession, 60);

  // 没写清楚就不限制，别把用户没说的话当成规则
  assert.deepEqual(parseAvailability("你看着办").days, []);
});

test("复习计划必须落在用户方便的时间：选了周末上午就不会排到周一", () => {
  const availability = parseAvailability("周末上午 09:00–12:00");
  const deadline = new Date("2026-10-25T00:00:00+08:00").getTime();
  const input = [
    { date: "2026-10-12T19:00:00+08:00", title: "周一安排", durationMinutes: 60 },
    { date: "2026-10-13T19:00:00+08:00", title: "周二安排", durationMinutes: 60 },
    { date: "2026-10-17T19:00:00+08:00", title: "周六晚上", durationMinutes: 60 },
  ];
  const { sessions, adjustment } = fitSessionsToAvailability(input, availability, deadline);
  assert.equal(sessions.length, 3);
  for (const session of sessions) {
    const date = new Date(session.date);
    assert.ok([0, 6].includes(date.getDay()), "排到了非周末：" + session.title);
    assert.ok(date.getHours() >= 9 && date.getHours() < 12, "排到了非上午：" + session.title);
  }
  // 早于今天的安排会被挪到最近的可排日期
  const past = fitSessionsToAvailability(
    [{ date: "2020-01-01T19:00:00+08:00", title: "过期安排", durationMinutes: 45 }],
    availability,
    deadline,
  );
  assert.equal(past.sessions.length, 1);
  assert.ok(new Date(past.sessions[0].date).getTime() > Date.now() - 86_400_000);
  assert.match(adjustment, /重新对齐/);

  // 今天已经过去的时间段要顺延，不能生成出来就是"已逾期"
  const pastSlot = fitSessionsToAvailability(
    [{ date: new Date().toISOString(), title: "今天很早的安排", durationMinutes: 60 }],
    availability,
    new Date(Date.now() + 30 * 86_400_000).getTime(),
  );
  if (pastSlot.sessions.length) {
    assert.ok(new Date(pastSlot.sessions[0].date).getTime() > Date.now(), "不应该排到已经过去的时间");
  }

  // 排不进时间窗（超过考试时间）就明确去掉并说明
  const late = fitSessionsToAvailability(
    [{ date: "2026-10-30T19:00:00+08:00", title: "考后安排", durationMinutes: 60 }],
    availability,
    deadline,
  );
  assert.equal(late.sessions.length, 0);
  assert.match(late.adjustment, /已去掉/);
});

test("复习计划的详细计划：重点 / 路线 / 自测会保留并拼成任务详情", () => {
  const sessions = sanitizePlanSessions([
    {
      date: "10/12",
      title: "第二章：连续优化",
      durationMinutes: 60,
      resourceName: "第二章连续最优化课件",
      focus: "凸函数判定与 KKT 条件",
      route: "先过定义 → 重做课件例题 → 整理易错点",
      checkpoint: "不看答案默写 KKT 条件并解一道例题",
    },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].focus, "凸函数判定与 KKT 条件");
  assert.equal(hasSessionDetail(sessions[0]), true);

  const detail = formatSessionDetail(sessions[0]);
  assert.match(detail, /【重点】凸函数判定与 KKT 条件/);
  assert.match(detail, /【复习路线】/);
  assert.match(detail, /【自测】/);
  assert.match(detail, /【资料】第二章连续最优化课件/);

  // 没有详细计划的安排就是普通的
  assert.equal(hasSessionDetail({ date: "2026-10-12T11:00:00.000Z", title: "裸安排", durationMinutes: 30 }), false);
  assert.equal(formatSessionDetail({ date: "2026-10-12T11:00:00.000Z", title: "裸安排", durationMinutes: 30 }), "");

  // 过长的字段会被截断，避免一条任务塞几千字
  const long = sanitizePlanSessions([{ date: "10/12", title: "长", durationMinutes: 60, route: "x".repeat(900) }]);
  assert.ok(long[0].route.length <= 400);
});

test("今天判定与提醒规则组合", () => {
  const now = new Date("2026-10-08T12:00:00+08:00");
  assert.equal(isDueToday(makeTask({ dueAt: "2026-10-08T23:59" }), now), true);
  assert.equal(isDueToday(makeTask({ dueAt: "2026-10-09T00:30" }), now), false);

  assert.equal(buildReminderText([4320, 1440, 120]), "提前3天、1天、2小时");
  assert.equal(buildReminderText([1440]), "提前1天");
  assert.equal(buildReminderText([60]), "提前1小时");
  assert.equal(buildReminderText([]), "提前1天");
  assert.deepEqual(parseReminderText("提前3天、1天、2小时").sort((a, b) => a - b), [120, 1440, 4320]);
  assert.deepEqual(parseReminderText("提前30分钟"), [30]);
  // 自定义提醒：任意分钟数都能写进去、读回来
  assert.equal(buildReminderText([90]), "提前90分钟");
  assert.equal(buildReminderText([90, 1440]), "提前1天、90分钟");
  assert.equal(buildReminderText([10080]), "提前7天");
  assert.deepEqual(parseReminderText(buildReminderText([10080, 45])).sort((a, b) => a - b), [45, 10080]);
  assert.equal(isPresetReminder(1440), true);
  assert.equal(isPresetReminder(90), false);
  assert.equal(formatReminderMinutes(4320), "3天");
  assert.equal(formatReminderMinutes(90), "90分钟");
  // 非法值不写进提醒文本
  assert.equal(buildReminderText([0, Number.NaN, -5]), "提前1天");
});

