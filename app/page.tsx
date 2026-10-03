/* eslint-disable @next/next/no-img-element -- previews use browser-local Blob URLs that Next Image cannot optimize */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  AppSnapshot,
  Course,
  Resource,
  Task,
  demoSnapshot,
  emptySnapshot,
  getLocalFile,
  deleteConversationRecord,
  loadChatLog,
  loadConversations,
  loadSnapshot,
  saveConversation,
  makeId,
  saveLocalFile,
  saveSnapshot,
  setDataScope,
} from "./lib/local-store";
import type { ChatLogRecord, ConversationRecord } from "./lib/local-store";
import { deriveConversationTitle, formatConversationStamp, groupConversationsByDate } from "./agent/conversations";
import type { ExtractRequest, ExtractResult } from "./lib/ai-contract";
import { buildLocalPreview, releaseLocalPreview } from "./lib/file-preview";
import type { LocalPreview } from "./lib/file-preview";
import { extractPdfForImport, mergeExtractResults } from "./lib/pdf-extract";
import {
  buildFallbackImportDraft,
  buildImportDraft,
  isImageImportFile,
  validateImportSelection,
} from "./lib/import-queue";
import type { ImportQueueItem, PendingResourceDraft } from "./lib/import-queue";
import { BatchImportQueue } from "./components/import-queue";
import { StudyIntro } from "./components/study-intro";
import { LoginScreen } from "./components/login-screen";
import { AccountPanel } from "./components/account-panel";
import {
  SEED_ACCOUNTS,
  authenticate,
  buildAccount,
  findAccountById,
  loadAccounts,
  saveAccounts,
  toPublicAccount,
  validateNewAccount,
} from "./lib/accounts";
import type { UserAccount } from "./lib/accounts";
import { runAgentLoop } from "./agent/loop";
import type { ConfirmationDecision, HistoryMessage, ToolExecutionResult } from "./agent/loop";
import type { AgentStepResponse, AgentToolCall, AgentWireMessage } from "./agent/protocol";
import { getToolSpec } from "./agent/tools";
import { extractSearchableText } from "./lib/content-extract";
import { buildICalendar } from "./lib/ical";
import { addProfileNote, loadProfile, saveProfile, sanitizeProfile, setMemoryScope } from "./agent/memory";
import { setReminderScope } from "./agent/reminders";
import { computeDueReminders, formatMinutesLeft, loadFiredReminders, saveFiredReminders } from "./agent/reminders";
import type { UserProfile } from "./agent/memory";
import { buildProactiveFallback, buildProactiveGoal, computeProactiveSignals } from "./agent/triggers";

gsap.registerPlugin(useGSAP);

type View = "assistant" | "resources" | "tasks" | "review" | "data" | "accounts";

type ToolStep = {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
  detail?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  steps?: ToolStep[];
  /** 用户消息附带的图片（data URL），可被多模态模型直接查看 */
  images?: string[];
};

type TaskConfirmDraft = {
  title: string;
  courseId: string;
  type: Task["type"];
  dueAt: string;
  priority: Task["priority"];
  reminder: string;
};

type PlanSession = {
  date: string;
  title: string;
  durationMinutes: number;
};

type PlanConfirmState = {
  courseName: string;
  sessions: PlanSession[];
};

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "你好，我是浅浅。我可以自己查资料库和任务表后再回答你，也能帮你记 DDL、安排复习——写入前会先给你确认。试试说：“我下周有什么要交的？”",
  },
];

const viewLabels: Record<View, string> = {
  assistant: "浅浅",
  resources: "资料库",
  tasks: "任务中心",
  review: "复习计划",
  data: "数据管理",
  accounts: "账号管理",
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatShortDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
};

