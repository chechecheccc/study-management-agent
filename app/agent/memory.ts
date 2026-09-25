// Agent 长期记忆：用户画像 + 记忆笔记。保存在 localStorage，每轮对话注入系统提示词。
// 记忆笔记由模型通过 remember_fact 工具主动写入（"数据库第三章薄弱"这类事实）。
// 这是纯逻辑模块，不依赖 React，可在 Node 中直接测试。

export type UserProfile = {
  name: string;
  studyTime: string;
  goal: string;
  notes: string[];
};

export const PROFILE_STORAGE_KEY = "study-agent-profile";

// 账号隔离：画像按账号键分开存储，避免多个用户互相看到对方的记忆
let memoryScope = "";

export function setMemoryScope(userId: string) {
  memoryScope = userId ? userId.replace(/[^a-zA-Z0-9._-]/g, "") : "";
}

export function scopedMemoryKey(base: string) {
  return memoryScope ? `${base}::${memoryScope}` : base;
}
export const MAX_NOTES = 20;
export const MAX_NOTE_CHARS = 140;

export function emptyProfile(): UserProfile {
  return { name: "", studyTime: "", goal: "", notes: [] };
}

export function loadProfile(): UserProfile {
  if (typeof window === "undefined") return emptyProfile();
  try {
    const raw = window.localStorage.getItem(scopedMemoryKey(PROFILE_STORAGE_KEY));
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    return sanitizeProfile(parsed);
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(profile: UserProfile) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(scopedMemoryKey(PROFILE_STORAGE_KEY), JSON.stringify(sanitizeProfile(profile)));
  } catch {
    // localStorage 不可用时静默降级：记忆仅保留在当前会话状态中。
  }
}

export function sanitizeProfile(value: Partial<UserProfile>): UserProfile {
  return {
    name: typeof value.name === "string" ? value.name.trim().slice(0, 40) : "",
    studyTime: typeof value.studyTime === "string" ? value.studyTime.trim().slice(0, 120) : "",
    goal: typeof value.goal === "string" ? value.goal.trim().slice(0, 200) : "",
    notes: sanitizeNotes(value.notes),
  };
}

export function addProfileNote(profile: UserProfile, fact: string): UserProfile {
  const note = fact.trim().slice(0, MAX_NOTE_CHARS);
  if (!note) return profile;
  const notes = [note, ...profile.notes.filter((item) => item !== note)].slice(0, MAX_NOTES);
  return { ...profile, notes };
}

function sanitizeNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const notes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const note = item.trim().slice(0, MAX_NOTE_CHARS);
    if (note && !notes.includes(note)) notes.push(note);
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

export function isEmptyProfile(profile: UserProfile) {
  return !profile.name && !profile.studyTime && !profile.goal && !(profile.notes ?? []).length;
}

export function formatProfileForPrompt(profile: UserProfile): string {
  const lines: string[] = [];
  if (profile.name) lines.push(`- 称呼：${profile.name}`);
  if (profile.studyTime) lines.push(`- 方便学习的时间：${profile.studyTime}`);
  if (profile.goal) lines.push(`- 学习目标：${profile.goal}`);
  if (!lines.length) lines.push("- （用户尚未填写画像，可适时引导补充）");
  if (profile.notes?.length) {
    lines.push("- 记忆笔记：");
    (profile.notes ?? []).forEach((note) => lines.push(`  · ${note}`));
  }
  return lines.join("\n");
}


