export type Course = {
  id: string;
  name: string;
  semester: string;
  color: string;
  archived?: boolean;
  /** 侧栏显示顺序（用户可拖拽调整，参与云同步） */
  order?: number;
  /** 最后修改时间（云同步合并依据，由本地自动打标） */
  updatedAt?: string;
};

/** 一份资料可以挂多个文件（例如一份课堂笔记下既有截图又有讲义） */
export type ResourceFile = {
  /** 本机 IndexedDB 里的文件 id */
  fileId?: string;
  /** 服务端 files 表里的文件 id */
  fileKey?: string;
  name: string;
  size?: number;
  mimeType?: string;
  uploadedAt?: string;
};

export type Resource = {
  id: string;
  title: string;
  courseId: string;
  type: "课件" | "作业" | "笔记" | "通知" | "试卷" | "其他";
  tags: string[];
  status: "未整理" | "学习中" | "待复习" | "已归档";
  importedAt: string;
  fileName?: string;
  fileId?: string;
  /** 服务端存储的文件 id（指向 files 表），用于跨设备打开原文件 */
  fileKey?: string;
  fileSize?: number;
  mimeType?: string;
  /** 入库时提取的正文文本（PDF 文字层 / DOCX / PPTX / 图片识别摘要），供 Agent 检索与阅读 */
  contentText?: string;
  /** 这份资料挂着的所有文件；老数据只有一个文件，由 resourceFiles() 兜底 */
  files?: ResourceFile[];
  updatedAt?: string;
};

export type LocalFileRecord = {
  id: string;
  resourceId: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  storedAt: string;
};

export type Task = {
  id: string;
  title: string;
  courseId: string;
  type: "DDL" | "考试" | "复习";
  dueAt: string;
  status: "未开始" | "进行中" | "已完成" | "已逾期";
  priority: "高" | "中" | "低";
  reminder: string;
  /** 关联的资料（复习任务可绑定到具体课件/笔记） */
  resourceId?: string;
  /** 附带的图片（data URL，用户自己选择是否上传） */
  images?: string[];
  /** 详细计划：这次要复习哪些重点、怎么走、怎么自测（复习计划会写进来） */
  detail?: string;
  updatedAt?: string;
};

export type AppSnapshot = {
  courses: Course[];
  resources: Resource[];
  tasks: Task[];
};

const DB_VERSION = 3;
const DATA_STORES = ["courses", "resources", "tasks"] as const;
const FILE_STORE = "files";
const ALL_STORES = [...DATA_STORES, FILE_STORE] as const;
const CHAT_STORE = "chat";
const CONVERSATION_STORE = "conversations";
const ALL_STORES_WITH_CHAT = [...ALL_STORES, CHAT_STORE, CONVERSATION_STORE] as const;

// 账号隔离：每个账号使用独立的 IndexedDB 与 localStorage 命名空间。
// 未登录（scope 为空）时回落到默认命名空间，保证旧数据仍可访问。
const FALLBACK_KEY = "study-agent-snapshot";
let dataScope = "";

export function setDataScope(userId: string) {
  dataScope = userId ? userId.replace(/[^a-zA-Z0-9._-]/g, "") : "";
}

export function getDataScope() {
  return dataScope;
}

function scopedDbName() {
  return dataScope ? `study-agent-local__${dataScope}` : "study-agent-local";
}

function scopedKey(base: string) {
  return dataScope ? `${base}::${dataScope}` : base;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(scopedDbName(), DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      ALL_STORES_WITH_CHAT.forEach((store) => {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: "id" });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readStore<T>(db: IDBDatabase, storeName: (typeof ALL_STORES)[number]) {
  return new Promise<T[]>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve((request.result ?? []) as T[]);
    request.onerror = () => reject(request.error);
  });
}

function saveStore(
  transaction: IDBTransaction,
  storeName: (typeof DATA_STORES)[number],
  records: unknown[],
) {
  const store = transaction.objectStore(storeName);
  store.clear();
  records.forEach((record) => store.put(record));
}

// 预设资料的"删除记忆"：用户主动删掉后，同一个账号不再自动补回来。
const PRESET_HIDE_KEY = "study-agent-hidden-presets";