export default function Home() {
  const appRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<View>("assistant");
  const [showIntro, setShowIntro] = useState(true);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot());
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  // 对话会话：按账号保存，可新建 / 切换 / 删除
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [showConversationList, setShowConversationList] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  // 主动巡检等后台任务运行时不锁定输入框
  const [agentBackground, setAgentBackground] = useState(false);
  // 用户消息排队：Agent 忙时先记下，空闲后自动发出
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const queuedMessageRef = useRef<string | null>(null);
  // 待发送给智能体的图片（可粘贴或选择）
  const [chatImages, setChatImages] = useState<string[]>([]);
  const chatImagesRef = useRef<string[]>([]);
  const queuedImagesRef = useRef<string[]>([]);
  const composerFileInputRef = useRef<HTMLInputElement>(null);
  const [composerHint, setComposerHint] = useState("");
  const [composerHintKind, setComposerHintKind] = useState<"info" | "error">("info");
  // 聊天消息首次出现的时间（保证刷新后顺序稳定）
  const chatTimestampsRef = useRef(new Map<string, string>());
  const [extractError, setExtractError] = useState("");
  const [importQueue, setImportQueue] = useState<ImportQueueItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [showResourceForm, setShowResourceForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [resourceTitle, setResourceTitle] = useState("");
  const [resourceCourse, setResourceCourse] = useState("");
  const [resourceType, setResourceType] = useState<Resource["type"]>("课件");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskCourse, setTaskCourse] = useState("");
  const [taskDueAt, setTaskDueAt] = useState("2026-08-12T23:59");
  const [accounts, setAccounts] = useState<UserAccount[]>([]);
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profile, setProfile] = useState<UserProfile>({ name: "", studyTime: "", goal: "", notes: [] });
  const [pendingTaskConfirm, setPendingTaskConfirm] = useState<AgentToolCall | null>(null);
  const [taskConfirmDraft, setTaskConfirmDraft] = useState<TaskConfirmDraft | null>(null);
  const [pendingPlanConfirm, setPendingPlanConfirm] = useState<PlanConfirmState | null>(null);
  const [confirmError, setConfirmError] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);

  const batchRunningRef = useRef(false);
  const agentRunningRef = useRef(false);
  const agentHistoryRef = useRef<HistoryMessage[]>([]);
  const confirmResolverRef = useRef<{ settle: (decision: ConfirmationDecision) => void; timerId: number } | null>(null);
  const cancelledImportIdsRef = useRef(new Set<string>());
  const importAbortControllersRef = useRef(new Map<string, AbortController>());
  const savingImportIdsRef = useRef(new Set<string>());
  const snapshotRef = useRef(snapshot);
  const profileRef = useRef(profile);

  useGSAP(() => {
    const intro = gsap.timeline({ defaults: { ease: "power3.out" } });
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const compact = window.matchMedia("(max-width: 720px)").matches;
    const duration = reduceMotion ? 0 : compact ? 0.42 : 0.62;
    intro
      .from(".sidebar", { x: -24, autoAlpha: 0, duration }, 0)
      .from(".topbar", { y: -14, autoAlpha: 0, duration: duration * 0.8 }, "<0.12")
      .from(".assistant-column > *", { y: 22, autoAlpha: 0, stagger: reduceMotion ? 0 : 0.08, duration }, "<0.12")
      .from(".dashboard-rail > *", { y: 18, autoAlpha: 0, stagger: reduceMotion ? 0 : 0.1, duration: duration * 0.9 }, "<0.1");

    gsap.fromTo(".brand-mark", { rotation: -8, scale: 0.86 }, { rotation: 0, scale: 1, duration: reduceMotion ? 0 : 0.8, ease: "back.out(1.8)", delay: reduceMotion ? 0 : 0.2 });
    if (!reduceMotion) {
      gsap.to(".local-indicator", { boxShadow: "0 0 0 6px rgba(138,197,140,.03)", repeat: -1, yoyo: true, duration: 1.8, ease: "sine.inOut" });
    }

    return () => {
      intro.kill();
    };
  }, { scope: appRef });

  useGSAP((_, contextSafe) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const buttons = gsap.utils.toArray<HTMLElement>("button", appRef.current);
    const cleanups: Array<() => void> = [];
    buttons.forEach((button) => {
      const onEnter = contextSafe?.(() => { gsap.to(button, { y: -2, scale: 1.015, duration: 0.18, ease: "power2.out", overwrite: "auto" }); })
        ?? (() => { gsap.to(button, { y: -2, scale: 1.015, duration: 0.18, ease: "power2.out", overwrite: "auto" }); });
      const onLeave = contextSafe?.(() => { gsap.to(button, { y: 0, scale: 1, duration: 0.22, ease: "power2.out", overwrite: "auto" }); })
        ?? (() => { gsap.to(button, { y: 0, scale: 1, duration: 0.22, ease: "power2.out", overwrite: "auto" }); });
      button.addEventListener("pointerenter", onEnter);
      button.addEventListener("pointerleave", onLeave);
      cleanups.push(() => {
        button.removeEventListener("pointerenter", onEnter);
        button.removeEventListener("pointerleave", onLeave);
      });
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, { scope: appRef });

  useGSAP(() => {
    gsap.fromTo(
      ".view-surface .page-view, .view-surface .assistant-layout",
      { y: 16, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.42, ease: "power2.out" },
    );
    gsap.fromTo(
      ".view-surface .gsap-action-card, .view-surface .queue-item",
      { y: 12, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.32, stagger: 0.045, ease: "power2.out", delay: 0.08 },
    );
  }, {
    scope: appRef,
    dependencies: [view, Boolean(pendingTaskConfirm), Boolean(pendingPlanConfirm), importQueue.length],
    revertOnUpdate: true,
  });

  // 只让"最新一条消息"播入场动画：历史消息不再重复播放，避免每次发送都满屏闪动
  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(
      ".view-surface .gsap-message-latest",
      { y: 10, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.26, ease: "power2.out", overwrite: "auto" },
    );
  }, { scope: appRef, dependencies: [messages.length] });

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.to(".ambient-glow-one", { x: 24, y: -18, rotation: 12, repeat: -1, yoyo: true, duration: 7, ease: "sine.inOut" });
    gsap.to(".ambient-glow-two", { x: -18, y: 22, rotation: -10, repeat: -1, yoyo: true, duration: 9, ease: "sine.inOut" });
  }, { scope: appRef });

  // 首次运行：植入 1 个管理员 + 2 个普通用户；已存在则保持原有账号
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = loadAccounts();
      if (existing.length) {
        if (!cancelled) setAccounts(existing);
        if (!cancelled) setAuthReady(true);
        return;
      }
      const seeded: UserAccount[] = [];
      for (const seed of SEED_ACCOUNTS) {
        seeded.push(await buildAccount(seed));
      }
      if (cancelled) return;
      saveAccounts(seeded);
      setAccounts(seeded);
      setAuthReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // 登录：切换数据作用域后再加载该账号自己的数据
  // 切换账号：先同步切换所有存储作用域，再加载该账号自己的数据
  const openUserWorkspace = async (account: UserAccount) => {
    setDataScope(account.id);
    setMemoryScope(account.id);
    setReminderScope(account.id);
    setReady(false);
    chatTimestampsRef.current = new Map();
    chatImagesRef.current = [];
    setChatImages([]);
    setProfile(loadProfile());

    const [stored, savedConversations, legacyChat] = await Promise.all([
      loadSnapshot(),
      loadConversations(),
      loadChatLog(),
    ]);
    const next = stored.courses.length ? stored : demoSnapshot();
    setSnapshot(next);
    if (!stored.courses.length) void saveSnapshot(next);

    // 兼容旧数据：此前只有一条全局聊天记录，首次升级时迁移成一个会话
    let conversationList = savedConversations;
    if (!conversationList.length && legacyChat.length) {
      const nowIso = new Date().toISOString();
      const migrated: ConversationRecord = {
        id: makeId("conversation"),
        title: deriveConversationTitle(legacyChat.find((record) => record.role === "user")?.text ?? "之前的对话"),
        createdAt: legacyChat[0]?.createdAt ?? nowIso,
        updatedAt: legacyChat[legacyChat.length - 1]?.createdAt ?? nowIso,
        messages: legacyChat,
      };
      conversationList = [migrated];
      void saveConversation(migrated);
    }
    setConversations(conversationList);
    const latest = conversationList[0] ?? null;
    setActiveConversationId(latest?.id ?? null);
    if (latest) {
      setMessages(latest.messages.length ? toChatMessages(latest.messages) : initialMessages);
      agentHistoryRef.current = toHistory(latest.messages);
      chatTimestampsRef.current = new Map(latest.messages.map((record) => [record.id, record.createdAt]));
    } else {
      setMessages(initialMessages);
      agentHistoryRef.current = [];
      chatTimestampsRef.current = new Map();
    }
    setImportQueue([]);
    setPendingTaskConfirm(null);
    setTaskConfirmDraft(null);
    setPendingPlanConfirm(null);
    setResourceCourse(next.courses[0]?.id ?? "");
    setTaskCourse(next.courses[0]?.id ?? "");
    setView("assistant");
    setReady(true);
  };

  // 会话记录 ↔ 界面消息
  const toChatMessages = (records: ChatLogRecord[]): ChatMessage[] =>
    records.map((record) => ({ id: record.id, role: record.role, text: record.text, steps: record.steps, images: record.images }));

  const toHistory = (records: ChatLogRecord[]): HistoryMessage[] =>
    records
      .filter((record) => record.text.trim())
      .slice(-12)
      .map((record) => ({ role: record.role, content: record.text, images: record.images }));

  // 打开指定会话；传 null 表示开始一个新对话
  const openConversation = (conversation: ConversationRecord | null) => {
    setActiveConversationId(conversation?.id ?? null);
    if (conversation) {
      const nextMessages = conversation.messages.length ? toChatMessages(conversation.messages) : initialMessages;
      setMessages(nextMessages);
      agentHistoryRef.current = toHistory(conversation.messages);
      chatTimestampsRef.current = new Map(conversation.messages.map((record) => [record.id, record.createdAt]));
    } else {
      setMessages(initialMessages);
      agentHistoryRef.current = [];
      chatTimestampsRef.current = new Map();
    }
    setShowConversationList(false);
    syncChatImages([]);
    setComposerHint("");
  };

  const startNewConversation = () => {
    if (agentRunningRef.current) {
      showComposerHint("浅浅正在处理，请等这条消息完成后再新建对话。", "error");
      return;
    }
    openConversation(null);
  };

  const switchConversation = (id: string) => {
    if (agentRunningRef.current) {
      showComposerHint("浅浅正在处理，请稍后再切换对话。", "error");
      return;
    }
    const target = conversations.find((conversation) => conversation.id === id);
    if (target) openConversation(target);
  };

  const removeConversation = (id: string) => {
    const next = conversations.filter((conversation) => conversation.id !== id);
    setConversations(next);
    void deleteConversationRecord(id);
    if (id === activeConversationId) openConversation(next[0] ?? null);
  };

  const login = async (username: string, password: string): Promise<string | null> => {
    const result = await authenticate(accounts, username, password);
    if (!result.ok) return result.message;
    const nextAccounts = accounts.map((account) =>
      account.id === result.account.id ? { ...account, lastLoginAt: new Date().toISOString() } : account,
    );
    setAccounts(nextAccounts);
    saveAccounts(nextAccounts);
    await openUserWorkspace(result.account);
    setCurrentUser(result.account);
    return null;
  };

  const logout = () => {
    // 先停用持久化（ready=false），再清空账号作用域，避免登出瞬间把数据写进默认命名空间
    setReady(false);
    setCurrentUser(null);
    setDataScope("");
    setMemoryScope("");
    setReminderScope("");
  };

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    fetch("/api/ai/health", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { configured?: boolean }) => setModelConfigured(Boolean(data.configured)))
      .catch(() => setModelConfigured(false));
  }, []);

  useEffect(() => () => {
    importAbortControllersRef.current.forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    if (ready && currentUser) saveSnapshot(snapshot);
  }, [ready, snapshot, currentUser]);

  // 按会话保存：新对话在产生第一条消息时自动建档，标题取首条用户消息。
  useEffect(() => {
    if (!ready || !currentUser) return;
    const records: ChatLogRecord[] = messages
      .filter((message) => message.id !== "welcome" && message.text.trim())
      .map((message, index) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        steps: message.steps,
        images: message.images,
        createdAt: chatTimestampsRef.current.get(message.id) ?? new Date(Date.now() + index).toISOString(),
      }));
    records.forEach((record) => {
      if (!chatTimestampsRef.current.has(record.id)) chatTimestampsRef.current.set(record.id, record.createdAt);
    });
    // 只有欢迎语不入库；且必须存在用户消息才建档——
    // 否则主动性巡检的助手消息会先建出一个"新对话"，标题就取不到用户内容了。
    const userRecords = records.filter((record) => record.role === "user");
    if (!userRecords.length) return;

    const nowIso = new Date().toISOString();
    const existing = conversations.find((conversation) => conversation.id === activeConversationId);
    const firstUserText = userRecords[0].text;
    // 已存在的会话若还是占位标题，补正为真实标题
    const title = existing && existing.title !== "新对话"
      ? existing.title
      : deriveConversationTitle(firstUserText);
    const record: ConversationRecord = {
      id: existing?.id ?? activeConversationId ?? makeId("conversation"),
      title,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      messages: records,
    };
    if (!existing) {
      setActiveConversationId(record.id);
      setConversations((current) => (current.some((item) => item.id === record.id) ? current : [record, ...current]));
    } else {
      setConversations((current) => current.map((item) => (item.id === record.id ? record : item)));
    }
    void saveConversation(record);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, ready, currentUser, activeConversationId]);

  const courseMap = useMemo(
    () => new Map(snapshot.courses.map((course) => [course.id, course])),
    [snapshot.courses],
  );

  const filteredResources = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return snapshot.resources;
    return snapshot.resources.filter((resource) => {
      const course = courseMap.get(resource.courseId)?.name ?? "";
      return [resource.title, resource.fileName, course, ...resource.tags]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [courseMap, search, snapshot.resources]);

  const upcomingTasks = snapshot.tasks
    .filter((task) => task.status !== "已完成")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const pendingCount = snapshot.resources.filter((resource) => resource.status === "未整理").length;
  const completedCount = snapshot.tasks.filter((task) => task.status === "已完成").length;

  const addAssistantMessage = (text: string) => {
    setMessages((current) => [...current, { id: makeId("message"), role: "assistant", text }]);
  };

  // ---------- Agent 循环接入 ----------

  const resolveCourseId = (courseName: string) => {
    const normalized = courseName.replace(/\s+/g, "").toLowerCase();
    if (!normalized) return "";
    const courses = snapshotRef.current.courses;
    return (
      courses.find((course) => course.name.replace(/\s+/g, "").toLowerCase() === normalized)?.id ??
      courses.find((course) => {
        const name = course.name.replace(/\s+/g, "").toLowerCase();
        return normalized.includes(name) || name.includes(normalized);
      })?.id ??
      ""
    );
  };

  const requestAgentStep = async (wireMessages: AgentWireMessage[]): Promise<AgentStepResponse> => {
    const response = await fetch("/api/agent/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: wireMessages,
        context: {
          currentDate: new Date().toISOString(),
          timezone: "Asia/Shanghai",
          profile: profileRef.current,
        },
      }),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      type?: "message" | "tool_calls";
      content?: string;
      calls?: AgentToolCall[];
      error?: { message?: string };
    };
    if (!response.ok || !data.ok || !data.type) {
      throw new Error(data.error?.message || "服务暂时不可用，请稍后重试。");
    }
    return { type: data.type, content: data.content ?? "", calls: data.calls ?? [] } as AgentStepResponse;
  };

  const executeAgentTool = async (call: AgentToolCall): Promise<ToolExecutionResult> => {
    const args = call.arguments;
    const snap = snapshotRef.current;
    const courseNameOf = (courseId: string) => snap.courses.find((course) => course.id === courseId)?.name ?? "未分类";

    switch (call.name) {
      case "list_courses": {
        const data = snap.courses.map((course) => ({
          name: course.name,
          semester: course.semester,
          resources: snap.resources.filter((resource) => resource.courseId === course.id).length,
        }));
        return { ok: true, summary: `共 ${data.length} 门课程`, data };
      }
      case "list_tasks": {
        const includeCompleted = args.includeCompleted === true;
        const statusFilter = asString(args.status);
        const courseFilter = asString(args.courseName);
        const withinDays = typeof args.dueWithinDays === "number" ? args.dueWithinDays : null;
        const now = Date.now();
        let tasks = snap.tasks.filter((task) => includeCompleted || task.status !== "已完成");
        if (statusFilter) tasks = tasks.filter((task) => task.status === statusFilter);
        if (courseFilter) {
          const courseId = resolveCourseId(courseFilter);
          tasks = courseId ? tasks.filter((task) => task.courseId === courseId) : [];
        }
        if (withinDays !== null) {
          tasks = tasks.filter((task) => {
            const due = new Date(task.dueAt).getTime();
            return !Number.isNaN(due) && due >= now - 86_400_000 && due <= now + withinDays * 86_400_000;
          });
        }
        tasks = [...tasks].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 20);
        return {
          ok: true,
          summary: `找到 ${tasks.length} 条任务`,
          data: tasks.map((task) => ({
            title: task.title,
            course: courseNameOf(task.courseId),
            type: task.type,
            dueAt: task.dueAt,
            status: task.status,
            priority: task.priority,
          })),
        };
      }
      case "search_resources": {
        const keyword = asString(args.keyword).trim().toLowerCase();
        const courseFilter = asString(args.courseName);
        const typeFilter = asString(args.type);
        const statusFilter = asString(args.status);
        let resources = snap.resources;
        if (courseFilter) {
          const courseId = resolveCourseId(courseFilter);
          resources = courseId ? resources.filter((resource) => resource.courseId === courseId) : [];
        }
        if (typeFilter) resources = resources.filter((resource) => resource.type === typeFilter);
        if (statusFilter) resources = resources.filter((resource) => resource.status === statusFilter);
        if (keyword) {
          resources = resources.filter((resource) =>
            [resource.title, resource.fileName, courseNameOf(resource.courseId), ...resource.tags, resource.contentText]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(keyword),
          );
        }
        const data = resources.slice(0, 10).map((resource) => ({
          title: resource.title,
          course: courseNameOf(resource.courseId),
          type: resource.type,
          tags: resource.tags,
          status: resource.status,
          fileName: resource.fileName ?? null,
          hasContent: Boolean(resource.contentText),
          contentExcerpt: resource.contentText ? contentExcerpt(resource.contentText, keyword) : null,
        }));
        return { ok: true, summary: `找到 ${data.length} 份资料`, data };
      }
      case "navigate": {
        const target = asString(args.view);
        if (!["assistant", "resources", "tasks", "review", "data"].includes(target)) {
          return { ok: false, summary: `未知页面：${target}` };
        }
        const keyword = asString(args.keyword).trim();
        if (keyword) setSearch(keyword);
        setView(target as View);
        return { ok: true, summary: `已打开「${viewLabels[target as View]}」页面` };
      }
      case "read_resource": {
        const title = asString(args.title).trim();
        const resource =
          snap.resources.find((candidate) => candidate.title === title) ??
          snap.resources.find((candidate) => candidate.title.includes(title) || (title && title.includes(candidate.title))) ??
          snap.resources.find((candidate) => candidate.fileName?.includes(title));
        if (!resource) return { ok: false, summary: `没有找到标题包含「${title}」的资料。` };
        if (!resource.contentText) {
          return { ok: true, summary: `「${resource.title}」没有已提取的正文内容（可能是手动卡片或尚未入库原文件）。`, data: { title: resource.title, hasContent: false } };
        }
        return {
          ok: true,
          summary: `已阅读「${resource.title}」`,
          data: {
            title: resource.title,
            course: courseNameOf(resource.courseId),
            type: resource.type,
            content: resource.contentText.slice(0, 3000),
          },
        };
      }
      case "remember_fact": {
        const fact = asString(args.fact).trim();
        if (!fact) return { ok: false, summary: "没有提供要记住的内容。" };
        const next = addProfileNote(profileRef.current, fact);
        profileRef.current = next;
        setProfile(next);
        saveProfile(next);
        return { ok: true, summary: `已记入长期记忆（当前共 ${next.notes.length} 条笔记）` };
      }
      case "update_task": {
        const taskTitle = asString(args.taskTitle).trim();
        const task =
          snap.tasks.find((candidate) => candidate.title === taskTitle) ??
          snap.tasks.find((candidate) => candidate.title.includes(taskTitle) || (taskTitle && taskTitle.includes(candidate.title)));
        if (!task) return { ok: false, summary: `没有找到标题包含「${taskTitle}」的任务。` };
        const patch: Partial<Task> = {};
        if (asString(args.title).trim()) patch.title = asString(args.title).trim();
        if (asString(args.dueAt).trim()) patch.dueAt = toLocalInputValue(asString(args.dueAt));
        if (["高", "中", "低"].includes(asString(args.priority))) patch.priority = asString(args.priority) as Task["priority"];
        if (["DDL", "考试", "复习"].includes(asString(args.type))) patch.type = asString(args.type) as Task["type"];
        if (!Object.keys(patch).length) return { ok: false, summary: "没有提供要修改的内容。" };
        setSnapshot((current) => ({
          ...current,
          tasks: current.tasks.map((candidate) => (candidate.id === task.id ? { ...candidate, ...patch } : candidate)),
        }));
        return { ok: true, summary: `已更新「${patch.title ?? task.title}」`, data: patch };
      }
      case "update_profile": {
        const patch: Partial<UserProfile> = {};
        if (asString(args.name).trim()) patch.name = asString(args.name);
        if (asString(args.studyTime).trim()) patch.studyTime = asString(args.studyTime);
        if (asString(args.goal).trim()) patch.goal = asString(args.goal);
        if (!Object.keys(patch).length) return { ok: false, summary: "没有提供要更新的画像内容。" };
        const next = sanitizeProfile({ ...profileRef.current, ...patch });
        profileRef.current = next;
        setProfile(next);
        saveProfile(next);
        return { ok: true, summary: "已更新长期记忆（用户画像）。", data: next };
      }
      case "update_task_status": {
        const title = asString(args.taskTitle).trim();
        const status = asString(args.status) as Task["status"];
        if (!title || !["未开始", "进行中", "已完成", "已逾期"].includes(status)) {
          return { ok: false, summary: "缺少任务标题或状态不合法。" };
        }
        const task =
          snap.tasks.find((candidate) => candidate.title === title) ??
          snap.tasks.find((candidate) => candidate.title.includes(title) || title.includes(candidate.title));
        if (!task) return { ok: false, summary: `没有找到标题包含「${title}」的任务。` };
        setSnapshot((current) => ({
          ...current,
          tasks: current.tasks.map((candidate) => (candidate.id === task.id ? { ...candidate, status } : candidate)),
        }));
        return { ok: true, summary: `已将「${task.title}」标记为${status}` };
      }
      case "create_task": {
        const title = asString(args.title).trim();
        const courseId = resolveCourseId(asString(args.courseName));
        const dueAt = toLocalInputValue(asString(args.dueAt));
        const type = (["DDL", "考试", "复习"].includes(asString(args.type)) ? asString(args.type) : "DDL") as Task["type"];
        if (!title || !courseId || !dueAt) {
          return { ok: false, summary: "任务信息不完整（名称、课程或截止时间缺失），未写入。" };
        }
        const task: Task = {
          id: makeId("task"),
          title,
          courseId,
          type,
          dueAt,
          status: "未开始",
          priority: (["高", "中", "低"].includes(asString(args.priority)) ? asString(args.priority) : "中") as Task["priority"],
          reminder: asString(args.reminder).trim() || "提前3天、1天、2小时",
        };
        setSnapshot((current) => ({ ...current, tasks: [task, ...current.tasks] }));
        return { ok: true, summary: `已创建${type}「${title}」，截止 ${formatDate(task.dueAt)}` };
      }
      case "save_review_plan": {
        const sessions = sanitizePlanSessions(args.sessions);
        if (!sessions.length) return { ok: false, summary: "复习计划为空，未写入。" };
        const courseId = resolveCourseId(asString(args.courseName));
        const tasks: Task[] = sessions.map((session) => ({
          id: makeId("task"),
          title: session.title,
          courseId,
          type: "复习",
          dueAt: toLocalInputValue(session.date),
          status: "未开始",
          priority: "中",
          reminder: "提前2小时",
        }));
        setSnapshot((current) => ({ ...current, tasks: [...tasks, ...current.tasks] }));
        return { ok: true, summary: `已保存 ${tasks.length} 个复习安排到任务中心`, data: { count: tasks.length } };
      }
      default:
        return { ok: false, summary: `未知工具：${call.name}` };
    }
  };

  const finishConfirmation = () => {
    const pending = confirmResolverRef.current;
    if (pending) window.clearTimeout(pending.timerId);
    confirmResolverRef.current = null;
    setPendingTaskConfirm(null);
    setTaskConfirmDraft(null);
    setPendingPlanConfirm(null);
    setConfirmError("");
  };

  // 打开一个确认卡片并返回 settle：卡片显示期间最多等待 3 分钟，超时自动取消，
  // 保证 Agent 循环不会因为用户切走页面 / 忘记确认而永久挂起。
  const openConfirmation = (resolve: (decision: ConfirmationDecision) => void) => {
    const settle = (decision: ConfirmationDecision) => {
      window.clearTimeout(timerId);
      resolve(decision);
    };
    const timerId = window.setTimeout(() => {
      if (confirmResolverRef.current?.settle !== settle) return;
      finishConfirmation();
      addAssistantMessage("这次确认等待太久了，我先取消了这个操作。需要的话再说一次就行。");
      resolve({ approved: false });
    }, 180_000);
    confirmResolverRef.current = { settle, timerId };
  };

  const requestToolConfirmation = (call: AgentToolCall) =>
    new Promise<ConfirmationDecision>((resolve) => {
      if (call.name === "create_task") {
        const type = asString(call.arguments.type);
        const priority = asString(call.arguments.priority);
        setTaskConfirmDraft({
          title: asString(call.arguments.title),
          courseId: resolveCourseId(asString(call.arguments.courseName)),
          type: (["DDL", "考试", "复习"].includes(type) ? type : "DDL") as Task["type"],
          dueAt: toLocalInputValue(asString(call.arguments.dueAt)),
          priority: (["高", "中", "低"].includes(priority) ? priority : "中") as Task["priority"],
          reminder: asString(call.arguments.reminder).trim() || "提前3天、1天、2小时",
        });
        setConfirmError("");
        setPendingTaskConfirm(call);
        openConfirmation(resolve);
        return;
      }
      if (call.name === "update_task") {
        const taskTitle = asString(call.arguments.taskTitle).trim();
        const snap = snapshotRef.current;
        const task =
          snap.tasks.find((candidate) => candidate.title === taskTitle) ??
          snap.tasks.find((candidate) => candidate.title.includes(taskTitle) || (taskTitle && taskTitle.includes(candidate.title)));
        if (!task) {
          // 找不到任务时直接放行，让执行器返回明确的失败信息
          resolve({ approved: true });
          return;
        }
        const priority = asString(call.arguments.priority);
        const type = asString(call.arguments.type);
        const proposedDue = asString(call.arguments.dueAt).trim();
        setTaskConfirmDraft({
          title: asString(call.arguments.title).trim() || task.title,
          courseId: task.courseId,
          type: (["DDL", "考试", "复习"].includes(type) ? type : task.type) as Task["type"],
          dueAt: proposedDue ? toLocalInputValue(proposedDue) : task.dueAt,
          priority: (["高", "中", "低"].includes(priority) ? priority : task.priority) as Task["priority"],
          reminder: task.reminder,
        });
        setConfirmError("");
        setPendingTaskConfirm(call);
        openConfirmation(resolve);
        return;
      }
      if (call.name === "save_review_plan") {
        setPendingPlanConfirm({
          courseName: asString(call.arguments.courseName),
          sessions: sanitizePlanSessions(call.arguments.sessions),
        });
        setConfirmError("");
        openConfirmation(resolve);
        return;
      }
      resolve({ approved: false });
    });

  const settleConfirmation = (decision: ConfirmationDecision) => {
    const pending = confirmResolverRef.current;
    finishConfirmation();
    pending?.settle(decision);
  };
  const approveTaskConfirm = () => {
    if (!taskConfirmDraft) return;
    if (!taskConfirmDraft.title.trim() || !taskConfirmDraft.courseId || !taskConfirmDraft.dueAt) {
      setConfirmError("请补充任务名称、课程和截止时间后再确认。");
      return;
    }
    if (pendingTaskConfirm?.name === "update_task") {
      settleConfirmation({
        approved: true,
        arguments: {
          taskTitle: asString(pendingTaskConfirm.arguments.taskTitle),
          title: taskConfirmDraft.title.trim(),
          type: taskConfirmDraft.type,
          dueAt: new Date(taskConfirmDraft.dueAt).toISOString(),
          priority: taskConfirmDraft.priority,
        },
      });
      return;
    }
    settleConfirmation({
      approved: true,
      arguments: {
        title: taskConfirmDraft.title.trim(),
        courseName: courseMap.get(taskConfirmDraft.courseId)?.name ?? "",
        type: taskConfirmDraft.type,
        dueAt: new Date(taskConfirmDraft.dueAt).toISOString(),
        priority: taskConfirmDraft.priority,
        reminder: taskConfirmDraft.reminder,
      },
    });
  };

  const approvePlanConfirm = () => {
    if (!pendingPlanConfirm || !pendingPlanConfirm.sessions.length) {
      setConfirmError("计划为空，无法保存。");
      return;
    }
    settleConfirmation({
      approved: true,
      arguments: { courseName: pendingPlanConfirm.courseName, sessions: pendingPlanConfirm.sessions },
    });
  };

  const rejectConfirm = () => settleConfirmation({ approved: false });

  const updateMessageSteps = (messageId: string, updater: (steps: ToolStep[]) => ToolStep[]) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, steps: updater(message.steps ?? []) } : message,
      ),
    );
  };

  const runAgent = async (goal: string, goalImages: string[] = [], options?: { background?: boolean }) => {
    if (agentRunningRef.current) return;
    agentRunningRef.current = true;
    setAgentRunning(true);
    // background = 主动性巡检：不阻塞用户输入，用户随时可以打断并开始自己的对话
    if (options?.background) setAgentBackground(true);
    const assistantId = makeId("message");
    setMessages((current) => [...current, { id: assistantId, role: "assistant", text: "", steps: [] }]);
    let finalText = "";
    let failed = "";
    try {
      for await (const event of runAgentLoop({
        goal,
        goalImages,
        history: agentHistoryRef.current,
        step: requestAgentStep,
        execute: executeAgentTool,
        requestConfirmation: requestToolConfirmation,
        maxSteps: 8,
      })) {
        if (event.type === "tool_call") {
          const spec = getToolSpec(event.call.name);
          updateMessageSteps(assistantId, (steps) => [
            ...steps,
            { id: event.call.id, label: spec?.label ?? event.call.name, status: "running" },
          ]);
        } else if (event.type === "tool_result") {
          updateMessageSteps(assistantId, (steps) =>
            steps.map((step) =>
              step.id === event.call.id
                ? { ...step, status: event.result.ok ? "done" : "failed", detail: event.result.summary }
                : step,
            ),
          );
        } else if (event.type === "message") {
          finalText = event.content;
          setMessages((current) =>
            current.map((message) => (message.id === assistantId ? { ...message, text: event.content } : message)),
          );
        } else if (event.type === "done" && event.reason === "error") {
          failed = event.error ?? "";
        }
      }
    } finally {
      if (!finalText) {
        finalText = failed || "这次处理没有得出结论，请换个说法再试一次。";
        setMessages((current) =>
          current.map((message) => (message.id === assistantId ? { ...message, text: finalText } : message)),
        );
      }
      const nextHistory: HistoryMessage[] = [
        ...agentHistoryRef.current,
        { role: "user", content: goal || "[图片]", images: goalImages.length ? goalImages : undefined },
        { role: "assistant", content: finalText },
      ];
      agentHistoryRef.current = nextHistory.slice(-12);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentBackground(false);
      // 上一轮结束后，自动发送排队中的用户消息（用户等待期间输入的内容不会被丢弃）
      const pending = queuedMessageRef.current;
      if (pending) {
        const pendingImages = queuedImagesRef.current;
        queuedMessageRef.current = null;
        queuedImagesRef.current = [];
        setQueuedMessage(null);
        window.setTimeout(() => { void runAgent(pending, pendingImages); }, 0);
      }
    }
  };


  const showComposerHint = (message: string, kind: "info" | "error" = "info") => {
    setComposerHint(message);
    setComposerHintKind(kind);
  };

  const syncChatImages = (next: string[]) => {
    chatImagesRef.current = next;
    setChatImages(next);
  };

  const attachChatImages = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    void Promise.all(images.slice(0, 4).map((file) => readAsDataUrl(file))).then((urls) => {
      syncChatImages([...chatImagesRef.current, ...urls].slice(0, 4));
    });
  };

  // 统一的文件入口：图片直接进对话给智能体看；PDF/Word/PPT 走资料库入库流水线。
  // 两种意图分开处理，并在界面上明确告知，避免"我选了文件但智能体看不到"。
  const handleComposerFiles = (files: File[]) => {
    if (!files.length) return;
    const images = files.filter((file) => file.type.startsWith("image/"));
    const documents = files.filter((file) => /\.(pdf|docx?|pptx?)$/i.test(file.name));
    const others = files.length - images.length - documents.length;

    if (images.length) {
      attachChatImages(images);
      showComposerHint(images.length > 1 ? `已附加 ${images.length} 张图片，可以直接问浅浅。` : "已附加图片，可以直接问浅浅。");
    }
    if (documents.length) {
      void handleAttachments(documents);
      showComposerHint(
        documents.length > 1
          ? `已把 ${documents.length} 个文件加入资料库入库队列（识别完成后需要你确认）。`
          : "已把文件加入资料库入库队列（识别完成后需要你确认）。",
      );
    }
    if (others) {
      showComposerHint(`有 ${others} 个文件格式不支持：图片可直接发给浅浅，PDF / Word / PPT 会入库到资料库。`, "error");
    }
  };

  // 提示条数秒后自动消失，避免长期占位
  useEffect(() => {
    if (!composerHint) return;
    const timer = window.setTimeout(() => setComposerHint(""), 6000);
    return () => window.clearTimeout(timer);
  }, [composerHint]);

  // 拖拽图片文件到输入区也能附加
  const handleComposerDrop = (event: React.DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    setComposerHint("");
    attachChatImages(files);
  };

  const removeChatImage = (index: number) => {
    syncChatImages(chatImagesRef.current.filter((_, i) => i !== index));
  };

  // 直接粘贴截图（Ctrl+V）
  // 注意：不同来源的剪贴板数据位置不同——截图工具常放在 files 里，
  // 而从网页「复制图片」时可能只在 items 里带 file，所以两者都要读。
  const handleComposerPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    // files 与 items 通常指向同一份图片数据：优先用 items，为空时才回退到 files，
    // 否则同一张截图会被读入两次。
    const fromItems = Array.from(clipboard.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const source = fromItems.length ? fromItems : Array.from(clipboard.files ?? []);
    const seen = new Set<string>();
    const images = source
      .filter((file) => file.type.startsWith("image/"))
      .filter((file) => {
        const key = `${file.name}:${file.size}:${file.type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!images.length) {
      // 剪贴板里只有文字/链接（例如复制的是图片网址），明确告诉用户怎么才能发进来
      const hasText = Boolean(clipboard.getData("text/plain").trim());
      showComposerHint(
        hasText
          ? "粘贴的内容里没有图片数据（可能只是图片链接或文字）。请用截图工具复制图片本身，或点右侧 ▣ 选择图片文件。"
          : "没有检测到图片，请用截图工具复制图片，或点右侧 ＋ 选择图片文件。",
        "error",
      );
      return;
    }
    event.preventDefault();
    showComposerHint("");
    attachChatImages(images);
  };

  const sendMessage = async () => {
    const text = input.trim();
    // 允许只发图片（用户可能只想问"这张图是什么"）
    if ((!text && !chatImagesRef.current.length) || batchRunningRef.current) return;
    const images = chatImagesRef.current;
    if (agentRunningRef.current) {
      // Agent 仍在处理上一条（例如后台巡检）：排队等它结束后自动发送，而不是丢消息
      setInput("");
      setMessages((current) => [...current, { id: makeId("message"), role: "user", text, images: images.length ? images : undefined }]);
      queuedMessageRef.current = text;
      queuedImagesRef.current = images;
      setQueuedMessage(text);
      return;
    }
    setMessages((current) => [...current, { id: makeId("message"), role: "user", text, images: images.length ? images : undefined }]);
    setInput("");
    syncChatImages([]);
    await runAgent(text, images);
  };

  const generateReviewPlan = (courseId: string, examAt: string, availability: string) => {
    if (agentRunningRef.current) return;
    const course = snapshot.courses.find((item) => item.id === courseId);
    const exam = new Date(examAt);
    const goal = [
      `请为「${course?.name ?? "未分类课程"}」制定复习计划。`,
      `考试或目标时间：${Number.isNaN(exam.getTime()) ? examAt : exam.toISOString()}。`,
      `我方便学习的时间：${availability || "未说明"}。`,
      "请先调用工具查询该课程的未完成任务与已有资料，再把计划拆成具体到天、每次 30-90 分钟的可执行安排，所有安排必须早于考试时间，最后调用 save_review_plan 保存。",
    ].join("");
    void runAgent(goal);
  };

  // 主动性：每天首次打开时巡检本地数据，让智能体先开口。
  useEffect(() => {
    if (!ready || modelConfigured === null) return;
    const today = new Date().toISOString().slice(0, 10);
    let alreadyShown = false;
    try {
      alreadyShown = window.localStorage.getItem(scopedLocalKey(PROACTIVE_KEY, currentUser?.id ?? null)) === today;
    } catch {
      alreadyShown = false;
    }
    if (alreadyShown) return;
    const signals = computeProactiveSignals(snapshotRef.current);
    if (!signals.length) return;
    try {
      window.localStorage.setItem(scopedLocalKey(PROACTIVE_KEY, currentUser?.id ?? null), today);
    } catch {
      // 忽略存储失败，明天再提醒一次也无妨
    }
    if (modelConfigured) {
      void runAgent(buildProactiveGoal(signals), [], { background: true });
    } else {
      addAssistantMessage(buildProactiveFallback(signals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, modelConfigured]);

  // 真正的定时提醒：每 60 秒按任务提醒规则巡检，触发对话内提醒 + 桌面通知。
  useEffect(() => {
    if (!ready) return;
    const check = () => {
      const fired = loadFiredReminders();
      const due = computeDueReminders(snapshotRef.current.tasks, new Date(), fired);
      if (!due.length) return;
      due.forEach((reminder) => fired.add(reminder.key));
      saveFiredReminders(fired);
      due.forEach((reminder) => {
        const text = reminder.minutesLeft > 0
          ? `⏰ 提醒：「${reminder.title}」（${reminder.type}）还有 ${formatMinutesLeft(reminder.minutesLeft)} 截止。需要我帮你安排复习或调整计划吗？`
          : `⏰ 「${reminder.title}」（${reminder.type}）已到截止时间。完成后告诉我，我帮你标记；没完成的话可以帮你顺延。`;
        addAssistantMessage(text);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("浅浅提醒", { body: `${reminder.title} · ${reminder.offsetLabel}` });
        }
      });
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [ready]);

  // ---------- 文件智能入库流水线（由用户上传触发，识别结果仍需确认后入库） ----------

  const requestExtraction = async (request: ExtractRequest, signal?: AbortSignal) => {
    const response = await fetch("/api/ai/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        ...request,
        courseNames: snapshot.courses.map((course) => course.name),
        currentDate: new Date().toISOString(),
        timezone: "Asia/Shanghai",
      }),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      result?: ExtractResult;
      error?: { message?: string };
    };
    if (!response.ok || !data.result) {
      throw new Error(data.error?.message || "在线识别失败，请手动检查。 ");
    }
    setModelConfigured(true);
    return data.result;
  };

  const updateImportQueueItem = (
    id: string,
    updater: (item: ImportQueueItem) => ImportQueueItem,
  ) => {
    setImportQueue((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  };

  const processImportItems = async (items: ImportQueueItem[]) => {
    if (!items.length || batchRunningRef.current) return;
    batchRunningRef.current = true;
    setBatchRunning(true);
    let readyCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;

    try {
      for (const item of items) {
        if (cancelledImportIdsRef.current.has(item.id)) {
          cancelledCount += 1;
          continue;
        }

        updateImportQueueItem(item.id, (current) => ({
          ...current,
          status: "processing",
          error: undefined,
          failureKind: undefined,
        }));
        const controller = new AbortController();
        importAbortControllersRef.current.set(item.id, controller);

        try {
          let result: ExtractResult;
          let contentText = "";
          if (isPdfImportFile(item.file)) {
            const extraction = await extractPdfForImport(item.file, controller.signal);
            contentText = extraction.text.slice(0, 20000);
            if (extraction.text) {
              result = await requestExtraction(
                { mode: "text", text: extraction.text, fileName: item.file.name },
                controller.signal,
              );
            } else if (extraction.previewImages.length) {
              // 扫描版 PDF 的逐页视觉识别改为并行，3 页延迟从 3x 降到 1x
              const pageResults = await Promise.all(
                extraction.previewImages.map((imageDataUrl, index) =>
                  requestExtraction(
                    {
                      mode: "image",
                      imageDataUrl,
                      fileName: `${item.file.name}（第${index + 1}页）`,
                    },
                    controller.signal,
                  ),
                ),
              );
              result = mergeExtractResults(pageResults);
            } else {
              result = await requestExtraction(
                { mode: "filename", fileName: item.file.name },
                controller.signal,
              );
            }
          } else if (isImageImportFile(item.file) && item.file.size <= 10 * 1024 * 1024) {
            const imageDataUrl = await readAsDataUrl(item.file);
            if (cancelledImportIdsRef.current.has(item.id)) throw new DOMException("Cancelled", "AbortError");
            result = await requestExtraction(
              { mode: "image", imageDataUrl, fileName: item.file.name },
              controller.signal,
            );
          } else {
            contentText = await extractSearchableText(item.file);
            result = await requestExtraction(
              { mode: "filename", fileName: item.file.name },
              controller.signal,
            );
          }

          if (cancelledImportIdsRef.current.has(item.id)) throw new DOMException("Cancelled", "AbortError");
          const draft = buildImportDraft(result, item.file, snapshot.courses);
          updateImportQueueItem(item.id, (current) => ({
            ...current,
            ...draft,
            contentText: (contentText || result.summary).slice(0, 20000),
            status: "awaiting_confirmation",
            error: undefined,
            failureKind: undefined,
          }));
          readyCount += 1;
        } catch (error) {
          if ((error instanceof DOMException && error.name === "AbortError") || cancelledImportIdsRef.current.has(item.id)) {
            updateImportQueueItem(item.id, (current) => ({ ...current, status: "cancelled", error: undefined }));
            cancelledCount += 1;
          } else {
            const message = error instanceof Error ? error.message : "在线识别暂时不可用。";
            updateImportQueueItem(item.id, (current) => ({
              ...current,
              status: "failed",
              resourceDraft: buildFallbackImportDraft(item.file, snapshot.courses),
              includeTask: false,
              error: `${message} 可重试，或按文件名手动整理。`,
              failureKind: "processing",
            }));
            failedCount += 1;
          }
        } finally {
          importAbortControllersRef.current.delete(item.id);
        }
      }
    } finally {
      batchRunningRef.current = false;
      setBatchRunning(false);
    }

    const details = [
      readyCount ? `${readyCount} 个待确认` : "",
      failedCount ? `${failedCount} 个失败` : "",
      cancelledCount ? `${cancelledCount} 个已取消` : "",
    ].filter(Boolean).join("，");
    if (details) addAssistantMessage(`本批次处理完成：${details}。确认前不会写入资料库。`);
  };

  const handleAttachments = async (files: File[]) => {
    if (!files.length || agentRunningRef.current) return;
    if (batchRunningRef.current) {
      setExtractError("当前批次仍在处理中，请完成或取消后再添加新文件。");
      return;
    }

    setExtractError("");
    const validation = validateImportSelection(files);
    if (validation.batchError) {
      setExtractError(`${validation.batchError} 当前选择共 ${formatBytes(validation.totalBytes)}。`);
      addAssistantMessage("这批文件没有加入队列，请减少文件数量或拆成多个批次。 ");
      return;
    }

    const acceptedItems: ImportQueueItem[] = validation.accepted.map((file) => ({
      id: makeId("import"),
      file,
      status: "queued",
      includeTask: false,
    }));
    const rejectedItems: ImportQueueItem[] = validation.rejected.map(({ file, message }) => ({
      id: makeId("import"),
      file,
      status: "failed",
      includeTask: false,
      error: message,
      failureKind: "validation",
    }));
    const nextItems = [...acceptedItems, ...rejectedItems];
    setImportQueue((current) => [...current, ...nextItems]);
    setMessages((current) => [
      ...current,
      { id: makeId("message"), role: "user", text: `已选择 ${files.length} 个文件，共 ${formatBytes(validation.totalBytes)}` },
    ]);
    if (rejectedItems.length) {
      addAssistantMessage(`${rejectedItems.length} 个文件未通过格式或大小校验，原因已显示在队列中。`);
    }
    await processImportItems(acceptedItems);
  };

  const cancelImportItem = (id: string) => {
    cancelledImportIdsRef.current.add(id);
    importAbortControllersRef.current.get(id)?.abort();
    updateImportQueueItem(id, (item) => ({ ...item, status: "cancelled", error: undefined }));
  };

  const retryImportItem = async (id: string) => {
    if (batchRunningRef.current) return;
    const item = importQueue.find((candidate) => candidate.id === id);
    if (!item || item.failureKind === "validation") return;
    if (item.failureKind === "storage" && item.resourceDraft) {
      updateImportQueueItem(id, (current) => ({
        ...current,
        status: "awaiting_confirmation",
        error: undefined,
        failureKind: undefined,
      }));
      return;
    }
    cancelledImportIdsRef.current.delete(id);
    const queuedItem: ImportQueueItem = {
      ...item,
      status: "queued",
      error: undefined,
      failureKind: undefined,
    };
    updateImportQueueItem(id, () => queuedItem);
    await processImportItems([queuedItem]);
  };

  const confirmImportItem = async (id: string) => {
    const item = importQueue.find((candidate) => candidate.id === id);
    const draft = item?.resourceDraft;
    if (!item || item.status !== "awaiting_confirmation" || !draft || savingImportIdsRef.current.has(id)) return;
    if (!draft.title.trim() || !draft.courseId) {
      updateImportQueueItem(id, (current) => ({ ...current, error: "请补充资料名称和课程后再确认。" }));
      return;
    }
    if (item.includeTask && item.taskDraft && (!item.taskDraft.title.trim() || !item.taskDraft.courseId || !item.taskDraft.dueAt)) {
      updateImportQueueItem(id, (current) => ({ ...current, error: "DDL 信息不完整：请补充任务名称、课程和截止时间，或取消勾选“同时保存”。" }));
      return;
    }

    savingImportIdsRef.current.add(id);
    updateImportQueueItem(id, (current) => ({ ...current, status: "saving", error: undefined }));
    const resourceId = makeId("resource");
    try {
      const fileRecord = await saveLocalFile(resourceId, item.file);
      const resource: Resource = {
        id: resourceId,
        title: draft.title.trim(),
        courseId: draft.courseId,
        type: draft.type,
        tags: draft.tags,
        status: "未整理",
        importedAt: new Date().toISOString().slice(0, 10),
        fileName: item.file.name,
        fileId: fileRecord.id,
        fileSize: fileRecord.size,
        mimeType: fileRecord.type,
        contentText: item.contentText?.slice(0, 20000) || undefined,
      };
      const task = item.includeTask && item.taskDraft
        ? { ...item.taskDraft, id: makeId("task") }
        : null;
      setSnapshot((current) => ({
        ...current,
        resources: [resource, ...current.resources],
        tasks: task ? [task, ...current.tasks] : current.tasks,
      }));
      updateImportQueueItem(id, (current) => ({ ...current, status: "saved", error: undefined }));
      addAssistantMessage(`“${draft.title.trim()}”已保存到本地资料库${task ? "，关联 DDL 也已创建" : ""}。`);
    } catch {
      updateImportQueueItem(id, (current) => ({
        ...current,
        status: "failed",
        error: "浏览器没有足够空间保存原文件，请清理空间后重试。",
        failureKind: "storage",
      }));
    } finally {
      savingImportIdsRef.current.delete(id);
    }
  };

  const updateImportResource = (id: string, patch: Partial<PendingResourceDraft>) => {
    updateImportQueueItem(id, (item) => item.resourceDraft
      ? { ...item, resourceDraft: { ...item.resourceDraft, ...patch }, error: undefined }
      : item);
  };

  const updateImportTask = (id: string, patch: Partial<Task>) => {
    updateImportQueueItem(id, (item) => item.taskDraft
      ? { ...item, taskDraft: { ...item.taskDraft, ...patch }, error: undefined }
      : item);
  };

  const toggleImportTask = (id: string, include: boolean) => {
    updateImportQueueItem(id, (item) => ({ ...item, includeTask: include }));
  };

  const useManualImportDraft = (id: string) => {
    updateImportQueueItem(id, (item) => item.resourceDraft
      ? { ...item, status: "awaiting_confirmation", error: undefined, includeTask: false }
      : item);
  };

  const removeImportItem = (id: string) => {
    importAbortControllersRef.current.get(id)?.abort();
    cancelledImportIdsRef.current.delete(id);
    setImportQueue((current) => current.filter((item) => item.id !== id));
  };

  const clearFinishedImports = () => {
    importQueue.forEach((item) => {
      if (item.status === "saved" || item.status === "cancelled") cancelledImportIdsRef.current.delete(item.id);
    });
    setImportQueue((current) => current.filter((item) => item.status !== "saved" && item.status !== "cancelled"));
  };

  // ---------- 手动表单与数据管理 ----------

  const updateTaskStatus = (taskId: string, status: Task["status"]) => {
    setSnapshot((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, status } : task)),
    }));
  };

  const createResource = () => {
    if (!resourceTitle.trim() || !resourceCourse) return;
    const resource: Resource = {
      id: makeId("resource"),
      title: resourceTitle.trim(),
      courseId: resourceCourse,
      type: resourceType,
      tags: [resourceType, "待整理"],
      status: "未整理",
      importedAt: new Date().toISOString().slice(0, 10),
    };
    setSnapshot((current) => ({ ...current, resources: [resource, ...current.resources] }));
    setResourceTitle("");
    setShowResourceForm(false);
  };

  const createTask = () => {
    if (!taskTitle.trim() || !taskCourse || !taskDueAt) return;
    const task: Task = {
      id: makeId("task"),
      title: taskTitle.trim(),
      courseId: taskCourse,
      type: "DDL",
      dueAt: taskDueAt,
      status: "未开始",
      priority: "中",
      reminder: "提前3天、1天、2小时",
    };
    setSnapshot((current) => ({ ...current, tasks: [task, ...current.tasks] }));
    setTaskTitle("");
    setShowTaskForm(false);
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ ...snapshot, profile }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qianqian-备份-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importBackup = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result)) as AppSnapshot & { profile?: UserProfile };
        if (!Array.isArray(imported.courses) || !Array.isArray(imported.resources) || !Array.isArray(imported.tasks)) {
          throw new Error("invalid backup");
        }
        setSnapshot({ courses: imported.courses, resources: imported.resources, tasks: imported.tasks });
        if (imported.profile) {
          const nextProfile = sanitizeProfile(imported.profile);
          setProfile(nextProfile);
          saveProfile(nextProfile);
        }
        addAssistantMessage("备份已载入当前浏览器。请检查课程、资料和任务数量是否符合预期。");
      } catch {
        addAssistantMessage("这个备份文件无法读取。请确认它是浅浅导出的 JSON 备份。");
      }
    };
    reader.readAsText(file);
  };

  const resetDemo = () => {
    const next = demoSnapshot();
    setSnapshot(next);
    addAssistantMessage("示例数据已恢复。你可以在此基础上继续添加自己的课程、资料和任务。");
  };

  // ---------- 账号管理（仅管理员） ----------

  const createAccount = async (input: { username: string; displayName: string; password: string; role: "admin" | "user" }): Promise<string | null> => {
    const validated = validateNewAccount({ ...input, accounts });
    if (!validated.ok) return validated.message;
    const account = await buildAccount({ ...input, username: validated.username, displayName: validated.displayName });
    const next = [...accounts, account];
    setAccounts(next);
    saveAccounts(next);
    return null;
  };

  const toggleAccountDisabled = (userId: string) => {
    if (userId === currentUser?.id) return;
    const next = accounts.map((account) =>
      account.id === userId ? { ...account, disabled: !account.disabled } : account,
    );
    setAccounts(next);
    saveAccounts(next);
  };

  const resetAccountPassword = async (userId: string, password: string): Promise<string | null> => {
    if (password.length < 6) return "密码至少 6 位。";
    const target = findAccountById(accounts, userId);
    if (!target) return "找不到该账号。";
    const rebuilt = await buildAccount({ username: target.username, displayName: target.displayName, password, role: target.role });
    const next = accounts.map((account) =>
      account.id === userId ? { ...rebuilt, id: target.id, createdAt: target.createdAt } : account,
    );
    setAccounts(next);
    saveAccounts(next);
    return null;
  };

  const deleteAccount = async (userId: string) => {
    if (userId === currentUser?.id) return;
    const next = accounts.filter((account) => account.id !== userId);
    setAccounts(next);
    saveAccounts(next);
    // 同时清除该账号在本机留下的数据（IndexedDB 命名空间 + 记忆键）
    try {
      indexedDB.deleteDatabase(`study-agent-local__${userId}`);
      window.localStorage.removeItem(`study-agent-profile::${userId}`);
      window.localStorage.removeItem(`study-agent-reminders-fired::${userId}`);
      window.localStorage.removeItem(`study-agent-snapshot::${userId}`);
    } catch {
      // 清理失败不影响账号移除
    }
  };

  const exportICalendar = () => {
    const blob = new Blob([buildICalendar(snapshot)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qianqian-日历-${new Date().toISOString().slice(0, 10)}.ics`;
    link.click();
    URL.revokeObjectURL(url);
    addAssistantMessage("日历文件已导出，导入系统日历后，DDL 和复习安排会出现在你的日历应用里。");
  };

  const enableNotifications = async () => {
    if (typeof Notification === "undefined") {
      addAssistantMessage("当前浏览器不支持桌面通知，我会在对话列表里提醒你。");
      return;
    }
    const permission = await Notification.requestPermission();
    addAssistantMessage(
      permission === "granted"
        ? "桌面提醒已开启。任务临近截止时（按提醒规则：提前 3 天、1 天、2 小时），我会弹出系统通知。"
        : "没有获得通知权限。你仍会在对话里收到提醒；想开桌面通知可以在浏览器设置里允许。",
    );
  };

  if (!authReady) {
    return <main className="auth-shell"><div className="auth-card"><div className="auth-brand"><div className="brand-mark">浅</div><div><div className="brand-name">浅浅</div><div className="brand-caption">qianqian</div></div></div><p className="auth-copy">正在准备…</p></div></main>;
  }

  if (!currentUser) {
    return <LoginScreen accounts={accounts.map(toPublicAccount)} onLogin={login} />;
  }

  return (
    <>
    <main className="app-shell" ref={appRef}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">浅</div>
          <div>
            <div className="brand-name">浅浅</div>
            <div className="brand-caption">qianqian</div>
          </div>
        </div>

        <nav className="main-nav" aria-label="主导航">
          {(Object.keys(viewLabels) as View[]).filter((item) => item !== "accounts" || currentUser.role === "admin").map((item) => (
            <button
              className={`nav-item ${view === item ? "active" : ""}`}
              key={item}
              onClick={() => setView(item)}
            >
              <span className="nav-dot">{item === "assistant" ? "✦" : item === "resources" ? "▣" : item === "tasks" ? "◷" : item === "review" ? "✓" : item === "accounts" ? "☰" : "⚙"}</span>
              <span>{viewLabels[item]}</span>
              {item === "tasks" && upcomingTasks.length > 0 ? <span className="nav-count">{upcomingTasks.length}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-section">
          <div className="section-label">我的课程</div>
          {snapshot.courses.map((course) => (
            <button className="course-row" key={course.id} onClick={() => { setSearch(course.name); setView("resources"); }}>
              <span className={`course-swatch ${course.color}`} />
              <span>{course.name}</span>
              <span className="course-count">{snapshot.resources.filter((resource) => resource.courseId === course.id).length}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-user">
          <span className={`role-badge ${currentUser.role}`}>{currentUser.role === "admin" ? "管理员" : "学生"}</span>
          <div className="sidebar-user-main">
            <strong>{currentUser.displayName}</strong>
            <small>@{currentUser.username}</small>
          </div>
          <button className="text-button" onClick={logout}>登出</button>
        </div>

        <div className="sidebar-footer">
          <span className="local-indicator" />
          <span>浅浅 · qianqian</span>
        </div>
      </aside>

      <section className="main-area">
        <div className="ambient-glow ambient-glow-one" aria-hidden="true" />
        <div className="ambient-glow ambient-glow-two" aria-hidden="true" />
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark small">浅</span>浅浅</div>
          <div className="breadcrumb">{viewLabels[view]} <span>/</span> {view === "assistant" ? "今天" : "全部内容"}</div>
          <label className="global-search">
            <span>⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") setView("resources"); }}
              placeholder="搜索资料、任务或课程"
              aria-label="搜索资料、任务或课程"
            />
          </label>
          <button className="icon-button" title="本地数据管理" onClick={() => setView("data")}>⚙</button>
        </header>

        <div className="content-wrap view-surface" data-view={view}>
          {view === "assistant" ? (
            <AssistantView
              messages={messages}
              input={input}
              setInput={setInput}
              onSend={sendMessage}
              agentRunning={agentRunning}
              agentBackground={agentBackground}
              queuedMessage={queuedMessage}
              conversations={conversations}
              conversationGroups={groupConversationsByDate(conversations)}
              activeConversationId={activeConversationId}
              showConversations={showConversationList}
              onToggleConversations={() => setShowConversationList((current) => !current)}
              onNewConversation={startNewConversation}
              onOpenConversation={switchConversation}
              onDeleteConversation={removeConversation}
              chatImages={chatImages}
              composerFileInputRef={composerFileInputRef}
              composerHint={composerHint}
              composerHintKind={composerHintKind}
              onPickFiles={handleComposerFiles}
              onRemoveImage={removeChatImage}
              onPasteImage={handleComposerPaste}
              onDropImage={handleComposerDrop}
              pendingTaskConfirm={pendingTaskConfirm}
              taskConfirmDraft={taskConfirmDraft}
              setTaskConfirmDraft={setTaskConfirmDraft}
              pendingPlanConfirm={pendingPlanConfirm}
              confirmError={confirmError}
              onApproveTask={approveTaskConfirm}
              onApprovePlan={approvePlanConfirm}
              onRejectConfirm={rejectConfirm}
              courses={snapshot.courses}
              extractError={extractError}
              modelConfigured={modelConfigured}
              importQueue={importQueue}
              batchRunning={batchRunning}

              onImportResourceChange={updateImportResource}
              onImportTaskChange={updateImportTask}
              onToggleImportTask={toggleImportTask}
              onConfirmImport={confirmImportItem}
              onCancelImport={cancelImportItem}
              onRetryImport={retryImportItem}
              onManualImport={useManualImportDraft}
              onRemoveImport={removeImportItem}
              onClearFinishedImports={clearFinishedImports}
              upcomingTasks={upcomingTasks}
              courseMap={courseMap}
              pendingCount={pendingCount}
              completedCount={completedCount}
              onNavigate={setView}
            />
          ) : null}

          {view === "resources" ? (
            <ResourcesView
              resources={filteredResources}
              courseMap={courseMap}
              courses={snapshot.courses}
              search={search}
              onSearch={setSearch}
              showForm={showResourceForm}
              setShowForm={setShowResourceForm}
              title={resourceTitle}
              setTitle={setResourceTitle}
              courseId={resourceCourse}
              setCourseId={setResourceCourse}
              type={resourceType}
              setType={setResourceType}
              onCreate={createResource}
            />
          ) : null}

          {view === "tasks" ? (
            <TasksView
              tasks={upcomingTasks}
              courseMap={courseMap}
              courses={snapshot.courses}
              showForm={showTaskForm}
              setShowForm={setShowTaskForm}
              title={taskTitle}
              setTitle={setTaskTitle}
              courseId={taskCourse}
              setCourseId={setTaskCourse}
              dueAt={taskDueAt}
              setDueAt={setTaskDueAt}
              onCreate={createTask}
              onComplete={(taskId) => updateTaskStatus(taskId, "已完成")}
            />
          ) : null}

          {view === "review" ? (
            <ReviewView
              courses={snapshot.courses}
              running={agentRunning}
              plan={pendingPlanConfirm}
              confirmError={confirmError}
              onGenerate={generateReviewPlan}
              onApprovePlan={approvePlanConfirm}
              onRejectPlan={rejectConfirm}
            />
          ) : null}

          {view === "accounts" && currentUser.role === "admin" ? (
            <AccountPanel
              accounts={accounts.map(toPublicAccount)}
              currentUserId={currentUser.id}
              onCreate={createAccount}
              onToggleDisabled={toggleAccountDisabled}
              onResetPassword={resetAccountPassword}
              onDelete={deleteAccount}
            />
          ) : null}

          {view === "data" ? (
            <DataView
              snapshot={snapshot}
              profile={profile}
              onSaveProfile={(next) => { const cleaned = sanitizeProfile(next); setProfile(cleaned); saveProfile(cleaned); addAssistantMessage("你的画像已更新，智能体之后的每一轮思考都会记住。 "); }}
              onExport={exportBackup}
              onExportICal={exportICalendar}
              onEnableNotifications={enableNotifications}
              onImport={() => importInputRef.current?.click()}
              onFile={importBackup}
              onReset={resetDemo}
              inputRef={importInputRef}
            />
          ) : null}
        </div>
      </section>
    </main>
    {view !== "assistant" && pendingTaskConfirm && taskConfirmDraft ? (
      <div className="confirm-overlay rescue-overlay" role="dialog" aria-label="浅浅请求写入任务">
        <div className="action-card confirm-sheet">
          <div className="action-label">{pendingTaskConfirm.name === "update_task" ? "浅浅请求写入 · 修改任务" : "浅浅请求写入 · 新任务"}</div>
          <input
            className="action-title-input"
            value={taskConfirmDraft.title}
            onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, title: event.target.value } : current)}
            aria-label="任务名称"
          />
          <div className="action-edit-grid">
            <label><span>课程</span><select value={taskConfirmDraft.courseId} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, courseId: event.target.value } : current)}><option value="">请选择课程</option>{snapshot.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>
            <label><span>截止</span><input type="datetime-local" value={taskConfirmDraft.dueAt} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, dueAt: event.target.value } : current)} /></label>
            <label><span>类型</span><select value={taskConfirmDraft.type} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, type: event.target.value as Task["type"] } : current)}><option>DDL</option><option>考试</option><option>复习</option></select></label>
            <label><span>提醒</span><input value={taskConfirmDraft.reminder} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, reminder: event.target.value } : current)} /></label>
          </div>
          {confirmError ? <div className="queue-error">{confirmError}</div> : null}
          <div className="action-buttons"><button className="primary-button" onClick={approveTaskConfirm}>确认并保存</button><button className="quiet-button" onClick={rejectConfirm}>取消</button></div>
          <small className="confirm-hint">浅浅正在等你确认，确认前不会写入任何数据。</small>
        </div>
      </div>
    ) : null}
    {view !== "review" && pendingPlanConfirm ? (
      <div className="confirm-overlay rescue-overlay" role="dialog" aria-label="浅浅请求保存复习计划">
        <div className="action-card confirm-sheet">
          <PlanConfirmCard plan={pendingPlanConfirm} error={confirmError} onApprove={approvePlanConfirm} onReject={rejectConfirm} />
          <small className="confirm-hint">浅浅正在等你确认，确认前不会写入任何数据。</small>
        </div>
      </div>
    ) : null}
    {showIntro ? <StudyIntro onComplete={() => setShowIntro(false)} /> : null}
    </>
  );
}

