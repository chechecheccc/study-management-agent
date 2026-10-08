// 验证数据管理页：备份内容、文案、二次确认
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const u = page.locator('input[aria-label="用户名"]');
  if (await u.isVisible().catch(() => false)) {
    await u.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
  }
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1500);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  await page.locator(".nav-item", { hasText: "数据管理" }).click();
  await page.waitForTimeout(2000);

  const body = (await page.locator(".page-view").textContent()) ?? "";
  check("「当前能力」卡片已移除", !body.includes("Agent 循环：多步推理"), "");
  check("云同步文案已更新（不再说文件只在本机）", !body.includes("原始文件目前仍只保存在本机"), "");
  check("备份范围说明清楚", body.includes("备份文件包含") && body.includes("不在备份里"), "");
  check("出现本机存储卡片", body.includes("本机存储与重置"), "");
  check("统计含对话数", body.includes("个对话"), "");

  // 导出备份并检查内容
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.getByRole("button", { name: "下载本地备份" }).click(),
  ]);
  const path = await download.path();
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw);
  check("备份含课程/资料/任务", Array.isArray(data.courses) && Array.isArray(data.resources) && Array.isArray(data.tasks), "");
  check("备份含对话记录", Array.isArray(data.conversations) && data.conversations.length > 0, `对话数=${data.conversations?.length ?? 0}`);
  check("备份含画像", Boolean(data.profile), "");
  check("备份带版本与导出时间", data.version === 2 && Boolean(data.exportedAt), `version=${data.version}`);

  // 恢复示例数据需二次确认
  await page.getByRole("button", { name: /恢复示例数据/ }).click();
  await page.waitForTimeout(600);
  check("恢复示例数据需要二次确认", await page.getByRole("button", { name: /确认恢复示例数据/ }).isVisible().catch(() => false));
  await page.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(400);

  await page.screenshot({ path: new URL("../.e2e/data-view.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("数据管理测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);