export function loadHiddenPresets(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(scopedKey(PRESET_HIDE_KEY));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function hidePreset(id: string) {
  if (typeof window === "undefined") return;
  try {
    const next = [...new Set([...loadHiddenPresets(), id])].slice(-200);
    window.localStorage.setItem(scopedKey(PRESET_HIDE_KEY), JSON.stringify(next));
  } catch {
    // 写不进去也不影响主流程：最坏情况是下次登录预设资料再出现一次
  }
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return emptySnapshot();
  }

  try {
    const db = await openDb();
    const [courses, resources, tasks] = await Promise.all([
      readStore<Course>(db, "courses"),
      readStore<Resource>(db, "resources"),
      readStore<Task>(db, "tasks"),
    ]);
    db.close();
    return { courses, resources, tasks };
  } catch {
    const fallback = window.localStorage.getItem(scopedKey(FALLBACK_KEY));
    return fallback ? (JSON.parse(fallback) as AppSnapshot) : emptySnapshot();
  }
}

export async function saveSnapshot(snapshot: AppSnapshot) {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return;

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([...DATA_STORES], "readwrite");
      DATA_STORES.forEach((storeName) => {
        saveStore(transaction, storeName, snapshot[storeName]);
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  } catch {
    window.localStorage.setItem(scopedKey(FALLBACK_KEY), JSON.stringify(snapshot));
  }
}

export async function saveLocalFile(resourceId: string, file: File) {
  if (typeof indexedDB === "undefined") throw new Error("INDEXED_DB_UNAVAILABLE");
  if (file.size > 100 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");

  const record: LocalFileRecord = {
    id: makeId("file"),
    resourceId,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    storedAt: new Date().toISOString(),
  };

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readwrite");
    transaction.objectStore(FILE_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
  return record;
}

export async function getLocalFile(fileId: string) {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDb();
  const record = await new Promise<LocalFileRecord | null>((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readonly");
    const request = transaction.objectStore(FILE_STORE).get(fileId);
    request.onsuccess = () => resolve((request.result as LocalFileRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return record;
}

export async function deleteLocalFile(fileId: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readwrite");
    transaction.objectStore(FILE_STORE).delete(fileId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export type ChatLogRecord = {
  id: string;
  role: "user" | "assistant";
  text: string;
  steps?: Array<{ id: string; label: string; status: "running" | "done" | "failed"; detail?: string }>;
  /** 用户消息附图（data URL） */
  images?: string[];
  createdAt: string;
};

export type ConversationRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatLogRecord[];
};

export async function loadConversations(): Promise<ConversationRecord[]> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return [];
  try {
    const db = await openDb();
    const records = await new Promise<ConversationRecord[]>((resolve, reject) => {
      const transaction = db.transaction(CONVERSATION_STORE, "readonly");
      const request = transaction.objectStore(CONVERSATION_STORE).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as ConversationRecord[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export async function saveConversation(record: ConversationRecord) {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CONVERSATION_STORE, "readwrite");
      transaction.objectStore(CONVERSATION_STORE).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // 写入失败不影响对话
  }
}

export async function deleteConversationRecord(id: string) {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CONVERSATION_STORE, "readwrite");
      transaction.objectStore(CONVERSATION_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // 删除失败时界面仍会移除该条目
  }
}

export async function loadChatLog(): Promise<ChatLogRecord[]> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return [];
  try {
    const db = await openDb();
    const records = await new Promise<ChatLogRecord[]>((resolve, reject) => {
      const transaction = db.transaction(CHAT_STORE, "readonly");
      const request = transaction.objectStore(CHAT_STORE).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as ChatLogRecord[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function saveChatLog(records: ChatLogRecord[]) {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CHAT_STORE, "readwrite");
      const store = transaction.objectStore(CHAT_STORE);
      store.clear();
      records.slice(-200).forEach((record) => store.put(record));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // 聊天记录写入失败不影响主流程
  }
}

/** 按用户设定的顺序排列课程（order 缺省视为 0，保持原相对顺序） */
export function sortCourses(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * 归一化课程顺序：先按 order 排好，再重新编号 0..n-1。
 * 旧数据没有 order 时按当前数组顺序补上；顺序本来就规整时返回原数组，避免无谓的状态更新。
 */
export function normalizeCourseOrder(courses: Course[]): Course[] {
  const tidy = sortCourses(courses).map((course, index) =>
    course.order === index ? course : { ...course, order: index },
  );
  const unchanged = tidy.length === courses.length && tidy.every((course, index) => course === courses[index]);
  return unchanged ? courses : tidy;
}

/** 把 sourceId 课程移动到 targetId 课程的位置，返回已重新编号的课程数组；没有变化时返回原数组 */
export function moveCourse(courses: Course[], sourceId: string, targetId: string): Course[] {
  const ordered = sortCourses(courses);
  const from = ordered.findIndex((course) => course.id === sourceId);
  const to = ordered.findIndex((course) => course.id === targetId);
  if (from < 0 || to < 0 || from === to) return courses;
  const next = [...ordered];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const tidy = next.map((course, index) => (course.order === index ? course : { ...course, order: index }));
  const unchanged = tidy.every((course, index) => course === courses[index]);
  return unchanged ? courses : tidy;
}

export function emptySnapshot(): AppSnapshot {
  return { courses: [], resources: [], tasks: [] };
}

/**
 * 清掉"没有原文件却写着文件名"的资料：早期演示数据里带着并不存在的文件名，
 * 界面上会让人以为文件就在那儿。只有真的存了原文件（本机 fileId 或服务端 fileKey）才保留文件名。
 */
export function stripMissingFileNames(resources: Resource[]): Resource[] {
  return resources.map((resource) => (resourceFiles(resource).length ? resource : { ...resource, fileName: undefined, files: resource.files }));
}

/** 取出一份资料挂着的全部文件；兼容只有一个文件的老数据（只有真的存了文件才算） */
export function resourceFiles(resource: Resource): ResourceFile[] {
  if (Array.isArray(resource.files) && resource.files.length) return resource.files;
  if (resource.fileId || resource.fileKey) {
    return [{
      fileId: resource.fileId,
      fileKey: resource.fileKey,
      name: resource.fileName ?? "原文件",
      size: resource.fileSize,
      mimeType: resource.mimeType,
    }];
  }
  // 只有文件名、没有任何真实文件：那是早期演示数据留下的假名字，不算文件
  return [];
}

/** 把老的单文件字段搬进 files[]，让后续逻辑只认 files */
export function withResourceFiles(resource: Resource): Resource {
  if (Array.isArray(resource.files) && resource.files.length) return resource;
  const files = resourceFiles(resource);
  return files.length ? { ...resource, files } : { ...resource, files: [], fileName: undefined };
}

export function demoSnapshot(): AppSnapshot {
  return {
    courses: [
      { id: "course-db", name: "数据库系统", semester: "2026 秋季", color: "coral", order: 0 },
      { id: "course-calc", name: "高等数学", semester: "2026 秋季", color: "blue", order: 1 },
      { id: "course-english", name: "学术英语", semester: "2026 秋季", color: "sage", order: 2 },
    ],
    resources: [
      {
        id: "resource-1",
        title: "第一章：关系模型与关系代数",
        courseId: "course-db",
        type: "课件",
        tags: ["关系模型", "第一章"],
        status: "待复习",
        importedAt: "2026-08-01",
      },
      {
        id: "resource-2",
        title: "实验一要求与提交说明",
        courseId: "course-db",
        type: "作业",
        tags: ["实验一", "DDL"],
        status: "未整理",
        importedAt: "2026-08-02",
      },
      {
        id: "resource-3",
        title: "导数与微分课堂笔记",
        courseId: "course-calc",
        type: "笔记",
        tags: ["导数", "错题"],
        status: "学习中",
        importedAt: "2026-08-02",
      },
      {
        id: "resource-4",
        title: "课程群通知截图",
        courseId: "course-db",
        type: "通知",
        tags: ["待确认"],
        status: "未整理",
        importedAt: "2026-08-03",
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "数据库实验一提交",
        courseId: "course-db",
        type: "DDL",
        dueAt: "2026-08-06T23:59",
        status: "进行中",
        priority: "高",
        reminder: "提前3天、1天、2小时",
      },
      {
        id: "task-2",
        title: "高等数学阶段测验",
        courseId: "course-calc",
        type: "考试",
        dueAt: "2026-08-10T09:00",
        status: "未开始",
        priority: "高",
        reminder: "提前3天、1天、2小时",
      },
      {
        id: "task-3",
        title: "复习关系代数",
        courseId: "course-db",
        type: "复习",
        dueAt: "2026-08-04T19:00",
        status: "未开始",
        priority: "中",
        reminder: "提前2小时",
      },
    ],
  };
}

export function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}









