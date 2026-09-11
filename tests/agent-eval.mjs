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

let failed = 0;
for (const scenario of scenarios) {
  try {
    const response = await fetch(`${BASE}/api/agent/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: scenario.input }], context }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
    const tool = data.type === "tool_calls" ? data.calls?.[0]?.name ?? null : null;
    const ok = scenario.expectTool !== undefined
      ? tool === scenario.expectTool
      : scenario.expectAny
        ? scenario.expectAny.includes(tool)
        : tool === null;
    console.log(`${ok ? "PASS" : "FAIL"}  ${scenario.name}  →  ${tool ?? "(直接回复)"}`);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`ERROR ${scenario.name}  →  ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}
console.log(failed === 0 ? `\n全部 ${scenarios.length} 个场景通过` : `\n${failed}/${scenarios.length} 个场景未通过`);
process.exit(failed === 0 ? 0 : 1);

