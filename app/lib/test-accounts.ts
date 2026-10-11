// 账号清理用到的纯逻辑（服务端与浏览器共用，不依赖数据库/React）。
//
// 背景：自动化测试每跑一次就会**注册一个全新账号**（用户名 = 前缀 + 随机后缀），
// 跑很多轮之后管理员列表里会堆满测试账号。这里集中维护测试脚本用到的用户名前缀，
// 服务端批量清理和前端分组展示都引用它，避免两边规则不一致。
//
// 取舍：判定放宽一点（短前缀的后缀不再要求必须含数字），因为漏判会在账号列表里
// 留下一堆没人认领的账号；而"真人自己起的名字"集中在下面 NEVER 名单里保护起来。
// 被判成测试账号的也只会归到「测试账号」分组，展开还能单独操作，不会偷偷删掉。

/** 正式账号（初始化脚本创建的账号，永远不会被当成测试账号） */
export const SEED_USERNAMES = ["admin", "student1", "student2"] as const;

/** 一看就是真人起名的前缀：永远不当测试账号 */
const NEVER_TEST_PREFIXES = [
  "admin",
  "classmate",
  "guest",
  "root",
  "student",
  "stu2024",
  "teacher",
  "user",
] as const;

/** 测试脚本里词形很长的前缀：后面跟 3-8 位后缀即可判定 */
const STRONG_PREFIXES = [
  "chatstate",
  "content",
  "detail",
  "flicker",
  "preset",
  "probe",
  "smoke",
  "syncdel",
  "taskfeat",
  "tasksync",
  "tester",
] as const;

/** 短前缀（可能是正常用户名的开头，例如 library），要求后缀 4-8 位 */
const SHORT_PREFIXES = [
  "alice",
  "bob",
  "conv",
  "courset",
  "diag",
  "lib",
  "llm",
  "stu",
  "sync",
  "up",
] as const;

export const TEST_USERNAME_PREFIXES = [...STRONG_PREFIXES, ...SHORT_PREFIXES] as const;

export function isSeedUsername(username: string) {
  return (SEED_USERNAMES as readonly string[]).includes(username.trim().toLowerCase());
}

/** 是不是自动化测试注册出来的账号？ */
export function isTestUsername(username: string) {
  const name = username.trim().toLowerCase();
  if (!name || isSeedUsername(name)) return false;
  if (!/^[a-z0-9]+$/.test(name)) return false;
  if (NEVER_TEST_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;

  const matches = (prefix: string, minSuffix: number) => {
    if (!name.startsWith(prefix)) return false;
    const suffix = name.slice(prefix.length);
    return suffix.length >= minSuffix && suffix.length <= 8;
  };

  if (STRONG_PREFIXES.some((prefix) => matches(prefix, 3))) return true;
  return SHORT_PREFIXES.some((prefix) => matches(prefix, 4));
}
