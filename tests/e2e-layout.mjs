// 布局回归测试：整页不应出现多余滚动，关键元素应在首屏内
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });

async function login(page) {
  await page.waitForTimeout(2200);
  const u = page.locator('input[aria-label="用户名"]');
  if (await u.isVisible().catch(() => false)) {
    await u.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
    await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
    await page.waitForTimeout(1000);
    const skip = page.locator(".intro-skip");
    if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(2200);
}

// 1) 桌面各分辨率：无整页滚动，快捷入口在首屏内
for (const vp of [{ width: 1920, height: 1080 }, { width: 1440, height: 950 }, { width: 1280, height: 800 }, { width: 1366, height: 768 }]) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await login(page);
  const r = await page.evaluate(() => {
    const actions = document.querySelector(".quick-actions");
    const composer = document.querySelector(".composer");
    return {
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      actionsInView: actions ? actions.getBoundingClientRect().bottom <= innerHeight + 1 : false,
      composerInView: composer ? composer.getBoundingClientRect().bottom <= innerHeight + 1 : false,
      msgScrollable: (() => { const m = document.querySelector(".message-list"); return m ? m.scrollHeight >= m.clientHeight : false; })(),
    };
  });
  check(`${vp.width}x${vp.height} 无整页滚动`, r.pageScroll <= 0, `滚动余量=${r.pageScroll}px`);
  check(`${vp.width}x${vp.height} 输入框与快捷入口在首屏内`, r.actionsInView && r.composerInView);
  await page.close();
}

// 2) 其他页面同样无整页滚动（内容在内部滚动）
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await login(page);
  // 资料库入口已合并到「我的课程」下的"全部资料"
  await page.locator(".course-row", { hasText: "全部资料" }).click();
  await page.waitForTimeout(1200);
  let scroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  check("资料页无整页滚动", scroll <= 0, `滚动余量=${scroll}px`);

  for (const view of ["任务中心", "复习计划", "数据管理", "账号管理"]) {
    await page.locator(".nav-item", { hasText: view }).click();
    await page.waitForTimeout(900);
    scroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    check(`${view} 页无整页滚动`, scroll <= 0, `滚动余量=${scroll}px`);
  }
  await page.close();
}

// 3) 平板/手机宽度：整页不出现"只能滑一点点"的多余滚动，输入框在首屏内
for (const vp of [{ width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await login(page);
  const r = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    const overflowY = getComputedStyle(document.querySelector(".app-shell")).overflow;
    return {
      composerInView: composer ? composer.getBoundingClientRect().bottom <= innerHeight + 1 : false,
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      shellFixed: overflowY === "hidden",
    };
  });
  check(`${vp.width}x${vp.height} 输入框在首屏内`, r.composerInView);
  // 桌面规则（固定高度）下不应有整页滚动；移动规则（自然滚动）下允许滚动但不应只有零星余量
  check(`${vp.width}x${vp.height} 无多余滚动余量`, r.shellFixed ? r.pageScroll <= 0 : r.pageScroll <= 0 || r.pageScroll > 40, `滚动余量=${r.pageScroll}px, 外壳固定=${r.shellFixed}`);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);


