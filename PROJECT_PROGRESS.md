# 学习管家项目进度与文件说明

> 更新时间：2026-09-09
>
> 本文按当前 Git 仓库中的源码编写。`node_modules`、`.next`、`dist`、`.vinext`、`.wrangler` 等生成目录不纳入说明。

## 一、项目定位

学习管家是面向学生个人的本地优先 Web 应用，目标是形成“资料入库—结构化标签—检索—任务提醒—复习安排”的学习管理闭环。

当前产品形态是“智能体对话为主、结构化页面为辅”，核心数据暂时保存在用户浏览器本地，不依赖账号系统或云端数据库。

当前已确定的产品约束：

- Web 应用。
- 用户数据优先保存在本地浏览器。
- 支持 PDF、Word、PPT、图片资料。
- 单个文件最大 100MB，单批次最大 500MB。
- 使用服务端模型代理调用 GLM-5V-Turbo。
- 面向真实学生使用，上传前后都需要考虑数据安全和失败恢复。

## 二、整体进度

### 已完成

#### 1. Sprint 1：产品壳与本地数据层

- 完成学习管家主界面和中文产品文案。
- 完成全屏进入动画、页面过渡和按钮交互动画。
- 完成响应式布局和 `prefers-reduced-motion` 降低动画支持。
- 完成智能体、资料库、任务中心、复习计划、数据管理五个主要视图。
- 完成课程、资料、任务三类结构化数据模型。
- 完成 IndexedDB 本地存储，并提供 `localStorage` 兜底。
- 完成示例数据、清空数据和恢复示例数据能力。

#### 2. Sprint 2：智能入库与文件管理

- 完成 `/api/ai/extract` 服务端模型代理。
- 完成文本、图片、文件名三种识别请求模式。
- 完成模型输出校验、日期规范化、置信度和证据字段。
- 完成“识别结果必须确认后才能入库”的流程。
- 完成多文件顺序处理队列。
- 完成取消、重试、失败、重新整理和清理已结束项目。
- 完成原始文件在 IndexedDB 中的本地保存。
- 完成图片和 PDF 预览、DOCX 正文预览、PPTX 按页文字预览。
- 完成 PDF 正文提取：普通 PDF 在浏览器本地提取文字后交给模型。
- 完成扫描 PDF 兜底：无文字层时渲染前 3 页并调用 GLM 视觉识别。
- 完成固定 `/pdf.worker.min.mjs` worker，避免 EdgeOne 动态 worker 路径加载失败。

#### 3. EdgeOne 部署适配

- EdgeOne 使用的 `next build` 已通过。
- 项目包含 `/api/ai/extract` 和 `/api/ai/health` 两个 API 路由。
- PDF worker 已放入 `public`，可以作为固定静态资源部署。
- 最近一次本地修复提交为 `fb23b7c`，内容是修复 EdgeOne PDF worker 加载。
- 由于当前开发环境连接 GitHub 不稳定，`fb23b7c` 在本地已提交，但需要网络恢复后执行 `git push github main` 才能同步到 GitHub。

#### 3. Sprint 3：Agent 化改造（本轮新增）

- 删除关键词正则路由，所有对话统一进入 Agent 循环：感知 → 模型决策 → 工具执行 → 观察 → 再决策，最多 8 步安全停止。
- 新增 `app/agent/` 纯逻辑层（不依赖 React，可单元测试）：
  - `loop.ts`：Agent 循环（async generator 逐事件输出，UI 实时展示思考轨迹）。
  - `tools.ts`：8 个工具的注册表（list_courses / list_tasks / search_resources / create_task / update_task_status / save_review_plan / update_profile / navigate），schema 同时用于 function calling 与前端确认卡片。
  - `protocol.ts`：前后端消息协议与清洗（长度上限、非法角色过滤）。
  - `prompts.ts`：系统提示词，注入当前时间与用户长期记忆。
  - `memory.ts`：用户画像（称呼/作息/目标），localStorage 持久化，对话中可由模型调用 update_profile 更新。
  - `triggers.ts`：主动巡检（逾期 / 3 天内截止 / 未整理资料），每天首次打开时智能体先开口。
- 新增 `/api/agent/step` 服务端代理：GLM function calling，密钥不出服务端；沿用同源校验、大小限制、超时与错误约定。
- 人在回路升级：create_task 与 save_review_plan 触发确认卡片（可编辑后确认、可取消），取消结果回喂模型避免重复尝试。
- 复习计划从写死的假数据改为 Agent 基于真实任务与资料生成，确认后批量写入任务中心。
- 数据管理页新增"我的画像"编辑；备份文件包含画像。
- 新增 `tests/agent-core.test.mjs`：9 个用例覆盖循环、确认门、取消、最大步数熔断、未知工具、协议清洗、触发器、画像注入。

### 当前未完成或需要后续完善

