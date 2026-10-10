// 大截图回归：聊天图片必须先压缩再发给 Agent，否则请求体积会超限报「对话内容过大」。
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { cleanupTestAccounts } from "./lib/cleanup.mjs";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SHOT = "C:\\Users\\31045\\Desktop\\qianqian\\site\\.e2e\\large-screenshot.png";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

mkdirSync("C:\\Users\\31045\\Desktop\\qianqian\\site\\.e2e", { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 150)));

try {
  // 0) 造一张「像真截图」的大图：2400x1600、有渐变与文字，PNG 体积会到 MB 级
  const maker = await browser.newPage({ viewport: { width: 2400, height: 1600 } });
  await maker.setContent(`<body style="margin:0"><div id="box" style="width:2400px;height:1600px;background:linear-gradient(120deg,#e8f0ff,#ffe9e2 60%,#fff7cc);padding:60px;font-family:sans-serif;color:#2b3a2f">
    <h1 style="font-size:64px">机器学习 第三次上机实验</h1>
    <p style="font-size:30px;line-height:1.9">实现逻辑回归与梯度下降，使用 iris.csv 数据集。<br>截止时间：2026-10-16 23:59<br>提交内容：代码 + 实验报告（含损失曲线）</p>
    <p style="font-size:26px;line-height:1.8">${"这里是课件正文，用来把图片撑得足够大以复现体积问题。".repeat(40)}</p></div></body>`);
  await maker.screenshot({ path: SHOT });
  await maker.close();
  const { statSync } = require("node:fs");
  const rawSize = statSync(SHOT).size;
  check("测试用的原图确实很大（>1MB）", rawSize > 1_000_000, `${(rawSize / 1024 / 1024).toFixed(2)}MB`);

  // 1) 登录
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator('input[aria-label="用户名"]').fill("admin");
  await page.locator('input[aria-label="密码"]').fill("admin123");
  await page.getByRole("button", { name: /^登录$/ }).click();
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1200);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  for (let i = 0; i < 40; i += 1) { if (await composer.isEnabled().catch(() => false)) break; await page.waitForTimeout(1000); }

  // 2) 拦截 Agent 步骤请求：记录体积并用假回复，避免真的调用模型花额度
  const seen = [];
  await page.route("**/api/agent/step", async (route) => {
    const body = route.request().postData() ?? "";
    seen.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, type: "message", content: "我看到这张图了：机器学习第三次上机实验，截止 2026-10-16。" }),
    });
  });

  await page.locator('[data-testid="composer-file-input"]').setInputFiles(SHOT);
  await page.waitForTimeout(2500);
  check("大截图能附加到输入框", (await page.locator(".chat-image-tile").count()) === 1);

  await composer.press("Enter");
  await page.waitForTimeout(3500);
  check("确实发出了 Agent 步骤请求", seen.length >= 1, `次数=${seen.length}`);

  const first = seen[0] ?? "";
  const mb = first.length / 1024 / 1024;
  check("请求体积远小于 14.5MB 上限", first.length < 3_000_000, `${mb.toFixed(2)}MB`);
  check("图片已被压缩成 JPEG（不再是原 PNG）", first.includes("data:image/jpeg"));
  check("请求内容里带上了图片数据", /"image_url"/.test(first));

  // 3) 对话里应该出现助手回复，而不是「对话内容过大」
  const bodyText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  check("没有出现体积超限报错", !bodyText.includes("内容过大") && !bodyText.includes("请求体积"));
  check("助手给出了回复", bodyText.includes("我看到这张图了"));

  // 4) 参考值：不压缩的话会有多大（用来证明修复真的有意义）
  const rawDataUrl = await page.evaluate(async (path) => {
    const response = await fetch(path);
    const buffer = await response.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return `data:image/png;base64,${btoa(binary)}`;
  }, "/@fs/" + SHOT.replace(/\\/g, "/")).catch(() => "");
  if (rawDataUrl) check("对比：原图若直发会超过 1MB 护栏", rawDataUrl.length > 1_000_000, `${(rawDataUrl.length / 1024 / 1024).toFixed(2)}MB`);
} catch (error) {
  check("用例未抛异常", false, String(error).slice(0, 200));
} finally {
  await browser.close();
}

// 收尾：清掉测试注册的账号
await cleanupTestAccounts();
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
