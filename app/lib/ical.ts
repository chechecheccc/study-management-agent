// iCal 导出：把任务（DDL/考试/复习安排）导出为 .ics，可导入系统日历。
// 纯逻辑模块，可在 Node 中直接测试。
import type { AppSnapshot } from "./local-store";
import { parseReminderOffsets } from "../agent/reminders.ts";

export function buildICalendar(snapshot: AppSnapshot, now: Date = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//qianqian//浅浅//CN",
    "CALSCALE:GREGORIAN",
  ];
  const courseName = (courseId: string) =>
    snapshot.courses.find((course) => course.id === courseId)?.name ?? "未分类";

  for (const task of snapshot.tasks) {
    const due = new Date(task.dueAt);
    if (Number.isNaN(due.getTime())) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${task.id}@study-agent`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(due)}`,
      `DTEND:${icsDate(new Date(due.getTime() + 30 * 60_000))}`,
      `SUMMARY:${escapeIcsText(`[${task.type}] ${task.title}`)}`,
      `DESCRIPTION:${escapeIcsText(`${courseName(task.courseId)} · ${task.status} · 提醒：${task.reminder}`)}`,
      `STATUS:${task.status === "已完成" ? "COMPLETED" : "CONFIRMED"}`,
    );
    // 把浅浅里的提醒规则写进日历（VALARM）：这样即使没开网页，手机/电脑日历也会按时提醒
    const offsets = parseReminderOffsets(task.reminder);
    for (const minutes of offsets) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(`[${task.type}] ${task.title}`)}`,
        `TRIGGER:-PT${minutes}M`,
        "END:VALARM",
      );
    }
    // 到点再提醒一次（没有设置提前量时也能收到）
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(`[${task.type}] ${task.title} 现在到时间了`)}`,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
    );
    lines.push(`X-QIANQIAN-REMINDER:${escapeIcsText(task.reminder || "无")}`);
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function icsDate(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeIcsText(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

