// 验证资料库：上传文件 → 预览 → 打开/下载入口 → 删除
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PDF = decodeURIComponent(new URL("./fixtures/数据库第四章讲义.pdf", import.meta.url).pathname.slice(1));

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
page.setDefaultTimeout(40000);
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 120)));

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const RUN = Date.now().toString(36).slice(-5);
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[aria-label="用户名"]').fill(`lib${RUN}`);
  await page.locator('input[aria-label="显示名称"]').fill("资料测试");
  await page.locator('input[aria-label="密码"]').fill("lib123456");
  await page.getByRole("button", { name: /注册并进入/ }).click();
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // 1) 等浅浅空闲（主动性巡检可能还在跑），再上传 PDF
  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 60; i += 1) {
    if (await composer.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(1000);
  }
  await page.locator('[data-testid="composer-file-input"]').setInputFiles(PDF);
  await page.waitForTimeout(3000);
  const queueCount = await page.locator(".queue-item").count();
  check("上传 PDF 进入入库队列", queueCount >= 1, `队列=${queueCount}`);

  // 2) 等确认卡片出现（识别完成）
  await page.waitForFunction(() => {
    const el = document.querySelector(".queue-item");
    return el && /status-awaiting_confirmation/.test(el.className);
  }, null, { timeout: 90000 }).catch(() => {});
  const awaiting = await page.locator(".queue-item.status-awaiting_confirmation").count();
  const queueText = ((await page.locator(".import-queue").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 160);
  check("识别完成等待确认", awaiting >= 1, `待确认项=${awaiting}｜队列状态：${queueText}`);

  // 3) 确认入库
  const confirmBtn = page.locator(".queue-item.status-awaiting_confirmation").first().getByRole("button", { name: /确认入库/ });
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    await page.waitForTimeout(2500);
  }
  const saved = await page.locator(".queue-item.status-saved").count();
  check("资料已入库", saved >= 1, `已入库=${saved}`);

  // 4) 到资料库查看预览与操作入口
  await page.locator(".nav-item", { hasText: "资料库" }).click();
  await page.waitForTimeout(1800);
  const previewText = (await page.locator(".preview-panel").textContent()) ?? "";
  check("预览区显示文件名与大小", /数据库第四章讲义\.pdf/.test(previewText), `片段：${previewText.replace(/\s+/g, " ").slice(0, 80)}`);
  check("出现「打开原文件」入口", await page.getByRole("link", { name: "打开原文件" }).isVisible().catch(() => false));
  check("出现「下载」入口", await page.getByRole("link", { name: "下载" }).isVisible().catch(() => false));
  check("出现「删除资料」入口", await page.getByRole("button", { name: "删除资料" }).isVisible().catch(() => false));
  check("PDF 内嵌预览已渲染", await page.locator("iframe.pdf-preview").isVisible().catch(() => false));

  await page.screenshot({ path: new URL("../.e2e/lib-with-file.png", import.meta.url).pathname.slice(1) });

  // 5) 打开原文件（新标签页）
  const [newPage] = await Promise.all([
    ctx.waitForEvent("page", { timeout: 15000 }).catch(() => null),
    page.getByRole("link", { name: "打开原文件" }).click().catch(() => {}),
  ]);
  check("点击「打开原文件」能新开标签页", Boolean(newPage), newPage ? `URL 前缀=${(newPage.url() || "").slice(0, 30)}` : "未打开");
  if (newPage) await newPage.close();

  // 6) 删除资料
  await page.getByRole("button", { name: "删除资料" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "确认删除" }).click();
  await page.waitForTimeout(2500);
  const after = (await page.locator(".resource-list").textContent()) ?? "";
  check("删除后列表不再包含该资料", !after.includes("数据库第四章"), `片段：${after.replace(/\s+/g, " ").slice(0, 60)}`);
} catch (error) {
  check("资料库测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);






