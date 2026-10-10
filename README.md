# 学习管家 · Study Management Agent

面向学生个人的本地优先学习管理 Web 应用。产品以智能体对话为主入口，以资料库、任务中心、复习计划和数据管理页面作为确认、浏览和编辑工具，帮助学生建立：

```text
课程资料入库 → 结构化标签 → 资料检索 → DDL/考试管理 → 复习计划
```

## 项目定位

当前版本围绕以下学生场景设计：

- 用自然语言录入 DDL、考试和复习任务。
- 上传课程资料，让 AI 辅助提取课程、资料类型、标签和截止时间。
- 在本地资料库中按标题、课程和标签检索文件。
- 先展示 AI 候选结果，用户确认后再写入本地数据。
- 根据课程、考试时间和空闲时间生成可调整的复习计划草案。
- 在暂不建立账号和云端数据库的阶段，优先保证本地可用、数据可控和失败可恢复。

## 当前版本能力

### 已实现

- 智能体对话入口：支持 DDL 录入、资料检索和打开复习计划等常见意图。
- 任务中心：手动创建 DDL、考试、复习任务；未逾期/已逾期/已完成分组，行内编辑，可关联资料、可附图、提醒时间可自定义。
- 复习计划：按课程与空闲时间生成具体到天的计划，读课件后给出重点/路线/自测，确认后写入任务中心。
- 资料库：手动创建资料卡片，按标题、课程和标签检索。
- 文件导入：支持 PDF、Word、PPT、PNG、JPEG、WebP、GIF。
- 批量导入：单个文件最大 100MB，单批次最大 500MB，支持逐项确认、取消、失败和重试。
- AI 提取：支持文本、图片、文件名三种输入，调用 GLM-5V-Turbo 返回结构化结果。
- PDF 提取：普通 PDF 在浏览器本地提取正文；扫描 PDF 渲染前最多 3 页交给视觉模型识别。
- 本地保存：课程、资料、任务和原始文件保存到浏览器 IndexedDB。
- 文件预览：支持图片、PDF、DOCX 正文和 PPTX 按页文字预览。
- 预设课程：每个账号自动带一门「机器学习」课程与两份预设课件（PDF 原件在服务端只存一份，全账号共用）。
- 本地备份：支持下载和恢复课程、资料、任务 JSON 快照。
- 设置页：外观与动画开关（可关掉片头与过渡动画）、模型（可换成用户自己的 OpenAI 兼容模型）、提醒与日历、数据与同步（备份/恢复/云同步/重置）、学习画像、账号。

### 当前未实现

- 账号注册、登录、多用户隔离和跨设备同步。
- 云端数据库、云端文件存储和多人协作。
- 真正的后台定时提醒、浏览器推送、邮件或短信通知。
- iCal/ICS、CSV 和 Markdown 导出。
- 基于真实任务和资料状态的 AI 复习计划持久化保存。
- `.doc`、`.ppt` 旧版 Office 文件的浏览器内直接预览。

## 技术架构

```text
浏览器
├── React / Next.js 页面
├── GSAP 动画层
├── IndexedDB：课程、资料、任务、原始文件
├── PDF.js：PDF 正文提取和扫描页渲染
└── /api/ai/extract
      │
      ▼
服务端模型代理
├── 校验请求来源、格式和大小
├── 读取服务端 GLM_API_KEY
├── 调用 GLM-5V-Turbo
└── 返回资料候选、任务候选、证据和追问
```

### AI 识别流程

1. 用户输入文字或上传资料。
2. 浏览器校验文件格式和大小。
3. PDF 在浏览器本地提取文字；没有文字层时渲染前 3 页。
4. 必要的文字或图片发送到 `/api/ai/extract`。
5. 服务端读取环境变量中的 API 密钥并调用 GLM-5V-Turbo。
6. 页面展示识别候选、置信度、原文证据和追问。
7. 用户确认或修改后，才保存到本地资料库和任务中心。

原始文件默认留在用户当前浏览器。只有用户主动执行 AI 识别时，识别所需的文本或图片才会发送到模型代理。

## 项目目录树

以下树状结构只列出当前 Git 仓库中的源码、配置、测试和静态资源。工作区中尚未加入 Git 的本地文档不列入此处；`node_modules`、`.next`、`dist`、`.vinext`、`.wrangler` 等生成目录也不应提交。

