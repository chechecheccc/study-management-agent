// 多模态对话测试：把图片发给智能体，验证它真能读出图中内容
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const IMAGE = new URL("./fixtures/chat-notice.png", import.meta.url).pathname.slice(1);
const SHOT = new URL("../.e2e/", import.meta.url).pathname.slice(1);

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 150)));

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  // 登录
  await page.locator('input[aria-label="用户名"]').fill("admin");
  await page.locator('input[aria-label="密码"]').fill("admin123");
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 等 Agent 空闲
  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 40; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(1000); }

  // 1) 选择图片
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(IMAGE);
  await page.waitForTimeout(1200);
  const tileCount = await page.locator(".chat-image-tile").count();
  check("聊天输入框可附加图片", tileCount === 1, `缩略图数量=${tileCount}`);

  // 2) 发送问题
  await composer.fill("这张图里写了什么？截止时间是什么时候？");
  await composer.press("Enter");
  check("发送后待发图片已清空", (await page.locator(".chat-image-tile").count()) === 0);

  // 3) 等回复
  let reply = "";
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(1000);
    const last = page.locator(".message-bubble").last();
    const txt = (await last.textContent().catch(() => "")) ?? "";
    const thinking = await page.locator(".thinking-placeholder").count();
    if (txt.trim() && !thinking) { reply = txt; break; }
  }
  console.log(`\n模型回复：${reply.slice(0, 260)}\n`);

  // 4) 校验模型确实看到了图
  check("回复不是「看不到图片」的推脱", !/看不到|无法查看|读不到|没有收到图片/.test(reply));
  check("识别出图中课程（机器学习）", /机器学习/.test(reply));
  check("识别出截止时间（10月16日 / 15:00）", /10\s*月\s*16|2026-10-16|16日/.test(reply) && /15:00|15 点|下午 ?3/.test(reply));
  check("识别出实验内容（逻辑回归 / iris）", /逻辑回归|iris|梯度下降/i.test(reply));

  // 5) 附图在气泡中可见
  const shownImages = await page.locator(".message-images img").count();
  check("用户气泡中显示附图", shownImages >= 1, `图片数=${shownImages}`);

  await page.screenshot({ path: `${SHOT}multimodal.png`, fullPage: true }).catch(() => {});
} catch (error) {
  check("多模态测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);

