// 修改自己的密码（所有用户都能用；管理员改别人的密码走 /api/admin/users）
import { and, eq, ne } from "drizzle-orm";
import { withPg } from "../../../../db/pg";
import { sessions, users } from "../../../../db/schema";
import { buildAccount, verifyPassword } from "../../../lib/accounts";
import type { UserAccount } from "../../../lib/accounts";
import { SESSION_COOKIE, getSessionUser, readCookie } from "../../../lib/server-auth";

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ ok: false, error: { message: "请先登录。" } }, 401);

  let payload: { currentPassword?: string; newPassword?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: { message: "无法读取请求内容。" } }, 400);
  }

  const currentPassword = String(payload.currentPassword ?? "");
  const newPassword = String(payload.newPassword ?? "");
  if (newPassword.length < 6) {
    return json({ ok: false, error: { message: "新密码至少 6 位。" } }, 400);
  }
  if (newPassword === currentPassword) {
    return json({ ok: false, error: { message: "新密码不能和当前密码相同。" } }, 400);
  }

  try {
    const row = await withPg(async (db) => {
      const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      return rows[0] ?? null;
    });
    if (!row) return json({ ok: false, error: { message: "找不到该账号。" } }, 404);

    const account: UserAccount = {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role === "admin" ? "admin" : "user",
      salt: row.salt,
      hash: row.hash,
      iterations: row.iterations,
      createdAt: row.createdAt.toISOString(),
    };
    if (!(await verifyPassword(currentPassword, account))) {
      return json({ ok: false, error: { message: "当前密码不正确。" } }, 400);
    }

    const rebuilt = await buildAccount({
      username: row.username,
      displayName: row.displayName,
      password: newPassword,
      role: account.role,
    });
    const token = readCookie(request, SESSION_COOKIE);
    await withPg(async (db) => {
      await db
        .update(users)
        .set({ salt: rebuilt.salt, hash: rebuilt.hash, iterations: rebuilt.iterations })
        .where(eq(users.id, user.id));
      // 改密码后把「其它设备」的登录踢下线，当前这个会话保留，用户不用重新登录
      if (token) await db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.token, token)));
      else await db.delete(sessions).where(eq(sessions.userId, user.id));
    });
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: { message: serverErrorMessage(error) } }, 500);
  }
}

function serverErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (message.includes("DATABASE_URL")) return "数据库未配置。";
  if (message.includes("ECONNREFUSED")) return "无法连接数据库。";
  return "服务暂时不可用，请稍后重试。";
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
