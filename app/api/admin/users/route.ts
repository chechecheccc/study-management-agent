// 管理员：账号管理（服务端真实用户）
import { eq } from "drizzle-orm";
import { withPg } from "../../../../db/pg";
import { sessions, users } from "../../../../db/schema";
import { buildAccount } from "../../../lib/accounts";
import { purgeAccount, purgeTestAccounts } from "../../../lib/admin-cleanup";
import { registerUser, requireAdmin } from "../../../lib/server-auth";
import { isTestUsername } from "../../../lib/test-accounts";

/** 账号列表（含每个账号的数据量，便于管理员了解使用情况） */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return json({ ok: false, error: { message: auth.message } }, auth.status);

  try {
    const rows = await withPg(async (db) =>
      db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
          disabled: users.disabled,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users),
    );
    return json({
      ok: true,
      users: rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: row.role === "admin" ? "admin" : "user",
        disabled: row.disabled,
        createdAt: row.createdAt.toISOString(),
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        test: isTestUsername(row.username),
      })),
    });
  } catch (error) {
    return json({ ok: false, error: { message: explain(error) } }, 500);
  }
}

/** 新建账号 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return json({ ok: false, error: { message: auth.message } }, auth.status);

  try {
    const payload = (await request.json()) as { username?: string; displayName?: string; password?: string; role?: string };
    const result = await registerUser({
      username: String(payload.username ?? ""),
      displayName: String(payload.displayName ?? ""),
      password: String(payload.password ?? ""),
      role: payload.role === "admin" ? "admin" : "user",
    });
    if (!result.ok) return json({ ok: false, error: { message: result.message } }, 400);
    return json({ ok: true, user: result.user }, 201);
  } catch (error) {
    return json({ ok: false, error: { message: explain(error) } }, 500);
  }
}

/** 停用 / 启用 / 重置密码 */
export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return json({ ok: false, error: { message: auth.message } }, auth.status);

  try {
    const payload = (await request.json()) as { userId?: string; action?: string; password?: string };
    const userId = String(payload.userId ?? "");
    if (!userId) return json({ ok: false, error: { message: "缺少 userId。" } }, 400);
    if (userId === auth.user.id && payload.action === "toggle-disabled") {
      return json({ ok: false, error: { message: "不能停用当前登录的管理员账号。" } }, 400);
    }

    if (payload.action === "toggle-disabled") {
      const updated = await withPg(async (db) => {
        const rows = await db.select({ disabled: users.disabled }).from(users).where(eq(users.id, userId)).limit(1);
        if (!rows[0]) return null;
        const next = !rows[0].disabled;
        await db.update(users).set({ disabled: next }).where(eq(users.id, userId));
        return next;
      });
      if (updated === null) return json({ ok: false, error: { message: "找不到该账号。" } }, 404);
      return json({ ok: true, disabled: updated });
    }

    if (payload.action === "reset-password") {
      const password = String(payload.password ?? "");
      if (password.length < 6) return json({ ok: false, error: { message: "密码至少 6 位。" } }, 400);
      const target = await withPg(async (db) => {
        const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        return rows[0] ?? null;
      });
      if (!target) return json({ ok: false, error: { message: "找不到该账号。" } }, 404);
      const rebuilt = await buildAccount({
        username: target.username,
        displayName: target.displayName,
        password,
        role: target.role === "admin" ? "admin" : "user",
      });
      await withPg(async (db) => {
        await db
          .update(users)
          .set({ salt: rebuilt.salt, hash: rebuilt.hash, iterations: rebuilt.iterations })
          .where(eq(users.id, userId));
        // 重置密码后吊销该账号的所有会话
        await db.delete(sessions).where(eq(sessions.userId, userId));
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: { message: "未知操作。" } }, 400);
  } catch (error) {
    return json({ ok: false, error: { message: explain(error) } }, 500);
  }
}

/** 删除账号（连带其会话与全部数据），或一键清理测试账号 */
export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return json({ ok: false, error: { message: auth.message } }, auth.status);

  try {
    const payload = (await request.json()) as { userId?: string; mode?: string };

    // 一键清理：删掉自动化测试注册出来的账号（保留管理员与初始化账号）
    if (payload.mode === "test-accounts") {
      const removed = await withPg((db) => purgeTestAccounts(db));
      return json({ ok: true, removed: removed.length, usernames: removed });
    }

    const userId = String(payload.userId ?? "");
    if (!userId) return json({ ok: false, error: { message: "缺少 userId。" } }, 400);
    if (userId === auth.user.id) return json({ ok: false, error: { message: "不能删除当前登录的账号。" } }, 400);

    await withPg((db) => purgeAccount(db, userId));
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: { message: explain(error) } }, 500);
  }
}
function explain(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (message.includes("DATABASE_URL")) return "数据库未配置。";
  if (message.includes("ECONNREFUSED")) return "无法连接数据库。";
  return "服务暂时不可用，请稍后重试。";
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