- 尚未建立真实账号、登录和多用户隔离。
- 尚未接入生产数据库；当前 `.openai/hosting.json` 中 `d1` 和 `r2` 均为 `null`。
- 尚未实现真正的后台提醒、浏览器通知、邮件通知或定时任务。
- 当前任务中的“提醒”是任务字段和展示规则，不是自动触发的通知服务。
- 当前源码没有真正的 iCal、CSV、Markdown 导出实现；README 中的 iCal 描述需要后续实现或修正。
- 复习计划草案暂不支持逐项编辑单个 session，只能整体确认或放弃。
- 旧版 `.doc` 和 `.ppt` 暂不支持浏览器直接预览，建议转换为 `.docx` 和 `.pptx`。
- 尚未实现跨设备同步、云端备份、权限管理和数据加密存储。

## 三、当前技术架构

```text
浏览器
  ├─ React / Next.js 页面
  ├─ GSAP 动画
  ├─ IndexedDB：课程、资料、任务、原始文件
  ├─ PDF.js：浏览器本地 PDF 文字提取与页面渲染
  └─ fetch /api/ai/extract
          │
          ▼
服务端模型代理
  ├─ 校验请求和来源
  ├─ 读取服务端 GLM_API_KEY
  ├─ 调用 GLM-5V-Turbo
  └─ 返回结构化资料、任务、证据和追问
```

关键数据流：

1. 用户输入文字或上传文件。
2. 文件在浏览器本地校验大小和格式。
3. PDF 在浏览器本地提取正文；扫描 PDF 转为页面图片。
4. 只有主动执行 AI 识别时，必要的文本或图片才发送到服务端代理。
5. 服务端代理读取环境变量中的模型密钥并调用 GLM。
6. 页面展示候选资料、候选任务、置信度和证据。
7. 用户确认后，结构化数据和原始文件才写入本地数据库。

## 四、项目文件作用说明

### 1. 根目录配置和说明文件

| 文件 | 作用 |
| --- | --- |
| `.env.example` | 环境变量模板。包含 `GLM_API_KEY`、`GLM_MODEL`、`GLM_API_URL`，只提供示例值，不应放真实密钥。 |
| `.gitignore` | Git 忽略规则，防止 `node_modules`、构建产物、环境变量和本地日志被提交。 |
| `.openai/hosting.json` | 项目托管平台配置。目前 `d1`、`r2` 均为空，因此没有启用 D1 数据库或 R2 对象存储。 |
| `README.md` | 项目快速开始、常用命令和能力边界说明。当前其中的 iCal 描述领先于实际源码，需要后续同步。 |
| `PROJECT_PROGRESS.md` | 本文档。记录产品定位、开发阶段、技术架构、文件职责、已知问题和后续计划。 |
| `CURRENT_FEATURES.md` | 当前功能说明。只列出源码已经实现的用户能力，同时注明现阶段限制。 |
| `package.json` | 项目依赖、Node.js 版本要求和开发/构建/测试命令。 |
| `package-lock.json` | npm 依赖版本锁定文件，保证本地和部署环境安装到一致版本。 |
| `tsconfig.json` | TypeScript 编译配置、路径别名和严格类型检查配置。 |
| `next.config.ts` | Next.js 配置入口。目前没有额外的 Next 配置。 |
| `vite.config.ts` | Vinext/Vite 本地开发和构建配置，也配置了 Cloudflare/Vinext 环境、模型环境变量映射和可选 D1/R2 绑定。 |
| `postcss.config.mjs` | PostCSS 配置，启用 Tailwind CSS 4 的 PostCSS 插件。 |
| `eslint.config.mjs` | ESLint 规则。忽略构建目录和第三方压缩版 `public/pdf.worker.min.mjs`。 |
| `drizzle.config.ts` | Drizzle Kit 配置，指定 SQLite 方言、数据库 schema 和迁移输出目录。 |

### 2. `app/` 页面和服务端接口

| 文件 | 作用 |
| --- | --- |
| `app/layout.tsx` | 全局页面布局、字体、页面标题、描述和 favicon 配置。 |
| `app/page.tsx` | 应用主页面和主要业务逻辑。负责导航、对话、资料入库、任务管理、复习计划、数据备份、IndexedDB 调用和页面视图切换。 |
| `app/globals.css` | 全局视觉样式，包括颜色、布局、卡片、表单、资料预览、队列、响应式断点、GSAP 动画辅助样式和降低动画规则。 |
| `app/chatgpt-auth.ts` | ChatGPT 宿主环境身份读取与登录跳转工具。目前应用没有启用账号登录流程，属于可复用的认证基础代码。 |
| `app/api/ai/extract/route.ts` | 服务端模型代理。校验请求来源、JSON 格式、请求大小和模型配置；读取服务端 `GLM_API_KEY`；调用 GLM-5V-Turbo；返回结构化结果。 |
| `app/api/ai/health/route.ts` | 模型代理健康检查接口，返回模型是否已配置以及当前模型名称，不返回密钥。 |
| `app/components/import-queue.tsx` | 多文件导入队列的 UI。展示处理状态、识别候选、证据、置信度、DDL 勾选、编辑、确认、重试和删除操作。 |
| `app/components/study-intro.tsx` | 首次进入页面的全屏学习主题动画，使用 GSAP 展示“资料入库、DDL 提醒、复习计划”等产品概念。 |

