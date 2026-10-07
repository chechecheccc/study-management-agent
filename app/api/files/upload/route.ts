// 上传文件本体到服务端（存 PostgreSQL bytea）
//
// 用法：POST /api/files/upload?name=xxx.pdf
//   Content-Type: 文件 MIME 类型，body 为原始二进制
// 说明：路由运行在 Workers 运行时，没有文件系统，所以文件存数据库而不是磁盘。
import { randomBytes } from "node:crypto";
import { withPg } from "../../../../db/pg";
import { files } from "../../../../db/schema";
import { getSessionUser } from "../../../lib/server-auth";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 单文件上限 50MB

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ ok: false, error: { message: "请先登录。" } }, 401);

  const url = new URL(request.url);
  const name = (url.searchParams.get("name") ?? "未命名文件").slice(0, 200);
  const mime = request.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_FILE_BYTES) {
    return json({ ok: false, error: { message: "文件超过 50MB，暂不支持上传到服务端。" } }, 413);
  }

  try {
    const buffer = Buffer.from(await request.arrayBuffer());
    if (!buffer.length) return json({ ok: false, error: { message: "文件内容为空。" } }, 400);
    if (buffer.length > MAX_FILE_BYTES) {
      return json({ ok: false, error: { message: "文件超过 50MB，暂不支持上传到服务端。" } }, 413);
    }

    const fileId = `file-${randomBytes(9).toString("hex")}`;
    await withPg(async (db) => {
      await db.insert(files).values({
        id: fileId,
        userId: user.id,
        name,
        mime,
        size: buffer.length,
        data: buffer,
      });
    });

    return json({ ok: true, fileId, size: buffer.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return json(
      { ok: false, error: { message: message.includes("DATABASE_URL") ? "数据库未配置。" : "上传失败，请稍后重试。" } },
      500,
    );
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
