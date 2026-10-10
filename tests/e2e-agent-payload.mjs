// 回归：请求体里出现"孤立代理"（数学符号被截断的产物）时，不能再让模型侧 400
// 历史 bug：PDF 里的 𝑢/𝐿 这类符号被按字数截断成半个，DeepSeek 直接
// "Failed to parse the request body as JSON: unexpected end of hex escape"，整轮对话直接失败。
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(40000);

try {
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await page.locator('input[aria-label="用户名"]').fill("admin");
  await page.locator('input[aria-label="密码"]').fill("admin123");
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1500);
  const cookies = (await ctx.cookies()).map((c) => c.name + "=" + c.value).join("; ");

  // 半个数学符号 + 一堆工具结果，模拟"读了长资料之后"的请求
  const lone = "数学建模 " + String.fromCharCode(0xd835) + " 的最优性条件";
  const messages = [{ role: "user", content: "这些资料讲了什么？" }];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `c${index}`, type: "function", function: { name: "read_resource", arguments: JSON.stringify({ title: "课件", offset: index * 6000 }) } }],
    });
    messages.push({
      role: "tool",
      tool_call_id: `c${index}`,
      content: JSON.stringify({ ok: true, summary: "读了资料", data: { content: lone.repeat(200), outline: lone.repeat(4) } }),
    });
  }

  const response = await fetch("http://localhost:3000/api/agent/step", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookies },
    body: JSON.stringify({ messages, context: { currentDate: new Date().toISOString(), timezone: "Asia/Shanghai", profile: { name: "", studyTime: "", goal: "", notes: [] } } }),
  });
  const text = await response.text();
  check("含孤立代理的请求不再被模型拒绝", !/unexpected end of hex escape/i.test(text), `status=${response.status} ${text.slice(0, 110)}`);
  check("请求本身有正常返回（不是解析错误）", response.status !== 400, `status=${response.status}`);
  check("响应里没有半个数学符号的残留", !/\\ud835/i.test(text), "");
} catch (error) {
  check("请求体健壮性测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
