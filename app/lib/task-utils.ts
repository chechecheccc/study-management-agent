// 任务中心的纯逻辑：逾期判定、时间分组、提醒规则组合。
// 不依赖 React / DOM，可在 Node 中直接测试。
import type { Task } from "./local-store";

export type TaskStatus = Task["status"];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 计算任务的"实际状态"。
 * 存储的 status 不会自动变化，所以展示与查询时都要用这个函数推导：
 * 已完成就是已完成；未完成且已过截止时间 → 已逾期；其余保持原状态。
 */
export function deriveTaskStatus(task: Task, now: Date = new Date()): TaskStatus {
  if (task.status === "已完成") return "已完成";
  const due = new Date(task.dueAt).getTime();
  if (!Number.isNaN(due) && due < now.getTime()) return "已逾期";
  return task.status;
}

export function isTaskOverdue(task: Task, now: Date = new Date()): boolean {
  return deriveTaskStatus(task, now) === "已逾期";
}

export type TaskGroupLabel = "已逾期" | "今天" | "明天" | "本周" | "更晚" | "无截止时间";

export type TaskGroup = { label: TaskGroupLabel; items: Task[] };

/** 按时间分组：已逾期 → 今天 → 明天 → 本周 → 更晚。组内按截止时间升序。 */
export function groupTasks(tasks: Task[], now: Date = new Date()): TaskGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = startOfToday + DAY_MS;
  const startOfDayAfter = startOfTomorrow + DAY_MS;
  const weekEnd = startOfToday + 7 * DAY_MS;

  const groups: TaskGroup[] = [
    { label: "已逾期", items: [] },
    { label: "今天", items: [] },
    { label: "明天", items: [] },
    { label: "本周", items: [] },
    { label: "更晚", items: [] },
    { label: "无截止时间", items: [] },
  ];

  for (const task of tasks) {
    const due = new Date(task.dueAt).getTime();
    if (Number.isNaN(due)) {
      groups[5].items.push(task);
      continue;
    }
    if (due < now.getTime() && task.status !== "已完成") groups[0].items.push(task);
    else if (due < startOfTomorrow) groups[1].items.push(task);
    else if (due < startOfDayAfter) groups[2].items.push(task);
    else if (due < weekEnd) groups[3].items.push(task);
    else groups[4].items.push(task);
  }

  return groups
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => (a.dueAt || "9999").localeCompare(b.dueAt || "9999")),
    }))
    .filter((group) => group.items.length > 0);
}

/** 任务是否落在今天（用于"今天做什么"） */
export function isDueToday(task: Task, now: Date = new Date()) {
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth() && due.getDate() === now.getDate();
}

// ---------- 提醒规则 ----------

export type ReminderChoice = { minutes: number; label: string };

export const REMINDER_CHOICES: ReminderChoice[] = [
  { minutes: 3 * 1440, label: "提前 3 天" },
  { minutes: 1440, label: "提前 1 天" },
  { minutes: 120, label: "提前 2 小时" },
  { minutes: 60, label: "提前 1 小时" },
];

/** 把勾选的提醒组合成存储字符串，例如「提前3天、1天、2小时」 */
export function buildReminderText(selectedMinutes: number[]): string {
  if (!selectedMinutes.length) return "提前1天";
  const ordered = [...new Set(selectedMinutes)].sort((a, b) => b - a);
  const parts = ordered.map((minutes) => {
    if (minutes % 1440 === 0) return `${minutes / 1440}天`;
    if (minutes % 60 === 0) return `${minutes / 60}小时`;
    return `${minutes}分钟`;
  });
  return `提前${parts.join("、")}`;
}

/** 从存储字符串解析出勾选状态 */
export function parseReminderText(reminder: string): number[] {
  const minutes: number[] = [];
  for (const match of (reminder ?? "").matchAll(/(\d+)\s*天/g)) minutes.push(Number(match[1]) * 1440);
  for (const match of (reminder ?? "").matchAll(/(\d+)\s*(?:个)?小时/g)) minutes.push(Number(match[1]) * 60);
  for (const match of (reminder ?? "").matchAll(/(\d+)\s*分钟/g)) minutes.push(Number(match[1]));
  return minutes;
}
