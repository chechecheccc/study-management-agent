// 登录：校验账号密码并建立会话（httpOnly Cookie）
import { createSession, sessionCookie, verifyLogin } from "../../../lib/server-auth";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { message: "无法读取请求内容。" } }, 400);
  }
  const payload = (body ?? {}) as { username?: string; password?: string };

  try {
    const result = await verifyLogin(String(payload.username ?? ""), String(payload.password ?? ""));
    if (!result.ok) return json({ ok: false, error: { message: result.message } }, 401);

    const { token, expiresAt } = await createSession(result.user.id);
    return json({ ok: true, user: result.user }, 200, { "Set-Cookie": sessionCookie(token, expiresAt) });
  } catch (error) {
    return json({ ok: false, error: { message: serverErrorMessage(error) } }, 500);
  }
}

function serverErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (message.includes("DATABASE_URL")) return "数据库未配置，请检查服务端环境变量。";
  if (message.includes("ECONNREFUSED") || message.includes("connect")) return "无法连接数据库。";
  return "服务暂时不可用，请稍后重试。";
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders },
  });
}




