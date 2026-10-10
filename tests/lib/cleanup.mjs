// 测试收尾：把自动化测试注册出来的账号从服务端数据库清掉，避免账号列表越来越长。
//
// 用法：在测试脚本最后（browser.close() 之后）调用一次
//   await cleanupTestAccounts();
// 它会用管理员身份登录，然后让服务端按「测试用户名前缀」规则批量清理。
const BASE = "http://localhost:3000";

export async function cleanupTestAccounts() {
  try {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    if (!login.ok) return 0;
    const cookie = login.headers.getSetCookie?.()[0]?.split(";")[0] ?? "";
    const response = await fetch(`${BASE}/api/admin/users`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ mode: "test-accounts" }),
    });
    const body = await response.json().catch(() => ({}));
    return typeof body.removed === "number" ? body.removed : 0;
  } catch {
    return 0;
  }
}
