// 重置某个账号的密码（忘记管理员密码时的兜底）。
//
// 用法：
//   node --experimental-strip-types scripts/reset-password.mjs <用户名> <新密码>
// 例：
//   node --experimental-strip-types scripts/reset-password.mjs admin newpass123
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error("用法：node --experimental-strip-types scripts/reset-password.mjs <用户名> <新密码>");
  process.exit(1);
}
if (password.length < 6) {
  console.error("新密码至少 6 位。");
  process.exit(1);
}

// 优先用环境变量传入的 DATABASE_URL，没有再从 .env.local 读
if (!process.env.DATABASE_URL?.trim()) {
  const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const dbUrl = envText.split(/\r?\n/).find((line) => line.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length).trim();
  if (!dbUrl) throw new Error("未在 .env.local 找到 DATABASE_URL（也没有通过环境变量传入）");
  process.env.DATABASE_URL = dbUrl;
}

const { getPg } = await import("../db/pg.ts");
const { users, sessions } = await import("../db/schema.ts");
const { buildAccount } = await import("../app/lib/accounts.ts");

const db = getPg();
const rows = await db.select().from(users).where(eq(users.username, username.trim().toLowerCase())).limit(1);
const target = rows[0];
if (!target) {
  console.error(`找不到账号「${username}」。现有账号：`);
  const all = await db.select({ username: users.username }).from(users);
  console.error("  " + all.map((row) => row.username).join("  "));
  process.exit(1);
}

const rebuilt = await buildAccount({
  username: target.username,
  displayName: target.displayName,
  password,
  role: target.role === "admin" ? "admin" : "user",
});
await db.update(users).set({ salt: rebuilt.salt, hash: rebuilt.hash, iterations: rebuilt.iterations }).where(eq(users.id, target.id));
// 换密码后把该账号已有的登录全部踢下线
const revoked = await db.delete(sessions).where(eq(sessions.userId, target.id)).returning({ token: sessions.token });

console.log(`✓ 已重置「${target.displayName}（${target.username}）」的密码，并注销了 ${revoked.length} 个已登录会话。`);
console.log("  现在可以用新密码登录了。");
process.exit(0);
