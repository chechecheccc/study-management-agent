// 服务端账号与会话
//
// 复用 lib/accounts.ts 里的 PBKDF2 实现（浏览器/服务端同一套哈希逻辑），
// 会话用随机 token 存在 sessions 表，通过 httpOnly Cookie 维持登录态。
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { withPg } from "../../db/pg";
import { sessions, users } from "../../db/schema";
import {
  PBKDF2_ITERATIONS,
  buildAccount,
  normalizeUsername,
  verifyPassword,
} from "./accounts";
import type { UserAccount } from "./accounts";

export const SESSION_COOKIE = "qianqian_session";
const SESSION_DAYS = 30;

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
};

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** 建会话：返回 token 与过期时间 */
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await withPg(async (db) => {
    await db.insert(sessions).values({ token, userId, expiresAt });
  });
  return { token, expiresAt };
}

export function sessionCookie(token: string, expiresAt: Date) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  // 本地开发是 http，只有生产（https）才加 Secure，否则浏览器不会保存 Cookie
  if (isProduction()) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/** 读取当前登录用户；未登录/会话过期返回 null */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    return await withPg(async (db) => {
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
          disabled: users.disabled,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
        .limit(1);
      const row = rows[0];
      if (!row || row.disabled) return null;
      return {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: (row.role === "admin" ? "admin" : "user") as "admin" | "user",
      };
    });
  } catch {
    return null;
  }
}

/** 注册：用户名唯一、密码至少 6 位 */
export async function registerUser(input: {
  username: string;
  displayName?: string;
  password: string;
  role?: "admin" | "user";
}): Promise<{ ok: true; user: SessionUser } | { ok: false; message: string }> {
  const username = normalizeUsername(input.username ?? "");
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return { ok: false, message: "用户名需为 3-20 位小写字母、数字、点、下划线或短横线。" };
  }
  if ((input.password ?? "").length < 6) {
    return { ok: false, message: "密码至少 6 位。" };
  }
  const account = await buildAccount({
    username,
    displayName: input.displayName,
    password: input.password,
    role: input.role ?? "user",
  });
  const created = await withPg(async (db) => {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing.length) return false;
    await db.insert(users).values({
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      salt: account.salt,
      hash: account.hash,
      iterations: account.iterations ?? PBKDF2_ITERATIONS,
    });
    return true;
  });
  if (!created) return { ok: false, message: "这个用户名已经被使用了。" };
  return {
    ok: true,
    user: { id: account.id, username: account.username, displayName: account.displayName, role: account.role },
  };
}

/** 校验用户名密码 */
export async function verifyLogin(username: string, password: string) {
  const row = await withPg(async (db) => {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, normalizeUsername(username ?? "")))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!row) return { ok: false as const, message: "用户名或密码不正确。" };
  if (row.disabled) return { ok: false as const, message: "该账号已被停用。" };

  const account: UserAccount = {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role === "admin" ? "admin" : "user",
    salt: row.salt,
    hash: row.hash,
    iterations: row.iterations,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString(),
    disabled: row.disabled,
  };
  const valid = await verifyPassword(password, account);
  if (!valid) return { ok: false as const, message: "用户名或密码不正确。" };

  await withPg(async (db) => {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
  });
  return {
    ok: true as const,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: (row.role === "admin" ? "admin" : "user") as "admin" | "user",
    },
  };
}

export async function revokeSession(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  await withPg(async (db) => {
    await db.delete(sessions).where(eq(sessions.token, token));
  });
}

/** 要求管理员身份 */
export async function requireAdmin(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return { ok: false as const, status: 401, message: "请先登录。" };
  if (user.role !== "admin") return { ok: false as const, status: 403, message: "需要管理员权限。" };
  return { ok: true as const, user };
}



