// 验证「账号管理」页：正式账号与测试账号分组、一键清理测试账号、删除账号同时清数据。
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

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const user = page.locator('input[aria-label="用户名"]');
  if (await user.isVisible().catch(() => false)) {
    await user.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
  }
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(3000);

  await page.locator(".nav-item", { hasText: "账号管理" }).click();
  await page.waitForTimeout(2000);

  const body = async () => ((await page.locator(".page-view").textContent()) ?? "").replace(/\s+/g, " ");

  // 1) 正式账号分组存在，且清理后只剩初始化账号
  check("有「正式账号」分组", (await body()).includes("正式账号"));
  check("正式账号里有管理员", (await body()).includes("管理员"));
  check("正式账号里有小林/小周", (await body()).includes("小林") && (await body()).includes("小周"));
  const realCount = await page.locator(".data-card", { hasText: "正式账号" }).locator(".account-row").count();
  check("正式账号数量为 3", realCount === 3, `实际=${realCount}`);

  // 2) 新建一个「测试样」账号（前缀符合测试规则），应落到测试账号分组
  const RUN = Date.now().toString(36).slice(-5);
  await page.locator('input[aria-label="新账号用户名"]').fill(`smoke${RUN}`);
  await page.locator('input[aria-label="新账号显示名称"]').fill("用例账号");
  await page.locator('input[aria-label="新账号密码"]').fill("smoke12345");
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.waitForTimeout(1800);
  check("测试账号分组出现", (await body()).includes("测试账号"));
  const testCount = await page.locator(".account-tests").count();
  check("存在测试账号卡片", testCount >= 1);
  const testRows = await page.locator(".account-tests .account-row").count();
  check("测试账号默认收起（行数 0）", testRows === 0, `行数=${testRows}`);
  await page.getByRole("button", { name: "展开查看" }).click();
  await page.waitForTimeout(500);
  check("展开后能看到测试账号", (await page.locator(".account-tests .account-row").count()) >= 1);

  // 3) 一键清理
  await page.getByRole("button", { name: "一键清理测试账号" }).click();
  await page.waitForTimeout(400);
  check("清理需要二次确认", await page.getByRole("button", { name: /确认清理/ }).isVisible().catch(() => false));
  await page.getByRole("button", { name: /确认清理/ }).click();
  await page.waitForTimeout(2500);
  check("清理后提示已清理", (await body()).includes("已清理"));
  check("测试账号卡片消失", (await page.locator(".account-tests").count()) === 0);

  // 4) 服务端真的删掉了：重新拉一次列表
  const after = await page.evaluate(async () => {
    const r = await fetch("/api/admin/users", { cache: "no-store" });
    return r.json();
  });
  check("服务端账号只剩 3 个", after.users?.length === 3, `实际=${after.users?.length}`);
  check("服务端没有被判定为测试账号的账号", !(after.users ?? []).some((u) => u.test), JSON.stringify((after.users ?? []).map((u) => [u.username, u.test])));

  // 5) 表单里只保留正式账号的删除入口
  check("正式账号行有删除按钮", (await page.locator(".data-card", { hasText: "正式账号" }).getByRole("button", { name: "删除" }).count()) >= 2);
} catch (error) {
  check("用例未抛异常", false, String(error).slice(0, 200));
} finally {
  await browser.close();
}

// 收尾：清掉本次测试注册的账号，不让账号列表越测越长
await cleanupTestAccounts();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
