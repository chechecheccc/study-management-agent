// 当前登录用户
import { getSessionUser } from "../../../lib/server-auth";

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    return Response.json(
      { ok: true, user },
      { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  } catch {
    return Response.json({ ok: true, user: null }, { headers: { "Cache-Control": "no-store" } });
  }
}
