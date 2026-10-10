// Agent 通信协议：前端循环 <-> 服务端代理之间的消息格式与清洗逻辑。
// 纯逻辑模块，服务端路由与前端循环共用同一份校验，Node 可直接测试。

export type AgentWireToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// 多模态内容片段：文本 + 图片（OpenAI 兼容格式，DeepSeek 原生支持）
export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type AgentWireContent = string | AgentContentPart[];

export type AgentWireMessage =
  | { role: "system" | "user" | "assistant"; content: AgentWireContent; tool_calls?: AgentWireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AgentStepResponse =
  | { type: "message"; content: string }
  | { type: "tool_calls"; content: string; calls: AgentToolCall[] };

export type AgentRequestContext = {
  currentDate: string;
  timezone: string;
  profile: { name: string; studyTime: string; goal: string; notes: string[] };
};

export const MAX_HISTORY_MESSAGES = 30;
// 多模态限制：单条消息最多 4 张图，单张 base64 长度上限约 12MB（应用侧限制 10MB）
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_DATA_CHARS = 12_000_000;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * 按字符数截断，但绝不把一个"代理对"切成孤立的一半。
 *
 * 为什么必须这样：PDF 抽出来的数学符号（𝑢 𝐿 𝑥 这类）在 JS 里是 UTF-16 代理对啊，
 * 直接 slice 可能只留下高位代理；JSON.stringify 会写成 \uD835（后面没有低位代理），
 * DeepSeek 的 JSON 解析器遇到这种孤立代理会直接 400：
 * "Failed to parse the request body as JSON: unexpected end of hex escape"。
 */
export function safeSlice(text: string, start: number, end?: number): string {
  let from = Math.max(0, start);
  let to = typeof end === "number" ? Math.min(text.length, end) : text.length;
  if (from > 0 && from < text.length) {
    const previous = text.charCodeAt(from - 1);
    const current = text.charCodeAt(from);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) from -= 1;
  }
  if (to > 0 && to < text.length) {
    const before = text.charCodeAt(to - 1);
    if (before >= 0xd800 && before <= 0xdbff) to -= 1;
  }
  if (to < from) to = from;
  return text.slice(from, to);
}

/**
 * 兜底：把 JSON 文本里"孤立代理"的转义替换成 ，避免上游 JSON 解析器直接 400。
 *
 * 场景：任何地方的截断（按字数切、正则 {0,48} 切）都可能只留下半个数学符号，
 * JSON.stringify 会写成 \uD835 但没有配对的低位代理，DeepSeek 会报
 * "unexpected end of hex escape"。与其到处补，不如发送前统一兜一下。
 */
export function stripLoneSurrogateEscapes(json: string): string {
  return json
    // 高位代理：没有紧跟成对的低位代理 → 换成替换字符（注意 JSON.stringify 用小写十六进制）
    .replace(/\\u(d[89ab][0-9a-f]{2})(?!\\udc[0-9a-f]{2})/gi, "\\ufffd")
    // 低位代理：前面不是成对的高位代理 → 同样换掉
    .replace(/(?<!\\ud[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})/gi, "\\ufffd");
}

export function sanitizeAgentMessages(value: unknown): AgentWireMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: AgentWireMessage[] = [];

  for (const item of value.slice(-MAX_HISTORY_MESSAGES)) {
    if (!isRecord(item) || typeof item.role !== "string") continue;

    if (item.role === "tool") {
      if (typeof item.tool_call_id !== "string" || !item.tool_call_id) continue;
      messages.push({
        role: "tool",
        tool_call_id: item.tool_call_id.slice(0, 80),
        content: cleanContent(item.content, MAX_TOOL_RESULT_CHARS),
      });
      continue;
    }

    if (item.role !== "user" && item.role !== "assistant" && item.role !== "system") continue;
    const message: AgentWireMessage = {
      role: item.role,
      content: sanitizeContent(item.content, item.role),
    };
    if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
      const toolCalls = item.tool_calls
        .map((call) => sanitizeWireToolCall(call))
        .filter((call): call is AgentWireToolCall => call !== null)
        .slice(0, 8);
      if (toolCalls.length) message.tool_calls = toolCalls;
    }
    const hasContent = typeof message.content === "string"
      ? message.content.length > 0
      : message.content.some((part) => part.type === "text" ? part.text.length > 0 : true);
    if (!hasContent && !message.tool_calls?.length) continue;
    messages.push(message);
  }

  return messages;
}

export function sanitizeAgentContext(value: unknown): AgentRequestContext {
  const record = isRecord(value) ? value : {};
  const profile = isRecord(record.profile) ? record.profile : {};
  return {
    currentDate: typeof record.currentDate === "string" ? record.currentDate.slice(0, 64) : new Date().toISOString(),
    timezone: typeof record.timezone === "string" ? record.timezone.slice(0, 64) : "Asia/Shanghai",
    profile: {
      name: typeof profile.name === "string" ? profile.name.slice(0, 40) : "",
      studyTime: typeof profile.studyTime === "string" ? profile.studyTime.slice(0, 120) : "",
      goal: typeof profile.goal === "string" ? profile.goal.slice(0, 200) : "",
      notes: Array.isArray(profile.notes)
        ? profile.notes.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 140)).slice(0, 20)
        : [],
    },
  };
}

function sanitizeWireToolCall(value: unknown): AgentWireToolCall | null {
  if (!isRecord(value) || !isRecord(value.function)) return null;
  const name = value.function.name;
  if (typeof name !== "string" || !name.trim()) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id.slice(0, 80) : `call-${name}`,
    type: "function",
    function: {
      name: name.slice(0, 80),
      arguments: typeof value.function.arguments === "string" ? safeSlice(value.function.arguments, 0, MAX_TOOL_RESULT_CHARS) : "{}",
    },
  };
}

function cleanContent(value: unknown, max: number) {
  return typeof value === "string" ? safeSlice(value, 0, max) : "";
}

// 内容可以是纯文本，也可以是"文本 + 图片"片段数组。
// 只有 user 角色允许带图片；图片必须是 data:image/* 的 base64，且有大小与数量上限。
function sanitizeContent(value: unknown, role: string): AgentWireContent {
  if (typeof value === "string") return safeSlice(value, 0, MAX_MESSAGE_CHARS);
  if (!Array.isArray(value)) return "";
  // 非用户角色不支持图片：只保留其中的文本片段，避免把可用内容整条丢掉
  if (role !== "user") {
    return value
      .filter((item): item is { type: "text"; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("")
      .slice(0, MAX_MESSAGE_CHARS);
  }

  const parts: AgentContentPart[] = [];
  let imageCount = 0;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      const text = safeSlice(item.text, 0, MAX_MESSAGE_CHARS);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (item.type === "image_url" && isRecord(item.image_url) && typeof item.image_url.url === "string") {
      const url = item.image_url.url;
      if (imageCount >= MAX_IMAGES_PER_MESSAGE) continue;
      if (url.length > MAX_IMAGE_DATA_CHARS) continue;
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) continue;
      parts.push({ type: "image_url", image_url: { url } });
      imageCount += 1;
    }
  }
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}




