// 服务端：决定这次请求到底打哪个模型
//
// 优先级：请求里带的用户配置（用户在「设置 → 模型」填的）> 服务端 .env 默认（当前在用的 DeepSeek）。
// 密钥只在这一层处理，不会写进日志或响应。
import { isDeepSeekEndpoint, normalizeLlmConfig, resolveChatEndpoint } from "./llm-config";

export type ModelTarget = {
  endpoint: string;
  apiKey: string;
  model: string;
  /** 是否用的用户自带模型 */
  custom: boolean;
  /** 是否 DeepSeek（决定要不要带 thinking 这类私有参数） */
  deepseek: boolean;
};

export const DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEFAULT_MODEL = "deepseek-v4-flash";

export function resolveModelTarget(
  requested: unknown,
  kind: "agent" | "vision",
): { ok: true; target: ModelTarget } | { ok: false; code: string; message: string } {
  const custom = normalizeLlmConfig(requested);
  if (custom) {
    return {
      ok: true,
      target: {
        endpoint: resolveChatEndpoint(custom.baseUrl),
        apiKey: custom.apiKey,
        model: kind === "agent" ? custom.agentModel : custom.visionModel,
        custom: true,
        deepseek: isDeepSeekEndpoint(custom.baseUrl),
      },
    };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      code: "MODEL_NOT_CONFIGURED",
      message: "服务端没有配置模型，也没有填自己的模型。可以到「设置 → 模型」里填一个 OpenAI 兼容接口。",
    };
  }
  const envModel = kind === "agent"
    ? process.env.DEEPSEEK_AGENT_MODEL?.trim()
    : process.env.DEEPSEEK_EXTRACT_MODEL?.trim();
  return {
    ok: true,
    target: {
      endpoint: process.env.DEEPSEEK_API_URL?.trim() || DEFAULT_ENDPOINT,
      apiKey,
      model: envModel || DEFAULT_MODEL,
      custom: false,
      deepseek: true,
    },
  };
}
