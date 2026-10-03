export type Course = {
  id: string;
  name: string;
  semester: string;
  color: string;
  archived?: boolean;
  /** 最后修改时间（云同步合并依据，由本地自动打标） */
  updatedAt?: string;
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
  fileSize?: number;
  mimeType?: string;
  /** 入库时提取的正文文本（PDF 文字层 / DOCX / PPTX / 图片识别摘要），供 Agent 检索与阅读 */
  contentText?: string;
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

export function emptySnapshot(): AppSnapshot {
  return { courses: [], resources: [], tasks: [] };
}

export function demoSnapshot(): AppSnapshot {
  return {
    courses: [
      { id: "course-db", name: "数据库系统", semester: "2026 秋季", color: "coral" },
      { id: "course-calc", name: "高等数学", semester: "2026 秋季", color: "blue" },
      { id: "course-english", name: "学术英语", semester: "2026 秋季", color: "sage" },
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
        fileName: "数据库-第一章.pdf",
      },
      {
        id: "resource-2",
        title: "实验一要求与提交说明",
        courseId: "course-db",
        type: "作业",
        tags: ["实验一", "DDL"],
        status: "未整理",
        importedAt: "2026-08-02",
        fileName: "实验一要求.docx",
      },
      {
        id: "resource-3",
        title: "导数与微分课堂笔记",
        courseId: "course-calc",
        type: "笔记",
        tags: ["导数", "错题"],
        status: "学习中",
        importedAt: "2026-08-02",
        fileName: "高数-导数笔记.pptx",
      },
      {
        id: "resource-4",
        title: "课程群通知截图",
        courseId: "course-db",
        type: "通知",
        tags: ["待确认"],
        status: "未整理",
        importedAt: "2026-08-03",
        fileName: "Screenshot_0803.png",
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






