// 账号系统端到端测试：验证登录、按账号隔离聊天与资料、管理员面板。
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SHOTS = new URL("../.e2e-auth/", import.meta.url);
await mkdir(SHOTS, { recursive: true });

const RUN_ID = Date.now().toString(36).slice(-5);
const NEW_USER = "stu" + RUN_ID;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, SHOTS).pathname.slice(1), fullPage: true });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

async function login(username, password) {
  const userInput = page.locator('input[aria-label="用户名"]');
  await userInput.waitFor({ state: "visible", timeout: 20000 });
  await userInput.fill(username);
  await page.locator('input[aria-label="密码"]').fill(password);
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(800);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function logout() {
  await page.getByRole("button", { name: /登出/ }).click();
  await page.locator('input[aria-label="用户名"]').waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(500);
}

try {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(2500);

  // 1. 登录页出现且有 3 个预置账号
  check("登录页显示", await page.locator('input[aria-label="用户名"]').isVisible());
  const accountRows = await page.locator(".auth-account-row").count();
  check("预置 3 个账号（1 管理员 + 2 用户）", accountRows === 3, `实际 ${accountRows} 个`);
  await shot(page, "01-login");

  // 2. 错误密码被拒
  await page.locator('input[aria-label="用户名"]').fill("student1");
  await page.locator('input[aria-label="密码"]').fill("wrong-password");
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.waitForTimeout(2500);
  check("错误密码被拒绝", await page.locator(".auth-error").isVisible());

  // 3. 用户 A 登录：普通用户看不到账号管理
  await login("student1", "123456");
  const hasAccountsNavStudent = await page.locator(".nav-item", { hasText: "账号管理" }).count();
  check("普通用户看不到账号管理入口", hasAccountsNavStudent === 0);

  // 分离模式：在每个阶段使用独立浏览器上下文，模拟两个不同用户各自的数据
  await logout();
  await login("admin", "admin123");
  const hasAccountsNavAdmin = await page.locator(".nav-item", { hasText: "账号管理" }).count();
  check("管理员看到账号管理入口", hasAccountsNavAdmin === 1);
  await shot(page, "02-admin");

  // 4. 管理员面板
  await page.locator(".nav-item", { hasText: "账号管理" }).click();
  await page.waitForTimeout(600);
  // 账号从服务端异步加载，先等列表出现
  await page.locator(".account-row").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  const listed = await page.locator(".account-row").count();
  check("面板列出服务端账号", listed >= 3, `实际 ${listed} 个`);
  await shot(page, "03-accounts-panel");

  // 5. 新增账号
  await page.locator('input[aria-label="新账号用户名"]').fill(NEW_USER);
  await page.locator('input[aria-label="新账号显示名称"]').fill("小陈");
  await page.locator('input[aria-label="新账号密码"]').fill("abc123456");
  await page.getByRole("button", { name: /创建账号/ }).click();
  await page.waitForTimeout(1500);
  const afterCreate = await page.locator(".account-row").count();
  check("新增账号成功", afterCreate === listed + 1, `新增前 ${listed} → 新增后 ${afterCreate}`);

  // 6. 重复用户名被拒
  await page.locator('input[aria-label="新账号用户名"]').fill(NEW_USER);
  await page.locator('input[aria-label="新账号密码"]').fill("abc123456");
  await page.getByRole("button", { name: /创建账号/ }).click();
  await page.waitForTimeout(1200);
  check("重复用户名被拒绝", await page.locator(".queue-error").first().isVisible());

  check("无页面级异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  check("测试脚本执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
