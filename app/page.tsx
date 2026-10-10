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
  deleteLocalFile,
  loadChatLog,
  loadConversations,
  loadHiddenPresets,
  loadSnapshot,
  moveCourse,
  normalizeCourseOrder,
  saveConversation,
  makeId,
  hidePreset,
  saveLocalFile,
  saveSnapshot,
  setDataScope,
  sortCourses,
} from "./lib/local-store";
import type { ChatLogRecord, ConversationRecord } from "./lib/local-store";
import { deriveConversationTitle, formatConversationStamp, groupConversationsByDate } from "./agent/conversations";
import { deleteCloud, mergeCloud, mergeConversations, pullCloud, pushCloud, serverFileUrl, touchSnapshot, uploadFileToServer } from "./lib/cloud-sync";
import {
  buildReminderText,
  deriveTaskStatus,
  formatReminderMinutes,
  groupTasks,
  isDueToday,
  isOverdueGroup,
  isPresetReminder,
  parseReminderText,
  REMINDER_CHOICES,
} from "./lib/task-utils";
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
import { applyPresets, isPresetCourseId, isPresetResourceId } from "./lib/presets";
import { loadPreferences, savePreferences } from "./lib/preferences";
import type { Preferences } from "./lib/preferences";
import { fitSessionsToAvailability, parseAvailability } from "./lib/availability";
import { formatPlanDate, formatSessionDetail, hasSessionDetail, planSummary, sanitizePlanSessions } from "./lib/review-plan";
import type { PlanSession } from "./lib/review-plan";

import type { PublicAccount } from "./lib/accounts";

/** 服务端登录用户（数据库 users 表） */
type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
};
import { runAgentLoop } from "./agent/loop";
import type { ConfirmationDecision, HistoryMessage, ToolExecutionResult } from "./agent/loop";
import type { AgentStepResponse, AgentToolCall, AgentWireMessage } from "./agent/protocol";
import { safeSlice } from "./agent/protocol";
import { getToolSpec } from "./agent/tools";
import { extractSearchableText } from "./lib/content-extract";
import { buildICalendar } from "./lib/ical";
import { addProfileNote, loadProfile, saveProfile, sanitizeProfile, setMemoryScope } from "./agent/memory";
import { setReminderScope } from "./agent/reminders";
import { computeDueReminders, formatMinutesLeft, loadFiredReminders, saveFiredReminders } from "./agent/reminders";
import type { UserProfile } from "./agent/memory";
import { buildProactiveFallback, buildProactiveGoal, computeProactiveSignals } from "./agent/triggers";

gsap.registerPlugin(useGSAP);

type View = "assistant" | "resources" | "tasks" | "review" | "settings" | "accounts";

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
  /** 详细计划（模型叫 update_task 时会带上） */
  detail?: string;
};

type PlanConfirmState = {
  courseName: string;
  sessions: PlanSession[];
  /** 因为要落在用户方便的时间窗里，做了哪些调整 */
  adjustment?: string;
};

