// LeadOS — Workspace Skill actions: activate / deactivate / replace / delete / inspect
import type { Prisma } from "@prisma/client"
// كل تفعيل أو استبدال بيعدي على بوابة الثقة من جديد — تغيير المحتوى = بصمة جديدة = إعادة فحص (43.18)
import { db } from "@/lib/db"
import { json, jsonError, requireAuth, isResponse, readBody } from "@/lib/api-helpers"
import { assessSkillTrust, contentHashOf } from "@/lib/skills/dsi/trust"

const OWNERSHIP = (workspaceId: string, id: string) => ({ id, workspaceId })

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const { id } = await params
  const row = await db.workspaceSkill.findFirst({ where: OWNERSHIP(auth.workspace.id, id) })
  if (!row) return jsonError("مهارة غير موجودة", 404)
  const outcomes = await db.skillOutcome.findMany({
    where: { workspaceId: auth.workspace.id, skillKind: "WORKSPACE", skillKey: `WS:${id}` },
    orderBy: { createdAt: "desc" },
    take: 20,
  })
  return json({ ok: true, skill: row, history: outcomes })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const { id } = await params
  const body = await readBody<{ action?: string; body?: string; description?: string; tags?: string; license?: string }>(req)
  const action = body?.action ?? ""
  const row = await db.workspaceSkill.findFirst({ where: OWNERSHIP(auth.workspace.id, id) })
  if (!row) return jsonError("مهارة غير موجودة", 404)

  if (action === "activate") {
    // إعادة فحص كاملة وقت التفعيل — حتى لو الكاش: البصمة الحالية هي المرجع (43.18)
    const trust = assessSkillTrust({ kind: "WORKSPACE", name: row.name, description: row.description, body: row.body, sourceRef: row.sourceRef, license: row.license })
    if (trust.verdict === "FAIL") {
      await db.workspaceSkill.update({ where: { id }, data: { status: "REJECTED", trustScore: trust.score, rejectReason: trust.reasons.join(" | ").slice(0, 400) } })
      return json({ ok: false, error: "بوابة الثقة رفضت التفعيل", trust: { score: trust.score, reasons: trust.reasons, checks: trust.checks } }, 422)
    }
    const updated = await db.workspaceSkill.update({
      where: { id },
      data: { status: "ACTIVE", trustScore: trust.score, rejectReason: null, contentHash: contentHashOf(`${row.name}\n${row.description}\n${row.body}`), activatedAt: new Date() },
    })
    await log(auth, "WORKSPACE_SKILL_ACTIVATE", id, { name: row.name, trustScore: trust.score })
    return json({ ok: true, skill: updated, trust: { score: trust.score, checks: trust.checks } })
  }

  if (action === "deactivate") {
    const updated = await db.workspaceSkill.update({ where: { id }, data: { status: "INACTIVE", activatedAt: null } })
    await log(auth, "WORKSPACE_SKILL_DEACTIVATE", id, { name: row.name })
    return json({ ok: true, skill: updated })
  }

  if (action === "replace") {
    const newBody = (body?.body ?? "").trim()
    if (newBody.length < 80) return jsonError("المحتوى الجديد قصير جدًا (80 حرف على الأقل)", 400)
    // استبدال = نسخة جديدة (version+1) + إعادة فحص كاملة — الرصيد القديم لا يحمل الثقة
    const trust = assessSkillTrust({ kind: "WORKSPACE", name: row.name, description: body?.description?.trim() || row.description, body: newBody, sourceRef: row.sourceRef, license: body?.license ?? row.license })
    const updated = await db.workspaceSkill.update({
      where: { id },
      data: {
        body: newBody,
        description: (body?.description?.trim() || row.description).slice(0, 500),
        tags: body?.tags !== undefined ? body.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8).join(",").slice(0, 200) : row.tags,
        license: (body?.license ?? row.license).slice(0, 80),
        version: row.version + 1,
        contentHash: contentHashOf(`${row.name}\n${body?.description?.trim() || row.description}\n${newBody}`),
        trustScore: trust.score,
        status: trust.verdict === "PASS" ? "ACTIVE" : "REJECTED",
        rejectReason: trust.reasons.length ? trust.reasons.join(" | ").slice(0, 400) : null,
        activatedAt: trust.verdict === "PASS" ? new Date() : null,
      },
    })
    await log(auth, "WORKSPACE_SKILL_REPLACE", id, { name: row.name, version: updated.version, verdict: trust.verdict })
    return json({ ok: trust.verdict === "PASS", skill: updated, trust: { score: trust.score, verdict: trust.verdict, checks: trust.checks, reasons: trust.reasons } }, trust.verdict === "PASS" ? 200 : 422)
  }

  return jsonError("action غير معروف — المسموح: activate | deactivate | replace", 400)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const { id } = await params
  const row = await db.workspaceSkill.findFirst({ where: OWNERSHIP(auth.workspace.id, id) })
  if (!row) return jsonError("مهارة غير موجودة", 404)
  await db.workspaceSkill.delete({ where: { id } })
  await log(auth, "WORKSPACE_SKILL_DELETE", id, { name: row.name, version: row.version })
  return json({ ok: true })
}

async function log(auth: NonNullable<Awaited<ReturnType<typeof requireAuth>>>, action: string, entityId: string, after: Record<string, unknown>) {
  if (isResponse(auth)) return
  await db.auditLog.create({
    data: { workspaceId: auth.workspace.id, userId: auth.user.id, action, entityType: "WorkspaceSkill", entityId, after: after as Prisma.InputJsonValue },
  }).catch(() => undefined)
}
