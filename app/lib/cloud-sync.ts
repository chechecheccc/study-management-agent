// 云同步：本地优先 + 服务端备份
//
// 策略：
//   - 每条记录带 updatedAt，写入时自动打标（touchSnapshot）；
//   - 合并时逐记录比较 updatedAt，较新者胜（避免"整包覆盖"互相清空数据）；
//   - 只推送本地有数据的实体，不做删除传播（删除暂不跨设备同步）。
import type { AppSnapshot, Course, Resource, Task } from "./local-store";
import type { ConversationRecord } from "./local-store";
import type { UserProfile } from "../agent/memory";

export type SyncPayload = {
  courses: Course[];
  resources: Resource[];
  tasks: Task[];
  conversations: ConversationRecord[];
  profile: UserProfile;
};

export type CloudSnapshot = {
  courses: Course[];
  resources: Resource[];
  tasks: Task[];
  conversations: ConversationRecord[];
  profile: UserProfile | null;
};

type Syncable = { id: string; updatedAt?: string };

/** 给新增或变化的记录打上 updatedAt（未变化的保持原值，避免每次都变"最新"） */
export function touchList<T extends Syncable>(prev: T[], next: T[], now: string): T[] {
  const prevById = new Map(prev.map((item) => [item.id, item]));
  return next.map((item) => {
    const before = prevById.get(item.id);
    if (before && sameRecord(before, item)) return item;
    // 有改动就盖新的 updatedAt：否则"改归属/改名/改顺序"这类编辑永远比云端旧，推送会被判定为过期而丢弃。
    return { ...item, updatedAt: now };
  });
}

function sameRecord(a: Syncable, b: Syncable) {
  const strip = (value: Syncable) => {
    const { updatedAt, ...rest } = value as Record<string, unknown> & { updatedAt?: string };
    void updatedAt;
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

/**
 * 对整个快照打标（在写入本地前调用）。
 * 注意：没有任何记录发生变化时**必须返回原对象**，否则调用方 setState 会造成无限渲染循环。
 */
export function touchSnapshot(prev: AppSnapshot, next: AppSnapshot, now = new Date().toISOString()): AppSnapshot {
  const courses = touchList(prev.courses, next.courses, now);
  const resources = touchList(prev.resources, next.resources, now);
  const tasks = touchList(prev.tasks, next.tasks, now);
  const changed =
    courses.some((item, index) => item !== next.courses[index]) ||
    resources.some((item, index) => item !== next.resources[index]) ||
    tasks.some((item, index) => item !== next.tasks[index]);
  return changed ? { courses, resources, tasks } : next;
}

/** 按 id 合并：同 id 取 updatedAt 较新者；本地没有的云端记录补进来 */
export function mergeById<T extends Syncable>(local: T[], cloud: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of local) merged.set(item.id, item);
  for (const item of cloud) {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, item);
      continue;
    }
    const localTime = existing.updatedAt ?? "";
    const cloudTime = item.updatedAt ?? "";
    if (cloudTime > localTime) merged.set(item.id, item);
  }
  return [...merged.values()];
}

/** 合并云端快照到本地快照，返回合并结果与"云端是否带来了变化" */
export function mergeCloud(local: AppSnapshot, cloud: CloudSnapshot): { snapshot: AppSnapshot; changed: boolean } {
  const courses = mergeById(local.courses, cloud.courses);
  const resources = mergeById(local.resources, cloud.resources);
  const tasks = mergeById(local.tasks, cloud.tasks);
  const changed =
    courses.length !== local.courses.length ||
    resources.length !== local.resources.length ||
    tasks.length !== local.tasks.length ||
    JSON.stringify(courses) !== JSON.stringify(local.courses) ||
    JSON.stringify(resources) !== JSON.stringify(local.resources) ||
    JSON.stringify(tasks) !== JSON.stringify(local.tasks);
  return { snapshot: { courses, resources, tasks }, changed };
}

/** 合并会话（按 updatedAt 取较新者，消息合并且按 id 去重） */
export function mergeConversations(
  local: ConversationRecord[],
  cloud: ConversationRecord[],
): ConversationRecord[] {
  const merged = new Map<string, ConversationRecord>();
  for (const item of local) merged.set(item.id, item);
  for (const item of cloud) {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, item);
      continue;
    }
    const cloudNewer = (item.updatedAt ?? "") > (existing.updatedAt ?? "");
    const base = cloudNewer ? item : existing;
    const other = cloudNewer ? existing : item;
    const seen = new Set(base.messages.map((message) => message.id));
    const extra = other.messages.filter((message) => !seen.has(message.id));
    merged.set(item.id, {
      ...base,
      messages: [...base.messages, ...extra].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------- 与服务端交互 ----------

export async function pullCloud(): Promise<
  { ok: true; data: CloudSnapshot } | { ok: false; message: string }
> {
  try {
    const response = await fetch("/api/sync/pull", { cache: "no-store" });
    const body = (await response.json()) as { ok?: boolean; data?: CloudSnapshot; error?: { message?: string } };
    if (!response.ok || !body.ok || !body.data) {
      return { ok: false, message: body.error?.message ?? "读取云端数据失败。" };
    }
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, message: "网络不可用，稍后会自动重试。" };
  }
}

/** 把文件本体上传到服务端，返回文件 id（写入 resource.fileKey） */
export async function uploadFileToServer(
  file: Blob,
  name: string,
): Promise<{ ok: true; fileId: string } | { ok: false; message: string }> {
  try {
    const response = await fetch(`/api/files/upload?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const body = (await response.json()) as { ok?: boolean; fileId?: string; error?: { message?: string } };
    if (!response.ok || !body.ok || !body.fileId) {
      return { ok: false, message: body.error?.message ?? "文件上传失败。" };
    }
    return { ok: true, fileId: body.fileId };
  } catch {
    return { ok: false, message: "网络不可用，文件暂未上传到服务端。" };
  }
}

/** 服务端文件的访问地址（内联预览 / 下载） */
export function serverFileUrl(fileKey: string, download = false) {
  return `/api/files/${encodeURIComponent(fileKey)}${download ? "?download=1" : ""}`;
}

/** 上报删除（否则下次拉取会把已删除的记录复活） */
export async function deleteCloud(
  entity: "courses" | "resources" | "tasks" | "conversations",
  ids: string[],
): Promise<{ ok: boolean; message?: string }> {
  if (!ids.length) return { ok: true };
  try {
    const response = await fetch("/api/sync/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity, ids }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
    if (!response.ok || !body.ok) return { ok: false, message: body.error?.message ?? "删除同步失败。" };
    return { ok: true };
  } catch {
    return { ok: false, message: "网络不可用，删除暂未同步。" };
  }
}

export async function pushCloud(payload: SyncPayload): Promise<
  { ok: true } | { ok: false; message: string }
> {
  try {
    const response = await fetch("/api/sync/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
    if (!response.ok || !body.ok) return { ok: false, message: body.error?.message ?? "上传失败。" };
    return { ok: true };
  } catch {
    return { ok: false, message: "网络不可用，稍后会自动重试。" };
  }
}



