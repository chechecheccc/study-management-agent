// Agent 单步代理：接收对话消息，调用 GLM function calling，返回规范化的
// "一步"结果（文本回复或工具调用）。Agent 循环的驱动在客户端，本路由无状态。
// 密钥只存在于服务端环境变量，与 /api/ai/extract 同一套安全约定。
import { sanitizeAgentContext, sanitizeAgentMessages } from "../../../agent/protocol";
import type { AgentToolCall } from "../../../agent/protocol";
import { buildAgentSystemPrompt } from "../../../agent/prompts";
import { toolSchemasForModel } from "../../../agent/tools";

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_AGENT_MODEL = "glm-4.6";
const MAX_REQUEST_BYTES = 1_000_000;
const TIMEOUT_MS = 55_000;

type GlmToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type GlmStepResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: GlmToolCall[];
    };
  }>;
  request_id?: string;
};

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return errorResponse("ORIGIN_NOT_ALLOWED", "请求来源不被允许。", 403);
  }

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return errorResponse("CONTENT_TYPE_REQUIRED", "请求必须使用 JSON。", 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_REQUEST_BYTES) {
    return errorResponse("REQUEST_TOO_LARGE", "对话内容过大，请清空部分历史后重试。", 413);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", "无法读取请求内容。", 400);
  }

  const body = isRecord(rawBody) ? rawBody : {};
  const messages = sanitizeAgentMessages(body.messages);
  if (!messages.length) {
    return errorResponse("EMPTY_CONVERSATION", "对话内容为空。", 400);
  }
  const context = sanitizeAgentContext(body.context);

  const apiKey = process.env.GLM_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse(
      "MODEL_NOT_CONFIGURED",
      "在线模型尚未配置，智能体暂时只能陪你做手动管理。",
      503,
      true,
    );
  }

  const model = process.env.GLM_AGENT_MODEL?.trim() || process.env.GLM_MODEL?.trim() || DEFAULT_AGENT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(process.env.GLM_API_URL?.trim() || DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildAgentSystemPrompt(context) },
          ...messages,
        ],
        tools: toolSchemasForModel(),
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 2048,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      return errorResponse(
        "MODEL_REQUEST_FAILED",
        upstream.status === 401 || upstream.status === 403
          ? "模型服务鉴权失败，请检查服务端密钥。"
          : "模型服务暂时不可用，请稍后重试。",
        upstream.status === 429 ? 429 : 502,
        true,
      );
    }

    const data = (await upstream.json()) as GlmStepResponse;
    const message = data.choices?.[0]?.message;
    if (!message) {
      return errorResponse("EMPTY_MODEL_RESPONSE", "模型没有返回内容。", 502, true);
    }

    const content = readMessageContent(message.content);
    const calls = normalizeToolCalls(message.tool_calls);

    if (calls.length) {
      return jsonResponse({ ok: true, type: "tool_calls", content, calls, model, requestId: data.request_id ?? null });
    }
    if (!content) {
      return errorResponse("EMPTY_MODEL_RESPONSE", "模型没有返回内容。", 502, true);
    }
    return jsonResponse({ ok: true, type: "message", content, model, requestId: data.request_id ?? null });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return errorResponse("MODEL_TIMEOUT", "模型响应超时，请重试。", 504, true);
    }
    return errorResponse("MODEL_UNAVAILABLE", "无法连接模型服务，请检查网络后重试。", 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeToolCalls(toolCalls: GlmToolCall[] | undefined): AgentToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((call, index) => {
      const name = call.function?.name?.trim();
      if (!name) return null;
      return {
        id: call.id?.trim() || `call-${index}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      };
    })
    .filter((call): call is AgentToolCall => call !== null)
    .slice(0, 8);
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readMessageContent(content: string | Array<{ type?: string; text?: string }> | undefined) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => item.text ?? "").join("").trim();
  }
  return "";
}

function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(code: string, message: string, status: number, fallback = false) {
  return jsonResponse({ ok: false, error: { code, message }, fallback }, status);
}

