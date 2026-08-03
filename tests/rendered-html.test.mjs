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

  assert.match(page, /学习管家/);
  assert.match(page, /课程资料库/);
  assert.match(page, /任务中心/);
  assert.match(page, /复习计划/);
  assert.match(layout, /学习管家 · 本地优先学习管理/);
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
    read("../原型设计与开发拆解.md"),
  ]);

  assert.match(page, /确认并保存/);
  assert.match(page, /下载本地备份/);
  assert.match(page, /恢复备份/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(prototype, /单文件 100MB/);
  assert.match(prototype, /GLM-5V-Turbo/);
});
