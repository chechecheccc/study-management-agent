// 模拟复习计划生成的完整循环，看 DeepSeek 的行为与耗时
const BASE = "http://localhost:3000";
const context = { currentDate: new Date().toISOString(), timezone: "Asia/Shanghai", profile: { name: "", studyTime: "工作日晚上 19:00–21:00", goal: "", notes: [] } };
const goal = "请为「数据库系统」制定复习计划。考试或目标时间：2026-10-03T09:00:00.000Z。我方便学习的时间：工作日晚上 19:00–21:00。请先调用工具查询该课程的未完成任务与已有资料，再把计划拆成具体到天、每次 30-90 分钟的可执行安排，所有安排必须早于考试时间，最后调用 save_review_plan 保存。";

let messages = [{ role: "user", content: goal }];
const started = Date.now();
for (let step = 1; step <= 8; step += 1) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/agent/step`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, context }),
  });
  const data = await r.json();
  const ms = Date.now() - t;
  if (data.type === "message") { console.log(`step${step} [${ms}ms] 最终回复: ${data.content.slice(0, 110)}`); break; }
  const calls = data.calls ?? [];
  console.log(`step${step} [${ms}ms] 调用: ${calls.map((c) => c.name).join(", ")}`);
  if (calls.some((c) => c.name === "save_review_plan")) {
    const p = calls.find((c) => c.name === "save_review_plan");
    console.log("  计划条目数:", (p.arguments.sessions ?? []).length);
  }
  messages = [
    ...messages,
    { role: "assistant", content: data.content ?? "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) },
    ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ ok: true, summary: "模拟", data: c.name === "list_tasks" ? [{ title: "实验一", dueAt: "2026-10-01T20:00" }] : c.name === "search_resources" ? [{ title: "第一章" }] : [] }) })),
  ];
}
console.log("总耗时:", ((Date.now() - started) / 1000).toFixed(1) + "s");
