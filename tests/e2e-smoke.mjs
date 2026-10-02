// 真实端到端冒烟测试：用系统 Chrome 驱动真实界面，覆盖对话/确认门/视图切换/数据管理。
// 用法：node tests/e2e-smoke.mjs   （需要 npm run dev 已在 3000 端口运行）
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SHOTS = new URL("../.e2e/", import.meta.url);
await mkdir(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const shot = (name) => page.screenshot({ path: new URL(`${name}.png`, SHOTS).pathname.slice(1), fullPage: true });

// 等待 Agent 与输入框都空闲（页面打开时可能正跑主动性巡检）
async function waitIdle(timeout = 90000) {
  const composer = page.locator('input[aria-label="输入学习管理需求"]');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await composer.isEnabled().catch(() => false)) return true;
    await page.waitForTimeout(700);
  }
  return false;
}

// 片头约 2.9 秒会自动结束并卸载；用 force 点击 + 忽略时序竞争，然后等待主界面
async function dismissIntro() {
  const skip = page.locator(".intro-skip");
  if (await skip.count()) {
    await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  }
  await page.locator(".brand-name").waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
}

try {
  // 1. 加载
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(2500);

  // 账号系统：先用预置的管理员账号登录
  const userField = page.locator('input[aria-label="用户名"]');
  if (await userField.isVisible().catch(() => false)) {
    await userField.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
    await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
    await page.waitForTimeout(1200);
  }

  await dismissIntro();
  check("页面加载并进入主界面", await page.locator(".brand-name").isVisible());
  const idle = await waitIdle();
  check("主动巡检不长期锁死输入框", idle, `空闲=${idle}`);
  await shot("01-home");

  const composer = page.locator('input[aria-label="输入学习管理需求"]');

  // 2. 对话：查询任务（读工具）
  await waitIdle();
  await composer.fill("我下周有什么要交的？");
  await composer.press("Enter");
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll(".message-bubble")];
    const last = bubbles.at(-1);
    return last && last.textContent.trim().length > 5 && !last.querySelector(".progress-spinner");
  }, null, { timeout: 90000 }).catch(() => {});
  const steps = await page.locator(".tool-step").allTextContents();
  const lastText = (await page.locator(".message-bubble").last().textContent()) ?? "";
  check("对话查询任务有回复", lastText.trim().length > 5, `回复：${lastText.trim().slice(0, 60)}`);
  check("对话展示工具轨迹", steps.length > 0, `轨迹：${steps.join(" / ")}`);
  await shot("02-chat-query");

  // 3. 写入流程：创建任务 + 确认卡片
  await waitIdle();
  await composer.fill("帮我记下：数据库系统 后天晚上 8 点交实验报告");
  await composer.press("Enter");
  const card = page.locator(".action-card").first();
  const cardAppeared = await card.waitFor({ state: "visible", timeout: 90000 }).then(() => true).catch(() => false);
  check("创建任务弹出确认卡片", cardAppeared);
  if (cardAppeared) {
    await shot("03-confirm-card");
    await card.getByRole("button", { name: /确认并保存/ }).click();
    await page.waitForTimeout(2500);
    const confirmGone = await card.isVisible().catch(() => false);
    check("确认后卡片关闭", !confirmGone);
  }

  // 4. 任务中心能看到新任务
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(1500);
  const taskText = await page.locator(".task-list-wrap").textContent();
  check("任务中心出现新建任务", (taskText ?? "").includes("实验报告"), `列表片段：${(taskText ?? "").slice(0, 80)}`);
  await shot("04-tasks");

  // 5. 视图切换后确认卡片是否仍可见（关键回归点）
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(800);
  await waitIdle();
  await composer.fill("先打开资料库，然后帮我记一个后天中午 12 点的 DDL：数据库系统的视图切换测试任务");
  await composer.press("Enter");

  // 模型可能把 navigate 与后续工具放在同轮或分轮，所以轮询等待"页面已切换且卡片已出现"，
  // 而不是假设固定的时序（旧脚本因此误报）。
  let sawOtherView = false;
  let rescueVisible = false;
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(1000);
    const v = await page.locator(".content-wrap").getAttribute("data-view");
    if (v && v !== "assistant") sawOtherView = true;
    rescueVisible = await page.locator(".confirm-overlay.rescue-overlay").isVisible().catch(() => false);
    if (sawOtherView && rescueVisible) break;
  }
  const visibleViews = await page.locator(".content-wrap").getAttribute("data-view");
  check("Agent 能切换页面", sawOtherView, `当前视图=${visibleViews}`);
  check("切走后确认卡片以非阻塞浮层兜底显示", rescueVisible, `当前视图=${visibleViews}, 兜底浮层=${rescueVisible}`);
  // 回到智能体页，确认等待期间输入框不再被禁用（此前会永久锁死）
  await page.locator(".nav-item", { hasText: "浅浅" }).click();
  await page.waitForTimeout(900);
  const composerNow = page.locator('input[aria-label="输入学习管理需求"]');
  const inputEnabled = (await composerNow.count()) > 0 && (await composerNow.isEnabled().catch(() => false));
  check("确认挂起时输入框仍可用（不再锁死）", inputEnabled, `输入框存在且可用=${inputEnabled}`);
  // 回智能体页后，兜底浮层应隐藏、卡片改为内联显示
  await page.waitForTimeout(800);
  const inlineCard = await page.locator(".inline-confirm").isVisible().catch(() => false);
  const rescueStillVisible = await page.locator(".confirm-overlay.rescue-overlay").isVisible().catch(() => false);
  check("回到智能体页后确认卡片内联显示", inlineCard, `内联卡片可见=${inlineCard}`);
  check("回到智能体页后兜底浮层自动隐藏", !rescueStillVisible, `兜底浮层=${rescueStillVisible}`);
  await shot("05-cross-view-confirm");
  // 收尾：如果卡片存在就取消，避免卡住
  if (rescueVisible) {
    const cancelBtn = page.locator(".confirm-overlay.rescue-overlay").getByRole("button", { name: /取消/ }).first();
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
    await page.waitForTimeout(1500);
  }

  // 6. 复习计划
  await page.locator(".nav-item", { hasText: "复习计划" }).click();
  await page.waitForTimeout(800);
  await waitIdle();
  const strayOverlay = page.locator(".confirm-overlay.rescue-overlay").getByRole("button", { name: /取消/ }).first();
  if (await strayOverlay.isVisible().catch(() => false)) { await strayOverlay.click(); await page.waitForTimeout(1200); }
  await page.getByRole("button", { name: /生成计划草案/ }).click();
  const planCard = page.locator(".plan-preview-card .plan-item").first();
  // 复习计划是 5 步深度推理（查课程/任务/资料 → 读正文 → 生成计划），给足超时
  const planOk = await planCard.waitFor({ state: "visible", timeout: 240000 }).then(() => true).catch(() => false);
  check("复习计划生成草案", planOk);
  await shot("06-review-plan");
  const approvePlan = page.locator(".plan-preview-card").getByRole("button", { name: /确认保存/ }).first();
  if (await approvePlan.isVisible().catch(() => false)) {
    await approvePlan.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const planSaved = await page.locator(".plan-preview-card").textContent().catch(() => "");
  check("复习计划可确认写入", (planSaved ?? "").includes("已保存") || (planSaved ?? "").includes("复习节奏"), `预览区：${(planSaved ?? "").slice(0, 60)}`);

  // 7. 数据管理：画像保存 + 按钮存在
  await page.locator(".nav-item", { hasText: "数据管理" }).click();
  await page.waitForTimeout(800);
  const hasIcal = await page.getByRole("button", { name: /导出日历/ }).isVisible().catch(() => false);
  const hasNotify = await page.getByRole("button", { name: /开启桌面提醒/ }).isVisible().catch(() => false);
  check("数据管理有 iCal 与通知入口", hasIcal && hasNotify, `ical=${hasIcal}, notify=${hasNotify}`);
  const nameInput = page.locator('.profile-form input').first();
  await nameInput.fill("测试同学");
  await page.getByRole("button", { name: /保存画像/ }).click();
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2200);
  const userField2 = page.locator('input[aria-label="用户名"]');
  if (await userField2.isVisible().catch(() => false)) {
    await userField2.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin123");
    await page.getByRole("button", { name: /^登录$/ }).click();
    await page.locator(".brand-name").waitFor({ state: "visible", timeout: 25000 });
    await page.waitForTimeout(1200);
  }
  await dismissIntro();
  await page.locator(".nav-item", { hasText: "数据管理" }).click();
  await page.waitForTimeout(1200);
  const persisted = await page.locator(".profile-form input").first().inputValue();
  check("画像刷新后仍保留", persisted === "测试同学", `读取到：${persisted}`);
  await shot("07-data");

  // 8. 控制台错误
  // 过滤 dev 环境噪音（vinext 开发服务器的本地字体加载提示），只关心应用自身的错误
  const appErrors = consoleErrors.filter((line) => !line.includes("Not allowed to load local resource"));
  check("无应用级控制台报错", appErrors.length === 0, appErrors.slice(0, 3).join(" | "));
} catch (error) {
  check("测试脚本执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await page.screenshot({ path: new URL("99-final.png", SHOTS).pathname.slice(1), fullPage: true }).catch(() => {});
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
await writeFile(new URL("report.json", SHOTS), JSON.stringify({ results, consoleErrors }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);













