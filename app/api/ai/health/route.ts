// 健康检查：文件抽取与 Agent 循环都使用 DeepSeek，分别报告各自模型，不返回密钥。
export async function GET() {
  const configured = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
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
