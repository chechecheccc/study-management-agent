// 下载/预览服务端保存的文件本体
// GET /api/files/<fileId>            内联预览
// GET /api/files/<fileId>?download=1 作为附件下载
import { and, eq, or } from "drizzle-orm";
import { withPg } from "../../../../db/pg";
import { files } from "../../../../db/schema";
import { getSessionUser } from "../../../lib/server-auth";
import { PRESET_FILE_SCOPE } from "../../../lib/presets";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) {
    return Response.json({ ok: false, error: { message: "请先登录。" } }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) return new Response("缺少文件 id", { status: 400 });

  try {
    const row = await withPg(async (db) => {
      const rows = await db
        .select()
        .from(files)
        // 自己的文件，或所有账号共用的预设课件
        .where(and(eq(files.id, id), or(eq(files.userId, user.id), eq(files.userId, PRESET_FILE_SCOPE))))
        .limit(1);
      return rows[0] ?? null;
    });
    if (!row) return new Response("文件不存在或无权访问", { status: 404 });

    const download = new URL(request.url).searchParams.get("download") === "1";
    const body = new Uint8Array(row.data);
    const filename = row.name || "file";
    return new Response(body, {
      headers: {
        "Content-Type": row.mime || "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("读取文件失败", { status: 500 });
  }
}
