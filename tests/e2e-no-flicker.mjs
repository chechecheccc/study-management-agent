// 验证"做一件事之后整页跳一下"的毛病没了：
// 以前整页入场动画依赖「确认卡 / 入库队列」，队列里一多文件、确认卡一出现，
// 整个页面会重播一次淡入位移（就是用户看到的"跳一下"）。现在整页只在切页面时播。
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

try {
  const RUN = Date.now().toString(36).slice(-5);
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[aria-label="用户名"]').fill(`flicker${RUN}`);
  await page.locator('input[aria-label="显示名称"]').fill("闪烁验收");
  await page.locator('input[aria-label="密码"]').fill("flicker12345");
  await page.getByRole("button", { name: /注册并进入/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 采样当前页面容器的透明度和位移
  const sampler = async (ms, selector = ".view-surface .assistant-layout") => page.evaluate(async ({ selector, ms }) => {
    const samples = [];
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const element = document.querySelector(selector);
      if (element) {
        const style = getComputedStyle(element);
        const transform = style.transform === "none" ? "" : style.transform;
        const match = /matrix\(([^)]+)\)/.exec(transform);
        const translateY = match ? Math.abs(Number(match[1].split(",")[5] ?? 0)) : 0;
        samples.push({ opacity: Number(style.opacity), translateY });
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return samples;
  }, { selector, ms });

  const before = await sampler(400);
  check("切到页面后动画已结束（不透明、无位移）",
    before.every((s) => s.opacity > 0.99 && s.translateY < 0.5),
    `样本=${before.length} 最低不透明度=${Math.min(...before.map((s) => s.opacity)).toFixed(2)}`);

  // 上传一个 PDF：入库队列会多一条（以前这一步会让整页重播动画）
  await page.locator('[data-testid="composer-file-input"]').setInputFiles(PDF);
  const during = await sampler(2200);
  const queueItems = await page.locator(".queue-item").count();
  check("上传后确实出现队列条目", queueItems >= 1, `队列=${queueItems}`);
  check("新条目出现时整页没有再播动画（不跳）",
    during.every((s) => s.opacity > 0.99 && s.translateY < 0.5),
    `样本=${during.length} 最低不透明度=${Math.min(...during.map((s) => s.opacity)).toFixed(2)} 最大位移=${Math.max(...during.map((s) => s.translateY)).toFixed(2)}px`);

  // 切页面时仍然应该有入场动画（别把动画整体删掉）
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  const afterSwitch = await sampler(260, ".view-surface .page-view");
  check("切页面仍然保留入场动画", afterSwitch.length > 0 && afterSwitch.some((s) => s.opacity < 0.99 || s.translateY > 0.5),
    `样本=${afterSwitch.length} 最低不透明度=${Math.min(...afterSwitch.map((s) => s.opacity)).toFixed(2)}`);

  await page.screenshot({ path: new URL("../.e2e/no-flicker.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("不跳验收执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
