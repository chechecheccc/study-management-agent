// 一键初始化：把「数据库」这一步变成一条命令。
//
//   npm run setup
//
// 它会按 .env.local 里的 DATABASE_URL：
//   1) 探测数据库能不能连上；
//   2) 连不上且是「库不存在 / 账号不存在」→ 用管理员账号自动建库建号；
//   3) 建表（drizzle 迁移）；
//   4) 初始化 admin / student1 / student2。
// 重复执行是安全的（已存在的都跳过）。
//
// 建库需要管理员权限。按下面顺序取值：
//   ① 环境变量 PG_ADMIN_URL（如 postgresql://postgres:密码@127.0.0.1:5432/postgres）
//   ② 命令行 --admin-url=...
//   ③ 交互输入 postgres 超级用户密码（.env.local 里没有超级用户信息时）
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const envPath = new URL("../.env.local", import.meta.url);
  if (!existsSync(envPath)) {
    console.error("找不到 .env.local。请先复制 .env.example 为 .env.local 并填好 DATABASE_URL。");
    process.exit(1);
  }
  const line = readFileSync(envPath, "utf8").split(/\r?\n/).find((item) => item.startsWith("DATABASE_URL="));
  if (!line) {
    console.error(".env.local 里没有 DATABASE_URL。");
    process.exit(1);
  }
  return line.slice("DATABASE_URL=".length).trim();
}

const quoteIdent = (value) => `"${value.replace(/"/g, "\"\"")}"`;
const quoteLiteral = (value) => `'${value.replace(/'/g, "''")}'`;

async function probe(url) {
  const client = postgres(url, { max: 1, connect_timeout: 8, prepare: false });
  try {
    await client`select 1`;
    return { ok: true, client };
  } catch (error) {
    await client.end({ timeout: 3 }).catch(() => {});
    return { ok: false, code: error?.code, message: String(error?.message ?? error) };
  }
}

function adminUrlFrom(databaseUrl, override) {
  if (override) return override;
  if (process.env.PG_ADMIN_URL?.trim()) return process.env.PG_ADMIN_URL.trim();
  const url = new URL(databaseUrl);
  return { host: url.hostname, port: url.port || "5432", database: "postgres" };
}

