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
  assert.match(goal, /不要调用任何写入工具/);
});

test("记忆与提示词：画像注入系统提示词", () => {
  const profile = sanitizeProfile({ name: " 小王 ", studyTime: "工作日晚上", goal: "数据库期末 90 分" });
  assert.equal(profile.name, "小王");
  const prompt = buildAgentSystemPrompt({ currentDate: "2026-09-09T09:00:00+08:00", timezone: "Asia/Shanghai", profile });
  assert.match(prompt, /学习管家/);
  assert.match(prompt, /小王/);
  assert.match(prompt, /工作日晚上/);
  assert.match(prompt, /确认卡片/);
  assert.match(prompt, /不可信数据/);
  assert.match(formatProfileForPrompt({ name: "", studyTime: "", goal: "" }), /尚未填写/);
});
