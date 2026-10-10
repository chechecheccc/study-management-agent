// 验证：发送消息后消息列表应停在最新内容（底部），而不是顶部
import { createRequire } from "node:module";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(30000);

const readScroll = () => page.evaluate(() => {
  const el = document.querySelector(".message-list");
  if (!el) return null;
  return { scrollTop: Math.round(el.scrollTop), scrollH: el.scrollHeight, clientH: el.clientHeight, fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
});

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(2400);
  const u = page.locator('input[aria-label="用户名"]');
  if (await u.isVisible().catch(() => false)) {
    await u.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
    await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
    await page.waitForTimeout(1200);
    const skip = page.locator(".intro-skip");
    if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(2200);

  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 40; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(1000); }

  for (const q of ["你好", "我有哪些课程？", "再帮我看看任务"]) {
    await composer.fill(q);
    await composer.press("Enter");
    await page.waitForTimeout(4500);
  }
  const s = await readScroll();
  check("多条消息后自动停在底部", s && s.fromBottom <= 5, `距底部=${s?.fromBottom}px, 内容高=${s?.scrollH}, 可视高=${s?.clientH}`);

  await composer.fill("再记一条：数据库系统 后天下午 5 点交作业");
  await composer.press("Enter");
  await page.waitForTimeout(1200);
  const rightAfterSend = await readScroll();
  check("发送瞬间即滚动到最新消息", rightAfterSend && rightAfterSend.fromBottom <= 5, `距底部=${rightAfterSend?.fromBottom}px`);

  await page.waitForTimeout(8000);
  const afterReply = await readScroll();
  check("智能体回复后仍停在最新内容", afterReply && afterReply.fromBottom <= 5, `距底部=${afterReply?.fromBottom}px`);

  await page.evaluate(() => { const el = document.querySelector(".message-list"); el.scrollTop = 0; });
  await page.waitForTimeout(300);
  const manual = await page.evaluate(() => { const el = document.querySelector(".message-list"); return { scrollTop: Math.round(el.scrollTop) }; });
  check("手动上翻后不被强制拉回", manual.scrollTop <= 5, `scrollTop=${manual.scrollTop}`);

  await page.screenshot({ path: new URL("../.e2e/scroll-bottom.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("滚动测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
// 收尾：清掉测试注册的账号
await cleanupTestAccounts();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
