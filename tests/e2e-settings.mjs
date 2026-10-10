// 验证「设置」页：数据管理并入设置、各分区齐全、动画开关真的生效
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const login = async (page) => {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const user = page.locator('input[aria-label="用户名"]');
  if (await user.isVisible().catch(() => false)) {
    await user.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
  }
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1500);
};

const skipIntro = async (page) => {
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(3500);
};

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

try {
  await login(page);
  await skipIntro(page);

  // 1) 导航：有「设置」，没有「数据管理」
  const navText = (await page.locator(".main-nav").textContent()) ?? "";
  check("侧栏有「设置」入口", navText.includes("设置"), navText.replace(/\s+/g, " ").slice(0, 60));
  check("侧栏不再有「数据管理」", !navText.includes("数据管理"));
  check("顶部齿轮也进设置", await page.locator('button[aria-label="设置"]').count() >= 1);

  await page.locator(".nav-item", { hasText: "设置" }).click();
  await page.waitForTimeout(1500);

  // 2) 设置页分区齐全
  const body = (await page.locator(".page-view").textContent()) ?? "";
  check("设置页标题正确", body.includes("设置") && body.includes("外观"), "");
  check("有外观与动画分区", body.includes("界面动画"));
  check("有提醒与日历分区", body.includes("桌面提醒") && body.includes("导出日历"));
  check("有数据与同步分区（原数据管理内容）", body.includes("云同步") && body.includes("本地备份") && body.includes("恢复示例数据"));
  check("有学习画像分区", body.includes("学习画像") && body.includes("保存画像"));
  check("有账号分区", body.includes("账号") && body.includes("登出"));
  check("统计含对话数", body.includes("个对话"));
  const cards = await page.locator(".settings-card").count();
  check("设置分组卡片 >= 5", cards >= 5, `卡片=${cards}`);

  // 3) 备份导出仍然可用
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.getByRole("button", { name: "下载备份" }).click(),
  ]);
  const data = JSON.parse(readFileSync(await download.path(), "utf8"));
  check("备份含课程/资料/任务/对话/画像",
    Array.isArray(data.courses) && Array.isArray(data.resources) && Array.isArray(data.tasks)
      && Array.isArray(data.conversations) && Boolean(data.profile), "");

  // 4) 恢复示例数据需要二次确认
  await page.getByRole("button", { name: /恢复…/ }).click();
  await page.waitForTimeout(600);
  check("恢复示例数据需要二次确认", await page.getByRole("button", { name: "确认恢复" }).isVisible().catch(() => false));
  await page.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(400);

  // 5) 动画开关：关掉后刷新不再出现片头
  const toggle = page.locator('button[role="switch"][aria-label="界面动画"]');
  check("有动画开关", await toggle.isVisible().catch(() => false));
  check("默认是开着的", (await toggle.getAttribute("aria-checked")) === "true", await toggle.getAttribute("aria-checked"));
  await toggle.click();
  await page.waitForTimeout(600);
  check("关掉后状态变 false", (await toggle.getAttribute("aria-checked")) === "false", await toggle.getAttribute("aria-checked"));

  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(4500);
  const introVisible = await page.locator(".study-intro").isVisible().catch(() => false);
  check("关掉动画后刷新不再有片头", !introVisible, `片头可见=${introVisible}`);
  const pageOpacity = await page.evaluate(() => {
    const el = document.querySelector(".view-surface .page-view, .view-surface .assistant-layout");
    return el ? Number(getComputedStyle(el).opacity) : 1;
  });
  check("关掉后页面也没有淡入", pageOpacity > 0.99, `opacity=${pageOpacity}`);

  // 6) 再打开，片头回来
  await page.locator(".nav-item", { hasText: "设置" }).click();
  await page.waitForTimeout(1500);
  await page.locator('button[role="switch"][aria-label="界面动画"]').click();
  await page.waitForTimeout(500);
  check("重新打开后状态变 true", (await page.locator('button[role="switch"][aria-label="界面动画"]').getAttribute("aria-checked")) === "true");
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2500);
  check("开启动画后片头回来", await page.locator(".study-intro").isVisible().catch(() => false));

  await page.screenshot({ path: new URL("../.e2e/settings.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("设置页测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
