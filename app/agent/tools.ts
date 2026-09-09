// Agent 工具注册表：每个工具 = 名称 + 中文标签 + JSON Schema + 是否需要用户确认。
// 这是模型与本地学习空间之间的唯一通道，schema 同时用于服务端 function calling
// 和前端确认卡片，保证"模型看到的"和"用户确认的"是同一份契约。
// 纯逻辑模块，不依赖 React / DOM。

export type ToolSpec = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresConfirmation: boolean;
};

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "list_courses",
    label: "查看课程",
    description: "列出用户的全部课程，以及每门课的资料数量。回答任何课程相关问题前应先调用。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    requiresConfirmation: false,
  },
  {
    name: "list_tasks",
    label: "查询任务",
    description:
      "查询任务与 DDL。可按状态、课程、截止时间过滤。返回标题、课程、类型、截止时间、状态、优先级。",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["未开始", "进行中", "已完成", "已逾期"],
          description: "按状态过滤；缺省返回未完成的任务",
        },
        courseName: { type: "string", description: "课程名，模糊匹配" },
        dueWithinDays: { type: "number", description: "只返回未来 N 天内截止的任务" },
        includeCompleted: { type: "boolean", description: "是否包含已完成任务，默认 false" },
      },
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
  {
    name: "search_resources",
    label: "搜索资料",
    description:
      "在本地资料库中按关键词、课程、类型、状态检索资料。返回标题、课程、类型、标签、状态和文件名。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "标题、标签或文件名中的关键词" },
        courseName: { type: "string", description: "课程名，模糊匹配" },
        type: { type: "string", enum: ["课件", "作业", "笔记", "通知", "试卷", "其他"] },
        status: { type: "string", enum: ["未整理", "学习中", "待复习", "已归档"] },
      },
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
  {
    name: "create_task",
    label: "创建任务",
    description:
      "创建一条任务 / DDL / 考试安排。调用后系统会向用户弹出确认卡片，确认后才真正写入。截止时间必须结合当前时间换算成 ISO 8601。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "任务名称" },
        courseName: { type: "string", description: "所属课程名，优先使用 list_courses 中的已有课程" },
        type: { type: "string", enum: ["DDL", "考试", "复习"] },
        dueAt: { type: "string", description: "ISO 8601 截止时间，例如 2026-09-10T20:00:00+08:00" },
        priority: { type: "string", enum: ["高", "中", "低"], description: "缺省为 中" },
        reminder: { type: "string", description: "提醒规则，缺省为 提前3天、1天、2小时" },
      },
      required: ["title", "courseName", "type", "dueAt"],
      additionalProperties: false,
    },
    requiresConfirmation: true,
  },
  {
    name: "update_task_status",
    label: "更新任务状态",
    description: "把已有任务标记为 进行中 / 已完成 等状态。按任务标题模糊匹配，优先使用 list_tasks 返回的标题。",
    parameters: {
      type: "object",
      properties: {
        taskTitle: { type: "string", description: "任务标题，模糊匹配" },
        status: { type: "string", enum: ["未开始", "进行中", "已完成", "已逾期"] },
      },
      required: ["taskTitle", "status"],
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
  {
    name: "save_review_plan",
    label: "保存复习计划",
    description:
      "保存一份复习计划：每个 session 会被创建为一条「复习」任务。调用前先用 list_tasks 和 search_resources 了解真实进度；调用后系统会向用户展示计划草案，确认后才写入。",
    parameters: {
      type: "object",
      properties: {
        courseName: { type: "string" },
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "ISO 8601 日期时间" },
              title: { type: "string", description: "这次复习要做什么，具体可执行" },
              durationMinutes: { type: "number" },
            },
            required: ["date", "title", "durationMinutes"],
            additionalProperties: false,
          },
          maxItems: 14,
        },
      },
      required: ["courseName", "sessions"],
      additionalProperties: false,
    },
    requiresConfirmation: true,
  },
  {
    name: "update_profile",
    label: "更新我的画像",
    description:
      "更新用户的长期记忆（称呼、方便学习的时间、学习目标）。当用户主动告知这些信息时调用，之后每轮对话都会记住。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        studyTime: { type: "string", description: "例如：工作日晚上 19:00-21:00" },
        goal: { type: "string", description: "例如：数据库期末 90 分" },
      },
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
  {
    name: "navigate",
    label: "打开页面",
    description: "帮用户切换到应用内的某个页面：assistant 智能体、resources 资料库、tasks 任务中心、review 复习计划、data 数据管理。",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["assistant", "resources", "tasks", "review", "data"] },
        keyword: { type: "string", description: "可选，跳转后在资料库中应用搜索关键词" },
      },
      required: ["view"],
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
];

export function getToolSpec(name: string): ToolSpec | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

// 发送给模型的 OpenAI 兼容 function calling schema。
export function toolSchemasForModel() {
  return AGENT_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
