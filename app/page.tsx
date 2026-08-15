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
  loadSnapshot,
  makeId,
  saveLocalFile,
  saveSnapshot,
} from "./lib/local-store";
import type { Confidence, ExtractRequest, ExtractResult } from "./lib/ai-contract";
import { buildLocalPreview, releaseLocalPreview } from "./lib/file-preview";
import type { LocalPreview } from "./lib/file-preview";
import {
  buildFallbackImportDraft,
  buildImportDraft,
  isImageImportFile,
  validateImportSelection,
} from "./lib/import-queue";
import type { ImportQueueItem, PendingMeta, PendingResourceDraft } from "./lib/import-queue";
import { BatchImportQueue } from "./components/import-queue";
import { StudyIntro } from "./components/study-intro";

gsap.registerPlugin(useGSAP);

type View = "assistant" | "resources" | "tasks" | "review" | "data";
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "你好，我是你的学习管家。你可以直接说“帮我记下这个DDL”“找数据库的课件”或“安排本周复习”。",
  },
];

const viewLabels: Record<View, string> = {
  assistant: "智能体",
  resources: "资料库",
  tasks: "任务中心",
  review: "复习计划",
  data: "数据管理",
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
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [pendingMeta, setPendingMeta] = useState<PendingMeta | null>(null);
  const [pendingResource, setPendingResource] = useState<PendingResourceDraft | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
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
  const importInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const batchRunningRef = useRef(false);
  const cancelledImportIdsRef = useRef(new Set<string>());
  const importAbortControllersRef = useRef(new Map<string, AbortController>());
  const savingImportIdsRef = useRef(new Set<string>());

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
      const onEnter = contextSafe(() => gsap.to(button, { y: -2, scale: 1.015, duration: 0.18, ease: "power2.out", overwrite: "auto" }));
      const onLeave = contextSafe(() => gsap.to(button, { y: 0, scale: 1, duration: 0.22, ease: "power2.out", overwrite: "auto" }));
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
      ".view-surface .gsap-message, .view-surface .gsap-action-card, .view-surface .queue-item",
      { y: 12, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.32, stagger: 0.045, ease: "power2.out", delay: 0.08 },
    );
  }, {
    scope: appRef,
    dependencies: [view, messages.length, Boolean(pendingTask), Boolean(pendingResource), importQueue.length],
    revertOnUpdate: true,
  });

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.to(".ambient-glow-one", { x: 24, y: -18, rotation: 12, repeat: -1, yoyo: true, duration: 7, ease: "sine.inOut" });
    gsap.to(".ambient-glow-two", { x: -18, y: 22, rotation: -10, repeat: -1, yoyo: true, duration: 9, ease: "sine.inOut" });
  }, { scope: appRef });

  useEffect(() => {
    loadSnapshot().then((stored) => {
      const next = stored.courses.length ? stored : demoSnapshot();
      setSnapshot(next);
      setReady(true);
      setResourceCourse(next.courses[0]?.id ?? "");
      setTaskCourse(next.courses[0]?.id ?? "");
      if (!stored.courses.length) saveSnapshot(next);
    });
  }, []);

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
    if (ready) saveSnapshot(snapshot);
  }, [ready, snapshot]);

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

  const findCourseId = (courseName: string | null) => {
    if (!courseName) return "";
    const normalized = courseName.replace(/\s+/g, "").toLowerCase();
    return snapshot.courses.find((course) => course.name.replace(/\s+/g, "").toLowerCase() === normalized)?.id ?? "";
  };

  const applyExtractResult = (result: ExtractResult, file?: File) => {
    const firstTask = result.tasks[0];
    if (firstTask) {
      setPendingTask({
        id: makeId("task-draft"),
        title: firstTask.title,
        courseId: findCourseId(firstTask.courseName),
        type: firstTask.taskType === "其他" ? "DDL" : firstTask.taskType,
        dueAt: firstTask.dueAt?.slice(0, 16) ?? "",
        status: "未开始",
        priority: firstTask.confidence === "high" ? "高" : "中",
        reminder: "提前3天、1天、2小时",
      });
      setPendingMeta({
        confidence: firstTask.confidence,
        evidence: firstTask.evidence,
        questions: [...firstTask.ambiguities, ...result.questions].slice(0, 8),
      });
    }

    if (result.resource || file) {
      const candidate = result.resource;
      setPendingResource({
        title: candidate?.title || stripExtension(file?.name || "待整理资料"),
        courseId: findCourseId(candidate?.courseName ?? null),
        type: candidate?.resourceType ?? guessResourceType(file?.name || ""),
        tags: candidate?.tags?.length ? candidate.tags : ["待整理"],
        confidence: candidate?.confidence ?? "low",
        evidence: candidate?.evidence || "根据文件名生成的本地建议",
        file,
      });
    }

    const followUp = result.questions.length ? ` 还需要确认：${result.questions.join("；")}` : "";
    addAssistantMessage(`${result.summary}${followUp}`);
  };

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

  const runExtraction = async (request: ExtractRequest, file?: File) => {
    setExtracting(true);
    setExtractError("");
    try {
      const result = await requestExtraction(request);
      applyExtractResult(result, file);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "在线识别暂时不可用。";
      setExtractError(message);
      addAssistantMessage(`${message} 原始内容没有丢失，你仍可手动完成录入。`);
      if (file) setPendingResource(buildFallbackImportDraft(file, snapshot.courses));
      return false;
    } finally {
      setExtracting(false);
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || extracting || batchRunningRef.current) return;
    setMessages((current) => [...current, { id: makeId("message"), role: "user", text }]);
    setInput("");

    if (/找|查|搜索|课件|资料/.test(text)) {
      setSearch(text.replace(/找|查|搜索|课件|资料/g, "").trim());
      setView("resources");
      addAssistantMessage("我已打开资料库，并按你的关键词筛选结果。你可以继续补充课程或资料类型。");
      return;
    }

    if (/复习|计划|考试安排/.test(text)) {
      setView("review");
      addAssistantMessage("好的，我打开复习计划。请先选择课程、考试时间和你方便学习的日期/时间段。");
      return;
    }

    if (/DDL|截止|作业|考试|提交|通知|课程群/.test(text)) {
      await runExtraction({ mode: "text", text });
      return;
    }

    addAssistantMessage("我可以帮你录入 DDL、整理资料、检索课程内容，或根据考试日期安排复习。你想先处理哪一件？");
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
          let request: ExtractRequest;
          if (isImageImportFile(item.file) && item.file.size <= 10 * 1024 * 1024) {
            const imageDataUrl = await readAsDataUrl(item.file);
            if (cancelledImportIdsRef.current.has(item.id)) throw new DOMException("Cancelled", "AbortError");
            request = { mode: "image", imageDataUrl, fileName: item.file.name };
          } else {
            request = { mode: "filename", fileName: item.file.name };
          }

          const result = await requestExtraction(request, controller.signal);
          if (cancelledImportIdsRef.current.has(item.id)) throw new DOMException("Cancelled", "AbortError");
          const draft = buildImportDraft(result, item.file, snapshot.courses);
          updateImportQueueItem(item.id, (current) => ({
            ...current,
            ...draft,
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
    if (!files.length || extracting) return;
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

  const toggleImportTask = (id: string, includeTask: boolean) => {
    updateImportQueueItem(id, (item) => ({ ...item, includeTask, error: undefined }));
  };

  const useManualImportDraft = (id: string) => {
    updateImportQueueItem(id, (item) => item.resourceDraft
      ? { ...item, status: "awaiting_confirmation", error: undefined, includeTask: false }
      : item);
  };

  const removeImportItem = (id: string) => {
    cancelledImportIdsRef.current.delete(id);
    setImportQueue((current) => current.filter((item) => item.id !== id));
  };

  const clearFinishedImports = () => {
    importQueue.forEach((item) => {
      if (item.status === "saved" || item.status === "cancelled") cancelledImportIdsRef.current.delete(item.id);
    });
    setImportQueue((current) => current.filter((item) => item.status !== "saved" && item.status !== "cancelled"));
  };

  const confirmPendingTask = () => {
    if (!pendingTask) return;
    if (!pendingTask.courseId || !pendingTask.dueAt || !pendingTask.title.trim()) {
      addAssistantMessage("课程、任务名称或截止时间仍不完整，请先补充后再确认。 ");
      return;
    }
    setSnapshot((current) => ({ ...current, tasks: [pendingTask, ...current.tasks] }));
    setPendingTask(null);
    setPendingMeta(null);
    addAssistantMessage("已保存任务，并设置了提前 3 天、1 天和 2 小时的提醒规则。之后可以在任务中心修改。");
  };

  const confirmPendingResource = async () => {
    if (!pendingResource) return;
    if (!pendingResource.courseId || !pendingResource.title.trim()) {
      addAssistantMessage("资料名称或课程仍不完整，请先补充后再确认。 ");
      return;
    }

    const resourceId = makeId("resource");
    try {
      const fileRecord = pendingResource.file
        ? await saveLocalFile(resourceId, pendingResource.file)
        : null;
      const resource: Resource = {
        id: resourceId,
        title: pendingResource.title.trim(),
        courseId: pendingResource.courseId,
        type: pendingResource.type,
        tags: pendingResource.tags,
        status: "未整理",
        importedAt: new Date().toISOString().slice(0, 10),
        fileName: pendingResource.file?.name,
        fileId: fileRecord?.id,
        fileSize: fileRecord?.size,
        mimeType: fileRecord?.type,
      };
      setSnapshot((current) => ({ ...current, resources: [resource, ...current.resources] }));
      setPendingResource(null);
      addAssistantMessage("资料和原始文件已保存在当前浏览器，并加入本地检索目录。 ");
    } catch {
      addAssistantMessage("浏览器没有足够空间保存原文件，请先备份或清理本地空间。 ");
    }
  };

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
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `学习管家备份-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importBackup = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result)) as AppSnapshot;
        if (!Array.isArray(imported.courses) || !Array.isArray(imported.resources) || !Array.isArray(imported.tasks)) {
          throw new Error("invalid backup");
        }
        setSnapshot(imported);
        addAssistantMessage("备份已载入当前浏览器。请检查课程、资料和任务数量是否符合预期。");
      } catch {
        addAssistantMessage("这个备份文件无法读取。请确认它是学习管家导出的 JSON 备份。");
      }
    };
    reader.readAsText(file);
  };

  const resetDemo = () => {
    const next = demoSnapshot();
    setSnapshot(next);
    addAssistantMessage("示例数据已恢复。你可以在此基础上继续添加自己的课程、资料和任务。");
  };

  return (
    <>
    <main className="app-shell" ref={appRef}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">学</div>
          <div>
            <div className="brand-name">学习管家</div>
            <div className="brand-caption">personal study desk</div>
          </div>
        </div>

        <nav className="main-nav" aria-label="主导航">
          {(Object.keys(viewLabels) as View[]).map((item) => (
            <button
              className={`nav-item ${view === item ? "active" : ""}`}
              key={item}
              onClick={() => setView(item)}
            >
              <span className="nav-dot">{item === "assistant" ? "✦" : item === "resources" ? "▣" : item === "tasks" ? "◷" : item === "review" ? "✓" : "⚙"}</span>
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

        <div className="sidebar-footer">
          <span className="local-indicator" />
          <span>数据保存在本机浏览器</span>
        </div>
      </aside>

      <section className="main-area">
        <div className="ambient-glow ambient-glow-one" aria-hidden="true" />
        <div className="ambient-glow ambient-glow-two" aria-hidden="true" />
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark small">学</span>学习管家</div>
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
              pendingTask={pendingTask}
              pendingMeta={pendingMeta}
              pendingResource={pendingResource}
              courses={snapshot.courses}
              extracting={extracting}
              extractError={extractError}
              modelConfigured={modelConfigured}
              importQueue={importQueue}
              batchRunning={batchRunning}
              attachmentInputRef={attachmentInputRef}
              onAttachments={handleAttachments}
              onImportResourceChange={updateImportResource}
              onImportTaskChange={updateImportTask}
              onToggleImportTask={toggleImportTask}
              onConfirmImport={confirmImportItem}
              onCancelImport={cancelImportItem}
              onRetryImport={retryImportItem}
              onManualImport={useManualImportDraft}
              onRemoveImport={removeImportItem}
              onClearFinishedImports={clearFinishedImports}
              onPendingTaskChange={setPendingTask}
              onPendingResourceChange={setPendingResource}
              onConfirm={confirmPendingTask}
              onConfirmResource={confirmPendingResource}
              onCancel={() => { setPendingTask(null); setPendingMeta(null); }}
              onCancelResource={() => setPendingResource(null)}
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

          {view === "review" ? <ReviewView courses={snapshot.courses} resources={snapshot.resources} /> : null}

          {view === "data" ? (
            <DataView
              snapshot={snapshot}
              onExport={exportBackup}
              onImport={() => importInputRef.current?.click()}
              onFile={importBackup}
              onReset={resetDemo}
              inputRef={importInputRef}
            />
          ) : null}
        </div>
      </section>
    </main>
    {showIntro ? <StudyIntro onComplete={() => setShowIntro(false)} /> : null}
    </>
  );
}

function AssistantView({
  messages,
  input,
  setInput,
  onSend,
  pendingTask,
  pendingMeta,
  pendingResource,
  courses,
  extracting,
  extractError,
  modelConfigured,
  importQueue,
  batchRunning,
  attachmentInputRef,
  onAttachments,
  onImportResourceChange,
  onImportTaskChange,
  onToggleImportTask,
  onConfirmImport,
  onCancelImport,
  onRetryImport,
  onManualImport,
  onRemoveImport,
  onClearFinishedImports,
  onPendingTaskChange,
  onPendingResourceChange,
  onConfirm,
  onConfirmResource,
  onCancel,
  onCancelResource,
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
  pendingTask: Task | null;
  pendingMeta: PendingMeta | null;
  pendingResource: PendingResourceDraft | null;
  courses: Course[];
  extracting: boolean;
  extractError: string;
  modelConfigured: boolean | null;
  importQueue: ImportQueueItem[];
  batchRunning: boolean;
  attachmentInputRef: React.RefObject<HTMLInputElement | null>;
  onAttachments: (files: File[]) => void | Promise<void>;
  onImportResourceChange: (id: string, patch: Partial<PendingResourceDraft>) => void;
  onImportTaskChange: (id: string, patch: Partial<Task>) => void;
  onToggleImportTask: (id: string, include: boolean) => void;
  onConfirmImport: (id: string) => void | Promise<void>;
  onCancelImport: (id: string) => void;
  onRetryImport: (id: string) => void | Promise<void>;
  onManualImport: (id: string) => void;
  onRemoveImport: (id: string) => void;
  onClearFinishedImports: () => void;
  onPendingTaskChange: React.Dispatch<React.SetStateAction<Task | null>>;
  onPendingResourceChange: React.Dispatch<React.SetStateAction<PendingResourceDraft | null>>;
  onConfirm: () => void;
  onConfirmResource: () => void | Promise<void>;
  onCancel: () => void;
  onCancelResource: () => void;
  upcomingTasks: Task[];
  courseMap: Map<string, Course>;
  pendingCount: number;
  completedCount: number;
  onNavigate: (view: View) => void;
}) {
  return (
    <div className="assistant-layout">
      <div className="assistant-column">
        <div className="eyebrow">MONDAY, 03 AUGUST 2026</div>
        <h1>今天，把学习<br /><em>理清一点。</em></h1>
        <p className="intro-copy">从一句话开始。整理资料、记下截止日期，或者让计划有一个可执行的起点。</p>

        <div className="chat-panel">
          <div className="chat-head">
            <span className={`online-dot ${modelConfigured === false ? "offline" : ""}`} />
            学习管家
            <span className="head-note">
              本地优先 · {modelConfigured === null ? "正在检查模型" : modelConfigured ? "GLM 在线识别可用" : "手动模式可用"}
            </span>
          </div>
          <div className="message-list">
            {messages.map((message) => (
              <div className={`message-row ${message.role} gsap-message`} key={message.id}>
                <div className="avatar">{message.role === "assistant" ? "学" : "我"}</div>
                <div className="message-bubble">{message.text}</div>
              </div>
            ))}
            {pendingTask ? (
              <div className="action-card gsap-action-card">
                <div className="action-label">待确认操作 · DDL</div>
                <input
                  className="action-title-input"
                  value={pendingTask.title}
                  onChange={(event) => onPendingTaskChange((current) => current ? { ...current, title: event.target.value } : current)}
                  aria-label="候选任务名称"
                />
                <div className="action-edit-grid">
                  <label><span>课程</span><select value={pendingTask.courseId} onChange={(event) => onPendingTaskChange((current) => current ? { ...current, courseId: event.target.value } : current)}><option value="">请选择课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>
                  <label><span>截止</span><input type="datetime-local" value={pendingTask.dueAt} onChange={(event) => onPendingTaskChange((current) => current ? { ...current, dueAt: event.target.value } : current)} /></label>
                  <label><span>类型</span><select value={pendingTask.type} onChange={(event) => onPendingTaskChange((current) => current ? { ...current, type: event.target.value as Task["type"] } : current)}><option>DDL</option><option>考试</option><option>复习</option></select></label>
                  <label><span>提醒</span><input value={pendingTask.reminder} onChange={(event) => onPendingTaskChange((current) => current ? { ...current, reminder: event.target.value } : current)} /></label>
                </div>
                {pendingMeta ? <div className="evidence-box"><span>识别置信度 · {confidenceLabel(pendingMeta.confidence)}</span><p>{pendingMeta.evidence || "模型未给出明确依据"}</p>{pendingMeta.questions.length ? <ul>{pendingMeta.questions.map((question) => <li key={question}>{question}</li>)}</ul> : null}</div> : null}
                <div className="action-buttons"><button className="primary-button" onClick={onConfirm}>确认并保存</button><button className="quiet-button" onClick={onCancel}>取消</button></div>
              </div>
            ) : null}
            {pendingResource ? (
              <div className="action-card resource-action-card gsap-action-card">
                <div className="action-label">待确认操作 · 资料入库</div>
                <input className="action-title-input" value={pendingResource.title} onChange={(event) => onPendingResourceChange((current) => current ? { ...current, title: event.target.value } : current)} aria-label="候选资料名称" />
                <div className="action-edit-grid">
                  <label><span>课程</span><select value={pendingResource.courseId} onChange={(event) => onPendingResourceChange((current) => current ? { ...current, courseId: event.target.value } : current)}><option value="">请选择课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>
                  <label><span>资料类型</span><select value={pendingResource.type} onChange={(event) => onPendingResourceChange((current) => current ? { ...current, type: event.target.value as Resource["type"] } : current)}><option>课件</option><option>作业</option><option>笔记</option><option>通知</option><option>试卷</option><option>其他</option></select></label>
                </div>
                <div className="candidate-tags">{pendingResource.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                <div className="evidence-box"><span>识别置信度 · {confidenceLabel(pendingResource.confidence)}</span><p>{pendingResource.evidence}</p>{pendingResource.file ? <small>{pendingResource.file.name} · {formatBytes(pendingResource.file.size)} · 原文件将保存在浏览器本地</small> : null}</div>
                <div className="action-buttons"><button className="primary-button" onClick={onConfirmResource}>确认入库</button><button className="quiet-button" onClick={onCancelResource}>取消</button></div>
              </div>
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
            {extracting ? <div className="extract-progress"><span className="progress-spinner" />GLM-5V-Turbo 正在提取课程、标签与 DDL…</div> : null}
            {extractError ? <div className="extract-error">{extractError}</div> : null}
          </div>
          <div className="composer">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !extracting && !batchRunning) onSend(); }}
              placeholder="说说你想处理什么…"
              aria-label="输入学习管理需求"
              disabled={extracting || batchRunning}
            />
            <input
              ref={attachmentInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,image/*"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                onAttachments(files);
                event.currentTarget.value = "";
              }}
            />
            <button className="attach-button" title="批量上传截图或课程文件" onClick={() => attachmentInputRef.current?.click()} disabled={extracting || batchRunning}>＋</button>
            <button className="send-button" onClick={onSend} aria-label="发送" disabled={extracting || batchRunning}>{extracting || batchRunning ? "·" : "↑"}</button>
          </div>
        </div>

        <div className="quick-actions">
          <button onClick={() => setInput("帮我记下这个DDL")}>＋ 录入 DDL</button>
          <button onClick={() => onNavigate("resources")}>▣ 整理资料</button>
          <button onClick={() => onNavigate("resources")}>⌕ 查找资料</button>
          <button onClick={() => onNavigate("review")}>✦ 生成复习计划</button>
        </div>
      </div>

      <aside className="dashboard-rail">
        <div className="date-card"><span>08</span><div><b>八月</b><small>2026 · 第 32 周</small></div></div>
        <div className="stat-row"><div><strong>{upcomingTasks.length}</strong><span>待完成任务</span></div><div><strong>{pendingCount}</strong><span>待整理资料</span></div><div><strong>{completedCount}</strong><span>本周完成</span></div></div>
        <div className="rail-section"><div className="section-heading"><span>接下来</span><button onClick={() => onNavigate("tasks")}>查看全部 →</button></div>
          {upcomingTasks.slice(0, 3).map((task) => <TaskMini key={task.id} task={task} course={courseMap.get(task.courseId)} />)}
        </div>
        <div className="tip-card"><span className="tip-kicker">一个小建议</span><p>先把散落的通知交给我，确认后再写入你的学习空间。</p><span className="tip-line" /></div>
      </aside>
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
    {showForm ? <div className="inline-form"><div className="form-title">新建资料卡片 <span>若要保存原文件并自动识别，请在智能体首页点击“＋”上传</span></div><div className="form-grid"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="资料名称" /><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><select value={type} onChange={(event) => setType(event.target.value as Resource["type"])}><option>课件</option><option>作业</option><option>笔记</option><option>通知</option><option>试卷</option><option>其他</option></select><button className="primary-button" onClick={onCreate}>保存资料</button></div></div> : null}
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
    return <div className="preview-panel"><div className="preview-top"><span>资料预览</span><span className="preview-tag">LOCAL</span></div><div className="preview-placeholder"><div className="paper-icon">▤</div><strong>选择一份资料</strong><span>原始文件、课程标签和学习状态会显示在这里。</span></div></div>;
  }

  return (
    <div className="preview-panel live-preview">
      <div className="preview-top"><span>资料预览</span><span className="preview-tag">本地文件</span></div>
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
      <div className="preview-note">原始文件留在当前浏览器；只有主动执行 AI 识别时才发送必要内容。</div>
    </div>
  );
}

function TasksView({ tasks, courseMap, courses, showForm, setShowForm, title, setTitle, courseId, setCourseId, dueAt, setDueAt, onCreate, onComplete }: { tasks: Task[]; courseMap: Map<string, Course>; courses: Course[]; showForm: boolean; setShowForm: (value: boolean) => void; title: string; setTitle: (value: string) => void; courseId: string; setCourseId: (value: string) => void; dueAt: string; setDueAt: (value: string) => void; onCreate: () => void; onComplete: (id: string) => void; }) {
  return <div className="page-view"><PageHeader eyebrow="TASK DESK" title="任务中心" description="DDL、考试和复习时段，放在同一条时间线上。" action={<button className="primary-button" onClick={() => setShowForm(!showForm)}>＋ 新建任务</button>} />
    {showForm ? <div className="inline-form"><div className="form-title">新建 DDL <span>默认提醒：提前 3 天、1 天、2 小时</span></div><div className="form-grid task-form"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="任务名称" /><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /><button className="primary-button" onClick={onCreate}>保存任务</button></div></div> : null}
    <div className="task-list-wrap"><div className="task-list-head"><span>未完成任务 · {tasks.length}</span><div><span className="legend-dot high" />高优先级 <span className="legend-dot" />普通</div></div>{tasks.map((task) => <div className="task-row" key={task.id}><div className={`task-marker ${task.priority === "高" ? "high" : ""}`} /><div className="task-row-main"><strong>{task.title}</strong><span>{courseMap.get(task.courseId)?.name ?? "未分类"} · {task.type} · {task.reminder}</span></div><time>{formatDate(task.dueAt)}</time><span className={`status-pill ${task.status === "进行中" ? "working" : ""}`}>{task.status}</span><button className="complete-button" onClick={() => onComplete(task.id)}>完成</button></div>)}{tasks.length === 0 ? <EmptyState title="所有任务都完成了" copy="可以去复习计划，安排下一步学习。" /> : null}</div>
  </div>;
}

function ReviewView({ courses, resources }: { courses: Course[]; resources: Resource[] }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [availability, setAvailability] = useState("工作日晚上 19:00–21:00");
  const [generated, setGenerated] = useState(false);
  const course = courses.find((item) => item.id === courseId);
  const count = resources.filter((resource) => resource.courseId === courseId).length;
  return <div className="page-view"><PageHeader eyebrow="REVIEW STUDIO" title="复习计划" description="先告诉我你什么时候有空，再把资料排成可以完成的节奏。" action={<span className="soft-badge">AI 草案 · 需确认</span>} />
    <div className="review-layout"><div className="review-form-card"><div className="card-kicker">STEP 01 · 先说你的时间</div><h2>为哪门课准备？</h2><select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><label>考试或复习截止时间<input type="datetime-local" defaultValue="2026-08-20T09:00" /></label><label>你什么时候方便学习？<input value={availability} onChange={(event) => setAvailability(event.target.value)} placeholder="例如：周一到周五晚上" /></label><div className="availability-chips"><button onClick={() => setAvailability("工作日晚上 19:00–21:00")}>工作日晚上</button><button onClick={() => setAvailability("周末上午 09:00–12:00")}>周末上午</button><button onClick={() => setAvailability("每天 60 分钟")}>每天1小时</button></div><button className="primary-button wide" onClick={() => setGenerated(true)}>生成计划草案</button><small className="form-help">当前课程已有 {count} 份资料，生成前还会参考“待复习”状态。</small></div><div className="plan-preview-card">{generated ? <><div className="plan-head"><div><div className="card-kicker">STEP 02 · 草案</div><h2>{course?.name ?? "课程"} · 复习节奏</h2></div><span className="soft-badge">{availability}</span></div><PlanItem date="8月13日" title="梳理第一章核心概念" duration="45分钟" /><PlanItem date="8月14日" title="完成一组基础题" duration="45分钟" /><PlanItem date="8月15日" title="整理错题与公式" duration="30分钟" /><div className="plan-actions"><button className="primary-button">确认保存</button><button className="quiet-button" onClick={() => setGenerated(false)}>重新生成</button></div></> : <div className="empty-plan"><div className="plan-orbit">✦</div><h2>计划会出现在这里</h2><p>选择课程并告诉我你有空的时间，先生成一份可调整的草案。</p></div>}</div></div>
  </div>;
}

function PlanItem({ date, title, duration }: { date: string; title: string; duration: string }) { return <div className="plan-item"><time>{date}</time><div><strong>{title}</strong><span>关联资料 · 可调整</span></div><b>{duration}</b></div>; }

function DataView({ snapshot, onExport, onImport, onFile, onReset, inputRef }: { snapshot: AppSnapshot; onExport: () => void; onImport: () => void; onFile: (file?: File) => void; onReset: () => void; inputRef: React.RefObject<HTMLInputElement | null>; }) {
  return (
    <div className="page-view">
      <PageHeader eyebrow="LOCAL SPACE" title="数据管理" description="你的学习空间默认留在当前浏览器里。" action={<span className="local-badge"><span className="local-indicator" />本地存储正常</span>} />
      <div className="data-grid">
        <div className="data-card primary-data">
          <div className="card-kicker">LOCAL SNAPSHOT</div>
          <h2>这是你的个人学习空间</h2>
          <p>课程、资料、任务和对话数据不会自动上传云端。使用备份文件可以在浏览器或设备之间迁移。</p>
          <div className="data-stats"><div><strong>{snapshot.courses.length}</strong><span>门课程</span></div><div><strong>{snapshot.resources.length}</strong><span>份资料</span></div><div><strong>{snapshot.tasks.length}</strong><span>条任务</span></div></div>
          <div className="data-actions"><button className="primary-button" onClick={onExport}>下载本地备份</button><button className="quiet-button" onClick={onImport}>恢复备份</button><input ref={inputRef} type="file" accept="application/json" hidden onChange={(event) => onFile(event.target.files?.[0])} /></div>
        </div>
        <div className="data-card">
          <div className="card-kicker">CURRENT STATUS</div>
          <h3>Sprint 2 智能入库</h3>
          <ul className="check-list">
            <li><span>✓</span>刷新页面后结构化数据仍保留</li>
            <li><span>✓</span>原始文件保存在 IndexedDB</li>
            <li><span>✓</span>文本、截图和文件名智能提取</li>
            <li><span>✓</span>PDF、图片、Word、PPTX 本地预览</li>
            <li><span>✓</span>多文件队列、100MB/500MB 校验</li>
            <li><span>✓</span>逐项确认、取消、失败与重试</li>
            <li><span>✓</span>无网络可浏览、编辑与备份</li>
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

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").trim() || fileName;
}

function guessResourceType(fileName: string): Resource["type"] {
  const name = fileName.toLowerCase();
  if (/作业|实验|homework|assignment/.test(name)) return "作业";
  if (/通知|公告|notice|screenshot|截图/.test(name)) return "通知";
  if (/试卷|真题|exam|test/.test(name)) return "试卷";
  if (/笔记|note/.test(name)) return "笔记";
  if (/\.pptx?$|课件|讲义|slide/.test(name)) return "课件";
  return "其他";
}

function confidenceLabel(confidence: Confidence) {
  return confidence === "high" ? "高" : confidence === "medium" ? "中" : "低";
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action ? <div className="page-header-action">{action}</div> : null}</div>; }

function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><div className="empty-symbol">＋</div><strong>{title}</strong><span>{copy}</span></div>; }