### 3. `app/lib/` 业务库和数据处理

| 文件 | 作用 |
| --- | --- |
| `app/lib/ai-contract.ts` | AI 输入输出契约。定义文本、图片、文件名三种模式，定义任务/资料候选结构、置信度、证据、追问字段，并校验和规范化模型返回结果。 |
| `app/lib/file-preview.ts` | 本地文件预览器。图片和 PDF 使用 Blob URL 预览；DOCX 使用 JSZip 读取 `word/document.xml`；PPTX 使用 JSZip 读取每页 XML 文本；负责释放 Blob URL。 |
| `app/lib/import-queue.ts` | 文件导入业务规则。校验支持的格式、100MB 单文件限制、500MB 单批次限制；根据模型结果或文件名生成待确认的资料和任务草稿。 |
| `app/lib/local-store.ts` | 本地数据层。使用 IndexedDB 保存课程、资料、任务和原始文件；IndexedDB 不可用时使用 `localStorage` 保存结构化快照；同时提供示例数据、空数据和 ID 生成工具。 |
| `app/lib/pdf-extract.ts` | PDF 智能入库处理。使用 PDF.js 在浏览器本地提取正文；如果没有文字层，渲染最多前 3 页图片并合并逐页视觉识别结果。 |

### 4. 数据库和托管适配代码

| 文件 | 作用 |
| --- | --- |
| `db/schema.ts` | 当前应用数据库 schema 入口，暂时为空，表示主应用尚未启用数据库表。 |
| `db/index.ts` | Cloudflare D1 + Drizzle 数据库连接入口。只有注入 `env.DB` 后才能使用。 |
| `drizzle/meta/_journal.json` | Drizzle 迁移元数据，目前没有实际迁移条目。 |
| `build/sites-vite-plugin.ts` | Vinext 构建插件。构建完成后把托管配置和 Drizzle 迁移文件复制到 `dist/.openai`。 |
| `worker/index.ts` | Cloudflare Worker 入口，负责图片优化和将请求交给 Vinext App Router。当前不是主应用业务数据库逻辑。 |
| `examples/d1/db/schema.ts` | D1 示例 schema，定义示例 `notes` 表，不是学习管家当前业务数据表。 |
| `examples/d1/app/api/notes/route.ts` | D1 示例 API，提供 notes 的 GET/POST，用来演示数据库接入方式，当前页面没有调用它。 |

### 5. `public/` 静态资源

| 文件 | 作用 |
| --- | --- |
| `public/favicon.svg` | 浏览器标签页图标。 |
| `public/pdf.worker.min.mjs` | PDF.js 的压缩版 worker。必须作为固定静态资源部署，用于 EdgeOne 上的 PDF 解析。不要手动修改内容。 |
| `public/file.svg` | 默认文件图标静态资源。 |
| `public/globe.svg` | 模板遗留的地球图标，目前不是核心业务逻辑。 |
| `public/window.svg` | 模板遗留的窗口图标，目前不是核心业务逻辑。 |

### 6. 测试和构建辅助文件

| 文件 | 作用 |
| --- | --- |
| `tests/rendered-html.test.mjs` | Node 测试文件，检查产品壳、路由关键内容、本地存储、文件限制、模型代理、GSAP、全屏片头等关键实现是否存在。 |
| `build/sites-vite-plugin.ts` | 同时承担本地构建后的托管元数据打包，详见上表。 |

## 五、常用命令

```bash
npm install       # 安装依赖
npm run dev       # 启动本地开发服务
npm run build     # 执行 Vinext 生产构建
npx next build    # 按 EdgeOne 当前配置验证 Next 构建
npm run lint      # ESLint 检查
npm test          # 生产构建 + 自动化测试
npm run test:agent # Agent 核心循环单元测试（无需构建）
npm run db:generate  # 生成 Drizzle 迁移，当前数据库 schema 为空
```

## 六、下一阶段建议

建议按以下顺序继续：

1. 修正文档和产品文案中的 iCal 能力差异，先实现 iCal 导出。
2. 把复习计划草案改为基于真实任务、资料状态和用户空闲时间生成，并支持确认保存。
3. 增加浏览器通知或定时提醒机制。
4. 再决定是否引入账号系统和云端数据库；如果引入，需要重新设计多用户隔离、文件存储和隐私策略。
5. 最后增加 CSV/Markdown 导出和跨设备备份。

