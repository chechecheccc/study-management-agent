import type { Confidence, ExtractResult } from "./ai-contract";
import type { Course, Resource, Task } from "./local-store";
import { makeId } from "./local-store";

export const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BYTES = 500 * 1024 * 1024;

export type PendingResourceDraft = {
  title: string;
  courseId: string;
  /** 选择「新建课程」时输入的新课程名 */
  newCourseName?: string;
  type: Resource["type"];
  tags: string[];
  confidence: Confidence;
  evidence: string;
  file?: File;
};

export type PendingMeta = {
  confidence: Confidence;
  evidence: string;
  questions: string[];
};

export type ImportQueueStatus =
  | "queued"
  | "processing"
  | "awaiting_confirmation"
  | "saving"
  | "saved"
  | "failed"
  | "cancelled";

export type ImportQueueItem = {
  id: string;
  file: File;
  status: ImportQueueStatus;
  resourceDraft?: PendingResourceDraft;
  taskDraft?: Task;
  taskMeta?: PendingMeta;
  includeTask: boolean;
  summary?: string;
  /** 入库时提取的正文文本，确认后写入 resource.contentText */
  contentText?: string;
  error?: string;
  failureKind?: "validation" | "processing" | "storage";
};

export type ImportSelectionValidation = {
  totalBytes: number;
  batchError: string | null;
  accepted: File[];
  rejected: Array<{ file: File; message: string }>;
};

export function validateImportSelection(files: File[]): ImportSelectionValidation {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_IMPORT_BATCH_BYTES) {
    return {
      totalBytes,
      batchError: "单批次文件总量不能超过 500MB，请拆分后重新选择。",
      accepted: [],
      rejected: [],
    };
  }

  const accepted: File[] = [];
  const rejected: Array<{ file: File; message: string }> = [];
  files.forEach((file) => {
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      rejected.push({ file, message: "单个文件不能超过 100MB。" });
      return;
    }
    if (!isAllowedImportFile(file)) {
      rejected.push({ file, message: "仅支持 PDF、Word、PPT、PNG、JPEG、WebP 和 GIF。" });
      return;
    }
    accepted.push(file);
  });

  return { totalBytes, batchError: null, accepted, rejected };
}

export function buildImportDraft(result: ExtractResult, file: File, courses: Course[]) {
  const firstTask = result.tasks[0];
  const candidate = result.resource;
  const resourceDraft: PendingResourceDraft = {
    title: candidate?.title || stripImportExtension(file.name),
    courseId: findCourseId(candidate?.courseName ?? null, courses) || guessCourseId(file.name, courses),
    type: candidate?.resourceType ?? guessImportResourceType(file.name),
    tags: candidate?.tags?.length ? candidate.tags : ["待整理"],
    confidence: candidate?.confidence ?? "low",
    evidence: candidate?.evidence || `文件名：${file.name}`,
    file,
  };

  const taskDraft: Task | undefined = firstTask
    ? {
        id: makeId("task-draft"),
        title: firstTask.title,
        courseId: findCourseId(firstTask.courseName, courses) || resourceDraft.courseId,
        type: firstTask.taskType === "其他" ? "DDL" : firstTask.taskType,
        dueAt: firstTask.dueAt?.slice(0, 16) ?? "",
        status: "未开始",
        priority: firstTask.confidence === "high" ? "高" : "中",
        reminder: "提前3天、1天、2小时",
      }
    : undefined;

  const taskMeta: PendingMeta | undefined = firstTask
    ? {
        confidence: firstTask.confidence,
        evidence: firstTask.evidence,
        questions: [...firstTask.ambiguities, ...result.questions].slice(0, 8),
      }
    : undefined;

  return {
    resourceDraft,
    taskDraft,
    taskMeta,
    includeTask: Boolean(taskDraft),
    summary: result.summary,
  };
}

export function buildFallbackImportDraft(file: File, courses: Course[]): PendingResourceDraft {
  return {
    title: stripImportExtension(file.name),
    courseId: guessCourseId(file.name, courses),
    type: guessImportResourceType(file.name),
    tags: ["待整理", "文件名建议"],
    confidence: "low",
    evidence: `文件名：${file.name}`,
    file,
  };
}

export function isImageImportFile(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

export function isAllowedImportFile(file: File) {
  return /\.(pdf|docx?|pptx?|png|jpe?g|webp|gif)$/i.test(file.name);
}

export function stripImportExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").trim() || fileName;
}

export function guessImportResourceType(fileName: string): Resource["type"] {
  const name = fileName.toLowerCase();
  if (/作业|实验|homework|assignment/.test(name)) return "作业";
  if (/通知|公告|notice|screenshot|截图/.test(name)) return "通知";
  if (/试卷|真题|exam|test/.test(name)) return "试卷";
  if (/笔记|note/.test(name)) return "笔记";
  if (/\.pptx?$|课件|讲义|slide/.test(name)) return "课件";
  return "其他";
}

function findCourseId(courseName: string | null, courses: Course[]) {
  if (!courseName) return "";
  const normalized = courseName.replace(/\s+/g, "").toLowerCase();
  return courses.find((course) => course.name.replace(/\s+/g, "").toLowerCase() === normalized)?.id ?? "";
}

function guessCourseId(fileName: string, courses: Course[]) {
  const normalized = fileName.replace(/\s+/g, "").toLowerCase();
  return courses.find((course) => normalized.includes(course.name.replace(/\s+/g, "").toLowerCase()))?.id ?? "";
}