function AssistantView({
  messages,
  input,
  setInput,
  onSend,
  agentRunning,
  agentBackground,
  queuedMessage,
  conversations,
  conversationGroups,
  activeConversationId,
  showConversations,
  onToggleConversations,
  onNewConversation,
  onOpenConversation,
  onDeleteConversation,
  chatImages,
  composerFileInputRef,
  composerHint,
  composerHintKind,
  onPickFiles,
  onRemoveImage,
  onPasteImage,
  onDropImage,
  pendingTaskConfirm,
  taskConfirmDraft,
  setTaskConfirmDraft,
  pendingPlanConfirm,
  confirmError,
  onApproveTask,
  onApprovePlan,
  onRejectConfirm,
  courses,
  extractError,
  modelConfigured,
  importQueue,
  batchRunning,

  onImportResourceChange,
  onImportTaskChange,
  onToggleImportTask,
  onConfirmImport,
  onCancelImport,
  onRetryImport,
  onManualImport,
  onRemoveImport,
  onClearFinishedImports,
  upcomingTasks,
  courseMap,
  pendingCount,
  completedCount,
  onNavigate,
}: {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  onSend: () => void | Promise<void>;
  agentRunning: boolean;
  agentBackground: boolean;
  queuedMessage: string | null;
  conversations: ConversationRecord[];
  conversationGroups: Array<{ label: string; items: ConversationRecord[] }>;
  activeConversationId: string | null;
  showConversations: boolean;
  onToggleConversations: () => void;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  chatImages: string[];
  composerFileInputRef: React.RefObject<HTMLInputElement | null>;
  composerHint: string;
  composerHintKind: "info" | "error";
  onPickFiles: (files: File[]) => void;
  onRemoveImage: (index: number) => void;
  onPasteImage: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onDropImage: (event: React.DragEvent<HTMLElement>) => void;
  pendingTaskConfirm: AgentToolCall | null;
  taskConfirmDraft: TaskConfirmDraft | null;
  setTaskConfirmDraft: React.Dispatch<React.SetStateAction<TaskConfirmDraft | null>>;
  pendingPlanConfirm: PlanConfirmState | null;
  confirmError: string;
  onApproveTask: () => void;
  onApprovePlan: () => void;
  onRejectConfirm: () => void;
  courses: Course[];
  extractError: string;
  modelConfigured: boolean | null;
  importQueue: ImportQueueItem[];
  batchRunning: boolean;

  onImportResourceChange: (id: string, patch: Partial<PendingResourceDraft>) => void;
  onImportTaskChange: (id: string, patch: Partial<Task>) => void;
  onToggleImportTask: (id: string, include: boolean) => void;
  onConfirmImport: (id: string) => void | Promise<void>;
  onCancelImport: (id: string) => void;
  onRetryImport: (id: string) => void | Promise<void>;
  onManualImport: (id: string) => void;
  onRemoveImport: (id: string) => void;
  onClearFinishedImports: () => void;
  upcomingTasks: Task[];
  courseMap: Map<string, Course>;
  pendingCount: number;
  completedCount: number;
  onNavigate: (view: View) => void;
}) {
  const today = new Date();
  // 消息列表自动贴底：发送后始终显示最新内容，而不是停在顶部第一条
  const messageListRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const handleMessageScroll = () => {
    const el = messageListRef.current;
    if (!el) return;
    // 距底部 80px 内视为"正在跟读最新消息"
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    // 用户自己发的消息一定跟到底部；其余更新只在原本就贴底时才跟随
    if (last?.role === "user") stickToBottomRef.current = true;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);
  // 等待用户确认时不锁定输入：用户仍可浏览、打字，确认卡片在智能体页或兜底浮层里可见
  const busy = (agentRunning && !agentBackground && !pendingTaskConfirm && !pendingPlanConfirm) || batchRunning;
  return (
    <div className="assistant-layout">
      <div className="assistant-column">
        <div className="eyebrow">{today.toLocaleDateString("en-US", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).toUpperCase()}</div>

        <div className="chat-panel">
          <div className="chat-head">
            <span className={`online-dot ${modelConfigured === false ? "offline" : ""}`} />
            浅浅
            <span className="head-note" title={modelConfigured === null ? "正在检查" : modelConfigured ? "在线" : "手动模式"}>
              {modelConfigured === null ? "正在检查" : modelConfigured ? "在线" : "手动模式"}
            </span>

          </div>

          <div className="message-list" ref={messageListRef} onScroll={handleMessageScroll}>
            {messages.map((message, messageIndex) => (
              <div
                className={`message-row ${message.role} gsap-message ${messageIndex === messages.length - 1 ? "gsap-message-latest" : ""}`}
                key={message.id}
              >
                <div className="avatar">{message.role === "assistant" ? "浅" : "我"}</div>
                <div className="message-stack">
                  {message.images?.length ? (
                    <div className="message-images">
                      {message.images.map((image, index) => (

                        <img key={`${message.id}-img-${index}`} src={image} alt={`消息附图 ${index + 1}`} />
                      ))}
                    </div>
                  ) : null}
                  <div className="message-bubble">
                    {message.text ? message.text : (
                      <span className="thinking-placeholder"><span className="progress-spinner" />正在思考与行动…</span>
                    )}
                  </div>
                  {message.steps?.length ? (
                    <div className="tool-steps" aria-label="智能体行动轨迹">
                      {message.steps.map((step) => (
                        <span className={`tool-step ${step.status}`} key={step.id} title={step.detail ?? step.label}>
                          {step.status === "running" ? <span className="progress-spinner" /> : step.status === "done" ? "✓" : "✕"}
                          {step.label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}

            {pendingTaskConfirm && taskConfirmDraft ? (
              <div className="action-card gsap-action-card inline-confirm">
                <div className="action-label">{pendingTaskConfirm.name === "update_task" ? "浅浅请求写入 · 修改任务" : "浅浅请求写入 · 新任务"}</div>
                <input
                  className="action-title-input"
                  value={taskConfirmDraft.title}
                  onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, title: event.target.value } : current)}
                  aria-label="任务名称"
                />
                <div className="action-edit-grid">
                  <label><span>课程</span><select value={taskConfirmDraft.courseId} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, courseId: event.target.value } : current)}><option value="">请选择课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>
                  <label><span>截止</span><input type="datetime-local" value={taskConfirmDraft.dueAt} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, dueAt: event.target.value } : current)} /></label>
                  <label><span>类型</span><select value={taskConfirmDraft.type} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, type: event.target.value as Task["type"] } : current)}><option>DDL</option><option>考试</option><option>复习</option></select></label>
                  <label><span>提醒</span><input value={taskConfirmDraft.reminder} onChange={(event) => setTaskConfirmDraft((current) => current ? { ...current, reminder: event.target.value } : current)} /></label>
                </div>
                {confirmError ? <div className="queue-error">{confirmError}</div> : null}
                <div className="action-buttons"><button className="primary-button" onClick={onApproveTask}>确认并保存</button><button className="quiet-button" onClick={onRejectConfirm}>取消</button></div>
              </div>
            ) : null}
            {pendingPlanConfirm ? (
              <PlanConfirmCard plan={pendingPlanConfirm} error={confirmError} onApprove={onApprovePlan} onReject={onRejectConfirm} />
            ) : null}
            <div className="gsap-queue-wrap">
            <BatchImportQueue
              items={importQueue}
              courses={courses}
              running={batchRunning}
              onResourceChange={onImportResourceChange}
              onTaskChange={onImportTaskChange}
              onToggleTask={onToggleImportTask}
              onConfirm={onConfirmImport}
              onCancel={onCancelImport}
              onRetry={onRetryImport}
              onManual={onManualImport}
              onRemove={onRemoveImport}
              onClearFinished={onClearFinishedImports}
            />
            </div>
            {extractError ? <div className="extract-error">{extractError}</div> : null}
          </div>
          {queuedMessage ? <div className="queued-note"><span className="progress-spinner" />已排队，等浅浅完成当前任务后会自动发送</div> : null}
          {composerHint ? <div className={`composer-hint ${composerHintKind}`}>{composerHint}</div> : null}
          {chatImages.length ? (
            <div className="chat-image-strip" aria-label="待发送图片">
              {chatImages.map((image, index) => (
                <div className="chat-image-tile" key={`${image.slice(0, 32)}-${index}`}>

                  <img src={image} alt={`待发送图片 ${index + 1}`} />
                  <button type="button" aria-label={`移除图片 ${index + 1}`} onClick={() => onRemoveImage(index)}>×</button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="composer">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !busy) onSend(); }}
              onPaste={(event) => { if (!busy) onPasteImage(event); }}
              onDrop={(event) => { if (!busy) onDropImage(event); }}
              onDragOver={(event) => event.preventDefault()}
              placeholder="交给浅浅：查 DDL、找资料、安排复习…也可以直接粘贴或拖入截图"
              aria-label="输入学习管理需求"
              disabled={busy}
            />
            <input
              ref={composerFileInputRef}
              data-testid="composer-file-input"
              type="file"
              accept="image/*,.pdf,.doc,.docx,.ppt,.pptx"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                onPickFiles(files);
                event.currentTarget.value = "";
              }}
            />
            <button className="attach-button" title="选择图片直接发给浅浅看；选择 PDF/Word/PPT 则入库到资料库" onClick={() => composerFileInputRef.current?.click()} disabled={busy}>＋</button>
            <button className="send-button" onClick={onSend} aria-label="发送" disabled={busy}>{busy ? "·" : "↑"}</button>
          </div>
        </div>

        <div className="quick-actions">
          <button onClick={() => setInput("帮我记下这个DDL：")}>＋ 录入 DDL</button>
          <button onClick={() => setInput("我下周有什么要交的？")}>◷ 下周截止</button>
          <button onClick={() => setInput("帮我把数据库的课件找出来")}>⌕ 查找资料</button>
          <button onClick={() => onNavigate("review")}>✦ 生成复习计划</button>
        </div>
      </div>

      <aside className="dashboard-rail">
        <div className="rail-section conversation-rail">
          <div className="section-heading">
            <span>对话</span>
            <button className="rail-new-chat" onClick={onNewConversation} title="开始一个新对话">＋ 新对话</button>
          </div>
          <button
            className="rail-toggle"
            onClick={onToggleConversations}
            aria-expanded={showConversations ? "true" : "false"}
          >
            <span>对话记录{conversations.length ? ` · ${conversations.length}` : ""}</span>
            <span aria-hidden="true">{showConversations ? "▴" : "▾"}</span>
          </button>
          {showConversations ? (
            <div className="conversation-panel" aria-label="历史对话">
              {conversationGroups.length ? conversationGroups.map((group) => (
                <div className="conversation-group" key={group.label}>
                  <div className="conversation-group-label">{group.label}</div>
                  {group.items.map((conversation) => (
                    <div className={`conversation-row ${conversation.id === activeConversationId ? "active" : ""}`} key={conversation.id}>
                      <button className="conversation-open" onClick={() => onOpenConversation(conversation.id)}>
                        <strong>{conversation.title}</strong>
                        <small>{formatConversationStamp(conversation.updatedAt)} · {conversation.messages.length} 条</small>
                      </button>
                      <button className="conversation-delete" aria-label={`删除对话 ${conversation.title}`} onClick={() => onDeleteConversation(conversation.id)}>×</button>
                    </div>
                  ))}
                </div>
              )) : <div className="conversation-empty">还没有历史对话。发出第一条消息后会自动保存。</div>}
            </div>
          ) : null}
        </div>

        <div className="date-card"><span>{String(today.getDate()).padStart(2, "0")}</span><div><b>{today.getMonth() + 1}月</b><small>{today.getFullYear()} · 第 {weekNumber(today)} 周</small></div></div>
        <div className="stat-grid"><div><strong>{upcomingTasks.length}</strong><span>待完成任务</span></div><div><strong>{pendingCount}</strong><span>待整理资料</span></div><div><strong>{completedCount}</strong><span>本周完成</span></div></div>
        <div className="rail-section"><div className="section-heading"><span>接下来</span><button onClick={() => onNavigate("tasks")}>查看全部 →</button></div>
          {upcomingTasks.slice(0, 3).map((task) => <TaskMini key={task.id} task={task} course={courseMap.get(task.courseId)} />)}
        </div>
        <div className="tip-card"><span className="tip-kicker">浅浅说明</span><p>我会自己调用工具查证后再回答；创建任务和复习计划前，会先弹出确认卡片等你点头。</p><span className="tip-line" /></div>
      </aside>
    </div>
  );
}

