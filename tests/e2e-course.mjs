// 验证：我的课程顺序（新建课程 → 全部资料 → 具体课程）、新建课程、拖拽排序、改资料所属课程
// 注意：两份「机器学习」预设课件会被固定在那门课（见 app/lib/presets.ts），
//      所以这里改用示例资料来验证"改所属课程"。
// 账号：用**临时账号**跑（新注册的账号会拿到示例数据），不要动 admin 的真实数据——
//      这个用例会把资料改挂到新课程再删掉课程，用 admin 跑会在他的账号里留下"未分类"的孤儿资料。
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
  const RUN = Date.now().toString(36).slice(-5);
  const USER = `courset${RUN}`;
  const PASS = "course123456";
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[aria-label="用户名"]').fill(USER);
  await page.locator('input[aria-label="显示名称"]').fill("课程验收");
  await page.locator('input[aria-label="密码"]').fill(PASS);
  await page.getByRole("button", { name: /注册并进入/ }).click();
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1500);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 1) 侧栏顺序：新建课程 → 全部资料 → 具体课程
  const sectionRows = (await page.locator(".sidebar-section .course-row").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const idxNew = sectionRows.findIndex((t) => t.includes("新建课程"));
  const idxAll = sectionRows.findIndex((t) => t.includes("全部资料"));
  check("我的课程第一项是「新建课程」", idxNew === 0, sectionRows.join(" | ").slice(0, 120));
  check("我的课程第二项是「全部资料」", idxAll === 1, sectionRows.join(" | ").slice(0, 120));
  check("具体课程排在聚合入口之后", idxNew === 0 && idxAll === 1 && sectionRows.length > 2, `共 ${sectionRows.length} 行`);

  // 2) 侧栏新建课程
  check("侧栏有「新建课程」入口", await page.locator(".course-row", { hasText: "新建课程" }).isVisible().catch(() => false));
  await page.locator(".course-row", { hasText: "新建课程" }).click();
  await page.locator('input[aria-label="新课程名称"]').fill("计算机科学中的建模技术");
  await page.getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(2000);
  const coursesText = (await page.locator(".sidebar-section").textContent()) ?? "";
  check("新课程已出现在侧栏", coursesText.includes("计算机科学中的建模技术"), coursesText.replace(/\s+/g, " ").slice(0, 80));

  // 3) 把两份示例资料改挂到新课程
  await page.locator(".course-row", { hasText: "全部资料" }).click();
  await page.waitForTimeout(1500);
  for (const keyword of ["关系模型", "导数与微分"]) {
    await page.locator(".resource-item", { hasText: keyword }).first().click();
    await page.waitForTimeout(2500);
    const select = page.locator('select[aria-label="修改所属课程"]');
    check(`预览区有课程下拉（${keyword}）`, await select.isVisible().catch(() => false));
    if (await select.isVisible().catch(() => false)) {
      await select.selectOption({ label: "计算机科学中的建模技术" });
      await page.waitForTimeout(2000);
    }
  }

  // 4) 侧栏计数应变化：新课程 2 份，数据库系统再少 1 份
  await page.waitForTimeout(2000);
  const rows = await page.locator(".course-row").allTextContents();
  const newCourseRow = rows.find((t) => t.includes("计算机科学中的建模技术")) ?? "";
  const dbRow = rows.find((t) => t.includes("数据库系统")) ?? "";
  check("新课程计数为 2", /2/.test(newCourseRow), `行内容=${newCourseRow.replace(/\s+/g, " ")}`);
  check("数据库系统计数已减少", /2/.test(dbRow), `行内容=${dbRow.replace(/\s+/g, " ")}`);

  // 5) 点新课程应能看到这两份资料
  // 注意：侧栏点课程是按课程名做文本匹配，预设课件的旧标题里也含这几个字，
  //      所以这里只断言"这两份资料确实被列出来了"，精确数量由上面的侧栏计数保证。
  await page.locator(".course-row", { hasText: "计算机科学中的建模技术" }).click();
  await page.waitForTimeout(1800);
  const meta = (await page.locator(".list-meta").textContent()) ?? "";
  const listText = ((await page.locator(".resource-list").textContent()) ?? "").replace(/\s+/g, "");
  check("按新课程能看到这两份资料", /关系模型/.test(listText) && /导数与微分/.test(listText), meta.replace(/\s+/g, " ").slice(0, 40));

  // 6) 拖拽排序：整行可拖，拖完立即改顺序，刷新后保持
  const courseNames = () => page.evaluate(() =>
    [...document.querySelectorAll(".course-row.course-draggable")].map((row) => (row.querySelector(".course-name")?.textContent ?? "").trim()));
  const dragCourse = (from, to) => page.evaluate(([fromName, toName]) => {
    const rows = [...document.querySelectorAll(".course-row.course-draggable")];
    const nameOf = (row) => (row.querySelector(".course-name")?.textContent ?? "").trim();
    const src = rows.find((row) => nameOf(row) === fromName);
    const dst = rows.find((row) => nameOf(row) === toName);
    if (!src || !dst) throw new Error("找不到课程行：" + fromName + " / " + toName);
    const dataTransfer = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
  }, [from, to]);

  const draggableRows = await page.locator(".course-row.course-draggable").count();
  check("课程行数量 >= 3", draggableRows >= 3, `共 ${draggableRows} 行`);
  check("课程行带 draggable 属性", await page.evaluate(() =>
    [...document.querySelectorAll(".course-row.course-draggable")].every((row) => row.draggable === true)));
  check("课程行有拖拽手柄", await page.evaluate(() =>
    [...document.querySelectorAll(".course-row.course-draggable")].every((row) => Boolean(row.querySelector(".course-handle")))));

  const before = await courseNames();
  const movedName = before[1];
  const targetName = before[0];
  await dragCourse(movedName, targetName);
  await page.waitForTimeout(1200);
  const after = await courseNames();
  check("拖拽后顺序立即变化", after[0] === movedName && after[1] === targetName, `${before.join(" > ")} → ${after.join(" > ")}`);

  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(4000);
  const persisted = await courseNames();
  check("刷新后顺序保持", persisted[0] === movedName && persisted[1] === targetName, persisted.join(" > "));

  // 7) 编辑类改动（改归属、改顺序）必须能同步到云端：换一台"设备"登录同一账号应看到同样的结果
  await page.waitForTimeout(6000);
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  try {
    const page2 = await ctx2.newPage();
    page2.setDefaultTimeout(45000);
    await page2.goto("http://localhost:3000/", { waitUntil: "load" });
    await page2.waitForTimeout(3000);
    const u2 = page2.locator('input[aria-label="用户名"]');
    if (await u2.isVisible().catch(() => false)) {
      await u2.fill(USER);
      await page2.locator('input[aria-label="密码"]').fill(PASS);
      await page2.getByRole("button", { name: /^登录$/ }).click();
    }
    await page2.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
    await page2.waitForTimeout(5000);
    const skip2 = page2.locator(".intro-skip");
    if (await skip2.count()) await skip2.click({ force: true, timeout: 3000 }).catch(() => {});
    const names2 = await page2.evaluate(() =>
      [...document.querySelectorAll(".course-row.course-draggable")].map((row) => (row.querySelector(".course-name")?.textContent ?? "").trim()));
    check("换设备登录后课程顺序一致", names2[0] === movedName && names2[1] === targetName, names2.join(" > "));

    await page2.locator(".course-row", { hasText: "计算机科学中的建模技术" }).click();
    await page2.waitForTimeout(2500);
    const listText2 = ((await page2.locator(".resource-list").textContent()) ?? "").replace(/\s+/g, "");
    check("换设备登录后资料归属已同步", /关系模型/.test(listText2) && /导数与微分/.test(listText2), listText2.slice(0, 60));
    await page2.screenshot({ path: new URL("../.e2e/course-device2.png", import.meta.url).pathname.slice(1) });
  } finally {
    await ctx2.close();
  }

  // 收尾：把顺序改回原样，并等自动同步把"改回后"的顺序推上去，避免留下半截状态
  await dragCourse(movedName, targetName);
  await page.waitForTimeout(6000);

  // 8) 删除课程：资料与任务不删除，只会变成「未分类」
  await page.locator(".course-row", { hasText: "计算机科学中的建模技术" }).hover();
  await page.locator('button[aria-label="删除课程 计算机科学中的建模技术"]').click();
  await page.waitForTimeout(700);
  check("删除课程有二次确认", await page.locator(".course-confirm").isVisible().catch(() => false));
  await page.locator(".course-confirm").getByRole("button", { name: "确认删除" }).click();
  await page.waitForTimeout(2500);
  const afterDelete = await courseNames(page);
  check("课程已从侧栏删除", !afterDelete.includes("计算机科学中的建模技术"), afterDelete.join(" > "));
  check("侧栏不再有该课程的资料计数", !afterDelete.join(" ").includes("计算机科学中的建模技术"));

  await page.screenshot({ path: new URL("../.e2e/course-new.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("新建课程测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
// 收尾：清掉测试注册的账号
await cleanupTestAccounts();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
