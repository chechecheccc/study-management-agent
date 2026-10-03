// 登出：删除会话并清除 Cookie
import { clearedCookie, revokeSession } from "../../../lib/server-auth";

export async function POST(request: Request) {
  try {
    await revokeSession(request);
  } catch {
    // 即使数据库异常也要让前端能登出
  }
  return Response.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store", "Set-Cookie": clearedCookie() } },
  );
}
