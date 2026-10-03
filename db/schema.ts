// PostgreSQL schema（Drizzle ORM）
//
// 设计要点：
// 1. 主键沿用客户端生成的字符串 id（如 task-xxx）——离线创建时也不会与云端冲突；
// 2. 每张业务表都带 user_id（多租户隔离，所有查询必须按它过滤）
//    + updated_at / deleted_at（同步需要"墓碑"，否则删除会被其它设备同步回来）；
// 3. 时间字段沿用客户端传入的 ISO 字符串（用 text 存储），保证同步往返不失真、
//    避免时区二次转换；服务端自己的时间（用户创建时间、会话过期）才用 timestamptz。
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ---------- 账号与会话 ----------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("user"), // admin | user
  salt: text("salt").notNull(),
  hash: text("hash").notNull(),
  iterations: integer("iterations").notNull(),
  disabled: boolean("disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

// ---------- 业务数据（与客户端 AppSnapshot 对应）----------

export const courses = pgTable(
  "courses",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    semester: text("semester").notNull().default(""),
    color: text("color").notNull().default("coral"),
    archived: boolean("archived").notNull().default(false),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] }), index("courses_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const resources = pgTable(
  "resources",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    courseId: text("course_id").notNull().default(""),
    title: text("title").notNull(),
    type: text("type").notNull().default("其他"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("未整理"),
    importedAt: text("imported_at").notNull().default(""),
    fileName: text("file_name"),
    /** 对象存储中的文件键；文件本体不入库 */
    fileKey: text("file_key"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    /** 入库时提取的正文，供智能体检索与阅读 */
    contentText: text("content_text"),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    index("resources_user_updated_idx").on(table.userId, table.updatedAt),
    index("resources_content_idx").on(table.userId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    courseId: text("course_id").notNull().default(""),
    title: text("title").notNull(),
    type: text("type").notNull().default("DDL"), // DDL | 考试 | 复习
    dueAt: text("due_at").notNull().default(""),
    status: text("status").notNull().default("未开始"),
    priority: text("priority").notNull().default("中"),
    reminder: text("reminder").notNull().default(""),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] }), index("tasks_user_due_idx").on(table.userId, table.dueAt)],
);

// ---------- 对话 ----------

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default("新对话"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] }), index("conversations_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").notNull(),
    conversationId: text("conversation_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // user | assistant
    text: text("text").notNull().default(""),
    steps: jsonb("steps").$type<unknown>(),
    images: jsonb("images").$type<string[]>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    index("messages_conversation_idx").on(table.conversationId, table.createdAt),
    index("messages_user_idx").on(table.userId),
  ],
);

// ---------- 用户画像与长期记忆 ----------

export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey(),
  name: text("name").notNull().default(""),
  studyTime: text("study_time").notNull().default(""),
  goal: text("goal").notNull().default(""),
  notes: jsonb("notes").$type<string[]>().notNull().default([]),
  updatedAt: text("updated_at").notNull(),
});

