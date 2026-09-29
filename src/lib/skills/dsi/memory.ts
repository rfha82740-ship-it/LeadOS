// LeadOS — ذاكرة استخدام المهارات (SkillUsageMemory — مواصفة 43.11 / 43.27)
// كل مهارة بتُستخدم بتدخل حلقة تعلم كاملة:
//   Skill Selected → Task Executed → Outcome Observed → Skill Utility Calculated
//   → Skill Weight Updated → Future Ranking Improved
// التعلم بيشتغل على مستويات: عالمي (وزن المكتبة) + ورشة (إحصاءات SkillOutcome).
// كل حاجة best-effort: فشل الذاكرة عمرو ما بيفشّل التنفيذ (43.28 #20-22).
import { db } from "@/lib/db"
import type { Prisma } from "@prisma/client"

export type SkillKind = "CORE" | "GITSKILLS" | "CLAWHUB" | "WORKSPACE"
export type SkillResult = "SUCCESS" | "PARTIAL" | "FAILURE" | "UNKNOWN"

const clampW = (w: number) => Math.max(0.2, Math.min(5, w))

export interface SkillOutcomeInput {
  workspaceId: string
  skillKind: SkillKind
  skillKey: string
  graphId?: string
  nodeId?: string
  taskId?: string
  outcome: SkillResult
  quality?: number // 0-100
  latencyMs?: number
  notes?: string
}

/** تسجيل نتيجة مهارة + تحديث وزنها في مكتبتها (الفاشلة تهبط — الناجحة تترقى) */
export async function recordSkillOutcome(inp: SkillOutcomeInput): Promise<void> {
  const quality = Math.max(0, Math.min(100, inp.quality ?? 0))
  try {
    await db.skillOutcome.create({
      data: {
        workspaceId: inp.workspaceId,
        skillKind: inp.skillKind,
        skillKey: inp.skillKey.slice(0, 200),
        graphId: inp.graphId,
        nodeId: inp.nodeId,
        taskId: inp.taskId,
        outcome: inp.outcome,
        quality,
        latencyMs: Math.max(0, Math.round(inp.latencyMs ?? 0)),
        notes: (inp.notes ?? "").slice(0, 500),
      },
    })
  } catch { /* السجل best-effort */ }

  // تحديث وزن المكتبة المشتركة (GitSkills/ClawHub/Workspace — CORE تسيطر عليها تعلم المنصات)
  try {
    const delta = inp.outcome === "SUCCESS" ? 0.15 : inp.outcome === "PARTIAL" ? 0.05 : -0.1
    if (inp.skillKind === "GITSKILLS") {
      const row = await db.gitSkill.findFirst({ where: { OR: [{ path: inp.skillKey }, { name: inp.skillKey }] }, select: { id: true, weight: true } })
      if (row) await db.gitSkill.update({ where: { id: row.id }, data: { weight: clampW(row.weight + delta) } })
    } else if (inp.skillKind === "CLAWHUB") {
      const row = await db.hubSkill.findFirst({ where: { OR: [{ slug: inp.skillKey }, { name: inp.skillKey }] }, select: { id: true, weight: true } })
      if (row) await db.hubSkill.update({ where: { id: row.id }, data: { weight: clampW(row.weight + delta) } })
    } else if (inp.skillKind === "WORKSPACE" && inp.skillKey.startsWith("WS:")) {
      const row = await db.workspaceSkill.findUnique({ where: { id: inp.skillKey.slice(3) }, select: { id: true, weight: true } })
      if (row) {
        await db.workspaceSkill.update({
          where: { id: row.id },
          data: { weight: clampW(row.weight + delta), useCount: { increment: 1 }, leadCount: inp.outcome === "SUCCESS" ? { increment: 1 } : undefined },
        })
      }
    }
  } catch { /* التعلم best-effort */ }
}

export interface SkillUtility {
  skillKey: string
  skillKind: string
  attempts: number
  successes: number
  failures: number
  successRate: number // 0-1
  avgQuality: number // 0-100
  avgLatencyMs: number
}

/** فائدة مهارة/مهارات من نتايجها الحقيقية — بيدخل في ترتيب الاسترجاع الجاي */
export async function skillUtilities(workspaceId: string, keys?: string[]): Promise<Record<string, SkillUtility>> {
  try {
    const where: Prisma.SkillOutcomeWhereInput = { workspaceId, ...(keys?.length ? { skillKey: { in: keys } } : {}) }
    const rows = await db.skillOutcome.findMany({ where, select: { skillKey: true, skillKind: true, outcome: true, quality: true, latencyMs: true } })
    const acc: Record<string, SkillUtility> = {}
    for (const r of rows) {
      const u = (acc[r.skillKey] ??= { skillKey: r.skillKey, skillKind: r.skillKind, attempts: 0, successes: 0, failures: 0, successRate: 0, avgQuality: 0, avgLatencyMs: 0 })
      u.attempts++
      if (r.outcome === "SUCCESS") u.successes++
      if (r.outcome === "FAILURE") u.failures++
      u.avgQuality += r.quality
      u.avgLatencyMs += r.latencyMs
    }
    for (const u of Object.values(acc)) {
      u.successRate = u.attempts ? u.successes / u.attempts : 0
      u.avgQuality = u.attempts ? Math.round(u.avgQuality / u.attempts) : 0
      u.avgLatencyMs = u.attempts ? Math.round(u.avgLatencyMs / u.attempts) : 0
    }
    return acc
  } catch {
    return {}
  }
}

/** سجل استرجاع كامل (43.7 + منشأ 43.10) — «ليه اختارنا دي وليه رفضنا دي» */
export async function recordRetrieval(entry: {
  workspaceId: string
  graphId?: string
  nodeId?: string
  taskId?: string
  objective: string
  parsed?: unknown
  candidates?: unknown
  selected?: unknown
  rejected?: unknown
  reason?: string
}): Promise<void> {
  try {
    await db.skillRetrieval.create({
      data: {
        workspaceId: entry.workspaceId,
        graphId: entry.graphId,
        nodeId: entry.nodeId,
        taskId: entry.taskId,
        objective: entry.objective.slice(0, 500),
        parsed: (entry.parsed ?? undefined) as Prisma.InputJsonValue | undefined,
        candidates: (entry.candidates ?? undefined) as Prisma.InputJsonValue | undefined,
        selected: (entry.selected ?? undefined) as Prisma.InputJsonValue | undefined,
        rejected: (entry.rejected ?? undefined) as Prisma.InputJsonValue | undefined,
        reason: entry.reason?.slice(0, 400),
      },
    })
  } catch { /* best-effort */ }
}
