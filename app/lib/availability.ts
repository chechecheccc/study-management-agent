// 用户"什么时候方便学习"的解析与落实。
//
// 为什么需要它：模型经常忽略这句话（用户选了"周末上午"，计划里却出现周一/周三）。
// 所以这里把空闲时间解析成硬规则，生成计划后强制对齐，对不上的安排挪时间或去掉，
// 并把调整结果明确告诉用户。纯逻辑，可在 Node 中测试。
import type { PlanSession } from "./review-plan";

export type Availability = {
  raw: string;
  /** 允许的星期：0=周日 … 6=周六；空数组表示不限 */
  days: number[];
  /** 允许开始的时间（当天分钟数，例如 09:00 = 540）；null 表示不限 */
  startMinutes: number | null;
  endMinutes: number | null;
  /** 用户说的单次时长（"每天 60 分钟"），null 表示不限制 */
  minutesPerSession: number | null;
};

const WEEKDAY_INDEX: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function parseAvailability(raw: string): Availability {
  const text = (raw ?? "").trim();
  const days = new Set<number>();

  const range = text.match(/周([一二三四五六日天])\s*(?:到|至|-|~|～|—)\s*周?([一二三四五六日天])/);
  if (range) {
    const from = WEEKDAY_INDEX[range[1]];
    const to = WEEKDAY_INDEX[range[2]];
    for (let step = 0; step < 7; step += 1) {
      const day = (from + step) % 7;
      days.add(day);
      if (day === to) break;
    }
  }
  if (/工作日|平日|上课日/.test(text)) [1, 2, 3, 4, 5].forEach((day) => days.add(day));
  if (/周末|双休/.test(text)) [0, 6].forEach((day) => days.add(day));
  if (/每天|每日|天天|任意/.test(text)) [0, 1, 2, 3, 4, 5, 6].forEach((day) => days.add(day));
  for (const [name, index] of Object.entries(WEEKDAY_INDEX)) {
    if (new RegExp(`周${name}`).test(text)) days.add(index);
  }

  const timeRange = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|~|～|到|至|—)\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  let startMinutes: number | null = null;
  let endMinutes: number | null = null;
  if (timeRange) {
    startMinutes = Number(timeRange[1]) * 60 + Number(timeRange[2]);
    endMinutes = Number(timeRange[3]) * 60 + Number(timeRange[4]);
  } else if (/上午|早上|清晨|早晨/.test(text)) {
    startMinutes = 9 * 60;
    endMinutes = 12 * 60;
  } else if (/下午/.test(text)) {
    startMinutes = 14 * 60;
    endMinutes = 17 * 60;
  } else if (/晚上|傍晚|夜间|今晚/.test(text)) {
    startMinutes = 19 * 60;
    endMinutes = 21 * 60;
  } else {
    const single = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (single) startMinutes = Number(single[1]) * 60 + Number(single[2]);
  }

  const per = text.match(/(\d+)\s*分钟/);
  return {
    raw: text,
    days: [...days].sort((a, b) => a - b),
    startMinutes,
    endMinutes,
    minutesPerSession: per ? Number(per[1]) : null,
  };
}

/** 把空闲时间说成人话，用于界面上解释"我按什么排的" */
export function describeAvailability(availability: Availability): string {
  const parts: string[] = [];
  if (availability.days.length) {
    const isWorkday = availability.days.length === 5 && [1, 2, 3, 4, 5].every((day) => availability.days.includes(day));
    const isWeekend = availability.days.length === 2 && availability.days.includes(0) && availability.days.includes(6);
    parts.push(isWorkday ? "工作日" : isWeekend ? "周末" : availability.days.map((day) => WEEKDAY_LABEL[day]).join("、"));
  }
  if (availability.startMinutes !== null) {
    const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
    parts.push(availability.endMinutes !== null ? `${clock(availability.startMinutes)}–${clock(availability.endMinutes)}` : `${clock(availability.startMinutes)} 之后`);
  }
  if (availability.minutesPerSession) parts.push(`每次 ${availability.minutesPerSession} 分钟`);
  return parts.join(" · ") || availability.raw || "未说明";
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

function nextAllowedDay(date: Date, allowed: Set<number>): Date {
  const next = new Date(date);
  for (let step = 0; step < 8; step += 1) {
    if (allowed.has(next.getDay())) return next;
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/**
 * 把模型排出来的安排对齐到用户真正方便的时间：
 *   - 落在不允许的星期的安排 → 挪到最近的允许日
 *   - 时间不在空闲时段 → 挪到时段开始（同一天多次安排依次往后排）
 *   - 一天塞不下或已过考试时间 → 去掉
 * 返回调整后的安排 + 一句给用户看的说明。
 */
export function fitSessionsToAvailability(
  sessions: PlanSession[],
  availability: Availability,
  deadline?: number | null,
): { sessions: PlanSession[]; adjustment: string } {
  const hasRule = availability.days.length > 0 || availability.startMinutes !== null || availability.minutesPerSession !== null;
  if (!hasRule) return { sessions, adjustment: "" };

  const allowed = availability.days.length ? new Set(availability.days) : null;
  const startMinutes = availability.startMinutes;
  const endMinutes = availability.endMinutes;
  const usedPerDay = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result: PlanSession[] = [];
  let moved = 0;
  let dropped = 0;

  for (const session of sessions) {
    const original = new Date(session.date);
    if (Number.isNaN(original.getTime())) continue;
    const duration = Math.round(availability.minutesPerSession ?? session.durationMinutes ?? 60);

    let date = new Date(original);
    if (date.getTime() < today.getTime()) {
      date = new Date(today);
      moved += 1;
    }
    if (allowed && !allowed.has(date.getDay())) {
      date = nextAllowedDay(date, allowed);
      moved += 1;
    }

    if (startMinutes !== null) {
      const slot = Math.max(30, duration + 15);
      let placed = false;
      for (let attempt = 0; attempt < 24 && !placed; attempt += 1) {
        if (allowed && !allowed.has(date.getDay())) {
          date = nextAllowedDay(date, allowed);
          continue;
        }
        const key = dayKey(date);
        const index = usedPerDay.get(key) ?? 0;
        const offset = startMinutes + index * slot;
        const timed = new Date(date);
        timed.setHours(Math.floor(offset / 60), offset % 60, 0, 0);

        // 今天这个时段已经过去了 → 顺延到下一个允许的日子，别一生成就是"已逾期"
        if (timed.getTime() < Date.now() - 5 * 60_000) {
          date = new Date(date);
          date.setDate(date.getDate() + 1);
          continue;
        }
        // 当天窗口塞不下 → 也顺延
        if (endMinutes !== null && offset + duration > endMinutes + 15) {
          date = new Date(date);
          date.setDate(date.getDate() + 1);
          continue;
        }
        usedPerDay.set(key, index + 1);
        if (timed.getHours() !== original.getHours() || timed.getMinutes() !== original.getMinutes() || dayKey(timed) !== dayKey(original)) {
          moved += 1;
        }
        date = timed;
        placed = true;
      }
      if (!placed) {
        dropped += 1;
        continue;
      }
    }

    if (deadline && date.getTime() > deadline) {
      dropped += 1;
      continue;
    }
    result.push({ ...session, date: date.toISOString(), durationMinutes: duration });
  }

  const notes: string[] = [];
  if (moved) notes.push(`${moved} 个安排按你方便的时间重新对齐`);
  if (dropped) notes.push(`${dropped} 个安排在这个时间窗里排不下，已去掉`);
  return { sessions: result, adjustment: notes.length ? notes.join("，") + `（你选的是：${describeAvailability(availability)}）` : "" };
}
