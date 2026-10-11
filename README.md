# 浅浅 qianqian · 个人学习管理智能体

浅浅是一个**以 Agent 为核心**的个人学习管理应用：用一句话说出需求，它会自己查证你的课程、资料和任务，再动手；**写入之前一定先问你**。

它不是一个"套壳聊天框"——真正的核心是 `app/agent/loop.ts` 里的 Agent 循环：感知 → 调模型决策 → 执行工具 → 观察结果 → 再决策，直到给出结论。

```
用户一句话
   ↓
Agent 循环（客户端驱动，可单测）
   ├─ 第 1 步：带上 13 个工具的 schema 调模型
   ├─ 模型回"直接回答" → 结束
   └─ 模型回"调用工具" → 本地执行 → 结果回灌 → 第 2 步 …
   ↓
写操作（建/改/删任务、改状态、存复习计划）→ 弹出确认卡片 → 你点了才写入
```

## 13 个工具

| 类型 | 工具 |
|---|---|
| 查询（免确认） | `list_courses`、`list_tasks`、`search_resources`、`read_resource`、`navigate` |
| 记忆（免确认） | `remember_fact`、`update_profile` |
| 课程（免确认） | `create_course` |
| **写入（需确认）** | `create_task`、`update_task`、`update_task_status`、`delete_task`、`save_review_plan` |

护栏：同一轮里"相同工具 + 相同参数"的只读调用只执行一次；确认卡片 3 分钟无人应答自动取消；默认最多 8 步（排复习计划放宽到 18 步）。

## 功能

- **浅浅（智能体）**：对话 + 工具调用，能读你的资料正文、查任务、排计划；支持图片/截图（原生多模态），聊天里直接粘图或选图都行。
- **任务中心**：DDL / 考试 / 复习三类任务，未逾期在前、已逾期沉底、已完成单独成组；自定义提醒、关联资料、任务附图、详细计划。
- **复习计划**：说清考试时间和空闲时段，它会真的读完这门课的课件再拆安排（每条带重点、复习路线、自测点），确认后写入任务中心。
- **课程与资料**：新建/拖拽排序课程；PDF / Word / PPT / 图片入库并抽取正文，原文件存数据库（换设备也能打开）。
- **设置**：界面动画开关、桌面提醒与日历导出（.ics）、数据备份/恢复、学习画像、模型设置、账号与修改密码。
- **账号管理（仅管理员）**：新增账号、停用/启用、重置密码、删除、一键清理测试账号。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 16 + React 19，构建用 Vinext（Vite 8），动画用 GSAP |
| 数据（本机） | IndexedDB：课程 / 资料 / 任务 / 对话 / 原文件，离线可用 |
| 数据（服务端） | PostgreSQL 18 + Drizzle ORM（10 张表，含文件二进制与删除墓碑） |
| 模型 | 默认 DeepSeek（OpenAI 兼容接口），也可在设置里填自己的模型 |
| 运行时 | Vinext/Cloudflare Workers 风格的 API 路由（每请求一个数据库连接） |

### 数据怎么走

```
浏览器 IndexedDB（先写本地，离线可用）
        ↓ 自动同步（逐条按 updatedAt 取新者）
PostgreSQL（9 + 1 张表：users/sessions/courses/resources/tasks/
            conversations/messages/profiles/files + deletions）
```

- 同一账号在**任何设备**登录，课程、资料、任务、对话、原文件、画像都会同步。
- 删除会传播：服务端记一条"删除墓碑"，其它设备下次拉取时把本地旧副本一并删掉（避免删了又回来）。
- 账号之间完全隔离（每个用户的数据都按 `user_id` 过滤）。

## 目录结构

