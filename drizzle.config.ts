import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * 数据库连接串的取值顺序：环境变量 → .env.local。
 * 这里**不允许**写死任何密码：仓库要能安全地公开，密码只放在被 .gitignore 忽略的 .env.local 里。
 */
function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    const line = envText
      .split(/\r?\n/)
      .find((item) => item.startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim();
  } catch {
    // 没有 .env.local，下面统一报错
  }
  throw new Error(
    "没有找到 DATABASE_URL：请把 .env.example 复制成 .env.local 并填好数据库地址，或用环境变量 DATABASE_URL 传入。",
  );
}

// 数据库：PostgreSQL（本机或远程都行）
export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
});
