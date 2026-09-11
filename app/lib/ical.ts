// iCal 导出：把任务（DDL/考试/复习安排）导出为 .ics，可导入系统日历。
// 纯逻辑模块，可在 Node 中直接测试。
import type { AppSnapshot } from "./local-store";

export function buildICalendar(snapshot: AppSnapshot, now: Date = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//study-agent//学习管家//CN",
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
      `SUMMARY:${escapeIcsText(`[${task.type}] ${task.title}`)}`,
      `DESCRIPTION:${escapeIcsText(`${courseName(task.courseId)} · ${task.status} · 提醒：${task.reminder}`)}`,
      `STATUS:${task.status === "已完成" ? "COMPLETED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
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
