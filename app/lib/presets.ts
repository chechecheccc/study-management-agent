// 预设课程与预设课件
//
// 设计要点：
//   - 课程/资料的 id 固定，登录后由 applyPresets() 合并进每个人的工作区；
//   - 同一份 PDF 只在服务端 files 表存一份（userId 用 PRESET_FILE_SCOPE），所有账号共用；
//   - 用户自己删掉预设资料后不会再被塞回来（见 local-store 的 hiddenPresets）；
//   - 用户自己上传过同一份课件时按文件名认领，不重复添加。
import type { AppSnapshot, Course } from "./local-store";
import { PRESET_ML_CH1_TEXT, PRESET_ML_CH2_TEXT } from "./preset-courseware";

/** 预设课件在服务端 files 表里的归属（不是真实账号 id，仅用于共享文件） */
export const PRESET_FILE_SCOPE = "__preset__";

export const PRESET_COURSE_ID = "course-ml";
export const PRESET_COURSE_NAME = "机器学习";

/** 预设记录用固定的旧时间戳：任何用户改动都比它新，不会被预设覆盖 */
const PRESET_STAMP = "2026-09-01T00:00:00.000Z";
const PRESET_DATE = "2026-09-01";

export const PRESET_COURSE: Course = {
  id: PRESET_COURSE_ID,
  name: PRESET_COURSE_NAME,
  semester: "2026 秋季",
  color: "yellow",
  updatedAt: PRESET_STAMP,
};

type PresetCourseware = {
  id: string;
  title: string;
  fileName: string;
  fileKey: string;
  fileSize: number;
  tags: string[];
  contentText: string;
};

export const PRESET_COURSEWARE: PresetCourseware[] = [
  {
    id: "resource-preset-ml-ch1",
    title: "第1章 引言",
    fileName: "第1章-引言.pdf",
    fileKey: "file-preset-ml-ch1",
    fileSize: 3412400,
    tags: ["课件", "机器学习", "第1章"],
    contentText: PRESET_ML_CH1_TEXT,
  },
  {
    id: "resource-preset-ml-ch2",
    title: "第2章 连续最优化建模与应用",
    fileName: "第2章  连续最优化建模与应用.pdf.pdf",
    fileKey: "file-preset-ml-ch2",
    fileSize: 2348626,
    tags: ["课件", "机器学习", "第2章"],
    contentText: PRESET_ML_CH2_TEXT,
  },
];

/** 预设资料的 id 前缀，用于判断"这条是不是预设" */
export const PRESET_RESOURCE_PREFIX = "resource-preset-";

export function isPresetResourceId(id: string) {
  return id.startsWith(PRESET_RESOURCE_PREFIX);
}

/** 是不是预设课程（用户删掉它之后不再自动补回来） */
export function isPresetCourseId(id: string) {
  return id === PRESET_COURSE_ID;
}

const normalizeName = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/**
 * 把预设课程与预设课件合并进快照。
 * - 已经有同名课程就复用（不会出现两门"机器学习"）；
 * - 已经有同 id 的资料就只校正它所属的课程；
 * - 用户自己传过同一份课件（文件名相同）就把它归到这门课，不重复添加；
 * - hidden 里的 id 视作用户已删除，不再补回来。
 */
export function applyPresets(snapshot: AppSnapshot, hidden: string[] = []): AppSnapshot {
  const hiddenSet = new Set(hidden);
  const existingCourse = snapshot.courses.find((course) => normalizeName(course.name) === normalizeName(PRESET_COURSE_NAME));
  const courseId = existingCourse?.id ?? PRESET_COURSE_ID;

  let courses = snapshot.courses;
  let changed = false;
  if (!existingCourse && !hiddenSet.has(PRESET_COURSE_ID)) {
    const maxOrder = courses.reduce((max, course) => Math.max(max, course.order ?? -1), -1);
    courses = [...courses, { ...PRESET_COURSE, order: maxOrder + 1 }];
    changed = true;
  }

  const resources = [...snapshot.resources];
  for (const item of PRESET_COURSEWARE) {
    if (hiddenSet.has(item.id)) continue;
    const byId = resources.findIndex((resource) => resource.id === item.id);
    if (byId >= 0) {
      if (resources[byId].courseId !== courseId) {
        resources[byId] = { ...resources[byId], courseId };
        changed = true;
      }
      continue;
    }
    // 自己已经传过同一份课件：认领它，不复制第二份
    const byFileName = resources.findIndex((resource) => resource.fileName && resource.fileName === item.fileName);
    if (byFileName >= 0) {
      if (resources[byFileName].courseId !== courseId) {
        resources[byFileName] = { ...resources[byFileName], courseId };
        changed = true;
      }
      continue;
    }
    resources.push({
      id: item.id,
      title: item.title,
      courseId,
      type: "课件",
      tags: [...item.tags],
      status: "学习中",
      importedAt: PRESET_DATE,
      fileName: item.fileName,
      fileKey: item.fileKey,
      fileSize: item.fileSize,
      mimeType: "application/pdf",
      contentText: item.contentText,
      updatedAt: PRESET_STAMP,
    });
    changed = true;
  }

  return changed ? { ...snapshot, courses, resources } : snapshot;
}
