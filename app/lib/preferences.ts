// 界面偏好（本机设置，跟着浏览器走，不参与云同步）
//
// 目前只有一项：界面动画。打开软件时的片头动画、页面切换与卡片入场都由它控制。
// 关掉之后：片头不出现，页面/卡片/消息的入场动画全部跳过，界面直接显示。

const PREFERENCES_KEY = "study-agent-preferences";

export type Preferences = {
  /** 是否播放界面动画（片头 + 过渡 + 卡片入场） */
  animations: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = { animations: true };

export function loadPreferences(): Preferences {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<Preferences> | null;
    return {
      animations: typeof parsed?.animations === "boolean" ? parsed.animations : DEFAULT_PREFERENCES.animations,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences: Preferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // 存不进去也无所谓：下次打开只是恢复默认（开启动画）
  }
}
