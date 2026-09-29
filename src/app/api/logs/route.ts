// LeadOS — Logs/Audit API: كل أحداث النظام قابلة للتدقيق (طلب #29)
// أنواع السجلات: audit | ai | graph | retrieval | outcome | search | radar
// كل نوع من جدوله الحقيقي — بدون دمج زائف، وبفلاتر بحث.
import { db } from "@/lib/db"
import { json, jsonError, requireAuth, isResponse } from "@/lib/api-helpers"

export const maxDuration = 30

export async function GET(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const wsId = auth.workspace.id
  const url = new URL(req.url)
  const type = url.searchParams.get("type") ?? "audit"
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80)
  const take = Math.min(100, Math.max(10, Number(url.searchParams.get("take") ?? 60)))

  if (type === "audit") {
    const rows = await db.auditLog.findMany({
      where: { workspaceId: wsId, ...(q ? { OR: [{ action: { contains: q } }, { entityType: { contains: q } }] } : {}) },
      orderBy: { createdAt: "desc" },
      take,
    })
    return json({ ok: true, type, rows: rows.map((r) => ({ id: r.id, at: r.createdAt, action: r.action, entity: r.entityType, entityId: r.entityId, userId: r.userId, before: r.before, after: r.after })) })
  }

  if (type === "ai") {
    const rows = await db.aiRun.findMany({
      where: { workspaceId: wsId, ...(q ? { OR: [{ provider: { contains: q } }, { model: { contains: q } }, { type: { contains: q } }] } : {}) },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, createdAt: true, provider: true, model: true, type: true, success: true, latencyMs: true, totalTokens: true, errorMessage: true },
    })
    return json({ ok: true, type, rows })
  }

  if (type === "graph") {
    const rows = await db.taskGraphEvent.findMany({
      where: { graph: { workspaceId: wsId }, ...(q ? { OR: [{ type: { contains: q } }, { message: { contains: q } }] } : {}) },
      orderBy: { createdAt: "desc" },
      take,
      include: { graph: { select: { goal: true, status: true } } },
    })
    return json({ ok: true, type, rows: rows.map((r) => ({ id: r.id, at: r.createdAt, graphId: r.graphId, goal: r.graph.goal.slice(0, 80), graphStatus: r.graph.status, nodeId: r.nodeId, type: r.type, message: r.message })) })
  }

  if (type === "retrieval") {
    const rows = await db.skillRetrieval.findMany({
      where: { workspaceId: wsId, ...(q ? { objective: { contains: q } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, createdAt: true, objective: true, reason: true, selected: true, rejected: true, graphId: true, nodeId: true },
    })
    return json({ ok: true, type, rows })
  }

  if (type === "outcome") {
    const rows = await db.skillOutcome.findMany({
      where: { workspaceId: wsId, ...(q ? { OR: [{ skillKey: { contains: q } }, { skillKind: { contains: q } }] } : {}) },
      orderBy: { createdAt: "desc" },
      take,
    })
    return json({ ok: true, type, rows })
  }

  if (type === "search") {
    const rows = await db.searchJob.findMany({
      where: { source: { workspaceId: wsId }, ...(q ? { query: { contains: q } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, createdAt: true, query: true, status: true, resultCount: true, completedAt: true, metadata: true, source: { select: { name: true, type: true } } },
    })
    return json({ ok: true, type, rows })
  }

  if (type === "radar") {
    const rows = await db.groupPost.findMany({
      where: { group: { workspaceId: wsId }, ...(q ? { OR: [{ author: { contains: q } }, { content: { contains: q } }] } : {}) },
      orderBy: { detectedAt: "desc" },
      take,
      include: { group: { select: { name: true } } },
    })
    return json({ ok: true, type, rows: rows.map((r) => ({ id: r.id, at: r.detectedAt, group: r.group.name, author: r.author, content: r.content.slice(0, 160), score: r.score, status: r.status, leadId: r.leadId })) })
  }

  return jsonError("type غير معروف — المسموح: audit | ai | graph | retrieval | outcome | search | radar", 400)
}
