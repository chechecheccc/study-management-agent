// 健康检查：分别报告文件抽取（GLM）与 Agent 循环（DeepSeek）的配置状态，不返回密钥。
export async function GET() {
  const extractConfigured = Boolean(process.env.GLM_API_KEY?.trim());
  const agentConfigured = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  return Response.json(
    {
      ok: true,
      // configured 供前端判断"是否可以在线对话/识别"，两个链路都要可用
      configured: extractConfigured && agentConfigured,
      extract: {
        configured: extractConfigured,
        model: process.env.GLM_MODEL?.trim() || "glm-5v-turbo",
      },
      agent: {
        configured: agentConfigured,
        model: process.env.DEEPSEEK_AGENT_MODEL?.trim() || "deepseek-v4-flash",
      },
    },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