function PlanConfirmCard({ plan, error, onApprove, onReject }: { plan: PlanConfirmState; error: string; onApprove: () => void; onReject: () => void }) {
  return (
    <div className="action-card gsap-action-card">
      <div className="action-label">浅浅请求写入 · 复习计划（{plan.courseName || "未指定课程"}）</div>
      <div className="plan-session-list">
        {plan.sessions.map((session) => (
          <div className="plan-item" key={`${session.date}-${session.title}`}>
            <time>{formatDate(session.date)}</time>
            <div><strong>{session.title}</strong><span>将创建为复习任务</span></div>
            <b>{session.durationMinutes}分钟</b>
          </div>
        ))}
      </div>
      {error ? <div className="queue-error">{error}</div> : null}
      <div className="action-buttons"><button className="primary-button" onClick={onApprove}>确认保存</button><button className="quiet-button" onClick={onReject}>取消</button></div>
    </div>
  );
}

function TaskMini({ task, course }: { task: Task; course?: Course }) {
  return <div className="task-mini"><div className={`task-marker ${task.priority === "高" ? "high" : ""}`} /><div><strong>{task.title}</strong><span>{course?.name ?? "未分类"} · {formatShortDate(task.dueAt)}</span></div><b>{task.type}</b></div>;
}

function ResourcesView({
  resources, courseMap, courses, search, onSearch, showForm, setShowForm, title, setTitle, courseId, setCourseId, type, setType, onCreate,
}: {
  resources: Resource[];
  courseMap: Map<string, Course>;
  courses: Course[];
  search: string;
  onSearch: (value: string) => void;
  showForm: boolean;
  setShowForm: (value: boolean) => void;
  title: string;
  setTitle: (value: string) => void;
  courseId: string;
  setCourseId: (value: string) => void;
  type: Resource["type"];
  setType: (value: Resource["type"]) => void;
  onCreate: () => void;
}) {
  const [selectedId, setSelectedId] = useState(resources[0]?.id ?? "");
  const selectedResource = resources.find((resource) => resource.id === selectedId) ?? resources[0] ?? null;

  return <div className="page-view"><PageHeader eyebrow="LIBRARY" title="课程资料库" description="让每份资料有位置，也有下一步。" action={<button className="primary-button" onClick={() => setShowForm(!showForm)}>＋ 添加资料</button>} />
    {showForm ? <div className="inline-form"><div className="form-title">新建资料卡片 <span>若要保存原文件并自动识别，请在浅浅页面点击“＋”上传</span></div><div className="form-grid"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="资料名称" /><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><select value={type} onChange={(event) => setType(event.target.value as Resource["type"])}><option>课件</option><option>作业</option><option>笔记</option><option>通知</option><option>试卷</option><option>其他</option></select><button className="primary-button" onClick={onCreate}>保存资料</button></div></div> : null}
    <div className="toolbar"><label className="local-search"><span>⌕</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索标题、课程、标签" /></label><div className="filter-chip">全部课程⌄</div><div className="filter-chip">全部状态⌄</div></div>
    <div className="resource-layout"><div className="resource-list"><div className="list-meta">{resources.length} 份资料 <span>· 本地索引</span></div>{resources.map((resource) => <ResourceListItem key={resource.id} resource={resource} course={courseMap.get(resource.courseId)} selected={selectedResource?.id === resource.id} onSelect={() => setSelectedId(resource.id)} />)}{resources.length === 0 ? <EmptyState title="还没有匹配资料" copy="试试换个关键词，或手动添加一张资料卡片。" /> : null}</div><LocalResourcePreview key={`${selectedResource?.id ?? "empty"}-${selectedResource?.fileId ?? "none"}`} resource={selectedResource} course={selectedResource ? courseMap.get(selectedResource.courseId) : undefined} /></div>
  </div>;
}