```
app/
  agent/            Agent 内核（纯逻辑、可单测）
    loop.ts           循环：感知 → 决策 → 工具 → 观察
    tools.ts          13 个工具的注册表（schema + 是否需要确认）
    prompts.ts        系统提示词
    memory.ts         长期记忆（画像 + 笔记）
    reminders.ts      提醒调度
    triggers.ts       主动巡检信号
    conversations.ts  会话分组/标题
    protocol.ts       请求协议与清洗（长度上限、代理对处理）
  api/
    agent/step/       单步代理：转发给模型，返回"回答"或"工具调用"
    ai/extract/       文件/截图信息抽取
    ai/health|ping/   模型健康检查与连接测试
    auth/             login / logout / me / register / password
    sync/             pull / push / delete（含删除墓碑）
    files/            upload / [id]（原文件存数据库）
    admin/users/      账号管理（列表/新建/改/删/清理测试账号）
  components/       登录页、账号面板、导入队列、片头动画
  lib/              账号、云同步、模型配置、PDF/Word/PPT 抽取、复习计划、任务逻辑…
  page.tsx          主界面（浅浅 / 任务中心 / 复习计划 / 设置 / 账号管理）
db/                 schema.ts（Drizzle 表定义）、pg.ts（连接）
drizzle/            迁移 SQL（0000–0005）
scripts/            初始化账号、写入预设课件、清理测试账号
tests/              测试（含一键跑全量）
worker/ build/ .openai/   构建脚手架（Vinext/Workers 运行时需要，勿删）
```

## 快速开始

前置：Node.js ≥ 22.13；PostgreSQL ≥ 14（本机或远程都行，没装可以看下面的“开箱即用”）。

```bash
# 1) 装依赖
npm install

# 2) 配置环境变量
cp .env.example .env.local     # 编辑它：填自己的库地址和模型密钥

# 3) 一条命令：自动建库 + 建表 + 初始化账号（可重复执行）
npm run setup

# 4) 启动
npm run dev                    # http://localhost:3000
```

登录：管理员 `admin / admin123`，普通用户 `student1 / 123456`、`student2 / 123456`。
**第一次登录后请立刻在「设置 → 账号 → 修改密码」里改掉默认密码。**

### 数据库怎么做到“开箱即用”

**做法 A：一条命令（推荐，本机已装 PostgreSQL）**

```bash
npm run setup
```

它会按 `.env.local` 里的 `DATABASE_URL` 自动：检测连接 → 库/账号不存在就用管理员账号建好 → 建表 → 初始化 `admin / student1 / student2`。
重复执行是安全的（已存在的都跳过）。需要建库权限时，会提示你输入本机 `postgres` 超级用户密码，也可以提前设好：

```bash
# Windows PowerShell
$env:PG_ADMIN_URL="postgresql://postgres:你的密码@127.0.0.1:5432/postgres"; npm run setup
```

**做法 B：对方电脑没装 PostgreSQL（便携版，免安装）**

下载 PostgreSQL 官方 **binaries zip**（不是 installer），解压到 `D:\pgsql`，然后：

```bat
D:\pgsql\bin\initdb.exe -D D:\pgsql\data -U postgres --pwprompt
D:\pgsql\bin\pg_ctl.exe -D D:\pgsql\data -l D:\pgsql\log.txt start
```

之后回到项目目录执行 `npm run setup` 即可（密码就是你刚设的那个）。

**做法 C：对方完全零安装（你自己的机器当数据库服务器）**

对方只需把 `DATABASE_URL` 改成你的局域网地址，本机什么都不用装：

1. 你的机器上打开 `D:\ruanjian\postgresql\data\pg_hba.conf`，末尾加一行：`host all all 0.0.0.0/0 scram-sha-256`
2. 重启 PostgreSQL 服务；Windows 防火墙放行 5432 端口
3. 对方：`DATABASE_URL=postgresql://qianqian:qianqian123@你的局域网IP:5432/qianqian`

> ⚠️ 这等于把数据库对局域网开放，仅在可信网络里用；用完建议把那行注释掉。

> 当然，也可以只把 **网址**给别人：你自己 `npm run build && npm start` 跑一份，别人浏览器打开就能用，连 `.env.local` 都不用给。

### 环境变量（`.env.local`）

