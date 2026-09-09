// Agent 主动性触发器：不等用户开口，基于本地数据状态产生"观察"，
// 由 Agent 循环消费后给出主动建议。纯逻辑模块，可在 Node 中直接测试。
import type { AppSnapshot } from "../lib/local-store";

export type ProactiveSignalKind = "overdue" | "due_soon" | "unorganized";

export type ProactiveSignal = {
  kind: ProactiveSignalKind;
  title: string;
  detail: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeProactiveSignals(
  snapshot: AppSnapshot,
  now: Date = new Date(),
  withinDays = 3,
): ProactiveSignal[] {
  const signals: ProactiveSignal[] = [];
  const horizon = now.getTime() + withinDays * DAY_MS;
  const courseName = (courseId: string) =>
    snapshot.courses.find((course) => course.id === courseId)?.name ?? "未分类";

  const openTasks = snapshot.tasks
    .filter((task) => task.status !== "已完成")
    .map((task) => ({ task, due: new Date(task.dueAt).getTime() }))
    .filter(({ due }) => !Number.isNaN(due))
    .sort((a, b) => a.due - b.due);

  for (const { task, due } of openTasks) {
    if (due < now.getTime()) {
      signals.push({
        kind: "overdue",
        title: task.title,
        detail: `${courseName(task.courseId)} · ${task.type} · 已于 ${task.dueAt} 截止`,
      });
    } else if (due <= horizon) {
      signals.push({
        kind: "due_soon",
        title: task.title,
        detail: `${courseName(task.courseId)} · ${task.type} · 截止 ${task.dueAt}`,
      });
    }
  }

  const unorganized = snapshot.resources.filter((resource) => resource.status === "未整理").length;
  if (unorganized > 0) {
    signals.push({
      kind: "unorganized",
      title: `${unorganized} 份资料待整理`,
      detail: "资料库中有尚未确认归类的资料",
    });
  }

  return signals;
}

// 把观察结果包装成一次 Agent 循环的目标：模型会先调用工具核实细节，再给出主动建议。
export function buildProactiveGoal(signals: ProactiveSignal[], now: Date = new Date()): string {
  const lines = signals.map((signal) => `- [${signal.kind}] ${signal.title}（${signal.detail}）`);
  return [
    "[系统观察] 用户尚未开口。后台巡检发现以下情况：",
    ...lines,
    `现在时间：${now.toISOString()}。`,
    "请你主动开场：先调用工具核实相关任务或资料的真实状态，然后用一段简洁自然的中文向用户汇报最重要的一两件事，并给出今天可以执行的建议。不要调用任何写入工具，不要修改数据。",
  ].join("\n");
}

export function buildProactiveFallback(signals: ProactiveSignal[]): string {
  const headline = signals
    .slice(0, 3)
    .map((signal) => signal.title)
    .join("；");
  return `我巡检了你的学习空间，需要关注：${headline}。当前模型未配置，接入 GLM 后我可以给出更具体的安排建议。`;
}