```text
study-management-agent/
├── .env.example                         # 环境变量模板，不包含真实密钥
├── .gitignore                            # Git 忽略规则
├── .openai/
│   └── hosting.json                      # 托管平台配置；当前未启用 D1/R2
├── README.md                             # 项目总说明、目录树、运行和部署指南
├── package.json                          # 依赖、脚本和 Node.js 版本要求
├── package-lock.json                     # npm 依赖版本锁定文件
├── tsconfig.json                         # TypeScript 编译配置
├── next.config.ts                        # Next.js 配置入口
├── vite.config.ts                        # Vinext/Vite、Cloudflare 和本地绑定配置
├── postcss.config.mjs                    # PostCSS/Tailwind CSS 配置
├── eslint.config.mjs                     # ESLint 检查配置
├── drizzle.config.ts                     # Drizzle Kit 数据库迁移配置
├── app/
│   ├── layout.tsx                        # 全局布局、字体、标题和 favicon
│   ├── page.tsx                          # 主页面、导航、对话和主要业务逻辑
│   ├── globals.css                       # 全局样式、响应式布局和动画样式
│   ├── chatgpt-auth.ts                   # ChatGPT 宿主身份读取工具，当前未启用登录
│   ├── api/
│   │   └── ai/
│   │       ├── extract/
│   │       │   └── route.ts               # GLM 服务端模型代理接口
│   │       └── health/
│   │           └── route.ts               # 模型配置健康检查接口
│   ├── components/
│   │   ├── import-queue.tsx              # 多文件导入队列和候选确认 UI
│   │   └── study-intro.tsx               # GSAP 全屏学习主题片头动画
│   └── lib/
│       ├── ai-contract.ts                # AI 请求、结果结构和模型输出校验
│       ├── file-preview.ts               # 图片、PDF、DOCX、PPTX 本地预览
│       ├── import-queue.ts                # 文件格式、大小和导入草稿规则
│       ├── local-store.ts                # IndexedDB、本地文件和示例数据
│       └── pdf-extract.ts                # PDF 正文提取和扫描页视觉识别兜底
├── public/
│   ├── favicon.svg                       # 浏览器标签页图标
│   ├── file.svg                          # 文件图标资源
│   ├── globe.svg                         # 模板静态图标，目前不是核心业务资源
│   ├── window.svg                        # 模板静态图标，目前不是核心业务资源
│   └── pdf.worker.min.mjs                # PDF.js worker，必须随项目部署
├── db/
│   ├── index.ts                          # Cloudflare D1 + Drizzle 连接入口
│   └── schema.ts                         # 主应用数据库 schema，目前为空
├── drizzle/
│   └── meta/
│       └── _journal.json                 # Drizzle 迁移元数据，目前无实际迁移
├── examples/
│   └── d1/
│       ├── app/api/notes/route.ts        # D1 notes 示例 GET/POST 接口
│       └── db/schema.ts                  # D1 notes 示例表结构
├── build/
│   └── sites-vite-plugin.ts              # 构建后打包托管配置和迁移文件的 Vite 插件
├── worker/
│   └── index.ts                          # Cloudflare Worker 入口和图片优化适配
└── tests/
    └── rendered-html.test.mjs            # Node 自动化回归测试
```

## 文件职责概览

### 页面和业务代码

- `app/page.tsx`：当前业务核心，连接对话、导入队列、本地数据和五个视图。
- `app/lib/ai-contract.ts`：定义文本、图片、文件名三种识别模式，以及任务、资料、置信度、证据和追问字段。
- `app/lib/file-preview.ts`：生成本地文件预览。DOCX 读取 `word/document.xml`，PPTX 读取幻灯片 XML。
- `app/lib/import-queue.ts`：执行格式校验、100MB/500MB 限制和待确认资料/任务草稿生成。
- `app/lib/local-store.ts`：使用 IndexedDB 保存课程、资料、任务和原始文件，并提供 localStorage 兜底。
- `app/lib/pdf-extract.ts`：使用 PDF.js 本地提取正文；无文字层时渲染前 3 页并合并视觉识别结果。
- `app/api/ai/extract/route.ts`：服务端读取 `GLM_API_KEY`，调用 GLM 并返回结构化识别结果。
- `app/components/import-queue.tsx`：展示队列状态、证据、置信度、DDL 勾选、确认、重试和删除操作。
- `app/components/study-intro.tsx`：全屏片头动画，展示资料入库、DDL 提醒和复习计划概念。

