// 云备份：把本机数据推送到服务端
//
// 合并策略：**逐记录按 updatedAt 比较，较新者胜**；不删除本地没有的记录。
// 这样多设备交替使用时不会互相清空数据（快照式全覆盖会有这个风险）。
import { eq } from "drizzle-orm";
import { withPg } from "../../../../db/pg";
import { conversations, courses, messages, profiles, resources, tasks } from "../../../../db/schema";
import { getSessionUser } from "../../../lib/server-auth";

type IncomingRecord = Record<string, unknown> & { id?: string; updatedAt?: string };

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ ok: false, error: { message: "请先登录。" } }, 401);

  let payload: {
    courses?: IncomingRecord[];
    resources?: IncomingRecord[];
    tasks?: IncomingRecord[];
    conversations?: IncomingRecord[];
    profile?: Record<string, unknown> | null;
  };
  try {
    payload = (await request.json()) ?? {};
  } catch {
    return json({ ok: false, error: { message: "无法读取请求内容。" } }, 400);
  }

  try {
    const now = new Date().toISOString();
    const stats = { courses: 0, resources: 0, tasks: 0, conversations: 0, messages: 0, profile: 0 };

    await withPg(async (db) => {

    // ---- 课程 ----
    for (const item of payload.courses ?? []) {
      if (!item?.id) continue;
      const row = {
        id: String(item.id),
        userId: user.id,
        name: String(item.name ?? ""),
        semester: String(item.semester ?? ""),
        color: String(item.color ?? "coral"),
        archived: Boolean(item.archived),
        updatedAt: String(item.updatedAt ?? now),
        deletedAt: (item.deletedAt as string | null) ?? null,
      };
      const existing = await db.select({ updatedAt: courses.updatedAt }).from(courses).where(eq(courses.id, row.id)).limit(1);
      if (existing[0] && existing[0].updatedAt >= row.updatedAt) continue;
      await db.insert(courses).values(row).onConflictDoUpdate({ target: courses.id, set: row });
      stats.courses += 1;
    }

    // ---- 资料（文件本体不参与同步，只同步元数据与提取出的正文）----
    for (const item of payload.resources ?? []) {
      if (!item?.id) continue;
      const row = {
        id: String(item.id),
        userId: user.id,
        courseId: String(item.courseId ?? ""),
        title: String(item.title ?? ""),
        type: String(item.type ?? "其他"),
        tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
        status: String(item.status ?? "未整理"),
        importedAt: String(item.importedAt ?? ""),
        fileName: (item.fileName as string | null) ?? null,
        fileKey: (item.fileKey as string | null) ?? null,
        fileSize: typeof item.fileSize === "number" ? item.fileSize : null,
        mimeType: (item.mimeType as string | null) ?? null,
        contentText: (item.contentText as string | null) ?? null,
        updatedAt: String(item.updatedAt ?? now),
        deletedAt: (item.deletedAt as string | null) ?? null,
      };
      const existing = await db.select({ updatedAt: resources.updatedAt }).from(resources).where(eq(resources.id, row.id)).limit(1);
      if (existing[0] && existing[0].updatedAt >= row.updatedAt) continue;
      await db.insert(resources).values(row).onConflictDoUpdate({ target: resources.id, set: row });
      stats.resources += 1;
    }

    // ---- 任务 ----
    for (const item of payload.tasks ?? []) {
      if (!item?.id) continue;
      const row = {
        id: String(item.id),
        userId: user.id,
        courseId: String(item.courseId ?? ""),
        title: String(item.title ?? ""),
        type: String(item.type ?? "DDL"),
        dueAt: String(item.dueAt ?? ""),
        status: String(item.status ?? "未开始"),
        priority: String(item.priority ?? "中"),
        reminder: String(item.reminder ?? ""),
        updatedAt: String(item.updatedAt ?? now),
        deletedAt: (item.deletedAt as string | null) ?? null,
      };
      const existing = await db.select({ updatedAt: tasks.updatedAt }).from(tasks).where(eq(tasks.id, row.id)).limit(1);
      if (existing[0] && existing[0].updatedAt >= row.updatedAt) continue;
      await db.insert(tasks).values(row).onConflictDoUpdate({ target: tasks.id, set: row });
      stats.tasks += 1;
    }

    // ---- 对话与会话内消息 ----
    for (const item of payload.conversations ?? []) {
      if (!item?.id) continue;
      const updatedAt = String(item.updatedAt ?? now);
      const convRow = {
        id: String(item.id),
        userId: user.id,
        title: String(item.title ?? "新对话"),
        createdAt: String(item.createdAt ?? updatedAt),
        updatedAt,
        deletedAt: (item.deletedAt as string | null) ?? null,
      };
      const existing = await db.select({ updatedAt: conversations.updatedAt }).from(conversations).where(eq(conversations.id, convRow.id)).limit(1);
      if (!existing[0] || existing[0].updatedAt < updatedAt) {
        await db.insert(conversations).values(convRow).onConflictDoUpdate({ target: conversations.id, set: convRow });
        stats.conversations += 1;
      }

      const items = Array.isArray(item.messages) ? (item.messages as IncomingRecord[]) : [];
      for (const message of items) {
        if (!message?.id) continue;
        const messageRow = {
          id: String(message.id),
          conversationId: convRow.id,
          userId: user.id,
          role: String(message.role ?? "user"),
          text: String(message.text ?? ""),
          steps: (message.steps as unknown) ?? null,
          images: (message.images as string[] | undefined) ?? null,
          createdAt: String(message.createdAt ?? updatedAt),
        };
        await db.insert(messages).values(messageRow).onConflictDoUpdate({
          target: messages.id,
          set: { text: messageRow.text, steps: messageRow.steps, images: messageRow.images },
        });
        stats.messages += 1;
      }
    }

    // ---- 用户画像 ----
    if (payload.profile) {
      const profileRow = {
        userId: user.id,
        name: String(payload.profile.name ?? ""),
        studyTime: String(payload.profile.studyTime ?? ""),
        goal: String(payload.profile.goal ?? ""),
        notes: Array.isArray(payload.profile.notes) ? (payload.profile.notes as string[]) : [],
        updatedAt: now,
      };
      await db.insert(profiles).values(profileRow).onConflictDoUpdate({ target: profiles.userId, set: profileRow });
      stats.profile = 1;
    }

    });

    return json({ ok: true, stats, syncedAt: now });
  } catch (error) {
    return json({ ok: false, error: { message: explain(error) } }, 500);
  }
}

function explain(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (message.includes("DATABASE_URL")) return "数据库未配置。";
  if (message.includes("ECONNREFUSED")) return "无法连接数据库。";
  return `同步失败：${message.slice(0, 160)}`;
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}