async function resolveAdminUrl(databaseUrl, override) {
  const candidate = adminUrlFrom(databaseUrl, override);
  if (typeof candidate === "string") return candidate;

  // 先试「用应用账号自己连 postgres 库」（它可能本来就有建库权限）
  const url = new URL(databaseUrl);
  const asAppUser = `postgresql://${encodeURIComponent(url.username)}:${encodeURIComponent(url.password)}@${candidate.host}:${candidate.port}/postgres`;
  if ((await probe(asAppUser)).ok) return asAppUser;

  // 再问超级用户密码（没有交互终端时不能卡在这里）
  if (!process.stdin.isTTY) {
    console.error("当前不是交互终端，无法输入密码。请改用环境变量指定管理员连接串：");
    console.error("  PG_ADMIN_URL=postgresql://postgres:密码@127.0.0.1:5432/postgres npm run setup");
    return null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = (await rl.question("建库需要管理员权限，请输入本机 postgres 超级用户的密码（直接回车跳过）：")).trim();
  rl.close();
  if (!password) return null;
  return `postgresql://postgres:${encodeURIComponent(password)}@${candidate.host}:${candidate.port}/postgres`;
}

const databaseUrl = loadDatabaseUrl();
const target = new URL(databaseUrl);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
const dbUser = decodeURIComponent(target.username);
const dbPassword = decodeURIComponent(target.password);
const adminOverride = process.argv.slice(2).find((arg) => arg.startsWith("--admin-url="))?.slice("--admin-url=".length);

console.log(`目标数据库：${dbUser}@${target.hostname}:${target.port || 5432}/${dbName}`);

const first = await probe(databaseUrl);
if (first.ok) {
  console.log("✓ 数据库已可连接");
  await first.client.end({ timeout: 3 }).catch(() => {});
} else {
  const code = first.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
    console.error("\n✗ 连不上 PostgreSQL 服务。请先确认它已安装并且正在运行：");
    console.error("   Windows：在「服务」里启动 postgresql-x64-<版本>，或运行 pg_ctl start");
    console.error("   macOS：brew services start postgresql@16");
    console.error(`   详情：${first.message}`);
    process.exit(1);
  }
  if (code !== "3D000" && code !== "28P01" && code !== "28000") {
    console.error(`\n✗ 连接数据库失败（${code}）：${first.message}`);
    process.exit(1);
  }

  console.log(code === "3D000" ? "… 数据库不存在，尝试自动创建" : "… 账号或密码不匹配，尝试自动创建");
  const adminUrl = await resolveAdminUrl(databaseUrl, adminOverride);
  if (!adminUrl) {
    console.error("\n✗ 没有管理员凭据，无法自动建库。可以手动执行：");
    console.error(`   psql -U postgres -c "CREATE USER ${dbUser} WITH PASSWORD '******' CREATEDB;"`);
    console.error(`   psql -U postgres -c "CREATE DATABASE ${dbName} OWNER ${dbUser};"`);
    process.exit(1);
  }

  const admin = postgres(adminUrl, { max: 1, connect_timeout: 8, prepare: false });
  try {
    const roles = await admin`select 1 from pg_roles where rolname = ${dbUser}`;
    if (!roles.length) {
      await admin.unsafe(`CREATE ROLE ${quoteIdent(dbUser)} LOGIN PASSWORD ${quoteLiteral(dbPassword)} CREATEDB`);
      console.log(`✓ 已创建账号 ${dbUser}`);
    } else {
      await admin.unsafe(`ALTER ROLE ${quoteIdent(dbUser)} LOGIN PASSWORD ${quoteLiteral(dbPassword)}`);
      console.log(`✓ 账号 ${dbUser} 已存在（已对齐密码）`);
    }
    const dbs = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (!dbs.length) {
      await admin.unsafe(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(dbUser)}`);
      console.log(`✓ 已创建数据库 ${dbName}`);
    } else {
      console.log(`✓ 数据库 ${dbName} 已存在`);
    }
  } catch (error) {
    console.error(`\n✗ 自动建库失败：${error?.message ?? error}`);
    console.error("   请确认管理员账号有创建角色/数据库的权限，或改用 --admin-url=postgresql://postgres:密码@127.0.0.1:5432/postgres 再试。");
    process.exit(1);
  } finally {
    await admin.end({ timeout: 3 }).catch(() => {});
  }

  const second = await probe(databaseUrl);
  if (!second.ok) {
    console.error(`\n✗ 建库后仍连不上：${second.message}`);
    process.exit(1);
  }
  console.log("✓ 数据库连接就绪");
  await second.client.end({ timeout: 3 }).catch(() => {});
}

const run = (label, args, extraEnv = {}, optional = false) => {
  process.stdout.write(`… ${label}\n`);
  try {
    execFileSync(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl, ...extraEnv },
    });
  } catch {
    if (optional) {
      console.warn(`! ${label} 没成功，但不影响其它功能（之后可以单独重跑）。`);
      return;
    }
    console.error(`✗ ${label} 失败`);
    process.exit(1);
  }
};

run("建表（应用数据库迁移）", ["node_modules/drizzle-kit/bin.cjs", "migrate"]);
run("初始化账号（admin / student1 / student2）", ["--experimental-strip-types", "scripts/seed-users.mjs"]);
// 预设课件原件：写进数据库后，任何账号都能在资料页「打开原文件」
run("写入预设课件原件", ["scripts/seed-preset-courseware.mjs"], {}, true);

console.log([
  "",
  "✓ 初始化完成，接下来：",
  "   npm run dev            启动后访问 http://localhost:3000",
  "   admin / admin123       管理员（可在「账号管理」里加人）",
  "   student1 / 123456      普通用户",
  "   student2 / 123456      普通用户",
  "   第一次登录后请在「设置 → 账号 → 修改密码」里改掉默认密码。",
].join("\n"));
