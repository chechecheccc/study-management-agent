import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("Sprint 1 product shell replaces the starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    read("app/page.tsx"),
    read("app/layout.tsx"),
    read("package.json"),
  ]);

  // 产品名：浅浅（英文名 qianqian）；界面不再出现旧品牌与技术标签
  assert.match(page, /浅浅/);
  assert.match(page, /qianqian/);
  assert.match(page, /课程资料库/);
  assert.match(page, /任务中心/);
  assert.match(page, /复习计划/);
  assert.match(layout, /浅浅 qianqian · 学习管理/);
  assert.doesNotMatch(page, /学习管家|本地优先|DeepSeek/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("local-first data layer contains the Sprint 1 domain stores", async () => {
  const store = await read("app/lib/local-store.ts");

  assert.match(store, /study-agent-local/);
  assert.match(store, /courses/);
  assert.match(store, /resources/);
  assert.match(store, /tasks/);
  assert.match(store, /indexedDB/);
  assert.match(store, /demoSnapshot/);
});

test("starter preview files are removed", async () => {
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
  await assert.rejects(access(new URL("app/_sites-preview/preview.css", root)));
});

test("the product enforces the agreed Sprint 1 boundaries", async () => {
  const [page, css, prototype] = await Promise.all([
    read("app/page.tsx"),
    read("app/globals.css"),
    read("原型设计与开发拆解.md"),
  ]);

  assert.match(page, /确认并保存/);
  assert.match(page, /下载备份/);
  assert.match(page, /恢复备份/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(prototype, /单文件 100MB/);
  assert.match(prototype, /GLM-5V-Turbo/);
});

test("Sprint 2 model proxy keeps credentials server-side", async () => {
  const [route, contract, page, envExample] = await Promise.all([
    read("app/api/ai/extract/route.ts"),
    read("app/lib/ai-contract.ts"),
    read("app/page.tsx"),
    read(".env.example"),
  ]);

  // 默认密钥只在服务端（llm-server）读取；用户自己填的 key 只存本机浏览器
  const llmServer = await read("app/lib/llm-server.ts");
  const llmConfig = await read("app/lib/llm-config.ts");
  assert.match(llmServer, /process\.env\.DEEPSEEK_API_KEY/);
  assert.match(llmServer, /resolveModelTarget/);
  assert.match(llmConfig, /localStorage\.setItem\(STORAGE_KEY/);
  assert.doesNotMatch(route, /DEEPSEEK_API_KEY/);
  assert.match(llmServer, /deepseek-v4-flash/);
  assert.match(route, /resolveModelTarget/);
  assert.match(route, /Cache-Control/);
  assert.match(route, /isSameOriginRequest/);
  assert.match(contract, /requiresConfirmation: true/);
  assert.match(contract, /MAX_IMAGE_DATA_LENGTH/);
  assert.match(page, /\/api\/ai\/extract/);
  assert.match(page, /确认并保存/);
  assert.match(envExample, /DEEPSEEK_API_KEY=replace-with-your-deepseek-key/);
  assert.doesNotMatch(`${route}\n${contract}\n${page}\n${envExample}`, /[a-f0-9]{32}\.[A-Za-z0-9]{16,}/);
});

test("Sprint 2 stores original files in IndexedDB", async () => {
  const [store, preview] = await Promise.all([
    read("app/lib/local-store.ts"),
    read("app/lib/file-preview.ts"),
  ]);
  assert.match(store, /const DB_VERSION = 3/);
  assert.match(store, /const CONVERSATION_STORE = "conversations"/);
  assert.match(store, /saveConversation/);
  assert.match(store, /deleteConversationRecord/);
  assert.match(store, /const FILE_STORE = "files"/);
  assert.match(store, /saveLocalFile/);
  assert.match(store, /100 \* 1024 \* 1024/);
  assert.match(preview, /JSZip/);
  assert.match(preview, /word\/document\.xml/);
  assert.match(preview, /ppt\\\/slides/);
  assert.match(preview, /URL\.revokeObjectURL/);
});

test("Sprint 2 batch import enforces limits and per-file recovery", async () => {
  const [page, queueLogic, queueView, css] = await Promise.all([
    read("app/page.tsx"),
    read("app/lib/import-queue.ts"),
    read("app/components/import-queue.tsx"),
    read("app/globals.css"),
  ]);

  assert.match(queueLogic, /MAX_IMPORT_FILE_BYTES = 100 \* 1024 \* 1024/);
  assert.match(queueLogic, /MAX_IMPORT_BATCH_BYTES = 500 \* 1024 \* 1024/);
  assert.match(queueLogic, /validateImportSelection/);
  assert.match(queueLogic, /awaiting_confirmation/);
  assert.match(page, /for \(const item of items\)/);
  assert.match(page, /new AbortController\(\)/);
  assert.match(page, /cancelledImportIdsRef/);
  assert.match(page, /savingImportIdsRef/);
  assert.match(page, /multiple/);
  assert.match(page, /Array\.from\(event\.target\.files/);
  assert.match(queueView, /同时保存识别到的 DDL/);
  assert.match(queueView, /重试识别/);
  assert.match(queueView, /重试保存/);
  assert.match(queueView, /清理已结束/);
  assert.match(css, /\.queue-progress/);
  assert.match(css, /\.status-awaiting_confirmation/);
});

test("GSAP motion layer is scoped, responsive, and reduced-motion aware", async () => {
  const [page, css, packageJson] = await Promise.all([
    read("app/page.tsx"),
    read("app/globals.css"),
    read("package.json"),
  ]);

  const manifest = JSON.parse(packageJson);
  assert.ok(manifest.dependencies.gsap);
  assert.ok(manifest.dependencies["@gsap/react"]);
  assert.match(page, /useGSAP/);
  assert.match(page, /window\.matchMedia/);
  assert.doesNotMatch(page, /gsap\.matchMedia\(\)/);
  assert.doesNotMatch(page, /mm\.(add|revert)/);
  assert.match(page, /prefers-reduced-motion/);
  assert.match(page, /contextSafe/);
  assert.match(page, /scope: appRef/);
  assert.doesNotMatch(page, /revertOnUpdate: true/); // 整页动画不再回滚重播（否则做一件事整页会跳一下）
  // 整页入场只依赖 view；卡片入场单独一段，并且只播没播过的
  assert.match(page, /dependencies: \[view\],/);
  assert.match(page, /dataset\.entered/);
  assert.match(page, /\.view-surface \.page-view/);
  assert.match(css, /will-change: transform/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("full-screen study intro is wired to the app entry", async () => {
  const [page, intro, css] = await Promise.all([
    read("app/page.tsx"),
    read("app/components/study-intro.tsx"),
    read("app/globals.css"),
  ]);

  assert.match(page, /showIntro/);
  assert.match(page, /<StudyIntro onComplete=\{\(\) => setShowIntro\(false\)\} \/>/);
  assert.match(intro, /role="dialog"/);
  assert.match(intro, /跳过片头/);
  assert.match(intro, /gsap\.timeline/);
  assert.match(intro, /intro-orbit/);
  assert.match(intro, /intro-node/);
  assert.match(intro, /onComplete: complete/);
  assert.match(css, /\.study-intro \{/);
  assert.match(css, /\.intro-grid \{/);
  assert.match(css, /\.intro-core \{/);
});




