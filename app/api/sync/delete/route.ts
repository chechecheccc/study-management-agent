// 云备份：删除传播
//
// 本地删除如果不告诉服务端，下次拉取会把已删除的记录"复活"。
// 因此删除操作必须显式上报（离线时删除暂不传播）。
import { and, eq, inArray } from "drizzle-orm";
import { withPg } from "../../../../db/pg";
import { conversations, courses, deletions, messages, resources, tasks } from "../../../../db/schema";
import { getSessionUser } from "../../../lib/server-auth";

const ENTITY_TABLES = {
  courses,
  resources,
  tasks,
  conversations,
} as const;

type EntityName = keyof typeof ENTITY_TABLES;

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ ok: false, error: { message: "请先登录。" } }, 401);

  let payload: { entity?: string; ids?: unknown };
  try {
    payload = (await request.json()) ?? {};
  } catch {
    return json({ ok: false, error: { message: "无法读取请求内容。" } }, 400);
  }

  const entity = String(payload.entity ?? "") as EntityName;
  const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === "string").slice(0, 500) : [];
  if (!(entity in ENTITY_TABLES) || !ids.length) {
    return json({ ok: false, error: { message: "参数不合法。" } }, 400);
  }

  try {
    const table = ENTITY_TABLES[entity];
    const deleted = await withPg(async (db) => {
      const rows = await db
        .delete(table)
        .where(and(eq(table.userId, user.id), inArray(table.id, ids)))
        .returning({ id: table.id });
      // 记下墓碑：其它设备下次拉取时才知道这条已经被删，不会把它重新推上来
      if (rows.length) {
        const deletedAt = new Date().toISOString();
        await db
          .insert(deletions)
          .values(rows.map((row) => ({ userId: user.id, entity, recordId: row.id, deletedAt })))
          .onConflictDoUpdate({
            target: [deletions.userId, deletions.entity, deletions.recordId],
            set: { deletedAt },
          });
      }
      // 删除对话时，连带删除其消息
      if (entity === "conversations") {
        const convIds = ids;
        for (const conversationId of convIds) {
          await db.delete(messages).where(and(eq(messages.userId, user.id), eq(messages.conversationId, conversationId)));
        }
      }
      return rows.length;
    });
    return json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return json({ ok: false, error: { message: message.includes("DATABASE_URL") ? "数据库未配置。" : "删除失败。" } }, 500);
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
