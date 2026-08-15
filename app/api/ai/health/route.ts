export async function GET() {
  return Response.json(
    {
      ok: true,
      configured: Boolean(process.env.GLM_API_KEY?.trim()),
      model: process.env.GLM_MODEL?.trim() || "glm-5v-turbo",
    },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
