// 用户自己的模型配置（OpenAI 兼容接口）
//
// 设计取舍：
//   - 默认用服务端 .env 里的模型（保持现在能用的那套）；
//   - 用户在「设置 → 模型」里填了自己的接口，就把它存在**本机浏览器**（localStorage），
//     每次请求随 body 一起发给我们的服务端，由服务端转发给模型服务商；
//   - 不把 key 写进数据库/云端，避免换设备时密钥跟着账号到处跑（想同步的话让用户自己再填一次）。
//
// 本文件是纯逻辑，客户端和服务端都能用（只有 load/save 会碰 window）。

export type LlmConfig = {
  /** 接口地址，例如 https://api.deepseek.com 或 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** 对话 + 工具调用用的模型 */
  agentModel: string;
  /** 图片 / 截图 / 文件识别用的模型 */
  visionModel: string;
};

export const LLM_DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  agentModel: "deepseek-v4-flash",
  visionModel: "deepseek-v4-flash",
} as const;

const STORAGE_KEY = "study-agent-llm-config";
const MAX_KEY_CHARS = 400;
const MAX_MODEL_CHARS = 120;
const MAX_URL_CHARS = 300;

/** 把用户输入整理成合法配置；任何一项不合法就返回 null（调用方据此回退默认模型） */
export function normalizeLlmConfig(input: unknown): LlmConfig | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const read = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

  const baseUrl = read(record.baseUrl, MAX_URL_CHARS);
  const apiKey = read(record.apiKey, MAX_KEY_CHARS);
  const agentModel = read(record.agentModel, MAX_MODEL_CHARS) || LLM_DEFAULTS.agentModel;
  const visionModel = read(record.visionModel, MAX_MODEL_CHARS) || agentModel;

  if (!isAllowedEndpoint(baseUrl) || apiKey.length < 8) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, agentModel, visionModel };
}

/** 只允许 http(s)，并且不能指向本机（避免被当成内网探测工具） */
export function isAllowedEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
}

/** 把接口地址补成 chat/completions 完整地址 */
export function resolveChatEndpoint(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** 只有 DeepSeek 认 thinking 参数，别的服务商带上去可能直接报错 */
export function isDeepSeekEndpoint(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith("deepseek.com");
  } catch {
    return false;
  }
}

/** 界面上展示用的掩码，别把完整 key 摆在屏幕上 */
export function maskApiKey(apiKey: string) {
  if (apiKey.length <= 10) return "****";
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

export function loadLlmConfig(): LlmConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeLlmConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveLlmConfig(config: LlmConfig | null) {
  if (typeof window === "undefined") return;
  try {
    if (config) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存不下就算了，本次会话仍然生效
  }
}
