// 服务端：删除账号时把该账号在数据库里的所有数据一并清掉。
//
// 注意：除 sessions 之外，其余表的 user_id 都是**裸文本列**（没有外键级联），
// 所以必须逐表显式删除，否则删了账号会留下一堆没人认领的孤儿数据。
import { eq, inArray } from "drizzle-orm";
import {
  conversations,
  courses,
  files,
  messages,
  profiles,
  resources,
  sessions,
  tasks,
  users,
} from "../../db/schema.ts";
import type { withPg } from "../../db/pg.ts";
import { isTestUsername } from "./test-accounts.ts";

type Db = Parameters<Parameters<typeof withPg>[0]>[0];

/** 删除某个账号名下的全部数据（不删账号本身） */
export async function purgeUserData(db: Db, userId: string) {
  await db.delete(messages).where(eq(messages.userId, userId));
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(resources).where(eq(resources.userId, userId));
  await db.delete(tasks).where(eq(tasks.userId, userId));
  await db.delete(courses).where(eq(courses.userId, userId));
  await db.delete(files).where(eq(files.userId, userId));
  await db.delete(profiles).where(eq(profiles.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** 删除一个账号（连带其数据） */
export async function purgeAccount(db: Db, userId: string) {
  await purgeUserData(db, userId);
  await db.delete(users).where(eq(users.id, userId));
}

/** 只找出测试账号，不做任何删除（供预览 / 界面统计使用） */
export async function findTestAccounts(db: Db) {
  const rows = await db
    .select({ id: users.id, username: users.username, role: users.role })
    .from(users);
  return rows
    .filter((row) => row.role !== "admin" && isTestUsername(row.username))
    .map((row) => ({ id: row.id, username: row.username }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

/** 按 id 批量删除账号及其全部数据，返回被删掉的用户名 */
export async function deleteAccounts(db: Db, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.select({ username: users.username }).from(users).where(inArray(users.id, ids));
  await db.delete(messages).where(inArray(messages.userId, ids));
  await db.delete(conversations).where(inArray(conversations.userId, ids));
  await db.delete(resources).where(inArray(resources.userId, ids));
  await db.delete(tasks).where(inArray(tasks.userId, ids));
  await db.delete(courses).where(inArray(courses.userId, ids));
  await db.delete(files).where(inArray(files.userId, ids));
  await db.delete(profiles).where(inArray(profiles.userId, ids));
  await db.delete(sessions).where(inArray(sessions.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
  return rows.map((row) => row.username).sort();
}

/**
 * 批量清掉自动化测试留下的账号（保留管理员与初始化账号）。
 * 返回被删除的账号用户名，便于界面回显"清掉了哪些"。
 */
export async function purgeTestAccounts(db: Db): Promise<string[]> {
  const targets = await findTestAccounts(db);
  return deleteAccounts(db, targets.map((row) => row.id));
}
