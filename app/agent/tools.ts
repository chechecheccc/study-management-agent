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
      "在本地资料库中按关键词、课程、类型、状态检索资料，关键词同时匹配资料正文。返回标题、课程、类型、标签、状态、是否含正文及正文摘要。",
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
        detail: { type: "string", description: "任务的详细计划/要点（可选，多行文本）" },
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
    name: "delete_task",
    label: "删除任务",
    description:
      "删除一条任务（例如重复录入或用户明确不要了）。先调用 list_tasks 找到准确标题。调用后系统会向用户弹确认卡片，确认后才真正删除。",
    parameters: {
      type: "object",
      properties: {
        taskTitle: { type: "string", description: "要删除的任务标题，模糊匹配" },
      },
      required: ["taskTitle"],
      additionalProperties: false,
    },
    requiresConfirmation: true,
  },
  {
    name: "save_review_plan",
    label: "保存复习计划",
    description:
      "保存一份复习计划：每个 session 会被创建为一条「复习」任务。调用前先用 list_tasks 和 search_resources 了解真实进度，并且**用 read_resource 真正读一遍这门课的关键资料**（长资料可以分次读）；安排要落到资料里的具体章节/知识点，时长按资料难度定（难点 90 分钟、一般 60、轻量 45），按日期从早到晚排好、不要重复同一天。每次都要给出详细计划：focus（这次的重点）+ route（具体怎么走）+ checkpoint（怎么自测），并填 resourceName。调用后系统会向用户展示计划草案，确认后才写入。",
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
              resourceName: {
                type: "string",
                description: "这次复习要用到的资料标题（从 search_resources 的结果里取，没有就省略）",
              },
              focus: {
                type: "string",
                description: "这次的重点：复习资料里的哪些概念/章节，为什么是重点（读过资料后写）",
              },
              route: {
                type: "string",
                description: "复习路线：先做什么再做什么，例如「先过一遍 5-12 页定义 → 重做例题 → 整理易错点」",
              },
              checkpoint: {
                type: "string",
                description: "自测标准：怎么算这次复习到位了，例如「能不看答案默写 KKT 条件并解一道例题」",
              },
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
    name: "create_course",
    label: "新建课程",
    description:
      "新建一门课程。当用户想添加一门还没有的课程（例如导入的教材属于新课程）时调用。如果同名课程已存在则直接返回它。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "课程名称，例如「计算机科学中的建模技术」" },
        semester: { type: "string", description: "学期，可选，例如 2026 秋季" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
  {
    name: "read_resource",
    label: "阅读资料",
    description:
      "阅读某份资料的正文内容（入库时从 PDF / Word / PPT 提取的文本）。按标题模糊匹配。回答资料内容相关问题、制定复习计划前必须先调用，禁止编造内容。资料较长时可以分段读：返回里会给出 totalLength / hasMore / nextOffset 和 outline（页码或小标题目录），据此继续读下一段，直到读完关键部分。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "资料标题，模糊匹配" },
        offset: { type: "number", description: "从第几个字开始读，默认 0；接着读时传上一次返回的 nextOffset" },
        length: { type: "number", description: "本次读取多少字，默认 6000，最大 8000" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
  {
    name: "remember_fact",
    label: "记住这件事",
    description:
      "把值得长期记住的学习情况写入长期记忆，例如：薄弱章节、重要考试日期、学习习惯、老师强调的考点。上限 20 条，只记有长期价值的事实，不要记闲聊。",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "一句简洁的事实，例如「数据库第三章事务部分是薄弱环节」" },
      },
      required: ["fact"],
      additionalProperties: false,
    },
    requiresConfirmation: false,
  },
  {
    name: "update_task",
    label: "修改任务",
    description:
      "修改已有任务的标题、截止时间、优先级或类型，例如把没完成的复习安排顺延。先调用 list_tasks 找到准确标题。调用后系统会向用户弹出确认卡片，确认后才写入。",
    parameters: {
      type: "object",
      properties: {
        taskTitle: { type: "string", description: "要修改的任务标题，模糊匹配" },
        title: { type: "string", description: "新标题，可选" },
        dueAt: { type: "string", description: "新的截止时间，ISO 8601，可选" },
        priority: { type: "string", enum: ["高", "中", "低"], description: "可选" },
        detail: { type: "string", description: "把任务的详细计划/要点改成这段文字（可选）" },
        type: { type: "string", enum: ["DDL", "考试", "复习"], description: "可选" },
        reminder: { type: "string", description: "提醒规则，例如 提前3天、1天、2小时" },
      },
      required: ["taskTitle"],
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



