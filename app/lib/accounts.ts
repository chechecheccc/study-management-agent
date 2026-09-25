// 本地账号系统：密码用 PBKDF2-SHA256 + 随机盐哈希，绝不保存明文。
// 账号注册表存在 localStorage；每个账号的数据存在各自独立的 IndexedDB 命名空间。
// 纯逻辑 + WebCrypto，可在 Node 中直接测试。

export type AccountRole = "admin" | "user";

export type UserAccount = {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  salt: string;
  hash: string;
  iterations: number;
  createdAt: string;
  lastLoginAt?: string;
  disabled?: boolean;
};

export type PublicAccount = Omit<UserAccount, "salt" | "hash" | "iterations">;

export type SeedAccount = {
  username: string;
  displayName: string;
  password: string;
  role: AccountRole;
};

export const ACCOUNTS_STORAGE_KEY = "study-agent-accounts";
export const PBKDF2_ITERATIONS = 120_000;
const HASH_BYTES = 32;
const MIN_PASSWORD_CHARS = 6;

// 首次运行预置：1 个管理员 + 2 个普通用户
export const SEED_ACCOUNTS: SeedAccount[] = [
  { username: "admin", displayName: "管理员", password: "admin123", role: "admin" },
  { username: "student1", displayName: "小林", password: "123456", role: "user" },
  { username: "student2", displayName: "小周", password: "123456", role: "user" },
];

export function loadAccounts(): UserAccount[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ACCOUNTS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUserAccount);
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: UserAccount[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts));
}

export function toPublicAccount(account: UserAccount): PublicAccount {
  const { salt, hash, iterations, ...rest } = account;
  void salt; void hash; void iterations;
  return rest;
}

export function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

export function findAccountByUsername(accounts: UserAccount[], username: string) {
  const normalized = normalizeUsername(username);
  return accounts.find((account) => account.username === normalized) ?? null;
}

export function findAccountById(accounts: UserAccount[], id: string) {
  return accounts.find((account) => account.id === id) ?? null;
}

export async function hashPassword(password: string, salt = randomSalt(), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(salt), iterations, hash: "SHA-256" },
    key,
    HASH_BYTES * 8,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function verifyPassword(password: string, account: UserAccount) {
  const candidate = await hashPassword(password, account.salt, account.iterations);
  return timingSafeEqual(candidate, account.hash);
}

export function validateNewAccount(input: {
  username: string;
  displayName?: string;
  password: string;
  accounts: UserAccount[];
  ignoreUserId?: string;
}):
  | { ok: true; username: string; displayName: string }
  | { ok: false; message: string } {
  const username = normalizeUsername(input.username);
  const displayName = (input.displayName ?? "").trim() || username;
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return { ok: false, message: "用户名需为 3-20 位小写字母、数字、点、下划线或短横线。" };
  }
  if (findAccountByUsername(input.accounts, username) && findAccountByUsername(input.accounts, username)?.id !== input.ignoreUserId) {
    return { ok: false, message: "这个用户名已经被使用了。" };
  }
  if (input.password.length < MIN_PASSWORD_CHARS) {
    return { ok: false, message: `密码至少 ${MIN_PASSWORD_CHARS} 位。` };
  }
  return { ok: true, username, displayName };
}

export async function buildAccount(input: {
  username: string;
  displayName?: string;
  password: string;
  role: AccountRole;
}): Promise<UserAccount> {
  const salt = randomSalt();
  return {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username: normalizeUsername(input.username),
    displayName: (input.displayName ?? "").trim() || normalizeUsername(input.username),
    role: input.role,
    salt,
    hash: await hashPassword(input.password, salt),
    iterations: PBKDF2_ITERATIONS,
    createdAt: new Date().toISOString(),
  };
}

export async function authenticate(accounts: UserAccount[], username: string, password: string) {
  const account = findAccountByUsername(accounts, username);
  if (!account) return { ok: false as const, message: "用户名或密码不正确。" };
  if (account.disabled) return { ok: false as const, message: "该账号已被管理员停用。" };
  const valid = await verifyPassword(password, account);
  if (!valid) return { ok: false as const, message: "用户名或密码不正确。" };
  return { ok: true as const, account };
}

export function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function isUserAccount(value: unknown): value is UserAccount {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.username === "string" &&
    typeof record.displayName === "string" &&
    (record.role === "admin" || record.role === "user") &&
    typeof record.salt === "string" &&
    typeof record.hash === "string" &&
    typeof record.iterations === "number"
  );
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// 常量时间比较，避免通过响应时间猜测哈希
function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