function ResourceListItem({ resource, course, selected, onSelect }: { resource: Resource; course?: Course; selected: boolean; onSelect: () => void }) {
  return <button className={`resource-item ${selected ? "selected" : ""}`} onClick={onSelect}><span className={`file-badge ${resource.type === "作业" ? "coral" : resource.type === "笔记" ? "blue" : ""}`}>{resource.type.slice(0, 1)}</span><span className="resource-main"><strong>{resource.title}</strong><small>{course?.name ?? "未分类"} · {resource.fileName ?? "手动资料卡片"}</small><span className="tag-line">{resource.tags.map((tag) => <em key={tag}>{tag}</em>)}</span></span><span className="resource-status">{resource.status}</span><span className="chevron">›</span></button>;
}

function LocalResourcePreview({ resource, course }: { resource: Resource | null; course?: Course }) {
  const [preview, setPreview] = useState<LocalPreview | null>(null);
  const [loading, setLoading] = useState(Boolean(resource?.fileId));
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let currentPreview: LocalPreview | null = null;
    if (!resource?.fileId) return;
    getLocalFile(resource.fileId)
      .then(async (record) => {
        if (!record) throw new Error("FILE_NOT_FOUND");
        currentPreview = await buildLocalPreview(record);
        if (active) setPreview(currentPreview);
      })
      .catch(() => { if (active) setError("原始文件无法读取，可能已被浏览器清理。 "); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      releaseLocalPreview(currentPreview);
    };
  }, [resource?.fileId]);

  if (!resource) {
    return <div className="preview-panel"><div className="preview-top"><span>资料预览</span><span className="preview-tag">预览</span></div><div className="preview-placeholder"><div className="paper-icon">▤</div><strong>选择一份资料</strong><span>原始文件、课程标签和学习状态会显示在这里。</span></div></div>;
  }

  return (
    <div className="preview-panel live-preview">
      <div className="preview-top"><span>资料预览</span><span className="preview-tag">文件</span></div>
      <div className="preview-resource-head">
        <strong>{resource.title}</strong>
        <span>{course?.name ?? "未分类"} · {resource.type} · {resource.fileSize ? formatBytes(resource.fileSize) : "资料卡片"}</span>
      </div>
      {loading ? <div className="preview-loading"><span className="progress-spinner" />正在生成本地预览…</div> : null}
      {error ? <div className="preview-error">{error}</div> : null}
      {!resource.fileId ? <div className="preview-placeholder compact"><div className="paper-icon">▤</div><strong>示例资料卡片</strong><span>这条记录没有原始文件。通过智能体“＋”上传后，可在此预览。</span></div> : null}
      {preview?.kind === "image" ? <img className="image-preview" src={preview.url} alt={resource.title} /> : null}
      {preview?.kind === "pdf" ? <iframe className="pdf-preview" src={preview.url} title={resource.title} /> : null}
      {preview?.kind === "word" ? <div className="word-preview">{preview.paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>)}</div> : null}
      {preview?.kind === "slides" ? <div className="slides-preview">{preview.slides.map((slide) => <section key={slide.number}><span>SLIDE {String(slide.number).padStart(2, "0")}</span>{slide.lines.length ? slide.lines.map((line, index) => index === 0 ? <h3 key={`${index}-${line}`}>{line}</h3> : <p key={`${index}-${line}`}>{line}</p>) : <p>空白幻灯片</p>}</section>)}</div> : null}
      {preview?.kind === "unsupported" ? <div className="preview-placeholder compact"><div className="paper-icon">!</div><strong>暂时无法渲染</strong><span>{preview.message}</span></div> : null}
      <div className="preview-note">原始文件保存在当前浏览器中。</div>
    </div>
  );
}

