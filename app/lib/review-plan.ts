// 复习计划的纯逻辑：日期解析、草案清洗、概览文案。不依赖 React / DOM，可在 Node 中测试。
//
// 为什么要有这一层：模型给的日期经常不是标准 ISO（"10/10 今晚""10月10日"），
// 以前直接 new Date() 会得到 NaN，整份计划被判成空的，用户那边就"点了没反应"。

/** 月和日，例如 10/10 */
export function formatPlanDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

export type PlanSession = {
  date: string;
  title: string;
  durationMinutes: number;
  /** 这次复习要用到的那份资料（模型读过的课件/笔记） */
  resourceName?: string;
  /** 这次的重点是什么、为什么重要（模型读过资料后给出） */
  focus?: string;
  /** 具体怎么走：先做什么、再做什么（复习路线） */
  route?: string;
  /** 怎么算复习到位了（自测 / 验收标准） */
  checkpoint?: string;
};

/** 这次安排是不是带了"详细计划" */
export function hasSessionDetail(session: PlanSession) {
  return Boolean(session.focus || session.route || session.checkpoint);
}

/** 把详细计划拼成任务里保存的文本（任务中心会原样展示） */
export function formatSessionDetail(session: PlanSession): string {
  const lines: string[] = [];
  if (session.focus) lines.push(`【重点】${session.focus}`);
  if (session.route) lines.push(`【复习路线】${session.route}`);
  if (session.checkpoint) lines.push(`【自测】${session.checkpoint}`);
  if (session.resourceName) lines.push(`【资料】${session.resourceName}`);
  return lines.join("\n");
}

/**
 * 解析模型给的日期。模型经常写成「10/10 今晚」「10月10日」「2026-10-10」这类，
 * 直接丢给 new Date() 会得到 NaN，整份计划就被判成空的了——所以这里多兜几层。
 */
export function parsePlanTimestamp(raw: string, now = new Date()): number {
  const value = raw.trim();
  if (!value) return NaN;

  const direct = new Date(value).getTime();
  if (!Number.isNaN(direct) && !/^\d{1,2}[-\/]\d{1,2}$/.test(value)) return direct;

  const relative: Record<string, number> = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2 };
  const relativeMatch = Object.keys(relative).find((key) => value.includes(key));
  const timeMatch = value.match(/(\d{1,2})[:：](\d{2})/);
  const hour = timeMatch ? Number(timeMatch[1]) : NaN;
  const minute = timeMatch ? Number(timeMatch[2]) : NaN;

  const withTime = (date: Date) => {
    const next = new Date(date);
    if (!Number.isNaN(hour) && !Number.isNaN(minute)) next.setHours(hour, minute, 0, 0);
    else next.setHours(19, 0, 0, 0); // 只给了日期：按晚上 19:00 算，免得当天中午就显示"已逾期"
    return next.getTime();
  };

  if (relativeMatch) {
    const date = new Date(now);
    date.setDate(date.getDate() + relative[relativeMatch]);
    return withTime(date);
  }

  // 2026-10-10 / 2026年10月10日 / 10-10 / 10月10日
  const full = value.match(/(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
  if (full) return withTime(new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3])));
  const short = value.match(/(\d{1,2})\s*[-\/月.]\s*(\d{1,2})\s*日?/);
  if (short) return withTime(new Date(now.getFullYear(), Number(short[1]) - 1, Number(short[2])));

  return NaN;
}

export function sanitizePlanSessions(value: unknown): PlanSession[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim().replace(/\s+/g, " ") : "";
      const rawDate = typeof record.date === "string" ? record.date.trim() : "";
      const time = parsePlanTimestamp(rawDate);
      if (!title || !rawDate || Number.isNaN(time)) return null;
      const rawDuration = typeof record.durationMinutes === "number" ? record.durationMinutes : 45;
      const durationMinutes = Math.min(240, Math.max(15, Math.round(rawDuration) || 45));
      const resourceName = typeof record.resourceName === "string" && record.resourceName.trim()
        ? record.resourceName.trim().slice(0, 60)
        : undefined;
      const text = (value: unknown, max: number) =>
        typeof value === "string" && value.trim() ? value.trim().replace(/\s*\n\s*/g, " ").slice(0, max) : undefined;
      const focus = text(record.focus, 200);
      const route = text(record.route, 400);
      const checkpoint = text(record.checkpoint, 200);
      return {
        date: new Date(time).toISOString(),
        title: title.slice(0, 80),
        durationMinutes,
        ...(resourceName ? { resourceName } : {}),
        ...(focus ? { focus } : {}),
        ...(route ? { route } : {}),
        ...(checkpoint ? { checkpoint } : {}),
      } satisfies PlanSession;
    })
    .filter((session): session is PlanSession => session !== null)
    // 同一天同一件事只留一条，并按日期排好——否则草案看起来是一团乱的
    .filter((session, index, list) =>
      list.findIndex((item) => item.date.slice(0, 10) === session.date.slice(0, 10) && item.title === session.title) === index)
    .sort((a, b) => a.date.localeCompare(b.date));
  return cleaned.slice(0, 14);
}

/** 草案概览：几次、合计多久、覆盖哪几天 */
export function planSummary(sessions: PlanSession[]): string {
  if (!sessions.length) return "";
  const total = sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
  const first = formatPlanDay(sessions[0].date);
  const last = formatPlanDay(sessions[sessions.length - 1].date);
  return `共 ${sessions.length} 次 · 合计 ${total} 分钟 · ${first === last ? first : `${first} – ${last}`}`;
}

/** 计划里的日期带上星期，比单纯的 10/10 好看懂 */
export function formatPlanDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${formatPlanDay(value)} ${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date)}`;
}

