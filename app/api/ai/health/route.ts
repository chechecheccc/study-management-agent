// 健康检查：文件抽取与 Agent 循环都使用 DeepSeek，分别报告各自模型，不返回密钥。
import { isPlaceholderApiKey } from "../../../lib/llm-server";

export async function GET() {
  // 占位符（replace-with-your-deepseek-key）算「未配置」：
  // 避免刚拉下代码、只复制了模板的人以为模型已经接好了，结果每次调用都报认证失败。
  const configured = !isPlaceholderApiKey(process.env.DEEPSEEK_API_KEY);
  return Response.json(
    {
      ok: true,
      configured,
      extract: {
        configured,
        model: process.env.DEEPSEEK_EXTRACT_MODEL?.trim() || "deepseek-v4-flash",
      },
      agent: {
        configured,
        model: process.env.DEEPSEEK_AGENT_MODEL?.trim() || "deepseek-v4-flash",
      },
    },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
