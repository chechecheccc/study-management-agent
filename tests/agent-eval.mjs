// Agent 行为评测：对真实运行的服务发场景请求，断言模型的工具选择。
// 用法：先启动 npm run dev，再运行 npm run eval:agent
// 环境变量：AGENT_EVAL_BASE_URL（默认 http://localhost:3000）
const BASE = process.env.AGENT_EVAL_BASE_URL ?? "http://localhost:3000";

const context = {
  currentDate: new Date().toISOString(),
  timezone: "Asia/Shanghai",
  profile: { name: "评测用户", studyTime: "工作日晚上", goal: "期末 90 分", notes: [] },
};

const scenarios = [
  { name: "查询临近 DDL 应调用 list_tasks", input: "我下周有什么要交的？", expectTool: "list_tasks" },
  { name: "搜索资料应调用 search_resources", input: "帮我找数据库的课件", expectTool: "search_resources" },
  { name: "录入 DDL 应调用 create_task", input: "帮我记下：后天晚上 8 点交数据库实验报告", expectTool: "create_task" },
  { name: "完成任务应先查后改（list_tasks 或 update_task_status）", input: "我把复习关系代数的任务做完了", expectAny: ["update_task_status", "list_tasks"] },
  { name: "读资料内容应调用 search_resources 或 read_resource", input: "数据库第一章讲了什么？", expectAny: ["search_resources", "read_resource"] },
  { name: "告知作息应调用 update_profile 或 remember_fact", input: "我一般工作日晚上 7 点到 9 点有空学习", expectAny: ["update_profile", "remember_fact"] },
  { name: "复习顺延应使用 list_tasks 或 update_task", input: "昨天的复习没完成，帮我往后挪", expectAny: ["list_tasks", "update_task"] },
  { name: "闲聊不应调用工具", input: "你好呀，今天心情不错", expectTool: null },
];

// 模拟工具返回的真实感数据：避免因返回空数据导致模型反复重查（那是评测环境假象）
function mockToolData(name) {
  if (name === "list_courses") {
    return [
      { name: "数据库系统", semester: "2026 秋季", resources: 3 },
      { name: "高等数学", semester: "2026 秋季", resources: 1 },
    ];
  }
  if (name === "list_tasks") {
    return [
      { title: "数据库实验报告", course: "数据库系统", type: "DDL", dueAt: "2026-09-28T20:00", status: "未开始", priority: "高" },
    ];
  }
  if (name === "search_resources") {
    return [
      { title: "第一章：关系模型与关系代数", course: "数据库系统", type: "课件", tags: ["关系模型"], status: "待复习", fileName: "数据库-第一章.pdf", hasContent: true, contentExcerpt: "本章介绍关系模型的基本概念与关系代数运算。" },
    ];
  }
  if (name === "read_resource") {
    return { title: "第一章：关系模型与关系代数", course: "数据库系统", type: "课件", content: "本章介绍关系模型的基本概念：关系、元组、属性、域，以及选择、投影、并、差、笛卡尔积等关系代数运算。" };
  }
  return [];
}

// 模拟完整的 Agent 循环（最多 6 步），记录整条工具轨迹。
// 这样允许模型先做准备动作（如 list_courses），只要期望工具出现在轨迹里就算通过——
// 这正是多步推理应有的行为，而不是只看第一步。
async function runScenario(input) {
  let messages = [{ role: "user", content: input }];
  const trajectory = [];
  for (let step = 0; step < 6; step += 1) {
    const response = await fetch(`${BASE}/api/agent/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, context }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
    if (data.type === "message") return { trajectory, final: data.content };
    const calls = data.calls ?? [];
    trajectory.push(...calls.map((call) => call.name));
    messages = [
      ...messages,
      {
        role: "assistant",
        content: data.content ?? "",
        tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      },
      ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true, summary: "评测模拟结果", data: mockToolData(call.name) }) })),
    ];
  }
  return { trajectory, final: "" };
}

let failed = 0;
for (const scenario of scenarios) {
  try {
    const { trajectory, final } = await runScenario(scenario.input);
    const ok = scenario.expectTool !== undefined
      ? scenario.expectTool === null
        ? trajectory.length === 0
        : trajectory.includes(scenario.expectTool)
      : scenario.expectAny
        ? scenario.expectAny.some((name) => trajectory.includes(name))
        : trajectory.length === 0;
    const shown = trajectory.length ? trajectory.join(" → ") : (final ? "(直接回复)" : "(无动作)");
    console.log(`${ok ? "PASS" : "FAIL"}  ${scenario.name}  →  ${shown}`);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`ERROR ${scenario.name}  →  ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}
console.log(failed === 0 ? `\n全部 ${scenarios.length} 个场景通过` : `\n${failed}/${scenarios.length} 个场景未通过`);
process.exit(failed === 0 ? 0 : 1);



