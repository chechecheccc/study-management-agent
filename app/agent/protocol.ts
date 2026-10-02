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
      arguments: typeof value.function.arguments === "string" ? value.function.arguments.slice(0, MAX_TOOL_RESULT_CHARS) : "{}",
    },
  };
}

function cleanContent(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

// 内容可以是纯文本，也可以是"文本 + 图片"片段数组。
// 只有 user 角色允许带图片；图片必须是 data:image/* 的 base64，且有大小与数量上限。
function sanitizeContent(value: unknown, role: string): AgentWireContent {
  if (typeof value === "string") return value.slice(0, MAX_MESSAGE_CHARS);
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
      const text = item.text.slice(0, MAX_MESSAGE_CHARS);
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




