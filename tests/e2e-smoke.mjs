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

const RUN_ID = Date.now().toString(36).slice(-5);
const TASK_MARK = `实验报告${RUN_ID.toUpperCase()}`;
// 每次运行使用全新账号，避免历史对话与任务累积导致断言失真
const E2E_USER = `smoke${RUN_ID}`;
const E2E_PASS = "smoke123456";
let registered = false;
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
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!registered) {
        await page.getByRole("tab", { name: "注册" }).click();
        await userField.fill(E2E_USER);
        await page.locator('input[aria-label="显示名称"]').fill("冒烟测试");
        await page.locator('input[aria-label="密码"]').fill(E2E_PASS);
        await page.getByRole("button", { name: /注册并进入/ }).click();
        registered = true;
      } else {
        await userField.fill(E2E_USER);
        await page.locator('input[aria-label="密码"]').fill(E2E_PASS);
        await page.getByRole("button", { name: /^登录$/ }).click();
      }
      const entered = await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 }).then(() => true).catch(() => false);
      if (entered) break;
      await page.waitForTimeout(1500);
    }
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

  // 3. 写入流程：创建任务 → 确认卡片 →（跨视图验证）→ 确认入库
  await waitIdle();
  await composer.fill(`帮我记下：数据库系统 后天晚上 8 点交${TASK_MARK}`);
  await composer.press("Enter");
  const card = page.locator(".inline-confirm").first();
  const cardAppeared = await card.waitFor({ state: "visible", timeout: 90000 }).then(() => true).catch(() => false);
  check("创建任务弹出确认卡片", cardAppeared);

  if (cardAppeared) {
    await shot("03-confirm-card");

    // 3b. 跨视图确定性验证：切到任务中心，卡片应变成右下角非阻塞浮层
    await page.locator(".nav-item", { hasText: "任务中心" }).click();
    await page.waitForTimeout(1200);
    const rescueVisible = await page.locator(".confirm-overlay.rescue-overlay").isVisible().catch(() => false);
    check("切走后确认卡片以非阻塞浮层兜底显示", rescueVisible, `兜底浮层=${rescueVisible}`);

    await page.locator(".nav-item", { hasText: "浅浅" }).click();
    await page.waitForTimeout(1200);
    const inputEnabled = await page.locator('input[aria-label="输入学习管理需求"]').isEnabled().catch(() => false);
    check("确认挂起时输入框仍可用（不再锁死）", inputEnabled, `输入框可用=${inputEnabled}`);
    const inlineBack = await page.locator(".inline-confirm").isVisible().catch(() => false);
    const rescueGone = await page.locator(".confirm-overlay.rescue-overlay").isVisible().catch(() => false);
    check("回到智能体页后确认卡片内联显示", inlineBack, `内联卡片可见=${inlineBack}`);
    check("回到智能体页后兜底浮层自动隐藏", !rescueGone, `兜底浮层=${rescueGone}`);

    // 3c. 确认入库（课程为空时兜底选一门）
    const courseSelect = page.locator(".inline-confirm").locator("select").first();
    if (!(await courseSelect.inputValue().catch(() => ""))) {
      const options = await courseSelect.locator("option").allTextContents();
      const pick = options.find((t) => t.trim() && !t.includes("请选择"));
      if (pick) await courseSelect.selectOption({ label: pick.trim() });
    }
    await page.locator(".inline-confirm").getByRole("button", { name: /确认并保存/ }).click();
    await page.waitForTimeout(2500);
    check("确认后卡片关闭", !(await page.locator(".inline-confirm").isVisible().catch(() => false)));
  }

  // 4. 任务中心能看到新任务
  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(1500);
  let taskText = "";
  for (let i = 0; i < 15; i += 1) {
    taskText = (await page.locator(".page-view").textContent()) ?? "";
    if (taskText.includes(TASK_MARK)) break;
    await page.waitForTimeout(1000);
  }
  check("任务中心出现新建任务", taskText.includes(TASK_MARK), `查找标记=${TASK_MARK}`);
  await shot("04-tasks");
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
    await userField2.fill(E2E_USER);
    await page.locator('input[aria-label="密码"]').fill(E2E_PASS);
    await page.getByRole("button", { name: /^登录$/ }).click();
    await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
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























