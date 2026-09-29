// LeadOS — Workspace Skills API (طبقة WORKSPACE — مواصفة 43.12 / 43.8)
// مهارات الورشة الخاصة: تخزين + بوابة ثقة كاملة عند الدخول/التفعيل + منشأ كامل.
// القاعدة الصارمة: المهارة معرفة واستراتيجية فقط — لا تنفيذ كود، لا تجاوز للسياسة.
// طبقة الأمان أعلى منها دايمًا: Security / Policy / Human Approval / deterministic execution.
import { db } from "@/lib/db"
import { json, jsonError, requireAuth, isResponse, readBody } from "@/lib/api-helpers"
import { assessSkillTrust, contentHashOf } from "@/lib/skills/dsi/trust"

export async function GET() {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const rows = await db.workspaceSkill.findMany({
    where: { workspaceId: auth.workspace.id },
    orderBy: [{ status: "asc" }, { weight: "desc" }, { updatedAt: "desc" }],
    take: 100,
  })
  // ملخص الاستخدام الحقيقي (SkillOutcome) لكل مهارة
  const outcomes = await db.skillOutcome.groupBy({
    by: ["skillKey"],
    where: { workspaceId: auth.workspace.id, skillKind: "WORKSPACE", skillKey: { in: rows.map((r) => `WS:${r.id}`) } },
    _count: { id: true },
    _avg: { quality: true },
  }).catch(() => [])
  const outcomeBy = Object.fromEntries(outcomes.map((o) => [o.skillKey, { runs: o._count.id, avgQuality: Math.round(o._avg.quality ?? 0) }]))
  return json({
    ok: true,
    skills: rows.map((r) => ({
      id: r.id, name: r.name, description: r.description, tags: r.tags, status: r.status,
      sourceRef: r.sourceRef, license: r.license, version: r.version, contentHash: r.contentHash,
      trustScore: r.trustScore, rejectReason: r.rejectReason, weight: r.weight, useCount: r.useCount,
      leadCount: r.leadCount, activatedAt: r.activatedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
      bodyPreview: r.body.length > 400 ? `${r.body.slice(0, 400)}…` : r.body,
      bodyLength: r.body.length,
      runs: outcomeBy[`WS:${r.id}`]?.runs ?? 0,
      avgQuality: outcomeBy[`WS:${r.id}`]?.avgQuality ?? null,
      layer: "WORKSPACE" as const,
    })),
  })
}

export async function POST(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const body = await readBody<{ name?: string; description?: string; body?: string; tags?: string; license?: string; sourceRef?: string }>(req)
  const name = (body?.name ?? "").trim()
  const description = (body?.description ?? "").trim()
  const skillBody = (body?.body ?? "").trim()
  if (name.length < 3) return jsonError("اسم المهارة قصير جدًا (3 أحرف على الأقل)", 400)
  if (skillBody.length < 80) return jsonError("محتوى المهارة قصير جدًا (80 حرف على الأقل — تعليمات فعلية)", 400)
  if (skillBody.length > 120_000) return jsonError("محتوى المهارة ضخم جدًا (الحد 120 ألف حرف)", 400)

  // ═══ بوابة الثقة الكاملة قبل التخزين — المرفوض يُحفظ بحالة REJECTED وسببه (43.28 #19) ═══
  const trust = assessSkillTrust({
    kind: "WORKSPACE",
    name,
    description,
    body: skillBody,
    sourceRef: body?.sourceRef?.slice(0, 200) || "manual",
    license: body?.license,
  })

  const row = await db.workspaceSkill.create({
    data: {
      workspaceId: auth.workspace.id,
      name: name.slice(0, 120),
      description: description.slice(0, 500),
      body: skillBody,
      tags: (body?.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8).join(",").slice(0, 200),
      status: trust.verdict === "PASS" ? "ACTIVE" : "REJECTED",
      sourceRef: (body?.sourceRef ?? "manual").slice(0, 200),
      license: (body?.license ?? "").slice(0, 80),
      contentHash: contentHashOf(`${name}\n${description}\n${skillBody}`),
      trustScore: trust.score,
      rejectReason: trust.reasons.length ? trust.reasons.join(" | ").slice(0, 400) : null,
      activatedAt: trust.verdict === "PASS" ? new Date() : null,
      createdBy: auth.user.id,
    },
  })
  await db.auditLog.create({
    data: {
      workspaceId: auth.workspace.id,
      userId: auth.user.id,
      action: "WORKSPACE_SKILL_CREATE",
      entityType: "WorkspaceSkill",
      entityId: row.id,
      after: { name, trustScore: trust.score, verdict: trust.verdict, reasons: trust.reasons.slice(0, 3) },
    },
  }).catch(() => undefined)

  return json({
    ok: true,
    id: row.id,
    status: row.status,
    trust: { score: trust.score, verdict: trust.verdict, hardReject: trust.hardReject, checks: trust.checks, reasons: trust.reasons },
  }, trust.verdict === "PASS" ? 201 : 422)
}
