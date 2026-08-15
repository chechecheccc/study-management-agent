# 学习资料与 DDL 管理智能体

面向学生个人的本地优先 Web 应用。当前版本支持课程与资料管理、DDL 管理、iCal 导出、GLM-5V-Turbo 辅助提取，以及本地文件保存和预览。

## 本地运行

要求 Node.js `>=22.13.0`。

```bash
npm install
copy .env.example .env.local
npm run dev
```

在 `.env.local` 中设置服务端 `GLM_API_KEY`。密钥不会发送到浏览器，也不应提交到版本库。

## 常用命令

- `npm run dev`：启动本地开发服务。
- `npm run lint`：运行代码规范检查。
- `npm test`：执行生产构建和自动化测试。
- `npm run build`：仅执行生产构建。

## 当前能力边界

- 原始文件、课程、资料和任务保存在浏览器 IndexedDB。
- 文本、截图和文件名可经服务端模型代理提取 DDL 与资料字段，写入前必须由用户确认。
- PDF 与图片直接预览；DOCX 提取正文预览；PPTX 按页提取文字预览。
- 支持顺序处理的多文件队列：单文件限制 100MB、单批次限制 500MB，并提供逐项确认、取消和重试。
- 旧版 `.doc`、`.ppt` 暂需先转换为 `.docx`、`.pptx`。
