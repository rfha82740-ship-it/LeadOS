// LeadOS — POST/GET /api/graph : خريطة التفكير الديناميكية (Dynamic Skill Intelligence)
// POST { objective } → بناء خريطة + تنفيذ شريحة. GET ?id= → فحص بأسئلة الوعي. GET → آخر الخرايط.
import { json, jsonError, requireAuth, isResponse, readBody } from "@/lib/api-helpers"
import { db } from "@/lib/db"

export const maxDuration = 120

export async function POST(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const body = await readBody<{ objective?: string; platforms?: string[] }>(req)
  const objective = (body?.objective ?? "").trim()
  if (objective.length < 5) return jsonError("اكتب هدفًا واضحًا للخريطة (5 أحرف على الأقل)", 400)
  if (objective.length > 300) return jsonError("الهدف طويل جدًا (الحد 300 حرف)", 400)

  const { runAgentGraph } = await import("@/lib/thinking/engine")
  const r = await runAgentGraph(auth.workspace.id, objective, {
    trigger: "API",
    platforms: body?.platforms?.map(String),
    budgetMs: 95_000,
  })
  return json({ ok: true, ...r })
}

export async function GET(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const url = new URL(req.url)
  const id = url.searchParams.get("id")
  const { inspectThinkingGraph } = await import("@/lib/thinking/engine")
  if (id) {
    const r = await inspectThinkingGraph(id)
    if (!r) return jsonError("خريطة غير موجودة", 404)
    return json({ ok: true, ...r })
  }
  // قائمة آخر الخرايط للورشة
  const graphs = await db.taskGraph.findMany({
    where: { workspaceId: auth.workspace.id },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { id: true, goal: true, status: true, trigger: true, createdAt: true, stats: true, finalResult: true },
  })
  return json({ ok: true, graphs })
}
