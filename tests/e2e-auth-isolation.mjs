// 账号隔离测试（确定性版）：直接用任务中心表单创建任务，不依赖模型响应。
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
page.setDefaultTimeout(25000);

// 登录辅助：若服务端会话仍有效（刷新后自动恢复工作区），则跳过登录
async function loginAs(username, password) {
  await page.waitForTimeout(2500);
  const userField = page.locator('input[aria-label="用户名"]');
  if (await userField.isVisible().catch(() => false)) {
    await userField.waitFor({ state: "visible", timeout: 20000 });
    await userField.fill(username);
    await page.locator('input[aria-label="密码"]').fill(password);
    await page.getByRole("button", { name: /^登录$/ }).click();
  }
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(900);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function logout() {
  await page.getByRole("button", { name: /登出/ }).click();
  await page.locator('input[aria-label="用户名"]').waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(500);
}

// 用任务中心的表单建一条独特任务（完全确定性，不经过模型）
async function createTaskViaForm(title) {
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: /新建任务/ }).click();
  await page.waitForTimeout(500);
  await page.locator('.inline-form input[placeholder="任务名称"]').fill(title);
  await page.getByRole("button", { name: /保存任务/ }).click();
  await page.waitForTimeout(1200);
}

async function readTasks() {
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(900);
  return (await page.locator(".task-list-wrap").textContent()) ?? "";
}

try {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(2500);

  // 用户 A 建任务
  await loginAs("student1", "123456");
  await createTaskViaForm("A用户专属AAA");
  check("用户A 创建任务成功", (await readTasks()).includes("A用户专属AAA"));
  await logout();

  // 用户 B 不应看到 A 的数据
  await loginAs("student2", "123456");
  const tasksB = await readTasks();
  check("用户B 看不到用户A 的任务", !tasksB.includes("A用户专属AAA"), `B 片段：${tasksB.slice(0, 60)}`);
  await createTaskViaForm("B用户专属BBB");
  check("用户B 创建任务成功", (await readTasks()).includes("B用户专属BBB"));
  await logout();

  // 用户 A 回来看自己的数据
  await loginAs("student1", "123456");
  const tasksA = await readTasks();
  check("用户A 重新登录后数据保留", tasksA.includes("A用户专属AAA"), `A 片段：${tasksA.slice(0, 60)}`);
  check("用户A 看不到用户B 的任务", !tasksA.includes("B用户专属BBB"));

  // 刷新后仍然正确
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2500);
  await loginAs("student1", "123456");
  const tasksA2 = await readTasks();
  check("刷新重登后数据归属正确", tasksA2.includes("A用户专属AAA") && !tasksA2.includes("B用户专属BBB"));
} catch (error) {
  check("隔离测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);

