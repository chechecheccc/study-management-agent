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

export type TaskGroupLabel = "今天" | "明天" | "本周" | "更晚" | "无截止时间" | "已逾期" | "已完成";

export type TaskGroup = { label: TaskGroupLabel; items: Task[] };

/** 分组顺序：还没过期的事排前面，已逾期与已完成沉到最后。组内按截止时间升序。 */
export const TASK_GROUP_ORDER: TaskGroupLabel[] = [
  "今天",
  "明天",
  "本周",
  "更晚",
  "无截止时间",
  "已逾期",
  "已完成",
];

export function groupTasks(tasks: Task[], now: Date = new Date()): TaskGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = startOfToday + DAY_MS;
  const startOfDayAfter = startOfTomorrow + DAY_MS;
  const weekEnd = startOfToday + 7 * DAY_MS;

  const buckets: Record<TaskGroupLabel, Task[]> = {
    今天: [],
    明天: [],
    本周: [],
    更晚: [],
    无截止时间: [],
    已逾期: [],
    已完成: [],
  };

  for (const task of tasks) {
    const due = new Date(task.dueAt).getTime();
    if (Number.isNaN(due)) {
      buckets["无截止时间"].push(task);
      continue;
    }
    // 已完成的任务不再算逾期，单独收在最后一组
    if (task.status === "已完成") {
      buckets["已完成"].push(task);
      continue;
    }
    if (due < now.getTime()) {
      buckets["已逾期"].push(task);
      continue;
    }
    if (due < startOfTomorrow) buckets["今天"].push(task);
    else if (due < startOfDayAfter) buckets["明天"].push(task);
    else if (due < weekEnd) buckets["本周"].push(task);
    else buckets["更晚"].push(task);
  }

  return TASK_GROUP_ORDER.map((label) => ({
    label,
    items: [...buckets[label]].sort((a, b) => (a.dueAt || "9999").localeCompare(b.dueAt || "9999")),
  })).filter((group) => group.items.length > 0);
}

/** 是否是"已逾期"这类需要提醒用户的组 */
export function isOverdueGroup(label: TaskGroupLabel) {
  return label === "已逾期";
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

/** 把分钟数写成可读文字：3天 / 2小时 / 45分钟 */
export function formatReminderMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}天`;
  if (minutes % 60 === 0) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

/** 是不是预设里的那几档（用来判断"自定义"要不要点亮） */
export function isPresetReminder(minutes: number): boolean {
  return REMINDER_CHOICES.some((choice) => choice.minutes === minutes);
}

/** 把勾选的提醒组合成存储字符串，例如「提前3天、1天、2小时」 */
export function buildReminderText(selectedMinutes: number[]): string {
  const options = [...new Set(selectedMinutes.filter((value) => Number.isFinite(value) && value > 0))];
  if (!options.length) return "提前1天";
  const ordered = options.sort((a, b) => b - a);
  return `提前${ordered.map(formatReminderMinutes).join("、")}`;
}

/** 从存储字符串解析出勾选状态 */
export function parseReminderText(reminder: string): number[] {
  const minutes: number[] = [];
  for (const match of (reminder ?? "").matchAll(/(\d+)\s*天/g)) minutes.push(Number(match[1]) * 1440);
  for (const match of (reminder ?? "").matchAll(/(\d+)\s*(?:个)?小时/g)) minutes.push(Number(match[1]) * 60);
  for (const match of (reminder ?? "").matchAll(/(\d+)\s*分钟/g)) minutes.push(Number(match[1]));
  return minutes;
}