function TasksView({ tasks, courseMap, courses, showForm, setShowForm, title, setTitle, courseId, setCourseId, dueAt, setDueAt, onCreate, onComplete }: { tasks: Task[]; courseMap: Map<string, Course>; courses: Course[]; showForm: boolean; setShowForm: (value: boolean) => void; title: string; setTitle: (value: string) => void; courseId: string; setCourseId: (value: string) => void; dueAt: string; setDueAt: (value: string) => void; onCreate: () => void; onComplete: (id: string) => void; }) {
  return <div className="page-view"><PageHeader eyebrow="TASK DESK" title="任务中心" description="DDL、考试和复习时段，放在同一条时间线上。" action={<button className="primary-button" onClick={() => setShowForm(!showForm)}>＋ 新建任务</button>} />
    {showForm ? <div className="inline-form"><div className="form-title">新建 DDL <span>默认提醒：提前 3 天、1 天、2 小时</span></div><div className="form-grid task-form"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="任务名称" /><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /><button className="primary-button" onClick={onCreate}>保存任务</button></div></div> : null}
    <div className="task-list-wrap"><div className="task-list-head"><span>未完成任务 · {tasks.length}</span><div><span className="legend-dot high" />高优先级 <span className="legend-dot" />普通</div></div>{tasks.map((task) => <div className="task-row" key={task.id}><div className={`task-marker ${task.priority === "高" ? "high" : ""}`} /><div className="task-row-main"><strong>{task.title}</strong><span>{courseMap.get(task.courseId)?.name ?? "未分类"} · {task.type} · {task.reminder}</span></div><time>{formatDate(task.dueAt)}</time><span className={`status-pill ${task.status === "进行中" ? "working" : ""}`}>{task.status}</span><button className="complete-button" onClick={() => onComplete(task.id)}>完成</button></div>)}{tasks.length === 0 ? <EmptyState title="所有任务都完成了" copy="可以去复习计划，安排下一步学习。" /> : null}</div>
  </div>;
}

