// 验证新建课程 + 改资料所属课程（把两份教材从"数据库系统"改挂到新课程）
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
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

  // 1) 侧栏新建课程
  check("侧栏有「新建课程」入口", await page.locator(".course-row", { hasText: "新建课程" }).isVisible().catch(() => false));
  await page.locator(".course-row", { hasText: "新建课程" }).click();
  await page.locator('input[aria-label="新课程名称"]').fill("计算机科学中的建模技术");
  await page.getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(2000);
  const coursesText = (await page.locator(".sidebar-section").textContent()) ?? "";
  check("新课程已出现在侧栏", coursesText.includes("计算机科学中的建模技术"), coursesText.replace(/\s+/g, " ").slice(0, 80));

  // 2) 把两份教材改挂到新课程
  await page.locator(".course-row", { hasText: "全部资料" }).click();
  await page.waitForTimeout(1500);
  for (const keyword of ["引言", "连续最优化"]) {
    await page.locator(".resource-item", { hasText: keyword }).first().click();
    await page.waitForTimeout(2500);
    const select = page.locator('select[aria-label="修改所属课程"]');
    check(`预览区有课程下拉（${keyword}）`, await select.isVisible().catch(() => false));
    if (await select.isVisible().catch(() => false)) {
      await select.selectOption({ label: "计算机科学中的建模技术" });
      await page.waitForTimeout(2000);
    }
  }

  // 3) 侧栏计数应变化：新课程 2 份，数据库系统从 5 降到 3
  await page.waitForTimeout(2000);
  const rows = await page.locator(".course-row").allTextContents();
  const newCourseRow = rows.find((t) => t.includes("计算机科学中的建模技术")) ?? "";
  const dbRow = rows.find((t) => t.includes("数据库系统")) ?? "";
  check("新课程计数为 2", /2/.test(newCourseRow), `行内容=${newCourseRow.replace(/\s+/g, " ")}`);
  check("数据库系统计数已减少", /3/.test(dbRow), `行内容=${dbRow.replace(/\s+/g, " ")}`);

  // 4) 点新课程应只显示这 2 份教材
  await page.locator(".course-row", { hasText: "计算机科学中的建模技术" }).click();
  await page.waitForTimeout(1800);
  const meta = (await page.locator(".list-meta").textContent()) ?? "";
  check("按新课程筛选出 2 份资料", /2\s*份资料/.test(meta), meta.replace(/\s+/g, " ").slice(0, 40));

  await page.screenshot({ path: new URL("../.e2e/course-new.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("新建课程测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
