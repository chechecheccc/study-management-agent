// 一键跑全量测试：单元测试 + 全部端到端用例，逐个执行并汇总结果。
//
// 用法（需要先 npm run dev，用例会访问 http://localhost:3000）：
//   node tests/run-all.mjs
//   node tests/run-all.mjs e2e-task-features      # 只跑名字里包含这个片段的用例
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const filter = process.argv[2] ?? "";
const files = readdirSync("tests")
  .filter((name) => name.endsWith(".mjs"))
  .filter((name) => name !== "run-all.mjs" && name !== "agent-eval.mjs")
  .filter((name) => name.includes(filter))
  .sort();

if (!files.length) {
  console.log("没有匹配的测试文件。");
  process.exit(0);
}

const rows = [];
for (const file of files) {
  const args = file === "agent-core.test.mjs" ? ["--experimental-strip-types", `tests/${file}`] : [`tests/${file}`];
  const started = Date.now();
  let output = "";
  try {
    output = execFileSync(process.execPath, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const summary = lines.filter((line) => /项通过|# pass|# fail|^# tests/.test(line)).join(" | ");
  const failures = lines.filter((line) => /^FAIL|^not ok/.test(line)).slice(0, 5);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  rows.push({ file, summary, failures, seconds });
  console.log(`${failures.length ? "✗" : "✓"} ${file} (${seconds}s) -> ${summary || "(无汇总)"}`);
  for (const failure of failures) console.log(`    ${failure}`);
}

const failed = rows.filter((row) => row.failures.length);
console.log(`\n共 ${rows.length} 个文件，失败 ${failed.length} 个。`);
if (failed.length) console.log(`失败清单：${failed.map((row) => row.file).join(", ")}`);
console.log("提示：依赖模型响应的用例偶尔会因为模型变慢而超时，单独重跑通常能通过。");
process.exit(failed.length ? 1 : 0);
