// 云备份：从服务端拉取该账号的全部数据
import { and, desc, eq, gt } from "drizzle-orm";
import { withPg } from "../../../../db/pg";
import { conversations, courses, deletions, messages, profiles, resources, tasks } from "../../../../db/schema";
import { getSessionUser } from "../../../lib/server-auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ ok: false, error: { message: "请先登录。" } }, 401);

  try {
    const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { courseRows, resourceRows, taskRows, conversationRows, messageRows, profileRows, deletionRows } = await withPg(async (db) => {
      const [courseRows, resourceRows, taskRows, conversationRows, messageRows, profileRows, deletionRows] = await Promise.all([
        db.select().from(courses).where(eq(courses.userId, user.id)).orderBy(courses.sortOrder),
        db.select().from(resources).where(eq(resources.userId, user.id)),
        db.select().from(tasks).where(eq(tasks.userId, user.id)),
        db.select().from(conversations).where(eq(conversations.userId, user.id)).orderBy(desc(conversations.updatedAt)),
        db.select().from(messages).where(eq(messages.userId, user.id)).orderBy(messages.createdAt),
        db.select().from(profiles).where(eq(profiles.userId, user.id)).limit(1),
        // 最近 30 天的删除记录（更早的设备基本已经同步过了，不再长期保留）
        db.select().from(deletions).where(and(eq(deletions.userId, user.id), gt(deletions.deletedAt, cutoffIso))),
      ]);
      return { courseRows, resourceRows, taskRows, conversationRows, messageRows, profileRows, deletionRows };
    });

    // 按会话归并消息，输出结构与客户端 ConversationRecord 一致
    const messagesByConversation = new Map<string, typeof messageRows>();
    for (const message of messageRows) {
      const list = messagesByConversation.get(message.conversationId) ?? [];
      list.push(message);
      messagesByConversation.set(message.conversationId, list);
    }

    return json({
      ok: true,
      data: {
        courses: courseRows.map((row) => ({
          id: row.id,
          name: row.name,
          semester: row.semester,
          color: row.color,
          archived: row.archived,
          order: row.sortOrder,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
        })),
        resources: resourceRows.map((row) => ({
          id: row.id,
          courseId: row.courseId,
          title: row.title,
          type: row.type,
          tags: row.tags,
          status: row.status,
          importedAt: row.importedAt,
          fileName: row.fileName,
          fileKey: row.fileKey,
          fileSize: row.fileSize,
          mimeType: row.mimeType,
          contentText: row.contentText,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
        })),
        tasks: taskRows.map((row) => ({
          id: row.id,
          courseId: row.courseId,
          title: row.title,
          type: row.type,
          dueAt: row.dueAt,
          status: row.status,
          priority: row.priority,
          reminder: row.reminder,
          resourceId: row.resourceId ?? undefined,
          images: row.images ?? [],
          detail: row.detail ?? undefined,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
        })),
        conversations: conversationRows.map((row) => ({
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          deletedAt: row.deletedAt,
          messages: (messagesByConversation.get(row.id) ?? []).map((message) => ({
            id: message.id,
            role: message.role === "assistant" ? "assistant" : "user",
            text: message.text,
            steps: message.steps ?? undefined,
            images: message.images ?? undefined,
            createdAt: message.createdAt,
          })),
        })),
        deletions: deletionRows.map((row) => ({ entity: row.entity, id: row.recordId, deletedAt: row.deletedAt })),
        profile: profileRows[0]
          ? {
              name: profileRows[0].name,
              studyTime: profileRows[0].studyTime,
              goal: profileRows[0].goal,
              notes: profileRows[0].notes,
            }
          : null,
      },
      pulledAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return json({ ok: false, error: { message: message.includes("DATABASE_URL") ? "数据库未配置。" : "读取云端数据失败。" } }, 500);
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}




