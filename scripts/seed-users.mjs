// 初始化服务端账号：1 个管理员 + 2 个普通用户（已存在则跳过）
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const dbUrl = envText.split("\n").find((line) => line.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length).trim();
if (!dbUrl) throw new Error("未在 .env.local 找到 DATABASE_URL");
process.env.DATABASE_URL = dbUrl;

const { getPg } = await import("../db/pg.ts");
const { users } = await import("../db/schema.ts");
const { buildAccount } = await import("../app/lib/accounts.ts");

const seeds = [
  { username: "admin", displayName: "管理员", password: "admin123", role: "admin" },
  { username: "student1", displayName: "小林", password: "123456", role: "user" },
  { username: "student2", displayName: "小周", password: "123456", role: "user" },
];

const db = getPg();
let created = 0;
for (const seed of seeds) {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, seed.username)).limit(1);
  if (existing.length) {
    console.log(`跳过（已存在）：${seed.username}`);
    continue;
  }
  const account = await buildAccount(seed);
  await db.insert(users).values({
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    salt: account.salt,
    hash: account.hash,
    iterations: account.iterations,
  });
  console.log(`已创建：${seed.username} / ${seed.displayName}（${seed.role}）`);
  created += 1;
}
console.log(`\n共创建 ${created} 个账号`);
process.exit(0);