```ini
# 服务端模型：Agent 对话与工具调用
DEEPSEEK_AGENT_MODEL=deepseek-v4-flash
# 服务端模型：文件 / 截图信息抽取（需要多模态）
DEEPSEEK_EXTRACT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions

# PostgreSQL
DATABASE_URL=postgresql://用户:密码@127.0.0.1:5432/qianqian
```

只想用自己电脑上的数据库、不想接模型也行：不填 `DEEPSEEK_API_KEY` 时数据管理和 Agent 的工具部分照常可用，只有"在线识别"和"模型对话"会提示未配置。

### 用你自己的模型

「设置 → 模型」里可以填任意 **OpenAI 兼容**接口：接口地址和 API Key 是两边共用的，下面两个模型各管一件事：

- **对话模型**：聊天、工具调用、排复习计划；
- **视觉模型**：看图片 / 截图 / 文件识别。

配置只存在**本机浏览器**（localStorage），随请求发给服务端转发，不写进数据库；留空则回退到 `.env.local` 里的默认模型。

### 预设课件（可选）

「机器学习」课程的两份预设课件正文已内嵌在 `app/lib/preset-courseware.ts`，所有账号登录后都能看到内容。如果还想让"打开原文件"可用，把 PDF 原件入库：

```bash
npm run db:seed:presets                      # 用默认路径
npm run db:seed:presets 第1章.pdf 第2章.pdf   # 或指定文件
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发（http://localhost:3000） |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run lint` | ESLint |
| `npm test` | 构建 + 渲染测试 + Agent 单元测试（快） |
| `npm run test:e2e` | 全量端到端测试（需先 `npm run dev`） |
| `npm run setup` | **一键初始化：自动建库 + 建表 + 初始化账号** |
| `npm run db:migrate` | 只应用迁移（新库建表；已有库是安全的空操作） |
| `npm run db:seed:users` | 初始化 admin / student1 / student2 |
| `npm run db:seed:presets` | 写入预设课件原件 |
| `npm run accounts:clean` | 清理测试账号（加 `--apply` 才真删） |

## 测试

- `tests/agent-core.test.mjs`：Agent 内核纯逻辑（循环、工具表、提醒、任务分组、同步合并等）
- `tests/rendered-html.test.mjs`：仓库结构与关键约束
- `tests/e2e-*.mjs`：浏览器端到端（分账号、聊天、导入、任务、复习计划、同步、确认卡片…）

> 依赖模型响应的用例偶尔会因为模型变慢而超时，单独重跑通常即可通过。

## 交付 / 部署说明

**要交的**：整个源码仓库（`app/ db/ drizzle/ public/ scripts/ tests/ worker/ build/ .openai/` + 配置文件 + 文档 + `package-lock.json`）。

**不要交**：

| 目录/文件 | 原因 |
|---|---|
| `.env.local` | **含真实模型密钥和数据库密码**，交付时只给 `.env.example` |
| `node_modules/` | 770MB+，对方 `npm install` 重新装 |
| `.next/ .vinext/ .wrangler/ dist/` | 构建缓存与产物，可重新生成 |
| `.e2e/ .e2e-auth/` | 测试截图产物 |
| `.git/`（可选） | 想保留提交历史就一起给，不想就删 |

`git archive --format=zip -o qianqian-source.zip HEAD` 可以导出干净的源码包（只含被 Git 跟踪的文件，自动排除上面这些）。

## 已知限制

- 从登录页自助注册的账号默认是开放的（谁拿到网址都能建号）；不需要的话可以让管理员在「账号管理」里停用或删除，或用 `npm run accounts:clean` 批量清理测试账号。
- Word / PPT 只做正文抽取（用于 Agent 阅读和检索），不在网页里渲染；图片和 PDF 可以内嵌预览。
- 单文件上限 100MB、批量 500MB；图片发给模型前会自动压缩到 1600px / 700KB 以内。
- 提醒需要浏览器通知权限；没授权时退化为对话内提醒 + 导出日历（.ics）。
