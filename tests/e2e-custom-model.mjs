// 验证「设置 → 模型」：可以填自己的 OpenAI 兼容模型，填完后请求真的换成用户那套，
// 恢复默认后又能回到内置模型；配置只存在本机浏览器里。
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

const composer = page.locator('input[aria-label="输入学习管理需求"]');
const waitIdle = async (timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await composer.isEnabled().catch(() => false)) return true;
    await page.waitForTimeout(700);
  }
  return false;
};
const lastReply = async () => {
  await page.waitForTimeout(500);
  const bubbles = await page.locator(".message-bubble").allTextContents();
  return (bubbles[bubbles.length - 1] ?? "").replace(/\s+/g, " ");
};
const ask = async (text, timeoutMs = 90000) => {
  await waitIdle();
  await composer.fill(text);
  await composer.press("Enter");
  const deadline = Date.now() + timeoutMs;
  let previous = await lastReply();
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const current = await lastReply();
    if (current && current !== previous && !current.includes("正在思考")) return current;
    previous = current;
  }
  return await lastReply();
};

try {
  const RUN = Date.now().toString(36).slice(-5);
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[aria-label="用户名"]').fill(`llm${RUN}`);
  await page.locator('input[aria-label="显示名称"]').fill("模型测试");
  await page.locator('input[aria-label="密码"]').fill("llmtest12345");
  await page.getByRole("button", { name: /注册并进入/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1500);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 1) 设置里有模型卡片
  await page.locator(".nav-item", { hasText: "设置" }).click();
  await page.waitForTimeout(1500);
  const body = (await page.locator(".page-view").textContent()) ?? "";
  check("设置有「模型（LLM）」卡片", body.includes("模型（LLM）") && body.includes("OpenAI 兼容"));
  check("模型卡片有四个输入项",
    await page.locator('input[aria-label="模型接口地址"]').isVisible().catch(() => false)
    && await page.locator('input[aria-label="模型 API Key"]').isVisible().catch(() => false)
    && await page.locator('input[aria-label="对话模型"]').isVisible().catch(() => false)
    && await page.locator('input[aria-label="视觉模型"]').isVisible().catch(() => false));
  check("默认状态显示用内置模型", body.includes("正在使用内置默认模型"));

  // 2) 填一套自己的模型（故意用无效 key，用来证明请求真的走了用户配置）
  await page.locator('input[aria-label="模型接口地址"]').fill("https://api.deepseek.com");
  await page.locator('input[aria-label="模型 API Key"]').fill("sk-invalid-00000000000000000000");
  await page.locator('input[aria-label="对话模型"]').fill("deepseek-chat");
  await page.locator('input[aria-label="视觉模型"]').fill("deepseek-chat");
  await page.getByRole("button", { name: "保存模型设置" }).click();
  await page.waitForTimeout(800);
  const savedBody = (await page.locator(".page-view").textContent()) ?? "";
  check("保存后显示正在使用自己的模型", savedBody.includes("正在使用你自己的模型"), savedBody.replace(/\s+/g, " ").slice(0, 80));
  check("卡片上显示的是掩码后的 key", savedBody.includes("sk-inv…") && !savedBody.includes("sk-invalid-00000000000000000000"));

  // 刷新后配置还在（只存本机）
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(4000);
  const intro = page.locator(".intro-skip");
  if (await intro.count()) await intro.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.locator(".nav-item", { hasText: "设置" }).click();
  await page.waitForTimeout(1500);
  check("刷新后自己的模型配置仍在", ((await page.locator(".page-view").textContent()) ?? "").includes("正在使用你自己的模型"));

  // 3) 真的走用户配置：无效 key 应该直接报鉴权失败，而不是照常回答
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(1200);
  const failedReply = await ask("你好，帮我看看这周有什么任务");
  check("用无效 key 时确实走了用户配置（报鉴权失败）",
    /鉴权|API Key|密钥|401|额度|余额|不可用/.test(failedReply), failedReply.slice(0, 120));

  // 4) 测试连接按钮：坏配置给出明确失败
  await page.locator(".nav-item", { hasText: "设置" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.waitForTimeout(6000);
  const testText = (await page.locator(".settings-card", { hasText: "模型（LLM）" }).textContent()) ?? "";
  check("测试连接会返回结果", /测试失败|连接成功/.test(testText), testText.replace(/\s+/g, " ").slice(-90));

  // 5) 恢复默认后又能正常对话
  await page.getByRole("button", { name: "恢复默认" }).click();
  await page.waitForTimeout(1000);
  check("恢复默认后回到内置模型", ((await page.locator(".page-view").textContent()) ?? "").includes("正在使用内置默认模型"));
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(1200);
  const okReply = await ask("你好", 120000);
  check("恢复默认后对话恢复正常", okReply.length > 4 && !/鉴权|API Key 可能已失效/.test(okReply), okReply.slice(0, 100));

  await page.screenshot({ path: new URL("../.e2e/custom-model.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("自带模型测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
