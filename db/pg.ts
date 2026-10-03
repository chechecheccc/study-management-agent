// PostgreSQL 连接
//
// ⚠️ 运行时约束（重要）：
// 应用的 API 路由跑在 Cloudflare Workers(workerd) 运行时里，它禁止把一个请求创建的
// I/O 对象（如 TCP 连接）用于另一个请求。因此**不能在模块级缓存数据库客户端**，
// 否则会报 "Cannot perform I/O on behalf of a different request"。
//
// 所以：
//   - API 路由统一用 withPg()：每次请求新建连接，用完立即关闭；
//   - getPg() 仅用于 Node 脚本（迁移、种子数据、测试），Node 下可以安全复用连接池。
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function getDatabaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL 未配置。请在 .env.local 里设置，例如 postgresql://qianqian:密码@127.0.0.1:5432/qianqian",
    );
  }
  return url;
}

/** 请求级连接：创建 → 执行 → 关闭（Workers 运行时必须这样用） */
export async function withPg<T>(
  run: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
): Promise<T> {
  const client = postgres(getDatabaseUrl(), {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
  try {
    return await run(drizzle(client, { schema }));
  } finally {
    // 结构关闭，避免连接泄漏
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

let scriptClient: ReturnType<typeof postgres> | null = null;

/** 仅供 Node 脚本/测试使用的常驻连接池；不要在 API 路由里用 */
export function getPg() {
  if (!scriptClient) {
    scriptClient = postgres(getDatabaseUrl(), {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return drizzle(scriptClient, { schema });
}

export { schema };