### 数据库和托管脚手架

- `db/`、`drizzle/`：未来接入 D1/Drizzle 的基础代码；当前主应用仍使用 IndexedDB。
- `examples/d1/`：演示 D1 notes 表和接口，当前页面没有调用。
- `worker/index.ts`：Cloudflare Worker 入口和图片优化适配。
- `build/sites-vite-plugin.ts`：构建完成后复制托管配置和迁移文件到 `dist/.openai`。

### 静态资源

`public/pdf.worker.min.mjs` 是 PDF.js 的第三方压缩 worker，不是普通临时构建文件，必须提交并部署。`favicon.svg`、`file.svg`、`globe.svg` 和 `window.svg` 是页面图标资源，其中后两个属于模板遗留资源。

## 本地运行

### 环境要求

- Node.js `>=22.13.0`。
- npm。
- 可访问 GLM API 的网络环境。

### 安装和启动

Windows PowerShell：

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

然后在 `.env.local` 中填写：

```env
GLM_API_KEY=你的服务端密钥
GLM_MODEL=glm-5v-turbo
GLM_API_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions
```

`.env.local` 不得提交到 GitHub。朋友协作时，每个人都应从 `.env.example` 创建自己的本地环境文件。

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 启动本地开发服务
npm run build        # 执行 Vinext 生产构建
npx next build       # 按 EdgeOne 当前方式验证 Next 构建
npm run start        # 启动生产服务
npm run lint         # ESLint 检查
npm test             # 生产构建并运行自动化测试
npm run db:generate  # 生成 Drizzle 迁移
npm run db:seed:presets  # 把两份预设课件 PDF 写进数据库（默认读桌面上的两份教材）
```

## EdgeOne 部署建议

当前项目按 GitHub 仓库部署到 EdgeOne 时，建议使用：

| 配置项 | 值 |
| --- | --- |
| 代码仓库 | `chechecheccc/study-management-agent` |
| 生产分支 | `main` |
| 框架预设 | Next |
| 根目录 | `./` |
| 安装命令 | `npm install` |
| 构建命令 | `next build` |
| 输出目录 | `.next` |

在 EdgeOne 环境变量中配置 `GLM_API_KEY`、`GLM_MODEL` 和 `GLM_API_URL`。部署完成后访问 `/api/ai/health`，返回 `configured: true` 才表示服务端读取到了 API 密钥。

PDF worker 应该通过以下地址返回 `200 OK`：

```text
https://你的域名/pdf.worker.min.mjs
```

## Git 协作

应提交源码、配置模板、产品文档、测试和 `package-lock.json`。不要提交：

- `.env`、`.env.local` 和任何真实 API 密钥。
- `node_modules/`。
- `.next/`、`dist/`、`.vinext/`、`.wrangler/`。
- 本地日志和临时缓存。

朋友克隆项目后，在项目目录运行 `npm install`，再从 `.env.example` 创建自己的 `.env.local`。

常用同步命令：

```powershell
git add .
git status
git commit -m "Update project documentation"
git push github main
```

## 数据安全和限制

- 原始文件、课程、资料和任务默认保存在当前浏览器。
- AI 识别时，必要的文本或图片会发送到配置的 GLM API。
- API 密钥只在服务端环境变量中使用，不应写进前端代码。
- 清理浏览器站点数据可能删除本地资料，重要数据应先下载 JSON 备份。
- 当前没有账号系统、云端数据库、跨设备同步和多人协作。
- 当前没有真正的后台提醒、浏览器通知、邮件通知或短信通知。
- 当前没有真正的 iCal/ICS、CSV、Markdown 导出。
- 当前复习计划页面的计划内容是演示草案，尚未基于真实任务持久化保存。
- 扫描 PDF 当前最多视觉识别前 3 页，后续页面可能没有参与提取。

## 验证状态

当前已验证：

- TypeScript 类型检查通过。
- ESLint 检查通过。
- `npm test` 自动化测试通过。
- EdgeOne 使用的 `next build` 通过。
- `/pdf.worker.min.mjs` 在本地生产服务器返回 `200 OK`。

最近一次 PDF worker 修复的本地提交为 `fb23b7c`。如果 GitHub 上没有该提交，需要在网络正常时执行 `git push github main`，然后重新触发 EdgeOne 部署。
