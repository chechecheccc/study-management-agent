// 任务中心新增能力的验收：
//   1) 未逾期排在已逾期前面
//   2) 自定义提醒时间
//   3) 课程下拉第一项「＋ 新建课程」，建完同时进入我的课程
//   4) 新建任务时可关联资料
//   5) 任务可以附图（可选上传），编辑态左侧可查看附图
//   6) 已完成单独成组，可恢复
import { createRequire } from "node:module";
const require = createRequire("file:///C:/Users/31045/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/noop.js");
const { chromium } = require("playwright");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const IMAGE = decodeURIComponent(new URL("./fixtures/chat-notice.png", import.meta.url).pathname.slice(1));

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
const watchdog = setTimeout(() => { console.log("FAIL  整体超时，强制结束"); process.exit(1); }, 10 * 60 * 1000);
watchdog.unref?.();

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

const localInput = (date) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

try {
  const RUN = Date.now().toString(36).slice(-5);
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const user = page.locator('input[aria-label="用户名"]');
  if (await user.isVisible().catch(() => false)) {
    await page.getByRole("tab", { name: "注册" }).click();
    await user.fill(`taskfeat${RUN}`);
    await page.locator('input[aria-label="显示名称"]').fill("任务验收");
    await page.locator('input[aria-label="密码"]').fill("taskfeat123");
    await page.getByRole("button", { name: /注册并进入/ }).click();
  }
  await page.locator(".main-nav").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(1500);
  const skip = page.locator(".intro-skip");
  if (await skip.count()) await skip.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(3500);

  await page.locator(".nav-item", { hasText: "任务中心" }).click();
  await page.waitForTimeout(2500);

  // 1) 先记下当前分组（admin 手上都是逾期任务）
  const groupLabels = async () =>
    (await page.locator(".task-group-label").allTextContents()).map((t) => t.trim().split(" ·")[0]);
  check("任务中心能读出分组", (await groupLabels()).length >= 1, (await groupLabels()).join(" / "));

  // 2) 新建任务：新建课程 + 自定义提醒 + 关联资料 + 附图
  await page.getByRole("button", { name: /新建任务/ }).click();
  await page.waitForTimeout(700);
  const newCourse = `任务建课${RUN}`;
  const taskTitle = `能力验收任务${RUN}`;
  await page.locator('.task-form input[placeholder="任务名称"]').fill(taskTitle);
  await page.locator('.task-form input[type="datetime-local"]').fill(localInput(new Date(Date.now() + 26 * 3600 * 1000)));

  // 3) 课程下拉第一项应该就是「＋ 新建课程」
  const courseSelect = page.locator('.task-form select').first();
  const firstOption = (await courseSelect.locator("option").first().textContent()) ?? "";
  check("课程下拉第一项是「＋ 新建课程」", firstOption.includes("新建课程"), firstOption.trim());
  await courseSelect.selectOption({ label: "＋ 新建课程" });
  await page.waitForTimeout(500);
  const newCourseInput = page.locator('input[aria-label="新课程名称"]');
  check("选中后出现新课程名输入框", await newCourseInput.isVisible().catch(() => false));
  await newCourseInput.fill(newCourse);
  await page.locator(".course-picker-new").getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(800);
  check("新课程被选中到任务上", (await courseSelect.inputValue()) !== "__new_course__", await courseSelect.inputValue());
  check("新课程已进入我的课程", ((await page.locator(".sidebar-section").textContent()) ?? "").includes(newCourse), newCourse);

  // 4) 关联资料（课程下的资料；新课程还没有资料，先切回有资料的一门课再验证关联）
  const resourceSelect = page.locator('.task-form select[aria-label="关联资料"]');
  check("新建任务有「关联资料」入口", await resourceSelect.isVisible().catch(() => false));
  await courseSelect.selectOption({ label: "数据库系统" });
  await page.waitForTimeout(700);
  const resourceOptions = await resourceSelect.locator("option").allTextContents();
  check("关联资料按课程列出资料", resourceOptions.length > 1, resourceOptions.join(" / ").slice(0, 80));
  if (resourceOptions.length > 1) await resourceSelect.selectOption({ index: 1 });

  // 2) 自定义提醒
  const customLabel = page.locator(".reminder-choices label", { hasText: "自定义" });
  check("提醒里有「自定义」", await customLabel.isVisible().catch(() => false));
  await customLabel.click();
  await page.waitForTimeout(400);
  await page.locator('input[aria-label="自定义提醒数值"]').fill("45");
  await page.locator('select[aria-label="自定义提醒单位"]').selectOption("分钟");
  await page.waitForTimeout(400);

  // 5) 附图
  await page.locator(".task-attach-row input[type=file]").setInputFiles(IMAGE);
  await page.waitForTimeout(1500);
  const thumbs = await page.locator(".task-attach-row .task-attach-thumb").count();
  check("可以选择附带图片", thumbs >= 1, `缩略图=${thumbs}`);

  await page.getByRole("button", { name: "保存任务" }).click();
  await page.waitForTimeout(2000);
  const pageText = (await page.locator(".page-view").textContent()) ?? "";
  check("任务已创建", pageText.includes(taskTitle));
  const createdRowText = ((await page.locator(".task-row", { hasText: taskTitle }).first().textContent()) ?? "").replace(/\s+/g, " ");
  check("提醒写入了自定义值", /45分钟/.test(createdRowText), createdRowText.slice(0, 90));
  check("任务显示了附图入口", pageText.includes("查看图片") && /查看图片/.test(createdRowText), "");

  // 1) 现在同时有未逾期和已逾期，检查分组顺序
  const labels = await groupLabels();
  const tomorrowIndex = labels.indexOf("明天");
  const overdueIndex = labels.indexOf("已逾期");
  check("未逾期分组排在已逾期之前", tomorrowIndex >= 0 && overdueIndex >= 0 && tomorrowIndex < overdueIndex, labels.join(" / "));
  check("已逾期分组带分隔样式", (await page.locator(".task-group.overdue-sep").count()) >= 1, labels.join(" / "));

  // 6) 编辑态左侧可以看附图
  const row = page.locator(".task-row", { hasText: taskTitle }).first();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await page.waitForTimeout(900);
  const mediaPanel = page.locator(".task-media-panel");
  check("编辑态左侧有附图入口", await mediaPanel.isVisible().catch(() => false));
  check("编辑态能读回自定义提醒", (await page.locator('input[aria-label="自定义提醒数值"]').inputValue().catch(() => "")) === "45", "自定义数值");
  const mediaThumb = mediaPanel.locator(".thumb-button").first();
  check("编辑态能看到附图缩略图", await mediaThumb.isVisible().catch(() => false));
  if (await mediaThumb.isVisible().catch(() => false)) {
    await mediaThumb.click();
    await page.waitForTimeout(700);
    check("点开可以看大图", await page.locator(".image-viewer img").isVisible().catch(() => false));
    await page.locator(".image-viewer-bar").getByRole("button", { name: "关闭" }).click();
    await page.waitForTimeout(500);
  }

  // 编辑态里也能新建课程（第二个入口）
  const editCourseSelect = page.locator('select[aria-label="任务课程"]').first();
  const editFirstOption = (await editCourseSelect.locator("option").first().textContent()) ?? "";
  check("编辑态课程下拉第一项也是「＋ 新建课程」", editFirstOption.includes("新建课程"), editFirstOption.trim());
  await page.getByRole("button", { name: "完成编辑" }).click();
  await page.waitForTimeout(900);

  // 7) 完成 → 进「已完成」组，可以恢复
  const rowForDone = page.locator(".task-row", { hasText: taskTitle }).first();
  await rowForDone.getByRole("button", { name: "完成", exact: true }).click();
  await page.waitForTimeout(1500);
  const doneGroup = page.locator(".task-group", { has: page.locator(".task-group-label", { hasText: "已完成" }) });
  check("完成后进入「已完成」分组", await doneGroup.count() > 0, "");
  const doneRow = page.locator(".task-row", { hasText: taskTitle }).first();
  check("已完成任务仍在列表里（不再凭空消失）", await doneRow.count() > 0);
  await doneRow.getByRole("button", { name: "恢复", exact: true }).click();
  await page.waitForTimeout(1500);
  check("可以恢复成未开始", ((await page.locator(".page-view").textContent()) ?? "").includes(taskTitle));

  // 收尾：删掉这条测试任务，别留在账号里
  const cleanupRow = page.locator(".task-row", { hasText: taskTitle }).first();
  await cleanupRow.getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "确认删除" }).first().click();
  await page.waitForTimeout(1500);
  check("测试任务已清理", !((await page.locator(".page-view").textContent()) ?? "").includes(taskTitle));

  await page.screenshot({ path: new URL("../.e2e/task-features.png", import.meta.url).pathname.slice(1) });
} catch (error) {
  check("任务中心新能力测试执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
clearTimeout(watchdog);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
