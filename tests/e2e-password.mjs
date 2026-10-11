// 修改自己的密码：注册一个新账号 → 设置里改密码 → 旧密码失效、新密码可登录。
import { createRequire } from "node:module";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

const RUN = Date.now().toString(36).slice(-5);
const USER = `preset${RUN}`;       // 走测试前缀，收尾会被自动清掉
const OLD_PW = "oldpass12345";
const NEW_PW = "newpass54321";

try {
  // 1) 注册一个全新账号
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[aria-label="用户名"]').fill(USER);
  await page.locator('input[aria-label="显示名称"]').fill("改密测试");
  await page.locator('input[aria-label="密码"]').fill(OLD_PW);
  await page.getByRole("button", { name: /注册并进入/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // 2) 设置 → 账号 → 修改密码
  await page.locator(".nav-item", { hasText: "设置" }).click();
  await page.waitForTimeout(1500);
  const body = async () => ((await page.locator(".page-view").textContent()) ?? "").replace(/\s+/g, " ");
  check("账号卡片有「修改密码」", (await body()).includes("修改密码"));

  await page.getByRole("button", { name: "修改密码" }).first().click();
  await page.waitForTimeout(600);
  check("展开改密表单", await page.locator(".password-form").isVisible().catch(() => false));

  // 3) 当前密码填错 → 应被拒绝
  await page.locator('input[aria-label="当前密码"]').fill("wrongpass123");
  await page.locator('input[aria-label="新密码"]').fill(NEW_PW);
  await page.locator('input[aria-label="确认新密码"]').fill(NEW_PW);
  await page.getByRole("button", { name: "保存新密码" }).click();
  await page.waitForTimeout(1500);
  check("当前密码错误被拒绝", (await body()).includes("当前密码不正确"), (await body()).slice(0, 80));

  // 4) 两次新密码不一致 → 前端拦下
  await page.locator('input[aria-label="当前密码"]').fill(OLD_PW);
  await page.locator('input[aria-label="新密码"]').fill(NEW_PW);
  await page.locator('input[aria-label="确认新密码"]').fill("mismatch12345");
  await page.getByRole("button", { name: "保存新密码" }).click();
  await page.waitForTimeout(800);
  check("两次输入不一致被拦下", (await body()).includes("两次输入的新密码不一致"));

  // 5) 正确修改
  await page.locator('input[aria-label="当前密码"]').fill(OLD_PW);
  await page.locator('input[aria-label="新密码"]').fill(NEW_PW);
  await page.locator('input[aria-label="确认新密码"]').fill(NEW_PW);
  await page.getByRole("button", { name: "保存新密码" }).click();
  await page.waitForTimeout(2000);
  check("提示修改成功", (await body()).includes("密码已修改"));

  // 6) 登出后用旧密码登录 → 失败；新密码 → 成功
  await page.getByRole("button", { name: "登出" }).first().click();
  await page.locator('input[aria-label="用户名"]').waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(600);

  await page.locator('input[aria-label="用户名"]').fill(USER);
  await page.locator('input[aria-label="密码"]').fill(OLD_PW);
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.waitForTimeout(2500);
  check("旧密码已失效", await page.locator(".auth-error").isVisible().catch(() => false));

  await page.locator('input[aria-label="密码"]').fill(NEW_PW);
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  check("新密码可以登录", await page.locator(".main-nav").isVisible());
} catch (error) {
  check("改密流程未抛异常", false, String(error).slice(0, 200));
} finally {
  await browser.close();
}

await cleanupTestAccounts();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
