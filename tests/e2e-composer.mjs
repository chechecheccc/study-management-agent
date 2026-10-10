// 验证合并后的单一文件入口：图片进对话、文档进资料库、不支持格式给提示
import { createRequire } from "node:module";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PNG = new URL("./fixtures/chat-notice.png", import.meta.url).pathname.slice(1);

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.setDefaultTimeout(25000);
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 160)));

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

  // 只剩一个 file input
  const inputCount = await page.locator('input[type="file"]').count();
  check("聊天区只剩一个文件入口", inputCount === 1, `file input 数量=${inputCount}`);
  const buttonCount = await page.locator(".composer .attach-button").count();
  check("只剩一个附件按钮", buttonCount === 1, `按钮数量=${buttonCount}`);

  const picker = page.locator('[data-testid="composer-file-input"]');

  // 1) 选图片 → 进入对话（缩略图）
  await picker.setInputFiles(PNG);
  await page.waitForTimeout(1500);
  const tiles = await page.locator(".chat-image-tile").count();
  check("选择图片后附加到对话", tiles === 1, `缩略图=${tiles}`);
  const hint1 = await page.locator(".composer-hint.info").textContent().catch(() => "");
  check("图片附加有明确提示", Boolean(hint1 && hint1.includes("附加")), `提示=${(hint1 ?? "").slice(0, 30)}`);

  // 2) 选不支持的格式 → 报错提示，且不误入队列
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="composer-file-input"]');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "笔记.txt", { type: "text/plain" }));
    el.files = dt.files;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(900);
  const hint2 = await page.locator(".composer-hint.error").textContent().catch(() => "");
  check("不支持的格式给出错误提示", Boolean(hint2 && hint2.includes("不支持")), `提示=${(hint2 ?? "").slice(0, 40)}`);

  // 3) 选 PDF → 进入资料库入库队列（不是对话）
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="composer-file-input"]');
    const dt = new DataTransfer();
    const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
    dt.items.add(new File([pdf], "示例讲义.pdf", { type: "application/pdf" }));
    el.files = dt.files;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(3000);
  const queueItems = await page.locator(".queue-item").count();
  check("选择 PDF 后进入资料库入库队列", queueItems >= 1, `队列项=${queueItems}`);

  await page.screenshot({ path: new URL("../.e2e/composer-merged.png", import.meta.url).pathname.slice(1), fullPage: true }).catch(() => {});
} catch (error) {
  check("合并入口测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

// 收尾：清掉测试注册的账号
await cleanupTestAccounts();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
