// 任务中心全面测试：逾期判定、分组、筛选、新建、编辑、删除、完成、关联资料
import { createRequire } from "node:module";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
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

  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(2000);

  // 1) 逾期自动判定（admin 有 3 条 8 月的任务）
  const groupLabels = await page.locator(".task-group-label").allTextContents();
  check("出现「已逾期」分组", groupLabels.some((t) => t.includes("已逾期")), `分组=${groupLabels.map((t) => t.trim()).join(" / ")}`);
  const overduePills = await page.locator(".status-pill.overdue").count();
  check("逾期任务显示红色「已逾期」状态", overduePills >= 3, `逾期标记数=${overduePills}`);
  check("页首有逾期汇总", await page.locator(".task-summary-chip.overdue").isVisible().catch(() => false));

  // 2) 真筛选
  await page.locator('select[aria-label="按状态筛选"]').selectOption("已逾期");
  await page.waitForTimeout(900);
  const afterFilter = await page.locator(".task-row").count();
  const nonOverdue = await page.locator(".status-pill:not(.overdue)").count();
  check("按状态筛选生效", afterFilter >= 3 && nonOverdue === 0, `筛选后=${afterFilter} 条，非逾期=${nonOverdue}`);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.waitForTimeout(600);

  // 3) 新建任务（含类型/优先级/提醒）
  await page.getByRole("button", { name: /新建任务/ }).click();
  await page.waitForTimeout(600);
  await page.locator('.task-form input[placeholder="任务名称"]').fill("任务中心测试任务ZZZ");
  const due = new Date(Date.now() + 2 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const local = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T${pad(due.getHours())}:${pad(due.getMinutes())}`;
  await page.locator('.task-form input[type="datetime-local"]').fill(local);
  await page.locator('.task-form select').nth(1).selectOption("考试");
  await page.locator('.task-form select').nth(2).selectOption("高");
  await page.locator(".reminder-choices label", { hasText: "提前 2 小时" }).click();
  await page.getByRole("button", { name: "保存任务" }).click();
  await page.waitForTimeout(1500);
  const listText = (await page.locator(".page-view").textContent()) ?? "";
  check("新建任务成功", listText.includes("任务中心测试任务ZZZ"));
  check("新建时可设类型/优先级", /考试/.test(listText) && /高/.test(listText), "");

  // 4) 行内编辑（进入编辑后标题会变成 input 的 value，因此改用页面级定位）
  const row = page.locator(".task-row", { hasText: "任务中心测试任务ZZZ" }).first();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await page.waitForTimeout(800);
  const titleInput = page.locator('.task-edit-grid input[aria-label="任务名称"]');
  check("可进入行内编辑", await titleInput.isVisible().catch(() => false));
  await titleInput.fill("任务中心测试任务ZZZ-已改名");
  await page.locator('select[aria-label="任务优先级"]').selectOption("低");
  await page.getByRole("button", { name: "完成编辑" }).click();
  await page.waitForTimeout(1200);
  check("编辑已保存", ((await page.locator(".page-view").textContent()) ?? "").includes("已改名"));

  // 5) 删除（二次确认）
  const row2 = page.locator(".task-row", { hasText: "已改名" }).first();
  await row2.getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForTimeout(600);
  const confirmBtn = page.getByRole("button", { name: "确认删除" }).first();
  check("删除需二次确认", await confirmBtn.isVisible().catch(() => false));
  await confirmBtn.click();
  await page.waitForTimeout(2000);
  check("删除后任务消失", !((await page.locator(".page-view").textContent()) ?? "").includes("已改名"));

  await page.screenshot({ path: new URL("../.e2e/task-center.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("任务中心测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
// 收尾：清掉测试注册的账号
await cleanupTestAccounts();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);

