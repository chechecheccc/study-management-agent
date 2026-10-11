// 跨设备删除传播：A 设备删掉的任务，B 设备重新打开后不应该还在（否则会被重新推回云端）。
import { createRequire } from "node:module";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const USER = `syncdel${Date.now().toString(36).slice(-5)}`;
const PASS = "sync123456";
const TASK = `跨设备删除验证${Date.now().toString(36).slice(-4)}`;

async function enterWorkspace(page, { register }) {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const userField = page.locator('input[aria-label="用户名"]');
  if (await userField.isVisible().catch(() => false)) {
    if (register) await page.getByRole("tab", { name: "注册" }).click();
    await userField.fill(USER);
    if (register) await page.locator('input[aria-label="显示名称"]').fill("同步删除");
    await page.locator('input[aria-label="密码"]').fill(PASS);
    await page.getByRole("button", { name: register ? /注册并进入/ : /^登录$/ }).click();
  }
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

try {
  // ---------- 设备 A：注册 + 建任务 ----------
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const a = await ctxA.newPage();
  a.setDefaultTimeout(45000);
  await enterWorkspace(a, { register: true });

  await a.locator(".nav-item", { hasText: "任务中心" }).click();
  await a.waitForTimeout(1000);
  await a.getByRole("button", { name: /新建任务/ }).click();
  await a.waitForTimeout(800);
  await a.locator('.task-form input[placeholder="任务名称"]').fill(TASK);
  await a.locator('.task-form select[aria-label="任务课程"]').selectOption({ index: 1 }).catch(() => {});
  const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  await a.locator('.task-form input[type="datetime-local"]').fill(localIso(new Date(Date.now() + 72 * 3600 * 1000)));
  await a.getByRole("button", { name: "保存任务" }).click();
  await a.waitForTimeout(2500);
  check("设备A 建好任务", ((await a.locator(".page-view").textContent()) ?? "").includes(TASK));

  // 等自动同步推上去（防抖 4 秒）
  await a.waitForTimeout(9000);

  // ---------- 设备 B：登录后应看到这条任务 ----------
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const b = await ctxB.newPage();
  b.setDefaultTimeout(45000);
  await enterWorkspace(b, { register: false });
  await b.locator(".nav-item", { hasText: "任务中心" }).click();
  await b.waitForTimeout(2000);
  check("设备B 能看到设备A建的任务", ((await b.locator(".page-view").textContent()) ?? "").includes(TASK));

  // ---------- 设备 A 删除 ----------
  await a.reload({ waitUntil: "load" });
  await a.waitForTimeout(3500);
  const skipA = a.locator(".intro-skip");
  if (await skipA.count()) await skipA.click({ force: true, timeout: 3000 }).catch(() => {});
  await a.waitForTimeout(2500);
  await a.locator(".nav-item", { hasText: "任务中心" }).click();
  await a.waitForTimeout(1800);
  const row = a.locator(".task-row", { hasText: TASK }).first();
  check("设备A 能找到该任务行", (await row.count()) >= 1);
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await a.waitForTimeout(600);
  await a.getByRole("button", { name: "确认删除" }).first().click();
  await a.waitForTimeout(2500);
  check("设备A 删除成功", !(((await a.locator(".page-view").textContent()) ?? "").includes(TASK)));
  await a.waitForTimeout(9000); // 等删除上报

  // ---------- 设备 B：重新打开，任务应当消失 ----------
  await b.reload({ waitUntil: "load" });
  await b.waitForTimeout(3500);
  const skipB = b.locator(".intro-skip");
  if (await skipB.count()) await skipB.click({ force: true, timeout: 3000 }).catch(() => {});
  await b.waitForTimeout(3000);
  await b.locator(".nav-item", { hasText: "任务中心" }).click();
  await b.waitForTimeout(2000);
  const bText = ((await b.locator(".page-view").textContent()) ?? "").replace(/\s+/g, " ");
  check("设备B 重新打开后任务已消失（删除已传播）", !bText.includes(TASK), bText.slice(0, 70));

  // 再等一次同步周期，确认 B 没有把它推回来
  await b.waitForTimeout(8000);
  await a.reload({ waitUntil: "load" });
  await a.waitForTimeout(3500);
  const skipA2 = a.locator(".intro-skip");
  if (await skipA2.count()) await skipA2.click({ force: true, timeout: 3000 }).catch(() => {});
  await a.waitForTimeout(3000);
  await a.locator(".nav-item", { hasText: "任务中心" }).click();
  await a.waitForTimeout(2000);
  check("设备A 刷新后任务没有被复活", !(((await a.locator(".page-view").textContent()) ?? "").includes(TASK)));
} catch (error) {
  check("跨设备删除用例未抛异常", false, String(error).slice(0, 200));
} finally {
  await browser.close();
}

await cleanupTestAccounts();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
