// 提醒调度：解析任务的提醒规则（"提前3天、1天、2小时"），计算当前应触发的提醒。
// 纯逻辑模块；页面每 60 秒检查一次，触发桌面通知 + 对话内提醒。
import type { Task } from "../lib/local-store";

export type DueReminder = {
  key: string;
  taskId: string;
  title: string;
  type: string;
  dueAt: string;
  minutesLeft: number;
  offsetLabel: string;
};

const DAY_MINUTES = 1440;
const HOUR_MINUTES = 60;
const FIRED_KEY = "study-agent-reminders-fired";

// 账号隔离：提醒触发记录按账号分开，避免 A 用户触发过导致 B 用户收不到
let reminderScope = "";

export function setReminderScope(userId: string) {
  reminderScope = userId ? userId.replace(/[^a-zA-Z0-9._-]/g, "") : "";
}

function scopedFiredKey() {
  return reminderScope ? `${FIRED_KEY}::${reminderScope}` : FIRED_KEY;
}
const MAX_FIRED_KEYS = 500;

// "提前3天、1天、2小时" → [4320, 1440, 120]（分钟，从大到小）
export function parseReminderOffsets(reminder: string): number[] {
  const offsets: number[] = [];
  for (const match of reminder.matchAll(/(\d+)\s*天/g)) offsets.push(Number(match[1]) * DAY_MINUTES);
  for (const match of reminder.matchAll(/(\d+)\s*(?:个)?小时/g)) offsets.push(Number(match[1]) * HOUR_MINUTES);
  for (const match of reminder.matchAll(/(\d+)\s*分钟/g)) offsets.push(Number(match[1]));
  return [...new Set(offsets)].filter((value) => value > 0).sort((a, b) => b - a);
}

export function computeDueReminders(tasks: Task[], now: Date, firedKeys: Set<string>): DueReminder[] {
  const result: DueReminder[] = [];
  const nowMs = now.getTime();

  for (const task of tasks) {
    if (task.status === "已完成") continue;
    const dueMs = new Date(task.dueAt).getTime();
    if (Number.isNaN(dueMs)) continue;
    const minutesLeft = Math.round((dueMs - nowMs) / 60_000);

    if (minutesLeft <= 0) {
      const key = `${task.id}@overdue`;
      // 截止当天提醒一次，超过一天不再打扰
      if (!firedKeys.has(key) && minutesLeft > -DAY_MINUTES) {
        result.push({ key, taskId: task.id, title: task.title, type: task.type, dueAt: task.dueAt, minutesLeft, offsetLabel: "已截止" });
      }
      continue;
    }

    // 当前档位 = 大于等于剩余时间的最小档；只触发这一档且仅一次。
    // 例如剩 90 分钟时档位是"提前2小时"，不会误触发"提前3天"，也不会在触发后回落补发旧档。
    const offsets = parseReminderOffsets(task.reminder).sort((a, b) => a - b);
    const currentTier = offsets.find((offset) => offset >= minutesLeft);
    if (currentTier !== undefined) {
      const key = `${task.id}@${currentTier}`;
      if (!firedKeys.has(key)) {
        result.push({
          key,
          taskId: task.id,
          title: task.title,
          type: task.type,
          dueAt: task.dueAt,
          minutesLeft,
          offsetLabel: currentTier >= DAY_MINUTES
            ? `提前 ${Math.round(currentTier / DAY_MINUTES)} 天`
            : currentTier >= HOUR_MINUTES
              ? `提前 ${Math.round(currentTier / HOUR_MINUTES)} 小时`
              : `提前 ${currentTier} 分钟`,
        });
      }
    }
  }

  return result.sort((a, b) => a.minutesLeft - b.minutesLeft);
}

