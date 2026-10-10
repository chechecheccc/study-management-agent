// 验证「机器学习」预设课程与预设课件：
//   1) 新注册的账号进来就有这门课和两份课件；
//   2) 课件原件是所有账号共用的服务端文件，能直接预览/打开；
//   3) 已经自己传过同一份课件的账号（admin）不会被塞重复；
//   4) 删掉预设课件后，重新登录不会又被补回来。
import { createRequire } from "node:module";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const login = async (page, username, password, register) => {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const user = page.locator('input[aria-label="用户名"]');
  if (await user.isVisible().catch(() => false)) {
    if (register) {
      await page.getByRole("tab", { name: "注册" }).click();
      await user.fill(username);
      await page.locator('input[aria-label="显示名称"]').fill("预设测试");
      await page.locator('input[aria-label="密码"]').fill(password);
      await page.getByRole("button", { name: /注册并进入/ }).click();
    } else {
      await user.fill(username);
      await page.locator('input[aria-label="密码"]').fill(password);
      await page.getByRole("button", { name: /^登录$/ }).click();
    }
  }
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(3500);
};

const courseNames = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".course-row.course-draggable")].map((row) => (row.querySelector(".course-name")?.textContent ?? "").trim()));

// 兜底：任何一步卡死都不至于让整个用例无限等下去
const watchdog = setTimeout(() => {
  console.log("FAIL  测试整体超时（10 分钟），强制结束");
  process.exit(1);
}, 10 * 60 * 1000);
watchdog.unref?.();

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const RUN = Date.now().toString(36).slice(-5);

try {
  // ---------- 新账号：开箱就有预设 ----------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  const username = `preset${RUN}`;
  await login(page, username, "preset123456", true);

  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 60; i += 1) {
    if (await composer.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(1000);
  }
  check("预设数据不影响对话输入", await composer.isEnabled().catch(() => false));

  const names = await courseNames(page);
  check("新账号自带「机器学习」课程", names.includes("机器学习"), names.join(" > "));

  await page.locator(".course-row", { hasText: "机器学习" }).click();
  await page.waitForTimeout(2500);
  const meta = (await page.locator(".list-meta").textContent()) ?? "";
  check("预设课程下有 2 份课件", /2\s*份资料/.test(meta), meta.replace(/\s+/g, " ").slice(0, 40));

  const listText = ((await page.locator(".resource-list").textContent()) ?? "").replace(/\s+/g, " ");
  check("课题目录里有第1章与第2章", /引言/.test(listText) && /连续最优化/.test(listText), listText.slice(0, 90));

  // 预设课件指向共用的服务端文件，且能预览
  const previewSrc = await page.locator("iframe.pdf-preview").getAttribute("src").catch(() => null);
  check("预设课件用共享文件渲染预览", Boolean(previewSrc && previewSrc.includes("/api/files/file-preset-ml-")), String(previewSrc).slice(0, 70));

  const openLink = page.getByRole("link", { name: "打开原文件" });
  check("预设课件有「打开原文件」入口", await openLink.isVisible().catch(() => false));
  const href = await openLink.getAttribute("href").catch(() => null);
  check("原文件链接指向共享文件", Boolean(href && href.includes("/api/files/file-preset-ml-")), String(href).slice(0, 70));

  if (href) {
    const cookies = await ctx.cookies();
    const cookieHeader = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const response = await fetch(`http://localhost:3000${href}`, { headers: { cookie: cookieHeader } });
    const body = Buffer.from(await response.arrayBuffer());
    check("共享文件真的能下载到 PDF", response.ok && body.length > 100000 && body.slice(0, 4).toString() === "%PDF", `status=${response.status} bytes=${body.length}`);
  } else {
    check("共享文件真的能下载到 PDF", false, "没有拿到链接");
  }

  // 删除预设课件后不再自动补回来

  // 删除预设课件后不再自动补回来
  await page.getByRole("button", { name: "删除资料" }).click();
  await page.waitForTimeout(600);
  const confirmDelete = page.getByRole("button", { name: "确认删除" });
  if (await confirmDelete.isVisible().catch(() => false)) {
    await confirmDelete.click();
    await page.waitForTimeout(2000);
  }
  const afterDelete = (await page.locator(".list-meta").textContent()) ?? "";
  check("删除预设课件后该课程剩 1 份", /1\s*份资料/.test(afterDelete), afterDelete.replace(/\s+/g, " ").slice(0, 40));

  await page.reload({ waitUntil: "load" });
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(4500);
  await page.locator(".course-row", { hasText: "机器学习" }).click();
  await page.waitForTimeout(2500);
  const afterReload = (await page.locator(".list-meta").textContent()) ?? "";
  check("重新登录后已删除的预设没有被补回", /1\s*份资料/.test(afterReload), afterReload.replace(/\s+/g, " ").slice(0, 40));
  await ctx.close();

  // ---------- 老账号：自己传过同一份课件，不应该出现重复 ----------
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(45000);
  await login(page2, "admin", "admin123", false);
  await page2.locator(".course-row", { hasText: "机器学习" }).click();
  await page2.waitForTimeout(3000);
  const adminMeta = ((await page2.locator(".list-meta").textContent()) ?? "").replace(/\s+/g, " ");
  const adminText = ((await page2.locator(".resource-list").textContent()) ?? "").replace(/\s+/g, " ");
  // 文件名里带空格，比较前统一去掉空白
  const flat = adminText.replace(/\s+/g, "");
  const ch1 = flat.split("第1章-引言.pdf").length - 1;
  const ch2 = flat.split("第2章连续最优化建模与应用.pdf.pdf").length - 1;
  check("已上传过同一份课件的账号没有重复", /2\s*份资料/.test(adminMeta) && ch1 === 1 && ch2 === 1,
    `课程内=${adminMeta.slice(0, 22)}；第1章文件出现 ${ch1} 次、第2章文件出现 ${ch2} 次`);
  await ctx2.close();
} catch (error) {
  check("预设课件测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}

clearTimeout(watchdog);
// 收尾：清掉本次测试注册的账号，不让账号列表越测越长
await cleanupTestAccounts();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
