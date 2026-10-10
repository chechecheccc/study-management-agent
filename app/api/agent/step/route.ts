// Agent 单步代理：接收对话消息，调用 DeepSeek function calling，返回规范化的
// "一步"结果（文本回复或工具调用）。Agent 循环的驱动在客户端，本路由无状态。
// 密钥只存在于服务端环境变量，与 /api/ai/extract 同一套安全约定。
import { sanitizeAgentContext, sanitizeAgentMessages, stripLoneSurrogateEscapes } from "../../../agent/protocol";
import type { AgentToolCall } from "../../../agent/protocol";
import { buildAgentSystemPrompt } from "../../../agent/prompts";
import { toolSchemasForModel } from "../../../agent/tools";
import { describeModelFailure, readModelErrorDetail } from "../../../lib/model-error";
import { resolveModelTarget } from "../../../lib/llm-server";

// Agent 对话与工具调用：DeepSeek V4.1 Flash（OpenAI 兼容接口）
// 上限与图片抽取链路保持一致：带图的多模态请求本身就可能几 MB，1MB 会误伤正常请求
const MAX_REQUEST_BYTES = 14_500_000;
const TIMEOUT_MS = 55_000;

type ModelToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type ModelStepResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: ModelToolCall[];
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
    return errorResponse("REQUEST_TOO_LARGE", "这次发送的内容太大（可能是图片太多或历史过长），请删或换小一点的图片，或新建一个对话后重试。", 413);
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

  // 用户自己的模型（设置里填的）优先，其次才是服务端 .env 的默认模型
  const resolved = resolveModelTarget(body.llm, "agent");
  if (!resolved.ok) {
    return errorResponse(resolved.code, resolved.message, 503, true);
  }
  const { endpoint, apiKey, model, deepseek } = resolved.target;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // 发送前清一遍孤立代理：只要有一个，DeepSeek 就会整条请求 400
    const payload = stripLoneSurrogateEscapes(JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildAgentSystemPrompt(context) },
          ...messages,
        ],
        tools: toolSchemasForModel(),
        tool_choice: "auto",
        // 同理：不设 max_tokens 时，关闭思考可保证工具调用一定能输出完整 JSON。
        // thinking 是 DeepSeek 私有参数，换成别家模型时不能带，否则可能直接被拒绝。
        ...(deepseek
          ? { thinking: { type: process.env.DEEPSEEK_AGENT_THINKING?.trim() === "enabled" ? "enabled" : "disabled" } }
          : {}),
        temperature: 0.3,
      stream: false,
    }));

    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: payload,
      signal: controller.signal,
    });

    if (!upstream.ok) {
      // 把上游的真实原因（余额不足 / 密钥失效 / 频率限制）透出来
      const failure = describeModelFailure(upstream.status, await readModelErrorDetail(upstream), { custom: resolved.target.custom });
      return errorResponse(failure.code, failure.message, failure.status, true);
    }

    const data = (await upstream.json()) as ModelStepResponse;
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

function normalizeToolCalls(toolCalls: ModelToolCall[] | undefined): AgentToolCall[] {
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







