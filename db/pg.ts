// PostgreSQL 连接（Node 运行时）
//
// 说明：db/index.ts 是模板自带的 Cloudflare D1 专用连接（依赖 cloudflare:workers），
// 本机/Node 部署请使用这里的 getPg()。
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

let client: ReturnType<typeof postgres> | null = null;

export function getDatabaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL 未配置。请在 .env.local 里设置，例如 postgresql://qianqian:密码@127.0.0.1:5432/qianqian",
    );
  }
  return url;
}

/** 返回 Drizzle 实例（进程内复用同一个连接池） */
export function getPg() {
  if (!client) {
    client = postgres(getDatabaseUrl(), {
      max: 5,              // 个人应用：连接池不需要大
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,      // 兼容连接池/Serverless 代理
    });
  }
  return drizzle(client, { schema });
}

export { schema };

