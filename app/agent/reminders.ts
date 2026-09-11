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
    const raw = window.localStorage.getItem(FIRED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveFiredReminders(keys: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FIRED_KEY, JSON.stringify([...keys].slice(-MAX_FIRED_KEYS)));
  } catch {
    // 存储失败时提醒可能重复，可接受
  }
}


