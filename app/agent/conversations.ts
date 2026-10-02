// 对话会话的纯逻辑：标题生成与按日期分组。不依赖 React / DOM，可在 Node 中测试。

export type ConversationLike = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationGroup = {
  label: "今天" | "昨天" | "最近 7 天" | "更早";
  items: ConversationLike[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

// 用首条用户消息生成标题：去掉首尾空白、压缩换行、超长截断
export function deriveConversationTitle(firstUserText: string): string {
  const cleaned = firstUserText.replace(/\s+/g, " ").trim();
  if (!cleaned) return "新对话";
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
}

// 按"今天 / 昨天 / 最近 7 天 / 更早"分组，组内按更新时间倒序
export function groupConversationsByDate<T extends ConversationLike>(
  conversations: T[],
  now: Date = new Date(),
): Array<{ label: ConversationGroup["label"]; items: T[] }> {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - DAY_MS;
  const weekAgo = startOfToday - DAY_MS * 6;

  const buckets: Array<{ label: ConversationGroup["label"]; items: T[] }> = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "最近 7 天", items: [] },
    { label: "更早", items: [] },
  ];

  for (const conversation of conversations) {
    const time = new Date(conversation.updatedAt).getTime();
    if (Number.isNaN(time) || time >= startOfToday) buckets[0].items.push(conversation);
    else if (time >= startOfYesterday) buckets[1].items.push(conversation);
    else if (time >= weekAgo) buckets[2].items.push(conversation);
    else buckets[3].items.push(conversation);
  }

  for (const bucket of buckets) {
    bucket.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}

// 会话的简短时间标注（今天显示时分，更早显示日期）
export function formatConversationStamp(updatedAt: string, now: Date = new Date()): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = date.getTime();
  if (time >= startOfToday) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (time >= startOfToday - DAY_MS) return "昨天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
