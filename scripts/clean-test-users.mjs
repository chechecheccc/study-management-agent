// 清理自动化测试留下的账号（保留 admin / student1 / student2 与所有管理员）。
//
// 用法：
//   node --experimental-strip-types scripts/clean-test-users.mjs            # 预览（只列出，不删）
//   node --experimental-strip-types scripts/clean-test-users.mjs --apply    # 真正删除
//   node --experimental-strip-types scripts/clean-test-users.mjs --apply --also 名字1,名字2   # 额外按用户名删除
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const dbUrl = envText.split("\n").find((line) => line.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length).trim();
if (!dbUrl) throw new Error("未在 .env.local 找到 DATABASE_URL");
process.env.DATABASE_URL = dbUrl;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const alsoIndex = args.indexOf("--also");
const also = alsoIndex >= 0 && args[alsoIndex + 1]
  ? args[alsoIndex + 1].split(",").map((name) => name.trim()).filter(Boolean)
  : [];

const { getPg } = await import("../db/pg.ts");
const { deleteAccounts, findTestAccounts } = await import("../app/lib/admin-cleanup.ts");
const { users } = await import("../db/schema.ts");
const { inArray, eq } = await import("drizzle-orm");

const db = getPg();
const targets = await findTestAccounts(db);
let names = targets.map((row) => row.username);
let ids = targets.map((row) => row.id);

// --also：按用户名精确补充（用于规则漏掉、但确认是测试账号的账号）
if (also.length) {
  const extra = await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.username, also));
  for (const row of extra) {
    if (!ids.includes(row.id)) { ids.push(row.id); names.push(row.username); }
  }
  const missing = also.filter((name) => !extra.some((row) => row.username === name));
  if (missing.length) console.log(`⚠️ 这些用户名不存在，已跳过：${missing.join(" ")}`);
}

// 安全兜底：任何情况下都不动管理员（按 id 一对一过滤，避免名单错位）
const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
const adminIds = new Set(admins.map((row) => row.id));
const pairs = ids.map((id, index) => ({ id, username: names[index] })).filter((pair) => !adminIds.has(pair.id));
ids = pairs.map((pair) => pair.id);
names = pairs.map((pair) => pair.username);

if (!names.length) {
  console.log("没有需要清理的测试账号。");
} else if (apply) {
  const removed = await deleteAccounts(db, ids);
  console.log(`已删除 ${removed.length} 个账号（含它们的资料 / 任务 / 对话）：`);
  console.log(removed.join("  "));
} else {
  console.log(`预览：将删除 ${names.length} 个账号（加 --apply 才会真正删除）`);
  console.log(names.join("  "));
}
process.exit(0);
