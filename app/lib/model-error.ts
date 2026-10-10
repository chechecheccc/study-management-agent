// 模型调用失败时，把上游（DeepSeek）的真实原因翻成用户能看懂的一句话。
//
// 之前所有失败都被压成"模型服务暂时不可用"，用户完全不知道发生了什么
// （比如余额不足、密钥失效、请求过频），排查起来全靠猜。

/** 读出上游返回的错误说明（尽量拿到 error.message） */
export async function readModelErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      if (typeof parsed.error === "string") return parsed.error;
      if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
        return parsed.error.message;
      }
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      // 不是 JSON 就直接用原文
    }
    return text;
  } catch {
    return "";
  }
}

export type ModelFailure = {
  code: string;
  message: string;
  /** 返回给前端的 HTTP 状态码 */
  status: number;
};

/** 把上游状态码 + 错误说明映射成 { code, message, status } */
export function describeModelFailure(status: number, detail: string): ModelFailure {
  const text = (detail ?? "").toLowerCase();
  const balance = /insufficient\s*balance|insufficient_quota|exceeded your current quota|余额不足|quota/.test(text);
  const auth = status === 401 || status === 403 || /invalid.*api[\s_-]?key|authentication|unauthorized/.test(text);
  const rate = status === 429 || /rate limit|too many requests/.test(text);

  if (balance) {
    return {
      code: "MODEL_INSUFFICIENT_BALANCE",
      message: "模型账户余额不足，请到 DeepSeek 控制台充值后再试（充值后无需改代码，刷新页面即可）。",
      status: 402,
    };
  }
  if (auth) {
    return {
      code: "MODEL_AUTH_FAILED",
      message: "模型服务鉴权失败：API Key 可能已失效或被重置，请在 .env.local 里更新 DEEPSEEK_API_KEY。",
      status: 502,
    };
  }
  if (rate) {
    return { code: "MODEL_RATE_LIMITED", message: "模型请求太频繁了，等十几秒再试。", status: 429 };
  }
  return {
    code: "MODEL_REQUEST_FAILED",
    message: detail ? `模型服务返回错误（${status}）：${detail.slice(0, 120)}` : `模型服务暂时不可用（${status}），请稍后重试。`,
    status: 502,
  };
}