export function formatMinutesLeft(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  if (minutes < DAY_MINUTES) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / DAY_MINUTES)} 天`;
}

export function loadFiredReminders(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(scopedFiredKey());
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveFiredReminders(keys: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(scopedFiredKey(), JSON.stringify([...keys].slice(-MAX_FIRED_KEYS)));
  } catch {
    // 存储失败时提醒可能重复，可接受
  }
}

// ---------- 提醒去重与限量 ----------
//
// 早期版本的"已提醒"记录只写在**本机 localStorage**，于是每换一个浏览器/设备都会把同一条提醒再发一遍，
// 对话里就堆了一串重复提醒；任务删掉之后那些历史提醒还留在聊天记录里，看着像"删了还提醒"。
// 现在把"提醒过"这件事记进消息本身（steps 里的标记），随对话一起同步，做到：
//   1) 同一档提醒跨设备只发一次；
//   2) 每个任务每天最多 2 条提醒；
//   3) 加载历史时清掉重复的、以及任务已经删掉的提醒。

/** 提醒消息里带的标记前缀，后面接 `${taskId}@${tier}` */
export const REMINDER_MARK = "reminder:";
/** 每个任务每天最多提醒几次 */
export const MAX_REMINDERS_PER_DAY = 2;

type MarkableMessage = { text?: string; steps?: unknown; createdAt?: string };

function markerOf(message: MarkableMessage): string | null {
  const steps = (message as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    const id = (step as { id?: unknown })?.id;
    if (typeof id === "string" && id.startsWith(REMINDER_MARK)) return id;
  }
  return null;
}

/** 老消息没有标记，就从文案里取任务名（⏰ 提醒：「XX」…） */
function titleOf(message: MarkableMessage): string {
  const match = (message.text ?? "").match(/「([^」]+)」/);
  return match ? match[1] : "";
}

function isReminderMessage(message: MarkableMessage): boolean {
  return Boolean(markerOf(message)) || (message.text ?? "").startsWith("⏰");
}

export type ReminderMark = { markerId: string; taskKey: string; at: number };

/** 从对话记录里收集"已经提醒过"的标记（标记存在消息里，会随对话同步） */
export function collectReminderMarks(
  conversations: Array<{ messages?: MarkableMessage[] }> = [],
): ReminderMark[] {
  const marks: ReminderMark[] = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages ?? []) {
      const marker = markerOf(message);
      if (!marker) continue;
      const body = marker.slice(REMINDER_MARK.length);
      marks.push({
        markerId: marker,
        taskKey: body.split("@")[0] ?? "",
        at: Date.parse(message.createdAt ?? "") || 0,
      });
    }
  }
  return marks;
}

/** 这个任务今天已经提醒过几次 */
export function countRemindersToday(marks: ReminderMark[], taskKey: string, now: Date = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return marks.filter((mark) => mark.taskKey === taskKey && mark.at >= start).length;
}

/**
 * 清理历史提醒消息：
 *   - 任务已经不存在（按 id 或标题对不上）的提醒直接丢掉；
 *   - 同一个任务同一天最多保留 maxPerDay 条（保留最早的几条）。
 */
export function pruneReminderMessages<T extends MarkableMessage>(
  messages: T[],
  options: { taskIds?: string[]; taskTitles?: string[]; maxPerDay?: number } = {},
): T[] {
  const maxPerDay = options.maxPerDay ?? MAX_REMINDERS_PER_DAY;
  const ids = new Set(options.taskIds ?? []);
  const titles = new Set(options.taskTitles ?? []);
  const hasTaskIndex = ids.size > 0 || titles.size > 0;
  const seen = new Map<string, number>();
  const out: T[] = [];

  for (const message of messages) {
    if (!isReminderMessage(message)) {
      out.push(message);
      continue;
    }
    const marker = markerOf(message);
    const taskKey = marker ? marker.slice(REMINDER_MARK.length).split("@")[0] : titleOf(message);
    // 任务已经不在了：这条提醒不再保留
    if (hasTaskIndex && taskKey && !ids.has(taskKey) && !titles.has(taskKey)) continue;

    const day = (message.createdAt ?? "").slice(0, 10) || "unknown";
    const bucket = `${taskKey}@${day}`;
    const count = seen.get(bucket) ?? 0;
    if (count >= maxPerDay) continue;
    seen.set(bucket, count + 1);
    out.push(message);
  }
  return out;
}
