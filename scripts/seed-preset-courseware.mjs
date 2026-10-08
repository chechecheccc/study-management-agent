// 把「机器学习」预设课件的 PDF 原件写进数据库（所有账号共用同一份）
//
// 用法：
//   node scripts/seed-preset-courseware.mjs [第1章.pdf] [第2章.pdf]
//   不带参数时用默认路径（桌面上的两份教材）。
//
// 说明：应用跑在 Workers 运行时，没有文件系统，所以文件本体存 PostgreSQL 的 bytea。
// 预设文件用固定的 file id + 保留的 userId（__preset__），任何登录用户都能通过
// /api/files/<id> 打开，不需要每个账号各存一份。
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const DEFAULTS = [
  { id: "file-preset-ml-ch1", file: "C:/Users/31045/Desktop/第1章-引言.pdf" },
  { id: "file-preset-ml-ch2", file: "C:/Users/31045/Desktop/第2章  连续最优化建模与应用.pdf.pdf" },
];

function readDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const envPath = path.join(process.cwd(), ".env.local");
  const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((item) => item.startsWith("DATABASE_URL="));
  if (!line) throw new Error("找不到 DATABASE_URL（.env.local 或环境变量）");
  return line.slice("DATABASE_URL=".length).trim();
}

const args = process.argv.slice(2);
const targets = DEFAULTS.map((item, index) => ({ ...item, file: args[index] ?? item.file }));

const sql = postgres(readDatabaseUrl(), { max: 1, prepare: false });
try {
  for (const target of targets) {
    const abs = path.resolve(target.file);
    if (!fs.existsSync(abs)) {
      console.error(`跳过：找不到文件 ${abs}`);
      continue;
    }
    const data = fs.readFileSync(abs);
    const name = path.basename(abs);
    await sql`
      insert into files (id, user_id, name, mime, size, data)
      values (${target.id}, '__preset__', ${name}, 'application/pdf', ${data.length}, ${data})
      on conflict (user_id, id) do update
        set name = excluded.name, mime = excluded.mime, size = excluded.size, data = excluded.data
    `;
    console.log(`已写入 ${target.id} ← ${name}（${(data.length / 1048576).toFixed(2)} MB）`);
  }
  const rows = await sql`select id, name, size from files where user_id = '__preset__' order by id`;
  console.log("当前预设文件：", rows.map((row) => `${row.id}(${row.size}B)`).join(" "));
} finally {
  await sql.end();
}