function ReviewView({ courses, running, plan, confirmError, onGenerate, onApprovePlan, onRejectPlan }: { courses: Course[]; running: boolean; plan: PlanConfirmState | null; confirmError: string; onGenerate: (courseId: string, examAt: string, availability: string) => void; onApprovePlan: () => void; onRejectPlan: () => void; }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [examAt, setExamAt] = useState(() => toLocalInputValue(new Date(Date.now() + 7 * 86_400_000).toISOString()));
  const [availability, setAvailability] = useState("工作日晚上 19:00–21:00");
  const [justSaved, setJustSaved] = useState(false);
  const course = courses.find((item) => item.id === courseId);

  return <div className="page-view"><PageHeader eyebrow="REVIEW STUDIO" title="复习计划" description="浅浅会先查询你的真实任务和资料，再把计划排成可以完成的节奏。" action={<span className="soft-badge">Agent 生成 · 需确认</span>} />
    <div className="review-layout"><div className="review-form-card"><div className="card-kicker">STEP 01 · 先说你的时间</div><h2>为哪门课准备？</h2><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><label>考试或复习截止时间<input type="datetime-local" value={examAt} onChange={(event) => setExamAt(event.target.value)} /></label><label>你什么时候方便学习？<input value={availability} onChange={(event) => setAvailability(event.target.value)} placeholder="例如：周一到周五晚上" /></label><div className="availability-chips"><button onClick={() => setAvailability("工作日晚上 19:00–21:00")}>工作日晚上</button><button onClick={() => setAvailability("周末上午 09:00–12:00")}>周末上午</button><button onClick={() => setAvailability("每天 60 分钟")}>每天1小时</button></div><button className="primary-button wide" disabled={running || !courseId} onClick={() => { setJustSaved(false); onGenerate(courseId, examAt, availability); }}>{running ? "智能体规划中…" : "生成计划草案"}</button><small className="form-help">智能体会先查询「{course?.name ?? "课程"}」的未完成任务和已有资料，再制定计划。</small></div><div className="plan-preview-card">{plan ? <><div className="plan-head"><div><div className="card-kicker">STEP 02 · 草案待确认</div><h2>{plan.courseName || course?.name || "课程"} · 复习节奏</h2></div><span className="soft-badge">{availability}</span></div>{plan.sessions.map((session) => <PlanItem key={`${session.date}-${session.title}`} date={formatShortDate(session.date)} title={session.title} duration={`${session.durationMinutes}分钟`} />)}{confirmError ? <div className="queue-error">{confirmError}</div> : null}<div className="plan-actions"><button className="primary-button" onClick={() => { onApprovePlan(); setJustSaved(true); }}>确认保存</button><button className="quiet-button" onClick={onRejectPlan}>放弃草案</button></div></> : justSaved ? <div className="empty-plan"><div className="plan-orbit">✓</div><h2>计划已保存</h2><p>复习安排已写入任务中心，到点会在任务列表中出现。</p></div> : running ? <div className="empty-plan"><span className="progress-spinner" /><h2>智能体正在规划</h2><p>正在查询任务与资料，并把复习安排拆到具体日期。</p></div> : <div className="empty-plan"><div className="plan-orbit">✦</div><h2>计划会出现在这里</h2><p>选择课程并告诉我你有空的时间，智能体会基于真实数据生成一份可确认的草案。</p></div>}</div></div>
  </div>;
}

