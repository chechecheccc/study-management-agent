// 写入确认卡片：删除任务 / 修改任务状态都必须先让用户确认，确认前不动数据。
// 这里把模型这一步 mock 掉（不真的调用模型），只验证 agent 循环 + 确认卡片的接线。
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
const KEEP = `保留任务${RUN}`;
const KILL = `删除任务${RUN}`;

const localInput = (date) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// 每次进对话前重设 mock 脚本：第一轮返回工具调用，确认之后再返回一段文本
let scripted = [];
const queueScript = (steps) => { scripted = [...steps]; };
const routeStep = async (route) => {
  const next = scripted.shift();
  if (!next) {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, type: "message", content: "好的。" }) });
    return;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(next) });
};

try {
  await page.route("**/api/agent/step", routeStep);

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
  await page.waitForTimeout(2500);

  // 建两条任务：一条用于「确认删除」，一条用于「取消不删除」
  const composerEl = page.locator('input[aria-label="输入学习管理需求"]');
  const waitIdle = async (tries = 40) => {
    for (let i = 0; i < tries; i += 1) { if (await composerEl.isEnabled({ timeout: 1000 }).catch(() => false)) return true; await page.waitForTimeout(800); }
    return false;
  };

  const createTask = async (title) => {
    await page.locator(".nav-item", { hasText: "任务中心" }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /新建任务/ }).click();
    await page.waitForTimeout(600);
    await page.locator('.task-form input[placeholder="任务名称"]').fill(title);
    await page.locator('.task-form select[aria-label="任务课程"]').selectOption({ index: 1 });
    await page.locator('.task-form input[type="datetime-local"]').fill(localInput(new Date(Date.now() + 48 * 3600 * 1000)));
    await page.getByRole("button", { name: "保存任务" }).click();
    await page.waitForTimeout(1800);
    const text = ((await page.locator(".page-view").textContent()) ?? "").replace(/\s+/g, " ");
    return text.includes(title);
  };
  check("建好第一条任务", await createTask(KILL));
  check("建好第二条任务", await createTask(KEEP));

  // ---- 场景 A：确认删除 ----
  await waitIdle();
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(1200);
  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 30; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(800); }

  queueScript([
    { ok: true, type: "tool_calls", content: "", calls: [{ id: "call-del-1", name: "delete_task", arguments: { taskTitle: KILL } }] },
    { ok: true, type: "message", content: "已经帮你删掉了。" },
  ]);
  await composer.fill(`把「${KILL}」这条任务删掉`);
  await composer.press("Enter");
  await page.waitForTimeout(2500);

  const card = page.locator(".inline-confirm, .confirm-sheet").first();
  const cardText = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
  check("弹出删除确认卡片", await card.isVisible().catch(() => false), cardText.slice(0, 70));
  check("卡片说明是删除任务", cardText.includes("删除任务"), cardText.slice(0, 70));
  check("卡片里带任务名", cardText.includes(KILL));
  // （确认前数据未写入，在 场景 B 用“取消后任务仍在”验证）

  await page.getByRole("button", { name: "确认删除" }).first().click();
  await waitIdle();
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.locator(".page-view").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const afterDelete = ((await page.locator(".page-view").textContent()) ?? "").replace(/\s+/g, " ");
  check("确认后任务真的被删除", !afterDelete.includes(KILL), afterDelete.slice(0, 60));
  check("另一条任务没被误删", afterDelete.includes(KEEP));

  // ---- 场景 B：取消删除 ----
  await waitIdle();
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(1200);
  for (let i = 0; i < 30; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(800); }
  queueScript([
    { ok: true, type: "tool_calls", content: "", calls: [{ id: "call-del-2", name: "delete_task", arguments: { taskTitle: KEEP } }] },
    { ok: true, type: "message", content: "好的，先不删。" },
  ]);
  await composer.fill(`把「${KEEP}」删了`);
  await composer.press("Enter");
  await page.waitForTimeout(2500);
  check("再次弹出删除确认卡片", await page.locator(".inline-confirm, .confirm-sheet").first().isVisible().catch(() => false));
  await page.getByRole("button", { name: "取消" }).first().click();
  await waitIdle();
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.locator(".page-view").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const afterCancel = ((await page.locator(".page-view").textContent()) ?? "").replace(/\s+/g, " ");
  check("取消后任务仍在（确认前不写入）", afterCancel.includes(KEEP));

  // ---- 场景 C：修改任务状态也要确认 ----
  await waitIdle();
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(1200);
  for (let i = 0; i < 30; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(800); }
  queueScript([
    { ok: true, type: "tool_calls", content: "", calls: [{ id: "call-st-1", name: "update_task_status", arguments: { taskTitle: KEEP, status: "已完成" } }] },
    { ok: true, type: "message", content: "已标记完成。" },
  ]);
  await composer.fill(`「${KEEP}」做完了`);
  await composer.press("Enter");
  await page.waitForTimeout(2500);
  const statusCard = ((await page.locator(".inline-confirm, .confirm-sheet").first().textContent()) ?? "").replace(/\s+/g, " ");
  check("改状态也要确认", statusCard.includes("修改任务状态") && statusCard.includes(KEEP), statusCard.slice(0, 70));
  await page.getByRole("button", { name: "确认修改" }).first().click();
  await waitIdle();
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.locator(".page-view").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const afterStatus = ((await page.locator(".page-view").textContent()) ?? "").replace(/\s+/g, " ");
  check("确认后状态改为已完成", afterStatus.includes("已完成"));

  // 收尾：把测试任务删掉
  for (const title of [KEEP, KILL]) {
    const row = page.locator(".task-row", { hasText: title });
    if (await row.count()) {
      await row.first().getByRole("button", { name: "删除" }).click().catch(() => {});
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: "确认删除" }).first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }
} catch (error) {
  check("确认卡片用例未抛异常", false, String(error).slice(0, 220));
} finally {
  await browser.close();
}

await cleanupTestAccounts();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
