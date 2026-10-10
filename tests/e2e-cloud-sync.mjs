// 端到端验证：界面登录 → 数据自动同步到 PostgreSQL → 新设备登录能看到
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const USER = `sync${Date.now().toString(36).slice(-5)}`;
const PASS = "sync123456";

// 登录辅助：若服务端会话仍有效（刷新后自动恢复工作区），则跳过登录步骤
async function login(page, username, password) {
  await page.waitForTimeout(3000);
  const userField = page.locator('input[aria-label="用户名"]');
  if (await userField.isVisible().catch(() => false)) {
    await userField.fill(username);
    await page.locator('input[aria-label="密码"]').fill(password);
    await page.getByRole("button", { name: /^登录$/ }).click();
  }
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

// ---------- 设备 1：注册 + 建数据 ----------
const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const p1 = await ctx1.newPage();
p1.setDefaultTimeout(30000);

await p1.goto("http://localhost:3000/", { waitUntil: "load" });
await p1.waitForTimeout(3000);
check("登录页出现登录/注册切换", await p1.getByRole("tab", { name: "注册" }).isVisible());

await p1.getByRole("tab", { name: "注册" }).click();
await p1.locator('input[aria-label="用户名"]').fill(USER);
await p1.locator('input[aria-label="显示名称"]').fill("同步测试");
await p1.locator('input[aria-label="密码"]').fill(PASS);
await p1.getByRole("button", { name: /注册并进入/ }).click();
await p1.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
await p1.waitForTimeout(1200);
const skip1 = p1.locator(".intro-skip");
if (await skip1.count()) await skip1.click({ force: true, timeout: 3000 }).catch(() => {});
await p1.waitForTimeout(2500);
check("注册后自动进入工作区", await p1.locator(".brand-name").isVisible());

// 用任务中心表单建一条独特任务
await p1.locator(".nav-item", { hasText: "任务中心" }).click();
await p1.waitForTimeout(800);
await p1.getByRole("button", { name: /新建任务/ }).click();
await p1.waitForTimeout(800);
const nameInput = p1.locator('.inline-form input[placeholder="任务名称"]');
const formReady = await nameInput.isVisible().catch(() => false);
check("任务表单可打开", formReady);
if (formReady) {
  await nameInput.fill("云同步验证任务XYZ");
  await p1.getByRole("button", { name: /保存任务/ }).click();
  await p1.waitForTimeout(2000);
}
const tasks1 = (await p1.locator(".page-view").textContent()) ?? "";
check("设备1 创建任务成功", tasks1.includes("云同步验证任务XYZ"), `片段：${tasks1.replace(/\s+/g, " ").slice(0, 60)}`);

// 等自动同步（防抖 4 秒）
await p1.waitForTimeout(8000);
await p1.locator(".nav-item", { hasText: "设置" }).click();
await p1.waitForTimeout(1200);
const syncText = (await p1.locator(".sync-status").textContent()) ?? "";
check("设置页显示已同步", syncText.includes("已同步"), `状态：${syncText.replace(/\s+/g, " ").slice(0, 50)}`);
await p1.screenshot({ path: new URL("../.e2e/sync-device1.png", import.meta.url).pathname.slice(1) });

// ---------- 设备 2：全新浏览器上下文（相当于另一台电脑） ----------
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const p2 = await ctx2.newPage();
p2.setDefaultTimeout(30000);
await p2.goto("http://localhost:3000/", { waitUntil: "load" });
await p2.waitForTimeout(3000);
await login(p2, USER, PASS);
await p2.locator(".nav-item", { hasText: "任务中心" }).click();
await p2.waitForTimeout(2000);
const tasks2 = (await p2.locator(".page-view").textContent()) ?? "";
check("设备2 登录后看到设备1的数据（跨设备同步）", tasks2.includes("云同步验证任务XYZ"), `片段：${tasks2.replace(/\s+/g, " ").slice(0, 60)}`);
await p2.screenshot({ path: new URL("../.e2e/sync-device2.png", import.meta.url).pathname.slice(1) });

// ---------- 设备 2 改数据 → 设备 1 应能拿到 ----------
await p2.getByRole("button", { name: /新建任务/ }).click();
await p2.waitForTimeout(500);
await p2.locator('.inline-form input[placeholder="任务名称"]').fill("设备2新建的任务ABC");
await p2.getByRole("button", { name: /保存任务/ }).click();
await p2.waitForTimeout(9000);

await p1.reload({ waitUntil: "load" });
await login(p1, USER, PASS);
await p1.locator(".nav-item", { hasText: "任务中心" }).click();
await p1.waitForTimeout(2000);
const tasks1b = (await p1.locator(".page-view").textContent()) ?? "";
check("设备1 刷新后拿到设备2的新数据", tasks1b.includes("设备2新建的任务ABC"), `片段：${tasks1b.replace(/\s+/g, " ").slice(0, 60)}`);

// ---------- 账号隔断 ----------
const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const p3 = await ctx3.newPage();
p3.setDefaultTimeout(30000);
await p3.goto("http://localhost:3000/", { waitUntil: "load" });
await p3.waitForTimeout(3000);
await login(p3, "student1", "123456");
await p3.locator(".nav-item", { hasText: "任务中心" }).click();
await p3.waitForTimeout(2000);
const tasks3 = (await p3.locator(".page-view").textContent()) ?? "";
check("另一账号看不到该用户的数据（账号隔离）", !tasks3.includes("云同步验证任务XYZ"), `片段：${tasks3.replace(/\s+/g, " ").slice(0, 50)}`);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过  （测试账号：${USER}）`);
process.exit(failed.length ? 1 : 0);


