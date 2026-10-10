// 账号清理用到的纯逻辑（服务端与浏览器共用，不依赖数据库/React）。
//
// 背景：自动化测试每跑一次就会**注册一个全新账号**（用户名 = 前缀 + 随机后缀），
// 跑很多轮之后管理员列表里会堆满测试账号。这里集中维护测试脚本用到的用户名前缀，
// 服务端批量清理和前端分组展示都引用它，避免两边规则不一致。

/** 正式账号（初始化脚本创建的账号，永远不会被当成测试账号） */
export const SEED_USERNAMES = ["admin", "student1", "student2"] as const;

/** 测试脚本里词形很长的前缀：后面跟 3-8 位后缀即可判定，后缀不含数字也算 */
const STRONG_PREFIXES = [
  "chatstate",
  "detail",
  "flicker",
  "preset",
  "probe",
  "smoke",
  "taskfeat",
  "tasksync",
  "tester",
] as const;

/**
 * 短前缀（可能是正常用户名的开头，例如 library / student / sync），
 * 必须再带数字才判定为测试账号，避免误删真人账号。
 */
const SHORT_PREFIXES = [
  "alice",
  "bob",
  "conv",
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

/** 是不是自动化测试注册出来的账号？判定故意保守，宁可漏判也不误删真人账号。 */
export function isTestUsername(username: string) {
  const name = username.trim().toLowerCase();
  if (!name || isSeedUsername(name)) return false;
  if (!/^[a-z0-9]+$/.test(name)) return false;

  const matches = (prefix: string) => {
    if (!name.startsWith(prefix)) return false;
    const suffix = name.slice(prefix.length);
    return suffix.length >= 3 && suffix.length <= 8;
  };

  if (STRONG_PREFIXES.some(matches)) return true;
  if (!/[0-9]/.test(name)) return false;
  return SHORT_PREFIXES.some(matches);
}
