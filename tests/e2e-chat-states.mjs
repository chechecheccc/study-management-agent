// 两个体验问题的回归：
//   1) 只发图片（没有文字）时，用户气泡不该借用"正在思考与行动"占位；答完后不该还留着转圈
//   2) 请求确认的卡片：确认/取消按钮必须一直固定在卡片底部可见（不用滚到底）
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const IMAGE = decodeURIComponent(new URL("./fixtures/chat-notice.png", import.meta.url).pathname.slice(1));

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

const composer = page.locator('input[aria-label="输入学习管理需求"]');
const waitIdle = async (timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await composer.isEnabled().catch(() => false)) return true;
    await page.waitForTimeout(800);
  }
  return false;
};

try {
  const RUN = Date.now().toString(36).slice(-5);
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[aria-label="用户名"]').fill(`chatstate${RUN}`);
  await page.locator('input[aria-label="显示名称"]').fill("状态测试");
  await page.locator('input[aria-label="密码"]').fill("chatstate12345");
  await page.getByRole("button", { name: /注册并进入/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1500);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await waitIdle();
  await page.waitForTimeout(1500);

  // 1) 只发图片，不带文字
  await page.locator('[data-testid="composer-file-input"]').setInputFiles(IMAGE);
  await page.waitForTimeout(1500);
  await composer.press("Enter");
  await page.waitForTimeout(2500);
  const userRow = page.locator(".message-row.user").last();
  const userText = ((await userRow.textContent()) ?? "").replace(/\s+/g, " ");
  check("只发图片时用户气泡不再显示「正在思考」", !userText.includes("正在思考与行动"), userText.slice(0, 40));
  check("只发图片时有明确的占位说明", userText.includes("［图片］"), userText.slice(0, 40));

  await waitIdle();
  await page.waitForTimeout(1500);
  // 图片是一份 DDL 通知，浅浅可能会顺手弹一张"建任务"确认卡；先处理掉它再看状态
  const anyConfirm = page.locator(".action-card", { has: page.locator(".action-buttons") }).first();
  if (await anyConfirm.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /取消|放弃/ }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
    await waitIdle();
    await page.waitForTimeout(1200);
  }
  const strays = await page.locator(".thinking-placeholder").count();
  check("回答完之后不再残留转圈气泡", strays === 0, `残留=${strays}`);
  const assistantText = ((await page.locator(".message-row.assistant").last().textContent()) ?? "").trim();
  check("助手确实给出了回答", assistantText.length > 8, assistantText.replace(/\s+/g, " ").slice(0, 60));

  // 2) 触发一张确认卡（让浅浅建任务），检查按钮固定可见
  const card = page.locator(".action-card", { has: page.locator(".action-buttons") }).first();
  let appeared = false;
  const askForTask = async (text, waitMs) => {
    await waitIdle();
    await composer.fill(text);
    await composer.press("Enter");
    appeared = await card.waitFor({ state: "visible", timeout: waitMs }).then(() => true).catch(() => false);
    return appeared;
  };
  await askForTask("帮我新建一条任务：标题「数据库作业」，课程「数据库系统」，类型 DDL，截止时间 明天晚上 20:00", 90000);
  if (!appeared) {
    // 模型可能先追问细节：再明确一次，直接让它调用 create_task
    await askForTask("就按上面这些直接调用 create_task 建这条任务，不用再问", 90000);
  }
  check("弹出确认卡片", appeared);
  if (appeared) {
    await page.waitForTimeout(800);
    const buttons = card.locator(".action-buttons").first();
    const box = await buttons.boundingBox();
    const viewport = page.viewportSize();
    check("确认/取消按钮在视口内可见", Boolean(box) && box.y >= 0 && box.y + box.height <= (viewport?.height ?? 0) + 1,
      box ? `按钮 y=${Math.round(box.y)} 高=${Math.round(box.height)} 视口高=${viewport?.height}` : "取不到位置");
    const sheetBox = await card.boundingBox();
    check("卡片不会超出屏幕高度", Boolean(sheetBox) && sheetBox.height <= (viewport?.height ?? 0), sheetBox ? `卡片高=${Math.round(sheetBox.height)}` : "");
    // 滚动内容区后按钮依然可见
    const list = card.locator(".plan-session-list, .action-grid, .action-edit-grid").first();
    if (await list.count()) await list.evaluate((element) => { element.scrollTop = element.scrollHeight; }).catch(() => {});
    await page.waitForTimeout(400);
    const box2 = await buttons.boundingBox();
    check("滚动内容后按钮仍在原位", Boolean(box2) && Math.abs(box2.y - (box?.y ?? 0)) < 4, box2 ? `y=${Math.round(box2.y)}` : "");
    await page.getByRole("button", { name: /取消|放弃/ }).first().click().catch(() => {});
  }

  await page.screenshot({ path: new URL("../.e2e/chat-states.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("聊天状态测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
