// Agent 长期记忆：用户画像。保存在 localStorage，每轮对话注入系统提示词。
// 这是纯逻辑模块，不依赖 React，可在 Node 中直接测试。

export type UserProfile = {
  name: string;
  studyTime: string;
  goal: string;
};

export const PROFILE_STORAGE_KEY = "study-agent-profile";

export function emptyProfile(): UserProfile {
  return { name: "", studyTime: "", goal: "" };
}

export function loadProfile(): UserProfile {
  if (typeof window === "undefined") return emptyProfile();
  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
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
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(sanitizeProfile(profile)));
  } catch {
    // localStorage 不可用时静默降级：记忆仅保留在当前会话状态中。
  }
}

export function sanitizeProfile(value: Partial<UserProfile>): UserProfile {
  return {
    name: typeof value.name === "string" ? value.name.trim().slice(0, 40) : "",
    studyTime: typeof value.studyTime === "string" ? value.studyTime.trim().slice(0, 120) : "",
    goal: typeof value.goal === "string" ? value.goal.trim().slice(0, 200) : "",
  };
}

export function isEmptyProfile(profile: UserProfile) {
  return !profile.name && !profile.studyTime && !profile.goal;
}

export function formatProfileForPrompt(profile: UserProfile): string {
  const lines: string[] = [];
  if (profile.name) lines.push(`- 称呼：${profile.name}`);
  if (profile.studyTime) lines.push(`- 方便学习的时间：${profile.studyTime}`);
  if (profile.goal) lines.push(`- 学习目标：${profile.goal}`);
  return lines.length ? lines.join("\n") : "- （用户尚未填写画像，可适时引导补充）";
}