function PlanItem({ date, title, duration }: { date: string; title: string; duration: string }) { return <div className="plan-item"><time>{date}</time><div><strong>{title}</strong><span>关联资料 · 可调整</span></div><b>{duration}</b></div>; }

function DataView({ snapshot, profile, onSaveProfile, onExport, onExportICal, onEnableNotifications, onImport, onFile, onReset, inputRef }: { snapshot: AppSnapshot; profile: UserProfile; onSaveProfile: (profile: UserProfile) => void; onExport: () => void; onExportICal: () => void; onEnableNotifications: () => void | Promise<void>; onImport: () => void; onFile: (file?: File) => void; onReset: () => void; inputRef: React.RefObject<HTMLInputElement | null>; }) {
  const [draft, setDraft] = useState<UserProfile>(profile);
  return (
    <div className="page-view">
      <PageHeader eyebrow="DATA" title="数据管理" description="在这里备份、恢复与整理你的学习空间。" />
      <div className="data-grid">
        <div className="data-card primary-data">
          <div className="card-kicker">BACKUP</div>
          <h2>这是你的个人学习空间</h2>
          <p>使用备份文件可以在浏览器或设备之间迁移你的课程、资料、任务与对话。</p>
          <div className="data-stats"><div><strong>{snapshot.courses.length}</strong><span>门课程</span></div><div><strong>{snapshot.resources.length}</strong><span>份资料</span></div><div><strong>{snapshot.tasks.length}</strong><span>条任务</span></div></div>
          <div className="data-actions"><button className="primary-button" onClick={onExport}>下载本地备份</button><button className="quiet-button" onClick={onImport}>恢复备份</button><button className="quiet-button" onClick={onExportICal}>导出日历 (.ics)</button><button className="quiet-button" onClick={onEnableNotifications}>开启桌面提醒</button><input ref={inputRef} type="file" accept="application/json" hidden onChange={(event) => onFile(event.target.files?.[0])} /></div>
        </div>
        <div className="data-card">
          <div className="card-kicker">AGENT MEMORY</div>
          <h3>我的画像 · 长期记忆</h3>
          <p>浅浅每一轮思考、制定计划时都会参考这些信息。也可以在对话中直接告诉它，它会自己记住。</p>
          <div className="form-grid profile-form">
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="怎么称呼你" />
            <input value={draft.studyTime} onChange={(event) => setDraft({ ...draft, studyTime: event.target.value })} placeholder="方便学习的时间，如：工作日晚上" />
            <input value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} placeholder="本学期目标，如：数据库期末 90 分" />
          </div>
          <div className="data-actions"><button className="primary-button" onClick={() => onSaveProfile(draft)}>保存画像</button></div>
        </div>
        <div className="data-card">
          <div className="card-kicker">CURRENT STATUS</div>
          <h3>当前能力</h3>
          <ul className="check-list">
            <li><span>✓</span>Agent 循环：多步推理 + 工具调用</li>
            <li><span>✓</span>资料正文检索：入库文件内容可读可问</li>
            <li><span>✓</span>定时提醒：对话提醒 + 桌面通知</li>
            <li><span>✓</span>跨会话记忆：对话历史 + 记忆笔记</li>
            <li><span>✓</span>计划可调整：update_task 顺延与修改</li>
            <li><span>✓</span>写入操作先弹确认卡片</li>
            <li><span>✓</span>主动巡检临近 DDL 并先开口</li>
            <li><span>✓</span>iCal 日历导出</li>
          </ul>
          <button className="text-button" onClick={onReset}>恢复示例数据</button>
        </div>
      </div>
    </div>
  );
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isPdfImportFile(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function toLocalInputValue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sanitizePlanSessions(value: unknown): PlanSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const date = typeof record.date === "string" ? record.date : "";
      const durationMinutes = typeof record.durationMinutes === "number" && record.durationMinutes > 0 ? Math.round(record.durationMinutes) : 45;
      if (!title || !date || Number.isNaN(new Date(date).getTime())) return null;
      return { date, title, durationMinutes };
    })
    .filter((session): session is PlanSession => session !== null)
    .slice(0, 14);
}

function weekNumber(date: Date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.max(1, Math.ceil(((date.getTime() - start.getTime()) / 86_400_000 + start.getDay() + 1) / 7));
}

// 按账号隔离的 localStorage 键：避免切换账号时读到上一个账号的标记
function scopedLocalKey(base: string, userId: string | null) {
  return userId ? `${base}::${userId}` : base;
}

const PROACTIVE_KEY = "study-agent-proactive-date";

function contentExcerpt(contentText: string, keyword: string) {
  const text = contentText.replace(/\s+/g, " ").trim();
  if (!keyword) return text.slice(0, 160);
  const index = text.toLowerCase().indexOf(keyword);
  if (index < 0) return text.slice(0, 160);
  const start = Math.max(0, index - 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, index + keyword.length + 100)}${index + keyword.length + 100 < text.length ? "…" : ""}`;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action ? <div className="page-header-action">{action}</div> : null}</div>; }

function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><div className="empty-symbol">＋</div><strong>{title}</strong><span>{copy}</span></div>; }































































