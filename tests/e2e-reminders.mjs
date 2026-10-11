// 提醒行为：同一档只提醒一次（换设备不重复）、任务删掉后提醒一并消失
import { createRequire } from "node:module";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const RUN = Date.now().toString(36).slice(-5);
const USER = `remind${RUN}`;
const PASS = "remind123456";
const TITLE = `提醒去重验证${RUN}`;

const login = async (page) => {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const user = page.locator('input[aria-label="用户名"]');
  if (await user.isVisible().catch(() => false)) {
    await user.fill(USER);
    await page.locator('input[aria-label="密码"]').fill(PASS);
    await page.getByRole("button", { name: /^登录$/ }).click();
  }
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4500);
};
const countReminders = (page) => page.evaluate((title) =>
  [...document.querySelectorAll(".message-bubble")].filter((b) => b.textContent.includes("⏰") && b.textContent.includes(title)).length, TITLE);

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);
try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[aria-label="用户名"]').fill(USER);
  await page.locator('input[aria-label="显示名称"]').fill("提醒验证");
  await page.locator('input[aria-label="密码"]').fill(PASS);
  await page.getByRole("button", { name: /注册并进入/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip0 = page.locator(".intro-skip");
  if (await skip0.count()) await skip0.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 先聊一句：提醒消息是随对话一起持久化/同步的，真实使用中也是先有对话
  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 40; i += 1) { if (await composer.isEnabled({ timeout: 1000 }).catch(() => false)) break; await page.waitForTimeout(1000); }
  await composer.fill("你好");
  await composer.press("Enter");
  await page.waitForTimeout(12000);

  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /新建任务/ }).click();
  await page.waitForTimeout(600);
  await page.locator('.task-form input[placeholder="任务名称"]').fill(TITLE);
  await page.locator('.task-form select[aria-label="任务课程"]').selectOption({ index: 1 }).catch(() => {});
  const d = new Date(Date.now() + 20 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  await page.locator('.task-form input[type="datetime-local"]').fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  await page.getByRole("button", { name: "保存任务" }).click();
  await page.waitForTimeout(2500);

  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(4500);
  const skip1 = page.locator(".intro-skip");
  if (await skip1.count()) await skip1.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(6000);
  check("打开后有 1 条提醒", (await countReminders(page)) === 1, `条数=${await countReminders(page)}`);

  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(4500);
  const skip2 = page.locator(".intro-skip");
  if (await skip2.count()) await skip2.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(6000);
  check("同一设备刷新后仍是 1 条（不重复）", (await countReminders(page)) === 1, `条数=${await countReminders(page)}`);

  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(45000);
  await login(page2);
  await page2.waitForTimeout(6000);
  check("换设备登录后仍是 1 条（跨设备不重复）", (await countReminders(page2)) === 1, `条数=${await countReminders(page2)}`);
  await ctx2.close();

  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(1500);
  const row = page.locator(".task-row", { hasText: TITLE }).first();
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "确认删除" }).first().click();
  await page.waitForTimeout(3000);
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(2500);
  check("删掉任务后它的提醒也消失", (await countReminders(page)) === 0, `条数=${await countReminders(page)}`);
} catch (error) {
  check("提醒用例未抛异常", false, String(error).slice(0, 160));
} finally {
  await browser.close();
}

await cleanupTestAccounts();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
