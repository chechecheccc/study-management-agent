// 模型连通性自检：用当前生效的模型（或用户刚填的那套）发一个最小请求。
// 设置页的「测试连接」按钮调它，失败时把服务商的原始说明带回来，方便排查。
import { describeModelFailure, readModelErrorDetail } from "../../../lib/model-error";
import { resolveModelTarget } from "../../../lib/llm-server";

const TIMEOUT_MS = 20_000;

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return json({ ok: false, error: { message: "请求来源不被允许。" } }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return json({ ok: false, error: { message: "请求必须使用 JSON。" } }, 415);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: { message: "无法读取请求内容。" } }, 400);
  }

  const kind = body.kind === "vision" ? "vision" : "agent";
  const resolved = resolveModelTarget(body.llm, kind);
  if (!resolved.ok) return json({ ok: false, error: { code: resolved.code, message: resolved.message } }, 503);
  const { endpoint, apiKey, model, custom, deepseek } = resolved.target;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: false,
        ...(deepseek ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const failure = describeModelFailure(upstream.status, await readModelErrorDetail(upstream), { custom: resolved.target.custom });
      return json({ ok: false, error: { code: failure.code, message: failure.message } });
    }
    await upstream.text();
    return json({ ok: true, model, endpoint, custom: custom ? "custom" : "default" });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return json({
      ok: false,
      error: {
        code: aborted ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE",
        message: aborted ? "模型响应超时，检查一下接口地址是否可达。" : "连不上这个接口地址，检查一下地址和网络。",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
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

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
