// 对话会话测试：新建、按日期分组、进入、删除、刷新后仍在
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 160)));

async function login() {
  await page.waitForTimeout(2400);
  const u = page.locator('input[aria-label="用户名"]');
  if (await u.isVisible().catch(() => false)) {
    await u.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
    await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
    await page.waitForTimeout(1200);
    const skip = page.locator(".intro-skip");
    if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);
}

async function send(text, waitMs = 9000) {
  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 40; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(800); }
  await composer.fill(text);
  await composer.press("Enter");
  await page.waitForTimeout(waitMs);
}

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await login();

  // 1) 新对话按钮存在
  check("聊天头部有新建对话入口", await page.getByRole("button", { name: /新对话/ }).isVisible());

  // 2) 发一条消息 → 自动建档
  await send("第一个对话：帮我看看任务", 9000);
  await page.getByRole("button", { name: /对话记录/ }).click();
  await page.waitForTimeout(800);
  const rows1 = await page.locator(".conversation-row").count();
  check("发出消息后自动保存为一个对话", rows1 >= 1, `对话数=${rows1}`);
  const groupLabels = await page.locator(".conversation-group-label").allTextContents();
  check("对话按日期分组显示", groupLabels.includes("今天"), `分组=${groupLabels.join("/")}`);

  // 3) 新建对话 → 界面清空
  await page.getByRole("button", { name: /＋ 新对话/ }).click();
  await page.waitForTimeout(900);
  const afterNew = await page.locator(".message-bubble").count();
  check("新建对话后界面重置为欢迎语", afterNew === 1, `气泡数=${afterNew}`);

  // 4) 在第二个对话里发消息
  await send("第二个对话：帮我找数据库课件", 9000);
  await page.getByRole("button", { name: /对话记录/ }).click();
  await page.waitForTimeout(800);
  const rows2 = await page.locator(".conversation-row").count();
  check("两个对话都在列表中", rows2 >= 2, `对话数=${rows2}`);
  const titles = await page.locator(".conversation-open strong").allTextContents();
  check("对话标题取自首条用户消息", titles.some((t) => t.includes("第二个对话")), `标题=${titles.join(" | ")}`);
  check("首个对话标题也取自用户消息（不被巡检消息抢占）", titles.some((t) => t.includes("第一个对话")), `标题=${titles.join(" | ")}`);

  // 5) 进入第一个对话 → 内容恢复
  const firstRow = page.locator(".conversation-row", { hasText: "第一个对话" }).first();
  await firstRow.locator(".conversation-open").click();
  await page.waitForTimeout(1200);
  const textNow = (await page.locator(".message-list").textContent()) ?? "";
  check("进入历史对话恢复其内容", textNow.includes("第一个对话"), `片段=${textNow.slice(0, 60)}`);

  // 6) 刷新后对话仍在
  await page.reload({ waitUntil: "load" });
  await login();
  await page.getByRole("button", { name: /对话记录/ }).click();
  await page.waitForTimeout(900);
  const rows3 = await page.locator(".conversation-row").count();
  check("刷新后对话仍保留", rows3 >= 2, `对话数=${rows3}`);

  // 7) 删除一个对话
  await page.locator(".conversation-row").last().locator(".conversation-delete").click();
  await page.waitForTimeout(1200);
  const rows4 = await page.locator(".conversation-row").count();
  check("删除对话后列表减少", rows4 === rows3 - 1, `删除前=${rows3}, 删除后=${rows4}`);

  await page.reload({ waitUntil: "load" });
  await login();
  await page.getByRole("button", { name: /对话记录/ }).click();
  await page.waitForTimeout(900);
  const rows5 = await page.locator(".conversation-row").count();
  check("删除后刷新不会复活", rows5 === rows4, `刷新后=${rows5}`);

  await page.screenshot({ path: new URL("../.e2e/conversations.png", import.meta.url).pathname.slice(1), fullPage: false });
} catch (error) {
  check("会话测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);