/** 复习计划页的状态：空闲 / 正在规划 / 这次没排出草案 */
type ReviewPlanStatus = {
  state: "idle" | "running" | "empty";
  courseId?: string;
  courseName?: string;
  /** 没排成的原因：浅浅手上还有事 / 在等另一张确认卡 */
  busy?: "running" | "confirm";
  /** 没排成时浅浅说了什么（直接显示出来，省得用户再去对话里找） */
  reply?: string;
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
  settings: "设置",
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
  // 界面偏好（本机设置）：动画开关
  const [preferences, setPreferences] = useState<Preferences>({ animations: true });
  const [preferencesReady, setPreferencesReady] = useState(false);
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
  // 桌面通知权限：数据管理页要显示当前状态
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
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
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [newCourseName, setNewCourseName] = useState("");
  // 侧栏课程拖拽排序
  const [draggingCourseId, setDraggingCourseId] = useState<string | null>(null);
  const [dragOverCourseId, setDragOverCourseId] = useState<string | null>(null);
  // 正在确认删除的课程
  const [pendingCourseDelete, setPendingCourseDelete] = useState<string | null>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [resourceTitle, setResourceTitle] = useState("");
  const [resourceCourse, setResourceCourse] = useState("");
  const [resourceType, setResourceType] = useState<Resource["type"]>("课件");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskCourse, setTaskCourse] = useState("");
  const [taskDueAt, setTaskDueAt] = useState(() => defaultTaskDueAt());
  const [taskType, setTaskType] = useState<Task["type"]>("DDL");
  const [taskPriority, setTaskPriority] = useState<Task["priority"]>("中");
  const [taskReminder, setTaskReminder] = useState("提前1天");
  const [taskResourceId, setTaskResourceId] = useState("");
  const [taskImages, setTaskImages] = useState<string[]>([]);
  const [taskDetail, setTaskDetail] = useState("");
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  // 管理员面板用的服务端账号列表
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [authReady, setAuthReady] = useState(false);
  // 云同步状态
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "error" | "offline">("idle");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState("");
  const [profile, setProfile] = useState<UserProfile>({ name: "", studyTime: "", goal: "", notes: [] });
  const [pendingTaskConfirm, setPendingTaskConfirm] = useState<AgentToolCall | null>(null);
  const pendingTaskConfirmRef = useRef<AgentToolCall | null>(null);
  const [taskConfirmDraft, setTaskConfirmDraft] = useState<TaskConfirmDraft | null>(null);
  const [pendingPlanConfirm, setPendingPlanConfirm] = useState<PlanConfirmState | null>(null);
  // 复习计划页：正在排 / 没排出来 的反馈，避免"点了没反应"
  const [reviewPlanStatus, setReviewPlanStatus] = useState<ReviewPlanStatus>({ state: "idle" });
  // 这次复习计划是为哪门课排的：模型没给准课程名时用它兜底
  const reviewTargetCourseRef = useRef("");
  // 用户说的空闲时间与考试时间：排计划时的硬约束
  const reviewAvailabilityRef = useRef("");
  const reviewDeadlineRef = useRef<number | null>(null);
  const reviewRunIdRef = useRef(0);
  const reviewPlanArrivedRunRef = useRef(0);
  const pendingPlanConfirmRef = useRef<PlanConfirmState | null>(null);
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
  // 上一次做过 updatedAt 打标的快照：用来判断"这一轮到底改了哪几条记录"
  const syncedSnapshotRef = useRef<AppSnapshot>(emptySnapshot());
  const conversationsRef = useRef(conversations);
  const profileRef = useRef(profile);

  useGSAP(() => {
    if (!preferences.animations) return;
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
  }, { scope: appRef, dependencies: [preferences.animations] });

  useGSAP((_, contextSafe) => {
    if (!preferences.animations) return;
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
  }, { scope: appRef, dependencies: [preferences.animations] });

  // 只在"切换页面"时播一次整页入场。
  // 以前这里依赖了确认卡和入库队列，于是生成复习计划 / 收到确认卡时整页会重播一次，
  // 看起来就是"页面跳一下再出来"——现在拆开：整页只认 view。
  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(
      ".view-surface .page-view, .view-surface .assistant-layout",
      { y: 16, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.42, ease: "power2.out" },
    );
  }, {
    scope: appRef,
    dependencies: [view],
  });

  // 新出现的卡片（确认卡、入库队列条目）单独播一次入场；
  // 已经出现过的卡片不会再播，避免整屏重排造成的跳动。
  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fresh = gsap.utils
      .toArray<HTMLElement>(".view-surface .gsap-action-card, .view-surface .queue-item")
      .filter((element) => !element.dataset.entered);
    if (!fresh.length) return;
    fresh.forEach((element) => { element.dataset.entered = "1"; });
    gsap.fromTo(
      fresh,
      { y: 12, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.32, stagger: 0.045, ease: "power2.out", overwrite: "auto" },
    );
  }, {
    scope: appRef,
    dependencies: [view, Boolean(pendingTaskConfirm), Boolean(pendingPlanConfirm), importQueue.length],
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


  // 登录：切换数据作用域后再加载该账号自己的数据
  // 切换账号：先同步切换所有存储作用域，再加载该账号自己的数据
  // 把本机数据推送到服务端（服务端逐记录按 updatedAt 取较新者，不做整包覆盖）
  const pushToCloud = async (options?: { manual?: boolean }) => {
    if (!currentUser) return;
    setSyncState("syncing");
    const result = await pushCloud({
      courses: snapshotRef.current.courses,
      resources: snapshotRef.current.resources,
      tasks: snapshotRef.current.tasks,
      conversations: conversationsRef.current,
      profile: profileRef.current,
    });
    if (result.ok) {
      setSyncState("idle");
      setLastSyncedAt(new Date().toISOString());
      setSyncMessage("");
      if (options?.manual) addAssistantMessage("已同步到云端。换设备登录同一账号就能看到这些数据。");
    } else {
      setSyncState("error");
      setSyncMessage(result.message);
      if (options?.manual) addAssistantMessage(`同步失败：${result.message}`);
    }
  };

  const openUserWorkspace = async (account: SessionUser) => {
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

    // 先拉云端数据，与本地按 updatedAt 合并（较新者胜）
    let merged = stored;
    let mergedConversations = savedConversations;
    let mergedProfile = loadProfile();
    let cloudOk = false;
    try {
      const pulled = await pullCloud();
      if (pulled.ok) {
        cloudOk = true;
        const result = mergeCloud(stored, pulled.data);
        merged = result.snapshot;
        mergedConversations = mergeConversations(savedConversations, pulled.data.conversations);
        if (pulled.data.profile?.name || pulled.data.profile?.notes?.length) {
          mergedProfile = { ...mergedProfile, ...pulled.data.profile };
        }
        if (result.changed) void saveSnapshot(merged);
        if (mergedConversations !== savedConversations) {
          for (const conversation of mergedConversations) void saveConversation(conversation);
        }
        if (mergedProfile !== loadProfile()) {
          saveProfile(mergedProfile);
          setProfile(mergedProfile);
        }
        setLastSyncedAt(new Date().toISOString());
      }
    } catch {
      cloudOk = false;
    }
    setSyncState(cloudOk ? "idle" : "offline");
    if (!cloudOk) setSyncMessage("离线模式：数据保存在本机，联网后会自动同步。");

    const next = merged.courses.length ? { ...merged, courses: normalizeCourseOrder(merged.courses) } : demoSnapshot();
    // 登录/合并后的这一份就是"已知最新"，不要给它打新时间戳，否则会把其它设备刚改的数据顶掉
    syncedSnapshotRef.current = next;
    // 预设课程与预设课件：每个账号都补一份（用户删过的除外）。
    // 基准留在 next 上，这样新补进来的预设会被正常打上时间戳并同步到云端。
    const withPresets = applyPresets(next, loadHiddenPresets());
    setSnapshot(withPresets);
    if (!stored.courses.length) void saveSnapshot(withPresets);

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
    conversationList = mergeConversations(mergedConversations, conversationList);
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
    setReviewPlanStatus({ state: "idle" });
    reviewTargetCourseRef.current = "";
    setPendingTaskConfirm(null);
    setTaskConfirmDraft(null);
    setPendingPlanConfirm(null);
    setResourceCourse(withPresets.courses[0]?.id ?? "");
    setTaskCourse(withPresets.courses[0]?.id ?? "");
    setView("assistant");
    setReady(true);
  };

  // 启动时向服务端确认登录态（Cookie 会话），已登录则直接恢复工作区
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const body = (await response.json()) as { user?: SessionUser | null };
        if (cancelled) return;
        if (body.user) {
          await openUserWorkspace(body.user);
          if (!cancelled) setCurrentUser(body.user);
        }
      } catch {
        // 离线时保持未登录状态
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 会话记录 ↔ 界面消息
  function toChatMessages(records: ChatLogRecord[]): ChatMessage[] {
    return records.map((record) => ({ id: record.id, role: record.role, text: record.text, steps: record.steps, images: record.images }));
  }

  function toHistory(records: ChatLogRecord[]): HistoryMessage[] {
    return records
      .filter((record) => record.text.trim())
      .slice(-12)
      .map((record) => ({ role: record.role, content: record.text, images: record.images }));
  }

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
    conversationsRef.current = next;
    void deleteConversationRecord(id);
    // 同时上报服务端，否则刷新拉取时会把这个对话"复活"
    void deleteCloud("conversations", [id]);
    if (id === activeConversationId) openConversation(next[0] ?? null);
  };

  // 登录：服务端校验 → 建立 Cookie 会话 → 打开该账号的工作区并同步云端数据
  const login = async (username: string, password: string): Promise<string | null> => {
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = (await response.json()) as { ok?: boolean; user?: SessionUser; error?: { message?: string } };
      if (!response.ok || !body.ok || !body.user) return body.error?.message ?? "登录失败，请稍后重试。";
      await openUserWorkspace(body.user);
      setCurrentUser(body.user);
      return null;
    } catch {
      return "无法连接服务端，请检查网络后重试。";
    }
  };

  const register = async (username: string, displayName: string, password: string): Promise<string | null> => {
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, displayName, password }),
      });
      const body = (await response.json()) as { ok?: boolean; user?: SessionUser; error?: { message?: string } };
      if (!response.ok || !body.ok || !body.user) return body.error?.message ?? "注册失败，请稍后重试。";
      await openUserWorkspace(body.user);
      setCurrentUser(body.user);
      return null;
    } catch {
      return "无法连接服务端，请检查网络后重试。";
    }
  };

  const logout = async () => {
    // 先停用持久化（ready=false），再清空账号作用域，避免登出瞬间把数据写进默认命名空间
    setReady(false);
    setCurrentUser(null);
    setDataScope("");
    setMemoryScope("");
    setReminderScope("");
    setSyncState("idle");
    setLastSyncedAt(null);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 网络异常时本地已登出，服务端会话会自然过期
    }
  };

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    pendingPlanConfirmRef.current = pendingPlanConfirm;
  }, [pendingPlanConfirm]);

  useEffect(() => {
    pendingTaskConfirmRef.current = pendingTaskConfirm;
  }, [pendingTaskConfirm]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

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

  // 读取本机偏好：关掉动画时连片头都不渲染（放在微任务里，避免 SSR 与首屏不一致）
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const stored = loadPreferences();
      setPreferences(stored);
      setPreferencesReady(true);
      if (!stored.animations) setShowIntro(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleAnimations = (next: boolean) => {
    const updated = { ...preferences, animations: next };
    setPreferences(updated);
    savePreferences(updated);
    if (!next) setShowIntro(false);
    addAssistantMessage(next ? "界面动画已开启。" : "界面动画已关闭：片头和过渡都不会再出现。");
  };

  useEffect(() => {
    if (ready && currentUser) {
      const stamped = touchSnapshot(syncedSnapshotRef.current, snapshot);
      syncedSnapshotRef.current = stamped;
      // 没有变化时 touchSnapshot 会返回原对象，这里就什么都不做，避免无限渲染
      if (stamped === snapshot) {
        saveSnapshot(snapshot);
      } else {
        snapshotRef.current = stamped;
        saveSnapshot(stamped);
        setSnapshot(stamped);
      }
    }
  }, [ready, snapshot, currentUser]);

  // 管理员打开账号管理页时，从服务端加载真实账号列表
  useEffect(() => {
    if (view === "accounts" && currentUser?.role === "admin") void loadServerAccounts();
  }, [view, currentUser]);

  // 自动云同步：本地数据/对话/画像变化后，延迟 4 秒推送到服务端
  useEffect(() => {
    if (!ready || !currentUser) return;
    const timer = window.setTimeout(() => {
      void pushToCloud();
    }, 4000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, conversations, profile, ready, currentUser]);

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

  // 侧栏课程按用户拖拽后的顺序展示
  const orderedCourses = useMemo(() => sortCourses(snapshot.courses), [snapshot.courses]);

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

  function addAssistantMessage(text: string) {
    setMessages((current) => [...current, { id: makeId("message"), role: "assistant", text }]);
  }

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

  // 模型用资料标题提到某份资料时，找到对应的资料 id（找不到就返回空）
  const resolveResourceId = (name: string) => {
    const normalized = name.replace(/\s+/g, "").toLowerCase();
    if (!normalized) return "";
    const resources = snapshotRef.current.resources;
    return (
      resources.find((item) => item.title.replace(/\s+/g, "").toLowerCase() === normalized)?.id ??
      resources.find((item) => (item.fileName ?? "").replace(/\s+/g, "").toLowerCase() === normalized)?.id ??
      resources.find((item) => {
        const title = item.title.replace(/\s+/g, "").toLowerCase();
        return normalized.includes(title) || title.includes(normalized);
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
        if (statusFilter) tasks = tasks.filter((task) => deriveTaskStatus(task) === statusFilter);
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
            status: deriveTaskStatus(task),
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
        const requested = asString(args.view);
        // 旧的 data 参数映射到现在的「设置」页
        const target = requested === "data" ? "settings" : requested;
        if (!["assistant", "resources", "tasks", "review", "settings"].includes(target)) {
          return { ok: false, summary: `未知页面：${requested}` };
        }
        const keyword = asString(args.keyword).trim();
        if (keyword) setSearch(keyword);
        setView(target as View);
        return { ok: true, summary: `已打开「${viewLabels[target as View]}」页面` };
      }
      case "create_course": {
        const name = asString(args.name).trim();
        if (!name) return { ok: false, summary: "缺少课程名称。" };
        const courseId = createCourse(name);
        if (!courseId) return { ok: false, summary: "课程名称不合法。" };
        return { ok: true, summary: `已添加课程「${name}」`, data: { courseId, name } };
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
        // 资料可能很长（一份章节 PDF 抽出来一两万字），一次只给一小段容易"没读到重点"，
        // 所以改成可以分段读，并把目录/页码结构一起给它。
        const content = resource.contentText;
        // 偏移量按字符给；下面的 safeSlice 保证不会把数学符号（UTF-16 代理对）切成一半
        const rawOffset = Math.max(0, Math.round(Number(args.offset) || 0));
        const offset = safeSlice(content, 0, rawOffset).length;
        const length = Math.min(8000, Math.max(1000, Math.round(Number(args.length) || 6000)));
        const end = Math.min(content.length, offset + length);
        const hasMore = end < content.length;
        return {
          ok: true,
          summary: hasMore
            ? `已阅读「${resource.title}」第 ${offset + 1}-${end} 字（全文 ${content.length} 字，还有后续）`
            : `已读完「${resource.title}」（共 ${content.length} 字）`,
          data: {
            title: resource.title,
            course: courseNameOf(resource.courseId),
            type: resource.type,
            totalLength: content.length,
            offset,
            hasMore,
            nextOffset: hasMore ? end : null,
            outline: offset === 0 ? buildResourceOutline(content) : null,
            content: safeSlice(content, offset, end),
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
        if (asString(args.reminder).trim()) patch.reminder = asString(args.reminder).trim();
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
      case "delete_task": {
        const taskTitle = asString(args.taskTitle).trim();
        const snapTasks = snapshotRef.current.tasks;
        const target =
          snapTasks.find((candidate) => candidate.title === taskTitle) ??
          snapTasks.find((candidate) => candidate.title.includes(taskTitle) || (taskTitle && taskTitle.includes(candidate.title)));
        if (!target) return { ok: false, summary: `没有找到标题包含「${taskTitle}」的任务。` };
        deleteTask(target.id, { silent: true });
        return { ok: true, summary: `已删除任务「${target.title}」` };
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
          ...(asString(args.detail).trim() ? { detail: asString(args.detail).trim().slice(0, 4000) } : {}),
        };
        setSnapshot((current) => ({ ...current, tasks: [task, ...current.tasks] }));
        return { ok: true, summary: `已创建${type}「${title}」，截止 ${formatDate(task.dueAt)}` };
      }
      case "save_review_plan": {
        const rawSessions = sanitizePlanSessions(args.sessions);
        const fitted = fitSessionsToAvailability(
          rawSessions,
          parseAvailability(reviewAvailabilityRef.current),
          reviewDeadlineRef.current,
        );
        const sessions = fitted.sessions;
        if (!sessions.length) {
          if (rawSessions.length) {
            reviewPlanArrivedRunRef.current = reviewRunIdRef.current;
            return {
              ok: false,
              summary: `按你选的时间（${reviewAvailabilityRef.current || "未说明"}）排不下这些安排，未写入。可以把空闲时间放宽一点再排。`,
            };
          }
          reviewPlanArrivedRunRef.current = reviewRunIdRef.current;
          return {
            ok: false,
            summary: "这份计划的日期没解析出来，未写入。请把 sessions[].date 换成 2026-10-10T19:00:00+08:00 这样的 ISO 时间再调用一次。",
          };
        }
        // 课程名对不上时，用复习计划页选中的课程兜底，别一股脑丢进"未分类"
        const courseId = resolveCourseId(asString(args.courseName)) || reviewTargetCourseRef.current;
        const courseLabel = courseNameOf(courseId) || asString(args.courseName) || "未分类";
        const tasks: Task[] = sessions.map((session) => {
          const resourceId = session.resourceName ? resolveResourceId(session.resourceName) : "";
          const detail = formatSessionDetail(session);
          return {
            id: makeId("task"),
            title: session.title,
            courseId,
            type: "复习",
            dueAt: toLocalInputValue(session.date),
            status: "未开始",
            priority: "中",
            reminder: "提前2小时",
            ...(resourceId ? { resourceId } : {}),
            ...(detail ? { detail } : {}),
          };
        });
        setSnapshot((current) => ({ ...current, tasks: [...tasks, ...current.tasks] }));
        return {
          ok: true,
          summary: `已把 ${tasks.length} 个复习安排写入「${courseLabel}」` + (fitted.adjustment ? `（${fitted.adjustment}）` : ""),
          data: { count: tasks.length },
        };
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
        reviewPlanArrivedRunRef.current = reviewRunIdRef.current;
        const plannedCourseId = resolveCourseId(asString(call.arguments.courseName)) || reviewTargetCourseRef.current;
        // 模型经常无视"我什么时候有空"，这里强制对齐一遍（挪时间 / 去掉排不下的）
        const fitted = fitSessionsToAvailability(
          sanitizePlanSessions(call.arguments.sessions),
          parseAvailability(reviewAvailabilityRef.current),
          reviewDeadlineRef.current,
        );
        setPendingPlanConfirm({
          courseName:
            snapshotRef.current.courses.find((item) => item.id === plannedCourseId)?.name ||
            asString(call.arguments.courseName),
          sessions: fitted.sessions,
          adjustment: fitted.adjustment,
        });
        setReviewPlanStatus((current) => (current.state === "running" ? { state: "idle" } : current));
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
          ...(taskConfirmDraft.detail ? { detail: taskConfirmDraft.detail } : {}),
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
        ...(taskConfirmDraft.detail ? { detail: taskConfirmDraft.detail } : {}),
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

  const runAgent = async (goal: string, goalImages: string[] = [], options?: { background?: boolean; maxSteps?: number }) => {
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
        maxSteps: options?.maxSteps ?? 8,
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

  /** 等浅浅把手上的循环跑完（撤掉确认卡后通常几百毫秒） */
  const waitForAgentIdle = async (timeoutMs = 20000) => {
    const started = Date.now();
    while (agentRunningRef.current && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
    return !agentRunningRef.current;
  };

  const generateReviewPlan = async (courseId: string, examAt: string, availability: string) => {
    // 每一轮生成拿一个编号：换课程重新生成时，上一轮的收尾不能把新轮的状态覆盖掉
    const runId = reviewRunIdRef.current + 1;
    reviewRunIdRef.current = runId;
    const course = snapshot.courses.find((item) => item.id === courseId);
    const courseName = course?.name ?? "";
    const setStatus = (next: ReviewPlanStatus) => {
      if (reviewRunIdRef.current === runId) setReviewPlanStatus(next);
    };

    // 旧草案还挂着的时候，浅浅其实卡在"等你确认"那一步：
    // 以前这里直接静默 return，用户换课程再点就完全没反应。现在先撤掉旧草案，把它放出来。
    const hasStaleDraft = Boolean(pendingPlanConfirmRef.current);
    setPendingPlanConfirm(null);
    setConfirmError("");
    setStatus({ state: "running", courseId, courseName });
    if (hasStaleDraft) {
      settleConfirmation({ approved: false });
      await waitForAgentIdle();
    }
    if (agentRunningRef.current) {
      setStatus({
        state: "empty",
        courseId,
        courseName,
        busy: pendingTaskConfirmRef.current ? "confirm" : "running",
      });
      return;
    }

    const exam = new Date(examAt);
    const goal = [
      `请为「${courseName || "未分类课程"}」制定复习计划。`,
      `考试或目标时间：${Number.isNaN(exam.getTime()) ? examAt : exam.toISOString()}。`,
      `我方便学习的时间（硬性要求，所有安排都必须落在这个范围里，不要排到其它星期或其它时段）：${availability || "未说明"}。`,
      "请先 list_tasks / search_resources 了解现状，再用 read_resource 真正把这门课的关键资料读完（长资料按返回的 nextOffset 分次读完，别只看开头），" +
      "然后按资料里的章节、知识点和难度拆成具体到天的安排（难点 90 分钟、一般 60 分钟、轻量 45 分钟）；" +
        "每次安排都要写清：resourceName（用哪份资料）、focus（哪些内容是重点、为什么）、route（先做什么再做什么的路线）、checkpoint（怎么自测才算过关）；所有安排必须早于考试时间。" +
        "最后必须调用 save_review_plan 把计划结构化提交（不要只在回复里用文字列计划，也不要再反问用户；信息不足就按合理默认值排，并在标题里写明假设）。" +
        "如果这门课任务和资料都很少，也按主题/章节排一份通用复习节奏。",
    ].join("");

    reviewTargetCourseRef.current = courseId;
    reviewAvailabilityRef.current = availability;
    reviewDeadlineRef.current = Number.isNaN(exam.getTime()) ? null : exam.getTime();
    reviewPlanArrivedRunRef.current = 0;
    // 排计划要先读资料（长课件要分几次读）再提交，8 步经常不够——给到 18 步
    await runAgent(goal, [], { maxSteps: 18 });
    if (reviewRunIdRef.current !== runId) return; // 这一轮已经被新的一轮接管了
    reviewTargetCourseRef.current = "";
    reviewAvailabilityRef.current = "";
    reviewDeadlineRef.current = null;
    const arrived = reviewPlanArrivedRunRef.current === runId;
    const lastReply = [...agentHistoryRef.current].reverse().find((item) => item.role === "assistant")?.content ?? "";
    setReviewPlanStatus((current) => {
      if (current.state !== "running") return current;
      return arrived
        ? { state: "idle" }
        : { state: "empty", courseId, courseName, reply: lastReply.slice(0, 280) };
    });
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
    if (!files.length) return;
    // 浅浅正在处理消息时不去抢队列，但要明确告诉用户，不能静默丢弃文件
    if (agentRunningRef.current) {
      showComposerHint("浅浅正在处理上一条消息，等它回复完再上传文件。", "error");
      return;
    }
    if (batchRunningRef.current) {
      setExtractError("当前批次仍在处理中，请完成或取消后再添加新文件。");
      showComposerHint("已有一批文件在处理中，请等这批完成。", "error");
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
        ? { ...item.taskDraft, id: makeId("task"), resourceId: item.taskDraft.resourceId ?? resourceId }
        : null;
      setSnapshot((current) => ({
        ...current,
        resources: [resource, ...current.resources],
        tasks: task ? [task, ...current.tasks] : current.tasks,
      }));
      updateImportQueueItem(id, (current) => ({ ...current, status: "saved", error: undefined }));
      addAssistantMessage(`“${draft.title.trim()}”已保存到本地资料库${task ? "，关联 DDL 也已创建" : ""}。正在把原文件上传到服务端…`);

      // 把文件本体上传到服务端：这样换设备/换浏览器登录同一账号也能打开原文件
      const uploaded = await uploadFileToServer(item.file, item.file.name);
      if (uploaded.ok) {
        setSnapshot((current) => ({
          ...current,
          resources: current.resources.map((entry) =>
            entry.id === resourceId ? { ...entry, fileKey: uploaded.fileId } : entry,
          ),
        }));
        updateImportQueueItem(id, (current) => ({ ...current, backupState: "done" }));
        addAssistantMessage(`“${draft.title.trim()}”的原文件已备份到服务端，在任何设备都能打开。`);
      } else {
        updateImportQueueItem(id, (current) => ({ ...current, backupState: "failed", backupError: uploaded.message }));
        addAssistantMessage(`原文件暂未上传到服务端（${uploaded.message}）—— 本机仍可正常打开。`);
      }
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

  // 删除任务：本地移除 + 上报云端（否则刷新会被同步回来）
  const deleteTask = (taskId: string, options?: { silent?: boolean }) => {
    const task = snapshotRef.current.tasks.find((item) => item.id === taskId);
    setSnapshot((current) => {
      const next = { ...current, tasks: current.tasks.filter((item) => item.id !== taskId) };
      snapshotRef.current = next;
      return next;
    });
    void deleteCloud("tasks", [taskId]);
    if (!options?.silent && task) addAssistantMessage(`已删除任务「${task.title}」。`);
  };

  // 编辑任务（标题/课程/截止/类型/优先级/提醒/关联资料）
  const updateTaskFields = (taskId: string, patch: Partial<Task>) => {
    setSnapshot((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
    }));
  };

  const updateTaskStatus = (taskId: string, status: Task["status"]) => {
    setSnapshot((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, status } : task)),
    }));
  };

  // 课程顺序是一整组数据：只把变动的那两门课写回云端，云端那些还是旧值的课程会跟新值撞号，
  // 别的设备拉下来顺序就乱了。所以顺序一变就给整组课程盖同一个时间戳，整组上传。
  const touchCourseList = (courses: Course[]): Course[] => {
    const now = new Date().toISOString();
    return courses.map((course) => ({ ...course, updatedAt: now }));
  };

  // 新建课程：用于导入新课程资料、或按课程整理资料
  const createCourse = (rawName: string): string | null => {
    const name = rawName.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return null;
    const existing = snapshotRef.current.courses.find(
      (course) => course.name.replace(/\s+/g, "").toLowerCase() === name.replace(/\s+/g, "").toLowerCase(),
    );
    if (existing) return existing.id;

    const palette = ["coral", "blue", "sage", "yellow"];
    const courseId = makeId("course");
    const existingCourses = snapshotRef.current.courses;
    const nextOrder = existingCourses.reduce((max, course) => Math.max(max, course.order ?? -1), -1) + 1;
    const next: Course = {
      id: courseId,
      name,
      semester: new Date().getFullYear() + " 秋季",
      color: palette[existingCourses.length % palette.length],
      order: nextOrder,
    };
    setSnapshot((current) => ({ ...current, courses: touchCourseList([...current.courses, next]) }));
    return courseId;
  };

  // 侧栏拖拽：把一门课放到另一门课的位置，并把顺序写回 order（参与云同步）
  const dropCourse = (sourceId: string, targetId: string) => {
    setSnapshot((current) => {
      const courses = moveCourse(current.courses, sourceId, targetId);
      if (courses === current.courses) return current;
      return { ...current, courses: touchCourseList(courses) };
    });
  };

  const clearCourseDrag = () => {
    setDraggingCourseId(null);
    setDragOverCourseId(null);
  };

  // 删除课程：课程下的资料与任务不删除，只变成"未分类"
  const deleteCourse = (course: Course) => {
    const affectedResources = snapshotRef.current.resources.filter((item) => item.courseId === course.id).length;
    const affectedTasks = snapshotRef.current.tasks.filter((item) => item.courseId === course.id).length;
    setSnapshot((current) => ({
      ...current,
      courses: current.courses.filter((item) => item.id !== course.id),
      resources: current.resources.map((item) => (item.courseId === course.id ? { ...item, courseId: "" } : item)),
      tasks: current.tasks.map((item) => (item.courseId === course.id ? { ...item, courseId: "" } : item)),
    }));
    // 预设课程删掉后不要再被补回来
    if (isPresetCourseId(course.id)) hidePreset(course.id);
    void deleteCloud("courses", [course.id]);
    const moved = [
      affectedResources ? affectedResources + " 份资料" : "",
      affectedTasks ? affectedTasks + " 条任务" : "",
    ].filter(Boolean).join("和");
    addAssistantMessage(
      moved
        ? "已删除课程「" + course.name + "」，" + moved + "变成了「未分类」。"
        : "已删除课程「" + course.name + "」。",
    );
  };

  // 修改某份资料所属课程（导入时挂错课程可就地纠正）
  const reassignResource = (resourceId: string, courseId: string) => {
    setSnapshot((current) => ({
      ...current,
      resources: current.resources.map((resource) =>
        resource.id === resourceId ? { ...resource, courseId } : resource,
      ),
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
      type: taskType,
      dueAt: taskDueAt,
      status: "未开始",
      priority: taskPriority,
      reminder: taskReminder || "提前1天",
      ...(taskResourceId ? { resourceId: taskResourceId } : {}),
      ...(taskDetail.trim() ? { detail: taskDetail.trim().slice(0, 4000) } : {}),
      ...(taskImages.length ? { images: taskImages } : {}),
    };
    setSnapshot((current) => ({ ...current, tasks: [task, ...current.tasks] }));
    // 存完把表单清干净，免得下一条任务误带上上一条的课程/资料/图片
    setTaskTitle("");
    setTaskReminder("提前1天");
    setTaskResourceId("");
    setTaskImages([]);
    setTaskDetail("");
    setTaskPriority("中");
    setTaskType("DDL");
    setTaskDueAt(defaultTaskDueAt());
    setShowTaskForm(false);
  };

  const exportBackup = () => {
    // 备份范围：课程、资料、任务、对话、画像。
    // 不含原始文件（PDF/图片本体）——它们保存在服务端与本机，可在资料库中单独下载。
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      ...snapshot,
      profile,
      conversations: conversationsRef.current,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
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
        const importedSnapshot = {
          courses: normalizeCourseOrder(imported.courses),
          resources: imported.resources,
          tasks: imported.tasks,
        };
        syncedSnapshotRef.current = importedSnapshot;
        const withPresets = applyPresets(importedSnapshot, loadHiddenPresets());
        setSnapshot(withPresets);
        if (imported.profile) {
          const nextProfile = sanitizeProfile(imported.profile);
          setProfile(nextProfile);
          saveProfile(nextProfile);
        }
        // 旧版备份没有对话字段，缺失时保持现有对话不变
        const importedConversations = (imported as { conversations?: ConversationRecord[] }).conversations;
        if (Array.isArray(importedConversations)) {
          setConversations(importedConversations);
          conversationsRef.current = importedConversations;
          for (const conversation of importedConversations) void saveConversation(conversation);
        }
        const summary = [
          `${imported.courses.length} 门课程`,
          `${imported.resources.length} 份资料`,
          `${imported.tasks.length} 条任务`,
          Array.isArray(importedConversations) ? `${importedConversations.length} 个对话` : null,
        ].filter(Boolean).join("、");
        addAssistantMessage(`备份已载入：${summary}。原始文件不在备份里，需要时请在资料库中重新上传。`);
      } catch {
        addAssistantMessage("这个备份文件无法读取。请确认它是浅浅导出的 JSON 备份。");
      }
    };
    reader.readAsText(file);
  };

  const resetDemo = () => {
    const next = demoSnapshot();
    syncedSnapshotRef.current = next;
    setSnapshot(applyPresets(next, loadHiddenPresets()));
    addAssistantMessage("示例数据已恢复。你可以在此基础上继续添加自己的课程、资料和任务。");
  };

  // ---------- 账号管理（仅管理员，服务端数据库） ----------

  async function loadServerAccounts() {
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const body = (await response.json()) as { ok?: boolean; users?: PublicAccount[] };
      if (body.ok && body.users) setAccounts(body.users);
    } catch {
      // 离线时保留上一次的列表
    }
  }

  const createAccount = async (input: { username: string; displayName: string; password: string; role: "admin" | "user" }): Promise<string | null> => {
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !body.ok) return body.error?.message ?? "创建失败。";
      await loadServerAccounts();
      return null;
    } catch {
      return "无法连接服务端。";
    }
  };

  const toggleAccountDisabled = async (userId: string) => {
    if (userId === currentUser?.id) return;
    try {
      await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action: "toggle-disabled" }),
      });
      await loadServerAccounts();
    } catch {
      // 忽略网络异常，列表保持原样
    }
  };

  const resetAccountPassword = async (userId: string, password: string): Promise<string | null> => {
    if (password.length < 6) return "密码至少 6 位。";
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action: "reset-password", password }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !body.ok) return body.error?.message ?? "重置失败。";
      return null;
    } catch {
      return "无法连接服务端。";
    }
  };

  const deleteAccount = async (userId: string) => {
    if (userId === currentUser?.id) return;
    try {
      await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      await loadServerAccounts();
    } catch {
      // 忽略网络异常
    }
  };

  // 删除资料：本地移除 + 删除原文件 + 上报云端（否则刷新会被同步回来）
  const deleteResource = async (resource: Resource) => {
    // 预设资料删掉后记一笔，避免下次登录又被补回来
    if (isPresetResourceId(resource.id)) hidePreset(resource.id);
    setSnapshot((current) => {
      const next = { ...current, resources: current.resources.filter((item) => item.id !== resource.id) };
      snapshotRef.current = next;
      return next;
    });
    if (resource.fileId) {
      try {
        await deleteLocalFile(resource.fileId);
      } catch {
        // 文件已被清理时忽略
      }
    }
    void deleteCloud("resources", [resource.id]);
    addAssistantMessage(`已删除资料「${resource.title}」。`);
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
    setNotificationPermission(permission);
    addAssistantMessage(
      permission === "granted"
        ? "桌面提醒已开启。任务临近截止时（按提醒规则：提前 3 天、1 天、2 小时），我会弹出系统通知——记得让浅浅这个页面开着。想在关掉网页后也收到提醒，可以去「数据管理 → 导出日历 (.ics)」导入系统日历。"
        : "没有获得通知权限。你仍会在对话里收到提醒；想开桌面通知可以在浏览器设置里允许，或者用「导出日历 (.ics)」让系统日历提醒你。",
    );
  };

  if (!authReady) {
    return <main className="auth-shell"><div className="auth-card"><div className="auth-brand"><div className="brand-mark">浅</div><div><div className="brand-name">浅浅</div><div className="brand-caption">qianqian</div></div></div><p className="auth-copy">正在准备…</p></div></main>;
  }

  if (!currentUser) {
    return <LoginScreen onLogin={login} onRegister={register} />;
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
          {/* 资料库不再是独立入口：它按课程组织，入口在下方「我的课程」里 */}
          {(Object.keys(viewLabels) as View[])
            .filter((item) => item !== "resources")
            .filter((item) => item !== "accounts" || currentUser.role === "admin")
            .map((item) => (
            <button
              className={`nav-item ${view === item ? "active" : ""}`}
              key={item}
              onClick={() => setView(item)}
            >
              <span className="nav-dot">{item === "assistant" ? "✦" : item === "tasks" ? "◷" : item === "review" ? "✓" : item === "accounts" ? "☰" : "⚙"}</span>
              <span>{viewLabels[item]}</span>
              {item === "tasks" && upcomingTasks.length > 0 ? <span className="nav-count">{upcomingTasks.length}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-section">
          <div className="section-label">我的课程</div>
          {/* 顺序：新建课程 → 全部资料 → 具体课程（可拖拽调整） */}
          {showCourseForm ? (
            <div className="course-form">
              <input
                value={newCourseName}
                onChange={(event) => setNewCourseName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const id = createCourse(newCourseName);
                  if (id) { setNewCourseName(""); setShowCourseForm(false); setSearch(""); setView("resources"); }
                }}
                placeholder="新课程名称，回车保存"
                aria-label="新课程名称"
                autoFocus
              />
              <button
                className="text-button"
                onClick={() => {
                  const id = createCourse(newCourseName);
                  if (id) { setNewCourseName(""); setShowCourseForm(false); setSearch(""); setView("resources"); }
                }}
              >
                保存
              </button>
              <button className="text-button" onClick={() => { setNewCourseName(""); setShowCourseForm(false); }}>取消</button>
            </div>
          ) : (
            <button className="course-row add-course" onClick={() => setShowCourseForm(true)}>
              <span className="course-swatch dashed" />
              <span>新建课程</span>
            </button>
          )}
          <button
            className={`course-row ${view === "resources" && !search.trim() ? "active" : ""}`}
            onClick={() => { setSearch(""); setView("resources"); }}
          >
            <span className="course-swatch all" />
            <span>全部资料</span>
            <span className="course-count">{snapshot.resources.length}</span>
          </button>
          {orderedCourses.map((course) => {
            const dragging = draggingCourseId === course.id;
            const dragOver = dragOverCourseId === course.id && !dragging;
            const confirming = pendingCourseDelete === course.id;
            const openCourse = () => { setSearch(course.name); setView("resources"); };
            return (
              <div key={course.id}>
                <div
                  className={`course-row course-draggable ${view === "resources" && search.trim() === course.name ? "active" : ""} ${dragging ? "dragging" : ""} ${dragOver ? "drag-over" : ""}`}
                  role="button"
                  tabIndex={0}
                  draggable
                  title="按住拖动可以调整课程顺序"
                  onDragStart={(event) => {
                    setDraggingCourseId(course.id);
                    event.dataTransfer.effectAllowed = "move";
                    try { event.dataTransfer.setData("text/plain", course.id); } catch { /* 部分浏览器不允许写入 */ }
                  }}
                  onDragOver={(event) => {
                    if (!draggingCourseId || draggingCourseId === course.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDragOverCourseId(course.id);
                  }}
                  onDragLeave={() => setDragOverCourseId((current) => (current === course.id ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = draggingCourseId ?? event.dataTransfer.getData("text/plain");
                    if (sourceId) dropCourse(sourceId, course.id);
                    clearCourseDrag();
                  }}
                  onDragEnd={clearCourseDrag}
                  onClick={openCourse}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openCourse();
                  }}
                >
                  <span className={`course-swatch ${course.color}`} />
                  <span className="course-name">{course.name}</span>
                  <span className="course-count">{snapshot.resources.filter((resource) => resource.courseId === course.id).length}</span>
                  <span className="course-handle" aria-hidden="true">⠿</span>
                  <button
                    type="button"
                    className="course-delete"
                    title={`删除课程「${course.name}」`}
                    aria-label={`删除课程 ${course.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingCourseDelete(course.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
                {confirming ? (
                  <div className="course-confirm" onClick={(event) => event.stopPropagation()}>
                    <span>删除「{course.name}」？资料与任务会变成未分类</span>
                    <button
                      type="button"
                      className="quiet-button danger"
                      onClick={() => { deleteCourse(course); setPendingCourseDelete(null); }}
                    >
                      确认删除
                    </button>
                    <button type="button" className="text-button" onClick={() => setPendingCourseDelete(null)}>取消</button>
                  </div>
                ) : null}
              </div>
            );
          })}
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
          <button className="icon-button" title="设置" aria-label="设置" onClick={() => setView("settings")}>⚙</button>
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
              onDeleteResource={deleteResource}
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
              onReassignResource={reassignResource}
            />
          ) : null}

          {view === "tasks" ? (
            <TasksView
              tasks={snapshot.tasks}
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
              taskType={taskType}
              setTaskType={setTaskType}
              priority={taskPriority}
              setPriority={setTaskPriority}
              reminder={taskReminder}
              setReminder={setTaskReminder}
              resourceId={taskResourceId}
              setResourceId={setTaskResourceId}
              images={taskImages}
              setImages={setTaskImages}
              detail={taskDetail}
              setDetail={setTaskDetail}
              resources={snapshot.resources}
              onCreateCourse={createCourse}
              onCreate={createTask}
              onComplete={(taskId) => updateTaskStatus(taskId, "已完成")}
              onDelete={deleteTask}
              onUpdate={updateTaskFields}
              onOpenResource={(resourceId) => {
                const target = snapshotRef.current.resources.find((item) => item.id === resourceId);
                setSearch(target?.title ?? "");
                setView("resources");
              }}
            />
          ) : null}

          {view === "review" ? (
            <ReviewView
              courses={snapshot.courses}
              running={agentRunning}
              plan={pendingPlanConfirm}
              status={reviewPlanStatus}
              confirmError={confirmError}
              onGenerate={generateReviewPlan}
              onApprovePlan={approvePlanConfirm}
              onRejectPlan={rejectConfirm}
              onOpenAssistant={() => setView("assistant")}
              onCreateCourse={createCourse}
            />
          ) : null}

          {view === "accounts" && currentUser.role === "admin" ? (
            <AccountPanel
              accounts={accounts}
              currentUserId={currentUser.id}
              onCreate={createAccount}
              onToggleDisabled={toggleAccountDisabled}
              onResetPassword={resetAccountPassword}
              onDelete={deleteAccount}
            />
          ) : null}

          {view === "settings" ? (
            <SettingsView
              snapshot={snapshot}
              profile={profile}
              syncState={syncState}
              syncMessage={syncMessage}
              lastSyncedAt={lastSyncedAt}
              conversationCount={conversations.length}
              onSyncNow={() => void pushToCloud({ manual: true })}
              onSaveProfile={(next) => { const cleaned = sanitizeProfile(next); setProfile(cleaned); saveProfile(cleaned); addAssistantMessage("你的画像已更新，智能体之后的每一轮思考都会记住。 "); }}
              onExport={exportBackup}
              onExportICal={exportICalendar}
              notificationPermission={notificationPermission}
              onEnableNotifications={enableNotifications}
              onImport={() => importInputRef.current?.click()}
              onFile={importBackup}
              onReset={resetDemo}
              preferences={preferences}
              currentUser={currentUser}
              onToggleAnimations={toggleAnimations}
              onLogout={logout}
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
    {preferencesReady && preferences.animations && showIntro ? <StudyIntro onComplete={() => setShowIntro(false)} /> : null}
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
          <button onClick={() => setInput("今天该做什么？帮我安排一下")}>✦ 今天做什么</button>
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
      <div className="plan-summary">{planSummary(plan.sessions)}</div>
      {plan.adjustment ? <div className="plan-adjust-note">已按你的空闲时间对齐：{plan.adjustment}</div> : null}
      <div className="plan-session-list">
        {plan.sessions.map((session) => (
          <div className="plan-item" key={`${session.date}-${session.title}`}>
            <time>{formatPlanDate(session.date)}</time>
            <div>
              <strong>{session.title}</strong>
              <span>{session.resourceName ? `用这份资料：${session.resourceName}` : "将创建为复习任务"}</span>
              {hasSessionDetail(session) ? (
                <div className="plan-item-detail">
                  {session.focus ? <p><b>重点</b>{session.focus}</p> : null}
                  {session.route ? <p><b>路线</b>{session.route}</p> : null}
                  {session.checkpoint ? <p><b>自测</b>{session.checkpoint}</p> : null}
                </div>
              ) : null}
            </div>
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
  resources, courseMap, courses, search, onSearch, showForm, setShowForm, title, setTitle, courseId, setCourseId, type, setType, onCreate, onDeleteResource, onReassignResource,
}: {
  resources: Resource[];
  onDeleteResource: (resource: Resource) => void;
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
  onReassignResource: (resourceId: string, courseId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(resources[0]?.id ?? "");
  const [courseFilter, setCourseFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  // 课程与状态筛选（搜索框由外层负责）
  const visible = resources.filter((resource) => {
    if (courseFilter && resource.courseId !== courseFilter) return false;
    if (statusFilter && resource.status !== statusFilter) return false;
    return true;
  });
  const selectedResource = visible.find((resource) => resource.id === selectedId) ?? visible[0] ?? null;

  return <div className="page-view"><PageHeader eyebrow="LIBRARY" title="课程资料库" description="让每份资料有位置，也有下一步。" action={<button className="primary-button" onClick={() => setShowForm(!showForm)}>＋ 添加资料</button>} />
    {showForm ? <div className="inline-form"><div className="form-title">新建资料卡片 <span>若要保存原文件并自动识别，请在浅浅页面点击“＋”上传</span></div><div className="form-grid"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="资料名称" /><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><select value={type} onChange={(event) => setType(event.target.value as Resource["type"])}><option>课件</option><option>作业</option><option>笔记</option><option>通知</option><option>试卷</option><option>其他</option></select><button className="primary-button" onClick={onCreate}>保存资料</button></div></div> : null}
    <div className="toolbar">
      <label className="local-search"><span>⌕</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索标题、课程、标签" /></label>
      <select value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)} aria-label="按课程筛选资料">
        <option value="">全部课程</option>
        {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
      </select>
      <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="按状态筛选资料">
        <option value="">全部状态</option>
        <option value="未整理">未整理</option>
        <option value="学习中">学习中</option>
        <option value="待复习">待复习</option>
        <option value="已归档">已归档</option>
      </select>
      {(courseFilter || statusFilter) ? <button className="text-button" onClick={() => { setCourseFilter(""); setStatusFilter(""); }}>清除筛选</button> : null}
    </div>
    <div className="resource-layout"><div className="resource-list"><div className="list-meta">{visible.length} 份资料 <span>· 本地索引</span></div>{visible.map((resource) => <ResourceListItem key={resource.id} resource={resource} course={courseMap.get(resource.courseId)} selected={selectedResource?.id === resource.id} onSelect={() => setSelectedId(resource.id)} />)}{visible.length === 0 ? <EmptyState title="还没有匹配资料" copy="试试换个关键词，或手动添加一张资料卡片。" /> : null}</div><LocalResourcePreview key={`${selectedResource?.id ?? "empty"}-${selectedResource?.fileId ?? "none"}`} resource={selectedResource} course={selectedResource ? courseMap.get(selectedResource.courseId) : undefined} onDelete={onDeleteResource} courses={courses} onReassign={onReassignResource} /></div>
  </div>;
}

function ResourceListItem({ resource, course, selected, onSelect }: { resource: Resource; course?: Course; selected: boolean; onSelect: () => void }) {
  return <button className={`resource-item ${selected ? "selected" : ""}`} onClick={onSelect}><span className={`file-badge ${resource.type === "作业" ? "coral" : resource.type === "笔记" ? "blue" : ""}`}>{resource.type.slice(0, 1)}</span><span className="resource-main"><strong>{resource.title}</strong><small>{course?.name ?? "未分类"} · {resource.fileName ?? "手动资料卡片"}</small><span className="tag-line">{resource.tags.map((tag) => <em key={tag}>{tag}</em>)}</span></span><span className="resource-status">{resource.status}</span><span className="chevron">›</span></button>;
}

function LocalResourcePreview({ resource, course, courses, onDelete, onReassign }: { resource: Resource | null; course?: Course; courses?: Course[]; onDelete?: (resource: Resource) => void; onReassign?: (resourceId: string, courseId: string) => void }) {
  // 载入结果整块存在一个 state 里，避免在 effect 里同步 setState（会触发级联渲染）；
  // 是否"加载中"由 fileId 与已载入结果推导得出。
  const [loaded, setLoaded] = useState<{
    fileId: string;
    preview: LocalPreview | null;
    fileUrl: string | null;
    error: string;
  } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const fileId = resource?.fileId ?? null;

  useEffect(() => {
    if (!fileId) return;
    let active = true;
    let currentPreview: LocalPreview | null = null;
    let currentFileUrl: string | null = null;
    (async () => {
      try {
        const record = await getLocalFile(fileId);
        if (!record) throw new Error("FILE_NOT_FOUND");
        currentFileUrl = URL.createObjectURL(record.blob);
        currentPreview = await buildLocalPreview(record);
        if (active) setLoaded({ fileId, preview: currentPreview, fileUrl: currentFileUrl, error: "" });
      } catch {
        if (active) setLoaded({ fileId, preview: null, fileUrl: null, error: "原始文件无法读取，可能已被浏览器清理。" });
      }
    })();
    return () => {
      active = false;
      releaseLocalPreview(currentPreview);
      if (currentFileUrl) URL.revokeObjectURL(currentFileUrl);
    };
  }, [fileId]);

  const ready = loaded && loaded.fileId === fileId ? loaded : null;
  const loading = Boolean(fileId) && !ready;

  // 优先用本机原文件；本机没有但服务端有备份时，回退到服务端地址
  const serverKey = resource?.fileKey ?? null;
  const preview: LocalPreview | null = ready?.preview
    ?? (serverKey && resource ? previewFromServer(serverKey, resource) : null);
  const fileUrl = ready?.fileUrl ?? null;
  const error = ready?.error ?? "";
  const openUrl = fileUrl ?? (serverKey ? serverFileUrl(serverKey) : null);
  const downloadUrl = serverKey ? serverFileUrl(serverKey, true) : fileUrl;
  const hasFile = Boolean(openUrl);

  if (!resource) {
    return <div className="preview-panel"><div className="preview-top"><span>资料预览</span><span className="preview-tag">预览</span></div><div className="preview-placeholder"><div className="paper-icon">▤</div><strong>选择一份资料</strong><span>原始文件、课程标签和学习状态会显示在这里。</span></div></div>;
  }

  return (
    <div className="preview-panel live-preview">
      <div className="preview-top"><span>资料预览</span><span className="preview-tag">文件</span></div>
      <div className="preview-resource-head">
        <strong>{resource.title}</strong>
        <span>{course?.name ?? "未分类"} · {resource.type} · {resource.status}</span>
        {onReassign && (courses?.length ?? 0) > 0 ? (
          <div className="preview-reassign">
            <span>所属课程</span>
            <select value={resource.courseId} onChange={(event) => onReassign(resource.id, event.target.value)} aria-label="修改所属课程">
              {(courses ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        ) : null}
        <small className="preview-file-meta">
          {resource.fileName ? <>文件：{resource.fileName}</> : "（无原始文件）"}
          {resource.fileSize ? ` · ${formatBytes(resource.fileSize)}` : ""}
          {resource.importedAt ? ` · 入库 ${resource.importedAt}` : ""}
        </small>
      </div>
      {hasFile ? (
        <div className="preview-actions">
          <a className="quiet-button" href={openUrl ?? "#"} target="_blank" rel="noreferrer">打开原文件</a>
          <a className="quiet-button" href={downloadUrl ?? "#"} download={resource.fileName ?? resource.title}>下载</a>
          {!resource.fileId && serverKey ? <span className="preview-tag">来自服务端备份</span> : null}
          {onDelete ? (
            confirmingDelete ? (
              <>
                <button className="quiet-button danger" onClick={() => { onDelete(resource); setConfirmingDelete(false); }}>确认删除</button>
                <button className="text-button" onClick={() => setConfirmingDelete(false)}>取消</button>
              </>
            ) : (
              <button className="text-button" onClick={() => setConfirmingDelete(true)}>删除资料</button>
            )
          ) : null}
        </div>
      ) : null}
      {loading ? <div className="preview-loading"><span className="progress-spinner" />正在生成本地预览…</div> : null}
      {error ? <div className="preview-error">{error}</div> : null}
      {!hasFile && !loading ? (
        <div className="preview-placeholder compact">
          <div className="paper-icon">▤</div>
          <strong>{resource.tags.includes("待整理") ? "示例资料卡片" : "这条资料没有原始文件"}</strong>
          <span>通过输入框右侧的「＋」上传 PDF / Word / PPT / 截图后，就能在这里查看原件与正文。</span>
          {onDelete ? (
            confirmingDelete ? (
              <div className="preview-actions">
                <button className="quiet-button danger" onClick={() => { onDelete(resource); setConfirmingDelete(false); }}>确认删除</button>
                <button className="text-button" onClick={() => setConfirmingDelete(false)}>取消</button>
              </div>
            ) : (
              <div className="preview-actions">
                <button className="text-button" onClick={() => setConfirmingDelete(true)}>删除这条资料</button>
              </div>
            )
          ) : null}
        </div>
      ) : null}
      {preview?.kind === "image" ? <img className="image-preview" src={preview.url} alt={resource.title} /> : null}
      {preview?.kind === "pdf" ? <iframe className="pdf-preview" src={preview.url} title={resource.title} /> : null}
      {preview?.kind === "server" ? (
        preview.render === "pdf" ? <iframe className="pdf-preview" src={preview.url} title={resource.title} />
          : preview.render === "image" ? <img className="image-preview" src={preview.url} alt={resource.title} />
            : <div className="preview-placeholder compact"><div className="paper-icon">▤</div><strong>已备份到服务端</strong><span>这类文件（Word / PPT）暂不支持在线渲染，可点「打开原文件」或「下载」查看。</span></div>
      ) : null}
      {preview?.kind === "word" ? <div className="word-preview">{preview.paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>)}</div> : null}
      {preview?.kind === "slides" ? <div className="slides-preview">{preview.slides.map((slide) => <section key={slide.number}><span>SLIDE {String(slide.number).padStart(2, "0")}</span>{slide.lines.length ? slide.lines.map((line, index) => index === 0 ? <h3 key={`${index}-${line}`}>{line}</h3> : <p key={`${index}-${line}`}>{line}</p>) : <p>空白幻灯片</p>}</section>)}</div> : null}
      {preview?.kind === "unsupported" ? <div className="preview-placeholder compact"><div className="paper-icon">!</div><strong>暂时无法渲染</strong><span>{preview.message}</span></div> : null}
      <div className="preview-note">原始文件保存在当前浏览器中。</div>
    </div>
  );
}

/** 任务相关的小组件与工具：课程选择（可顺手新建课程）、提醒选择（含自定义）、任务附图 */

const NEW_COURSE_VALUE = "__new_course__";
const MAX_TASK_IMAGES = 6;

type ReminderUnit = "分钟" | "小时" | "天";
const REMINDER_UNITS: ReminderUnit[] = ["分钟", "小时", "天"];
const UNIT_MINUTES: Record<ReminderUnit, number> = { 分钟: 1, 小时: 60, 天: 1440 };

/** 把分钟数拆成"数值 + 单位"，用作自定义提醒的初值 */
function splitReminderMinutes(minutes: number): { amount: number; unit: ReminderUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "天" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "小时" };
  return { amount: minutes > 0 ? minutes : 2, unit: minutes > 0 ? "分钟" : "小时" };
}

/** 课程下拉：第一项是"＋ 新建课程"，选它就能就地输入新课程名 */
function CoursePicker({ value, onChange, courses, onCreateCourse, ariaLabel }: {
  value: string;
  onChange: (courseId: string) => void;
  courses: Course[];
  onCreateCourse: (name: string) => string | null;
  ariaLabel?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const submit = () => {
    const id = onCreateCourse(name);
    if (!id) return;
    setName("");
    setCreating(false);
    onChange(id);
  };

  return (
    <span className="course-picker">
      <select
        value={creating ? NEW_COURSE_VALUE : value}
        aria-label={ariaLabel}
        onChange={(event) => {
          if (event.target.value === NEW_COURSE_VALUE) {
            setCreating(true);
            return;
          }
          setCreating(false);
          onChange(event.target.value);
        }}
      >
        <option value={NEW_COURSE_VALUE}>＋ 新建课程</option>
        {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
      </select>
      {creating ? (
        <span className="course-picker-new">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
            placeholder="新课程名称"
            aria-label="新课程名称"
            autoFocus
          />
          <button type="button" className="text-button" onClick={submit}>保存</button>
          <button type="button" className="text-button" onClick={() => { setCreating(false); setName(""); }}>取消</button>
        </span>
      ) : null}
    </span>
  );
}

/** 提醒选择：预设档位 + 自定义（数值 + 分钟/小时/天） */
function ReminderPicker({ value, onChange, className }: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const parsed = parseReminderText(value);
  const presets = parsed.filter(isPresetReminder);
  const customValue = parsed.find((minutes) => !isPresetReminder(minutes)) ?? 0;
  const initial = customValue > 0 ? splitReminderMinutes(customValue) : { amount: 45, unit: "分钟" as ReminderUnit };
  const [customOpen, setCustomOpen] = useState(customValue > 0);
  // 只有用户真的填过自定义值才写进提醒文本，避免"点开就塞一个默认值"越加越多
  const [customTouched, setCustomTouched] = useState(customValue > 0);
  const [amount, setAmount] = useState(String(initial.amount));
  const [unit, setUnit] = useState<ReminderUnit>(initial.unit);

  const commit = (nextPresets: number[], open: boolean, nextAmount: string, nextUnit: ReminderUnit, touched = customTouched) => {
    let minutes = [...nextPresets];
    if (open && touched) {
      const size = Math.max(1, Math.round(Number(nextAmount) || 0));
      const custom = size * UNIT_MINUTES[nextUnit];
      // 自定义值和预设档位撞上时只留一条，免得写成"提前2小时、2小时"
      minutes = minutes.filter((value) => value !== custom);
      minutes.push(custom);
    }
    onChange(buildReminderText(minutes));
  };

  return (
    <div className={`reminder-choices ${className ?? ""}`}>
      <span>提醒：</span>
      {REMINDER_CHOICES.map((choice) => {
        const selected = presets.includes(choice.minutes);
        return (
          <label key={choice.minutes} className={selected ? "on" : ""}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) => {
                const nextPresets = event.target.checked
                  ? [...presets, choice.minutes]
                  : presets.filter((minutes) => minutes !== choice.minutes);
                commit(nextPresets, customOpen, amount, unit);
              }}
            />
            {choice.label}
          </label>
        );
      })}
      <label className={customOpen ? "on" : ""}>
        <input
          type="checkbox"
          checked={customOpen}
          onChange={(event) => {
            const open = event.target.checked;
            setCustomOpen(open);
            // 打开时不立刻写入，等用户真的填了数值；关闭时把自定义值去掉
            if (!open) {
              setCustomTouched(false);
              commit(presets, false, amount, unit, false);
            }
          }}
        />
        自定义
      </label>
      {customOpen ? (
        <span className="reminder-custom">
          <input
            type="number"
            min={1}
            max={999}
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setCustomTouched(true);
              commit(presets, true, event.target.value, unit, true);
            }}
            aria-label="自定义提醒数值"
          />
          <select
            value={unit}
            onChange={(event) => {
              const nextUnit = event.target.value as ReminderUnit;
              setUnit(nextUnit);
              setCustomTouched(true);
              commit(presets, true, amount, nextUnit, true);
            }}
            aria-label="自定义提醒单位"
          >
            {REMINDER_UNITS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <span className="reminder-custom-hint">提前 {formatReminderMinutes(Math.max(1, Math.round(Number(amount) || 0)) * UNIT_MINUTES[unit])}</span>
        </span>
      ) : null}
    </div>
  );
}

/** 任务附图：读成 data URL；太大的先压到 1600px 以内，避免任务记录过大 */
async function readAttachmentImage(file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file);
  if (!file.type.startsWith("image/") || file.type === "image/gif") return dataUrl;
  try {
    const image = await loadImageElement(dataUrl);
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale >= 1 && dataUrl.length < 400_000) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return dataUrl;
  }
}

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
    image.src = src;
  });
}

/** 新建任务默认给今天 23:59（不是写死的旧日期，否则一建出来就逾期） */
function defaultTaskDueAt() {
  const due = new Date();
  due.setHours(23, 59, 0, 0);
  return toLocalInputValue(due.toISOString());
}

function TasksView({
  tasks, courseMap, courses, resources, showForm, setShowForm, title, setTitle, courseId, setCourseId,
  dueAt, setDueAt, taskType, setTaskType, priority, setPriority, reminder, setReminder,
  resourceId, setResourceId, images, setImages, detail, setDetail,
  onCreate, onComplete, onDelete, onUpdate, onOpenResource, onCreateCourse,
}: {
  tasks: Task[];
  courseMap: Map<string, Course>;
  courses: Course[];
  resources: Resource[];
  showForm: boolean;
  setShowForm: (value: boolean) => void;
  title: string;
  setTitle: (value: string) => void;
  courseId: string;
  setCourseId: (value: string) => void;
  dueAt: string;
  setDueAt: (value: string) => void;
  taskType: Task["type"];
  setTaskType: (value: Task["type"]) => void;
  priority: Task["priority"];
  setPriority: (value: Task["priority"]) => void;
  reminder: string;
  setReminder: (value: string) => void;
  resourceId: string;
  setResourceId: (value: string) => void;
  images: string[];
  setImages: (value: string[]) => void;
  detail: string;
  setDetail: (value: string) => void;
  onCreate: () => void;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onOpenResource: (resourceId: string) => void;
  onCreateCourse: (name: string) => string | null;
}) {
  const now = new Date();
  const [courseFilter, setCourseFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ images: string[]; index: number } | null>(null);
  // 展开"详细计划"的任务 id
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [imageError, setImageError] = useState("");

  const decorated = tasks.map((task) => ({ task, status: deriveTaskStatus(task, now) }));
  const filtered = decorated.filter(({ task, status }) => {
    if (courseFilter && task.courseId !== courseFilter) return false;
    if (typeFilter && task.type !== typeFilter) return false;
    if (statusFilter && status !== statusFilter) return false;
    return true;
  });

  const overdueCount = decorated.filter((item) => item.status === "已逾期").length;
  const todayCount = decorated.filter((item) => item.status !== "已逾期" && isDueToday(item.task, now)).length;
  const groups = groupTasks(filtered.map((item) => item.task), now);
  const statusOf = new Map(decorated.map((item) => [item.task.id, item.status]));
  const openImages = (list: string[], index = 0) => setViewing({ images: list, index });

  // 附图：用户自己选，最多 6 张；大图会先压一下再存（任务数据要参与云同步）
  const addImages = async (files: File[]) => {
    const room = Math.max(0, MAX_TASK_IMAGES - images.length);
    if (!files.length || room === 0) {
      if (room === 0) setImageError(`最多附带 ${MAX_TASK_IMAGES} 张图片。`);
      return;
    }
    try {
      const urls = await Promise.all(files.slice(0, room).map(readAttachmentImage));
      setImages([...images, ...urls]);
      setImageError("");
    } catch {
      setImageError("图片读取失败，换一张再试试。");
    }
  };

  return (
    <div className="page-view">
      <PageHeader
        eyebrow="TASK DESK"
        title="任务中心"
        description="DDL、考试和复习时段，放在同一条时间线上。"
        action={<button className="primary-button" onClick={() => setShowForm(!showForm)}>＋ 新建任务</button>}
      />

      {overdueCount > 0 || todayCount > 0 ? (
        <div className="task-summary">
          {overdueCount > 0 ? <span className="task-summary-chip overdue">已逾期 {overdueCount}</span> : null}
          {todayCount > 0 ? <span className="task-summary-chip today">今天 {todayCount}</span> : null}
          <button className="text-button" onClick={() => { setStatusFilter("已逾期"); }}>只看逾期</button>
        </div>
      ) : null}

      {showForm ? (
        <div className="inline-form">
          <div className="form-title">新建任务 <span>提醒规则可多选，也能自己填；不选就默认提前 1 天</span></div>
          <div className="form-grid task-form">
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="任务名称" />
            <CoursePicker
              value={courseId}
              onChange={(nextCourseId) => {
                setCourseId(nextCourseId);
                const stillValid = resources.some((item) => item.id === resourceId && item.courseId === nextCourseId);
                if (!stillValid) setResourceId("");
              }}
              courses={courses}
              onCreateCourse={onCreateCourse}
              ariaLabel="任务课程"
            />
            <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} aria-label="任务截止" />
            <select value={taskType} onChange={(event) => setTaskType(event.target.value as Task["type"])} aria-label="任务类型">
              <option value="DDL">DDL</option>
              <option value="考试">考试</option>
              <option value="复习">复习</option>
            </select>
            <select value={priority} onChange={(event) => setPriority(event.target.value as Task["priority"])} aria-label="任务优先级">
              <option value="高">高优先级</option>
              <option value="中">中优先级</option>
              <option value="低">低优先级</option>
            </select>
            <select value={resourceId} onChange={(event) => setResourceId(event.target.value)} aria-label="关联资料">
              <option value="">不关联资料</option>
              {resources.filter((item) => item.courseId === courseId).map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
            <button className="primary-button" onClick={onCreate}>保存任务</button>
          </div>
          <ReminderPicker value={reminder} onChange={setReminder} />
          <div className="task-attach-row">
            <span className="task-attach-label">附带图片（可选）：</span>
            {images.map((src, index) => (
              <span className="task-attach-thumb" key={`${index}-${src.slice(0, 20)}`}>
                <button type="button" className="thumb-button" onClick={() => openImages(images, index)} title="查看这张图">
                  <img src={src} alt={`附图 ${index + 1}`} />
                </button>
                <button type="button" className="thumb-remove" onClick={() => setImages(images.filter((_, i) => i !== index))} aria-label={`移除第 ${index + 1} 张图片`}>×</button>
              </span>
            ))}
            <label className="image-attach-button">
              ＋ 选择图片
              <input
                type="file"
                accept="image/*"
                multiple
                className="visually-hidden"
                onChange={(event) => {
                  void addImages([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
            </label>
            {imageError ? <span className="queue-error inline">{imageError}</span> : null}
          </div>
          <label className="task-detail-field">
            <span>详细计划（可选）：这次的重点、先做什么、怎么自测</span>
            <textarea
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              placeholder={"【重点】第2章 凸函数判定、KKT 条件\n【路线】先过一遍定义 → 重做课件例题 → 整理易错点\n【自测】不看答案默写 KKT 条件"}
            />
          </label>
        </div>
      ) : null}

      <div className="toolbar task-toolbar">
        <select value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)} aria-label="按课程筛选">
          <option value="">全部课程</option>
          {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
        </select>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="按类型筛选">
          <option value="">全部类型</option>
          <option value="DDL">DDL</option>
          <option value="考试">考试</option>
          <option value="复习">复习</option>
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option value="未开始">未开始</option>
          <option value="进行中">进行中</option>
          <option value="已逾期">已逾期</option>
          <option value="已完成">已完成</option>
        </select>
        {(courseFilter || typeFilter || statusFilter) ? (
          <button className="text-button" onClick={() => { setCourseFilter(""); setTypeFilter(""); setStatusFilter(""); }}>清除筛选</button>
        ) : null}
        <span className="list-meta-inline">共 {filtered.length} 条</span>
      </div>

      {groups.length === 0 ? (
        <EmptyState title="没有符合条件的任务" copy="换个筛选条件，或点右上角新建一条任务。" />
      ) : groups.map((group, groupIndex) => (
        <div
          className={`task-group ${groupIndex > 0 && isOverdueGroup(group.label) ? "overdue-sep" : ""} ${groupIndex > 0 && group.label === "已完成" ? "done-sep" : ""}`}
          key={group.label}
        >
          <div className={`task-group-label ${isOverdueGroup(group.label) ? "overdue" : ""}`}>
            {group.label} · {group.items.length}
          </div>
          {group.items.map((task) => {
            const status = statusOf.get(task.id) ?? task.status;
            const linked = task.resourceId ? resources.find((item) => item.id === task.resourceId) : undefined;
            const editing = editingId === task.id;
            const taskImages = task.images ?? [];
            return (
              <div className={`task-row ${status === "已逾期" ? "overdue" : ""}`} key={task.id}>
                <div className={`task-marker ${task.priority === "高" ? "high" : status === "已逾期" ? "overdue" : ""}`} />
                {!editing && taskImages.length ? (
                  <button type="button" className="task-thumb" onClick={() => openImages(taskImages, 0)} title="查看任务附图">
                    <img src={taskImages[0]} alt="任务附图" />
                    {taskImages.length > 1 ? <span className="task-thumb-count">{taskImages.length}</span> : null}
                  </button>
                ) : null}
                {editing ? (
                  <div className="task-edit-wrap">
                    <div className="task-media-panel">
                      <span className="task-media-title">附图</span>
                      <div className="task-media-list">
                        {taskImages.map((src, index) => (
                          <span className="task-attach-thumb" key={`${index}-${src.slice(0, 20)}`}>
                            <button type="button" className="thumb-button" onClick={() => openImages(taskImages, index)} title="查看这张图">
                                        <img src={src} alt={`附图 ${index + 1}`} />
                            </button>
                            <button
                              type="button"
                              className="thumb-remove"
                              aria-label={`移除第 ${index + 1} 张图片`}
                              onClick={() => onUpdate(task.id, { images: taskImages.filter((_, i) => i !== index) })}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <label className="image-attach-button small">
                          ＋ 加图
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            className="visually-hidden"
                            onChange={async (event) => {
                              const files = [...(event.target.files ?? [])];
                              event.target.value = "";
                              const room = Math.max(0, MAX_TASK_IMAGES - taskImages.length);
                              if (!files.length || room === 0) return;
                              const urls = await Promise.all(files.slice(0, room).map(readAttachmentImage));
                              onUpdate(task.id, { images: [...taskImages, ...urls] });
                            }}
                          />
                        </label>
                      </div>
                      {taskImages.length ? (
                        <button type="button" className="text-button" onClick={() => openImages(taskImages, 0)}>看大图</button>
                      ) : (
                        <span className="task-media-hint">没附图</span>
                      )}
                    </div>
                    <div className="task-edit-grid">
                      <input value={task.title} onChange={(event) => onUpdate(task.id, { title: event.target.value })} aria-label="任务名称" />
                      <CoursePicker
                        value={task.courseId}
                        onChange={(nextCourseId) => {
                          const stillValid = resources.some((item) => item.id === task.resourceId && item.courseId === nextCourseId);
                          onUpdate(task.id, stillValid || !task.resourceId ? { courseId: nextCourseId } : { courseId: nextCourseId, resourceId: undefined });
                        }}
                        courses={courses}
                        onCreateCourse={onCreateCourse}
                        ariaLabel="任务课程"
                      />
                      <input type="datetime-local" value={task.dueAt} onChange={(event) => onUpdate(task.id, { dueAt: event.target.value })} aria-label="任务截止" />
                      <select value={task.type} onChange={(event) => onUpdate(task.id, { type: event.target.value as Task["type"] })} aria-label="任务类型">
                        <option value="DDL">DDL</option>
                        <option value="考试">考试</option>
                        <option value="复习">复习</option>
                      </select>
                      <select value={task.priority} onChange={(event) => onUpdate(task.id, { priority: event.target.value as Task["priority"] })} aria-label="任务优先级">
                        <option value="高">高</option>
                        <option value="中">中</option>
                        <option value="低">低</option>
                      </select>
                      <select
                        value={task.resourceId ?? ""}
                        onChange={(event) => onUpdate(task.id, { resourceId: event.target.value || undefined })}
                        aria-label="关联资料"
                      >
                        <option value="">不关联资料</option>
                        {resources.filter((item) => item.courseId === task.courseId).map((item) => (
                          <option key={item.id} value={item.id}>{item.title}</option>
                        ))}
                      </select>
                      <ReminderPicker
                        key={task.id}
                        value={task.reminder}
                        onChange={(next) => onUpdate(task.id, { reminder: next })}
                        className="task-edit-reminders"
                      />
                      <textarea
                        className="task-edit-detail"
                        value={task.detail ?? ""}
                        onChange={(event) => onUpdate(task.id, { detail: event.target.value })}
                        placeholder={"详细计划：重点 / 复习路线 / 自测标准\n例如：【重点】KKT 条件与罚函数法\n【路线】定义 → 例题 → 错题\n【自测】解一道约束优化题"}
                        aria-label="详细计划"
                      />
                      <div className="task-edit-actions">
                        <button className="quiet-button" onClick={() => setEditingId(null)}>完成编辑</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="task-row-main">
                    <strong>{task.title}</strong>
                    <span>
                      {courseMap.get(task.courseId)?.name ?? "未分类"} · {task.type} · {task.reminder}
                      {linked ? <> · <button className="text-button inline" onClick={() => onOpenResource(linked.id)}>查看资料：{linked.title}</button></> : null}
                      {taskImages.length ? <> · <button className="text-button inline" onClick={() => openImages(taskImages, 0)}>查看图片（{taskImages.length}）</button></> : null}
                      {task.detail ? (
                        <>
                          {" · "}
                          <button
                            className="text-button inline"
                            onClick={() => setOpenDetailId((current) => (current === task.id ? null : task.id))}
                          >
                            {openDetailId === task.id ? "收起详细计划" : "详细计划"}
                          </button>
                        </>
                      ) : null}
                    </span>
                    {task.detail && openDetailId === task.id ? (
                      <div className="task-detail-body">{task.detail}</div>
                    ) : null}
                  </div>
                )}
                {!editing ? <time className={status === "已逾期" ? "overdue" : ""}>{formatDate(task.dueAt)}</time> : null}
                {!editing ? <span className={`status-pill ${status === "进行中" ? "working" : status === "已逾期" ? "overdue" : ""}`}>{status}</span> : null}
                {!editing ? (
                  <div className="task-row-actions">
                    <button className="text-button" onClick={() => setEditingId(task.id)}>编辑</button>
                    {pendingDeleteId === task.id ? (
                      <>
                        <button className="quiet-button danger" onClick={() => { onDelete(task.id); setPendingDeleteId(null); }}>确认删除</button>
                        <button className="text-button" onClick={() => setPendingDeleteId(null)}>取消</button>
                      </>
                    ) : (
                      <button className="text-button" onClick={() => setPendingDeleteId(task.id)}>删除</button>
                    )}
                    {status === "已完成" ? (
                      <button className="complete-button" onClick={() => onUpdate(task.id, { status: "未开始" })}>恢复</button>
                    ) : (
                      <button className="complete-button" onClick={() => onComplete(task.id)}>完成</button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}

      {viewing ? (
        <div className="image-viewer" role="dialog" aria-label="任务附图" onClick={() => setViewing(null)}>
          <div className="image-viewer-inner" onClick={(event) => event.stopPropagation()}>
            <img src={viewing.images[viewing.index]} alt={`附图 ${viewing.index + 1}`} />
            <div className="image-viewer-bar">
              <button
                className="quiet-button"
                disabled={viewing.images.length < 2}
                onClick={() => setViewing({ images: viewing.images, index: (viewing.index + viewing.images.length - 1) % viewing.images.length })}
              >
                上一张
              </button>
              <span>{viewing.index + 1} / {viewing.images.length}</span>
              <button
                className="quiet-button"
                disabled={viewing.images.length < 2}
                onClick={() => setViewing({ images: viewing.images, index: (viewing.index + 1) % viewing.images.length })}
              >
                下一张
              </button>
              <a className="quiet-button" href={viewing.images[viewing.index]} download={`任务附图-${viewing.index + 1}`}>下载</a>
              <button className="quiet-button" onClick={() => setViewing(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReviewView({
  courses, running, plan, status, confirmError, onGenerate, onApprovePlan, onRejectPlan, onOpenAssistant, onCreateCourse,
}: {
  courses: Course[];
  onCreateCourse: (name: string) => string | null;
  running: boolean;
  plan: PlanConfirmState | null;
  status: ReviewPlanStatus;
  confirmError: string;
  onGenerate: (courseId: string, examAt: string, availability: string) => void;
  onApprovePlan: () => void;
  onRejectPlan: () => void;
  onOpenAssistant: () => void;
}) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [examAt, setExamAt] = useState(() => toLocalInputValue(new Date(Date.now() + 7 * 86_400_000).toISOString()));
  const [availability, setAvailability] = useState("工作日晚上 19:00–21:00");
  const [justSaved, setJustSaved] = useState(false);
  // 课程列表变了（新建 / 重置数据）时，别让选中项停在一门已经不存在的课上
  const selectedCourseId = courses.some((item) => item.id === courseId) ? courseId : (courses[0]?.id ?? "");
  const course = courses.find((item) => item.id === selectedCourseId);

  const planning = status.state === "running" || (running && !plan && status.state !== "empty");
  const planningCourse = status.courseName || course?.name || "这门课";

  return (
    <div className="page-view">
      <PageHeader
        eyebrow="REVIEW STUDIO"
        title="复习计划"
        description="浅浅会先查询你的真实任务和资料，再把计划排成可以完成的节奏。"
        action={<span className="soft-badge">Agent 生成 · 需确认</span>}
      />
      <div className="review-layout">
        <div className="review-form-card">
          <div className="card-kicker">STEP 01 · 先说你的时间</div>
          <h2>为哪门课准备？</h2>
          <CoursePicker
            value={selectedCourseId}
            onChange={setCourseId}
            courses={courses}
            onCreateCourse={onCreateCourse}
            ariaLabel="复习计划课程"
          />
          <label>考试或复习截止时间<input type="datetime-local" value={examAt} onChange={(event) => setExamAt(event.target.value)} /></label>
          <label>你什么时候方便学习？<input value={availability} onChange={(event) => setAvailability(event.target.value)} placeholder="例如：周一到周五晚上" /></label>
          <div className="availability-chips">
            <button onClick={() => setAvailability("工作日晚上 19:00–21:00")}>工作日晚上</button>
            <button onClick={() => setAvailability("周末上午 09:00–12:00")}>周末上午</button>
            <button onClick={() => setAvailability("每天 60 分钟")}>每天1小时</button>
          </div>
          <button
            className="primary-button wide"
            disabled={planning || !selectedCourseId}
            onClick={() => { setJustSaved(false); onGenerate(selectedCourseId, examAt, availability); }}
          >
            {planning ? "浅浅规划中…" : plan ? "重新生成计划" : "生成计划草案"}
          </button>
          <small className="form-help">
            浅浅会先查「{course?.name ?? "课程"}」的未完成任务和已有资料，再排出具体到天的安排；
            安排只会落在你写的时间段里（写「周末上午 09:00–12:00」就只排周末上午）。
            <strong>确认保存后</strong>才会写进任务中心。
          </small>
        </div>

        <div className="plan-preview-card">
          {plan ? (
            <>
              <div className="plan-head">
                <div>
                  <div className="card-kicker">STEP 02 · 草案待确认</div>
                  <h2>{plan.courseName || course?.name || "课程"} · 复习节奏</h2>
                </div>
                <span className="soft-badge">{availability}</span>
              </div>
              <div className="plan-summary">{planSummary(plan.sessions)}</div>
              {plan.adjustment ? <div className="plan-adjust-note">已按你的空闲时间对齐：{plan.adjustment}</div> : null}
              <div className="plan-session-list">
                {plan.sessions.map((session, index) => (
                  <PlanItem
                    key={`${session.date}-${index}`}
                    date={formatPlanDate(session.date)}
                    title={session.title}
                    duration={`${session.durationMinutes}分钟`}
                    note={session.resourceName ? `用这份资料：${session.resourceName}` : "将创建为复习任务"}
                    focus={session.focus}
                    route={session.route}
                    checkpoint={session.checkpoint}
                  />
                ))}
              </div>
              {confirmError ? <div className="queue-error">{confirmError}</div> : null}
              <div className="plan-actions">
                <button className="primary-button" onClick={() => { onApprovePlan(); setJustSaved(true); }}>确认保存</button>
                <button className="quiet-button" onClick={onRejectPlan}>放弃草案</button>
                <button className="text-button" onClick={() => { setJustSaved(false); onGenerate(selectedCourseId, examAt, availability); }}>换一套重排</button>
              </div>
            </>
          ) : justSaved ? (
            <div className="empty-plan">
              <div className="plan-orbit">✓</div>
              <h2>计划已保存</h2>
              <p>复习安排已写入任务中心，到点会在任务列表中出现。</p>
              <div className="plan-actions">
                <button className="quiet-button" onClick={() => setJustSaved(false)}>再排一份</button>
              </div>
            </div>
          ) : planning ? (
            <div className="empty-plan">
              <span className="progress-spinner" />
              <h2>正在为「{planningCourse}」排计划</h2>
              <p>浅浅正在查这门课的任务和资料，一般 20–60 秒。你可以先去别处，排好会回到这里等你确认。</p>
            </div>
          ) : status.state === "empty" ? (
            <div className="empty-plan">
              <div className="plan-orbit">!</div>
              <h2>这次没有排出计划草案</h2>
              <p>
                {status.busy === "confirm"
                  ? "浅浅正在等你确认另一张卡片（任务写入），先处理完那张再回来排计划。"
                  : status.busy === "running"
                    ? "浅浅正在处理上一件事，等它结束再点一次就好。"
                    : "浅浅这次没有整理出计划草案，它说的是："}
              </p>
              {!status.busy && status.reply ? <p className="plan-reply">{status.reply}</p> : null}
              <div className="plan-actions">
                <button className="primary-button" onClick={() => { setJustSaved(false); onGenerate(selectedCourseId, examAt, availability); }}>重新生成</button>
                <button className="quiet-button" onClick={onOpenAssistant}>去浅浅看看</button>
              </div>
            </div>
          ) : (
            <div className="empty-plan">
              <div className="plan-orbit">✦</div>
              <h2>计划会出现在这里</h2>
              <p>选择课程并告诉我你有空的时间，浅浅会基于真实数据生成一份可确认的草案。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanItem({ date, title, duration, note, focus, route, checkpoint }: {
  date: string;
  title: string;
  duration: string;
  note?: string;
  focus?: string;
  route?: string;
  checkpoint?: string;
}) {
  const detailed = Boolean(focus || route || checkpoint);
  return (
    <div className="plan-item">
      <time>{date}</time>
      <div>
        <strong>{title}</strong>
        {note ? <span>{note}</span> : null}
        {detailed ? (
          <div className="plan-item-detail">
            {focus ? <p><b>重点</b>{focus}</p> : null}
            {route ? <p><b>路线</b>{route}</p> : null}
            {checkpoint ? <p><b>自测</b>{checkpoint}</p> : null}
          </div>
        ) : null}
      </div>
      <b>{duration}</b>
    </div>
  );
}

function SettingsView({
  snapshot, profile, syncState, syncMessage, lastSyncedAt, conversationCount, notificationPermission,
  preferences, currentUser, onToggleAnimations, onSyncNow, onSaveProfile, onExport, onExportICal,
  onEnableNotifications, onImport, onFile, onReset, onLogout, inputRef,
}: {
  snapshot: AppSnapshot;
  profile: UserProfile;
  syncState: "idle" | "syncing" | "error" | "offline";
  syncMessage: string;
  lastSyncedAt: string | null;
  conversationCount: number;
  notificationPermission: NotificationPermission | "unsupported";
  preferences: Preferences;
  currentUser: SessionUser;
  onToggleAnimations: (next: boolean) => void;
  onSyncNow: () => void;
  onSaveProfile: (profile: UserProfile) => void;
  onExport: () => void;
  onExportICal: () => void;
  onEnableNotifications: () => void | Promise<void>;
  onImport: () => void;
  onFile: (file?: File) => void;
  onReset: () => void;
  onLogout: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState<UserProfile>(profile);
  const [confirmReset, setConfirmReset] = useState(false);
  const notificationLabel =
    notificationPermission === "granted" ? "桌面提醒已开启"
      : notificationPermission === "denied" ? "被浏览器拦截"
        : notificationPermission === "unsupported" ? "浏览器不支持"
          : "开启桌面提醒";
  const syncTitle =
    syncState === "syncing" ? "正在同步…"
      : syncState === "error" ? "同步失败"
        : syncState === "offline" ? "离线模式"
          : lastSyncedAt ? "已同步" : "等待首次同步";
  const syncDetail =
    syncState === "error" || syncState === "offline"
      ? (syncMessage || "联网后会自动重试")
      : lastSyncedAt
        ? `上次同步：${formatDate(lastSyncedAt)}`
        : "有任何改动都会自动同步到云端";
  const totalFileBytes = snapshot.resources.reduce((sum, resource) => sum + (resource.fileSize ?? 0), 0);

  return (
    <div className="page-view settings-view">
      <PageHeader eyebrow="SETTINGS" title="设置" description="外观、提醒、数据与账号，都收在这里。" />
      <div className="settings-grid">
        <section className="settings-card">
          <div className="card-kicker">APPEARANCE</div>
          <h3>外观与动画</h3>
          <div className="settings-row">
            <div className="settings-row-main">
              <strong>界面动画</strong>
              <small>打开软件时的片头动画、页面切换与卡片入场。关掉后界面直接出现，不再有过渡动画。</small>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.animations}
              aria-label="界面动画"
              className={`switch ${preferences.animations ? "on" : ""}`}
              onClick={() => onToggleAnimations(!preferences.animations)}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="settings-hint">
            当前：<b>{preferences.animations ? "动画已开启" : "动画已关闭"}</b>
            {preferences.animations ? " · 片头动画与页面过渡都会播放" : " · 片头与过渡都不会再出现"}
          </p>
        </section>

        <section className="settings-card">
          <div className="card-kicker">REMINDERS</div>
          <h3>提醒与日历</h3>
          <div className="settings-row">
            <div className="settings-row-main">
              <strong>桌面提醒</strong>
              <small>任务临近截止时弹系统通知。需要浏览器授权，且只在浅浅页面开着的时候生效。</small>
            </div>
            <button className="quiet-button" onClick={onEnableNotifications}>{notificationLabel}</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <strong>导出日历 (.ics)</strong>
              <small>把每条任务连同它的提醒规则写进日历（含提前 3 天 / 1 天 / 2 小时等闹钟）。导入手机或电脑日历后，关掉网页也会照常提醒。</small>
            </div>
            <button className="quiet-button" onClick={onExportICal}>导出日历</button>
          </div>
        </section>

        <section className="settings-card">
          <div className="card-kicker">DATA</div>
          <h3>数据与同步</h3>
          <div className="settings-row">
            <div className="sync-status">
              <span className={`sync-dot ${syncState}`} />
              <div>
                <strong>云同步 · {syncTitle}</strong>
                <small>{syncDetail}</small>
              </div>
            </div>
            <button className="quiet-button" onClick={onSyncNow} disabled={syncState === "syncing"}>
              {syncState === "syncing" ? "同步中…" : "立即同步"}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main">
              <strong>本地备份</strong>
              <small>备份包含课程、资料、任务、对话与画像；原始文件（PDF / 图片本体）不在这里，可在资料库单独打开或下载。</small>
            </div>
            <span className="settings-row-actions">
              <button className="quiet-button" onClick={onExport}>下载备份</button>
              <button className="quiet-button" onClick={onImport}>恢复备份</button>
            </span>
          </div>
          <div className="settings-stats">
            <div><strong>{snapshot.courses.length}</strong><span>门课程</span></div>
            <div><strong>{snapshot.resources.length}</strong><span>份资料</span></div>
            <div><strong>{snapshot.tasks.length}</strong><span>条任务</span></div>
            <div><strong>{conversationCount}</strong><span>个对话</span></div>
          </div>
          <div className="settings-row danger">
            <div className="settings-row-main">
              <strong>恢复示例数据</strong>
              <small>
                会把示例课程、资料与任务加回你的空间并同步到服务端，你自己的资料不会被删除。
                本机存储：{snapshot.resources.length} 份资料 · 原文件 {totalFileBytes > 0 ? formatBytes(totalFileBytes) : "—"} · {profile.notes.length} 条记忆笔记。
              </small>
            </div>
            {confirmReset ? (
              <span className="settings-row-actions">
                <button className="quiet-button danger" onClick={() => { onReset(); setConfirmReset(false); }}>确认恢复</button>
                <button className="text-button" onClick={() => setConfirmReset(false)}>取消</button>
              </span>
            ) : (
              <button className="text-button" onClick={() => setConfirmReset(true)}>恢复…</button>
            )}
          </div>
          <input ref={inputRef} type="file" accept="application/json" hidden onChange={(event) => onFile(event.target.files?.[0])} />
        </section>

        <section className="settings-card">
          <div className="card-kicker">PROFILE</div>
          <h3>学习画像</h3>
          <p>浅浅每一轮思考、制定计划时都会参考这些信息；也可以在对话里直接告诉它，它会自己记住。</p>
          <div className="form-grid profile-form">
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="怎么称呼你" aria-label="称呼" />
            <input value={draft.studyTime} onChange={(event) => setDraft({ ...draft, studyTime: event.target.value })} placeholder="方便学习的时间，如：工作日晚上" aria-label="方便学习的时间" />
            <input value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} placeholder="本学期目标，如：数据库期末 90 分" aria-label="本学期目标" />
          </div>
          <div className="data-actions"><button className="primary-button" onClick={() => onSaveProfile(draft)}>保存画像</button></div>
        </section>

        <section className="settings-card">
          <div className="card-kicker">ACCOUNT</div>
          <h3>账号</h3>
          <div className="settings-row">
            <div className="settings-row-main">
              <strong>{currentUser.displayName}</strong>
              <small>@{currentUser.username} · {currentUser.role === "admin" ? "管理员" : "学生"} · 数据按账号隔离，换设备登录同一账号即可继续</small>
            </div>
            <button className="quiet-button" onClick={onLogout}>登出</button>
          </div>
        </section>
      </div>
    </div>
  );
}

// 本机没有原文件、但服务端有备份时，用服务端地址做预览
function previewFromServer(fileKey: string, resource: Resource): LocalPreview {
  const url = serverFileUrl(fileKey);
  const name = (resource.fileName ?? resource.title ?? "").toLowerCase();
  const mime = resource.mimeType ?? "";
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    return { kind: "server", url, render: "image" };
  }
  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    return { kind: "server", url, render: "pdf" };
  }
  return { kind: "server", url, render: "other" };
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









function weekNumber(date: Date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.max(1, Math.ceil(((date.getTime() - start.getTime()) / 86_400_000 + start.getDay() + 1) / 7));
}

// 按账号隔离的 localStorage 键：避免切换账号时读到上一个账号的标记
function scopedLocalKey(base: string, userId: string | null) {
  return userId ? `${base}::${userId}` : base;
}

const PROACTIVE_KEY = "study-agent-proactive-date";

/** 从抽取正文里抽出"目录感"的结构（页码 / 小标题），帮模型快速定位重点 */
function buildResourceOutline(contentText: string) {
  const pages = [...contentText.matchAll(/第(\d+)页[：:]\s*([^\n]{0,48})/g)];
  if (pages.length >= 3) {
    return pages.slice(0, 30).map((match) => `第${match[1]}页：${safeSlice(match[2].trim(), 0, 48)}`).join("\n");
  }
  const headings = contentText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 2 && line.length <= 28);
  return headings.slice(0, 20).join("\n");
}

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


































































































