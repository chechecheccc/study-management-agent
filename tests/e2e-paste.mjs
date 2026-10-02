// 验证「粘贴截图」路径：用真实 ClipboardEvent（DataTransfer 带图片文件）触发，
// 而不是用 setInputFiles —— 后者走的是文件选择，和用户 Ctrl+V 是两条路径。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 150)));

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await page.locator('input[aria-label="用户名"]').fill("admin");
  await page.locator('input[aria-label="密码"]').fill("admin123");
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 40; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(1000); }

  // 用真实 paste 事件注入图片（DataTransfer.items + files，模拟截图工具）
  const b64 = readFileSync(new URL("./fixtures/chat-notice.png", import.meta.url)).toString("base64");
  await composer.click();
  await page.evaluate(async (base64) => {
    const res = await fetch(`data:image/png;base64,${base64}`);
    const blob = await res.blob();
    const file = new File([blob], "screenshot.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[aria-label="输入学习管理需求"]');
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.waitForTimeout(1500);

  const tiles = await page.locator(".chat-image-tile").count();
  check("Ctrl+V 粘贴截图能附加（DataTransfer.items 路径）", tiles === 1, `缩略图=${tiles}`);

  // 再验证"剪贴板里只有文字"时给出明确提示，而不是静默失败
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "https://example.com/pic.png");
    const input = document.querySelector('input[aria-label="输入学习管理需求"]');
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
  const hint = await page.locator(".composer-hint").textContent().catch(() => "");
  check("粘贴纯文字/链接时给出明确提示", Boolean(hint && hint.includes("没有图片")), `提示=${(hint ?? "").slice(0, 48)}`);

  // 发送并确认模型读到图
  await composer.fill("图里写的截止时间是几号？");
  await composer.press("Enter");
  let reply = "";
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(1000);
    const txt = (await page.locator(".message-bubble").last().textContent().catch(() => "")) ?? "";
    if (txt.trim() && !(await page.locator(".thinking-placeholder").count())) { reply = txt; break; }
  }
  console.log(`\n回复：${reply.slice(0, 150)}\n`);
  check("粘贴的图被模型正确读到（含 10月16日）", /10\s*月\s*16|10-16|10\/16/.test(reply) && !/看不到|读不到|无法查看/.test(reply));

  await page.screenshot({ path: new URL("../.e2e/paste-test.png", import.meta.url).pathname.slice(1), fullPage: true }).catch(() => {});
} catch (error) {
  check("粘贴测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
