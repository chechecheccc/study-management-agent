import { defineConfig } from "drizzle-kit";

// 数据库：PostgreSQL（本机 D:\ruanjian\postgresql，库名 qianqian）
export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL?.trim() ??
      "postgresql://qianqian:qianqian123@127.0.0.1:5432/qianqian",
  },
});
