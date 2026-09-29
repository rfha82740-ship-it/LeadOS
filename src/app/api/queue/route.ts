// LeadOS — Queue/Jobs API: الطابور بكل حالاته + أفعال آمنة (طلب #28)
// queued/running/retrying/success/failed/stale + retry | cancel | unlock-stale — كل فعل يسجل AuditLog
import { db } from "@/lib/db"
import { json, jsonError, requireAuth, isResponse, readBody, rateLimit } from "@/lib/api-helpers"

export const maxDuration = 30

export async function GET(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const wsId = auth.workspace.id
  const url = new URL(req.url)
  const status = url.searchParams.get("status")
  const take = Math.min(100, Math.max(10, Number(url.searchParams.get("take") ?? 50)))

  const [jobs, counts, stale] = await Promise.all([
    db.job.findMany({
      where: { workspaceId: wsId, ...(status ? { status: status.toUpperCase() } : {}) },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take,
    }),
    db.job.groupBy({ by: ["status"], where: { workspaceId: wsId }, _count: { id: true } }).catch(() => []),
    db.job.count({ where: { workspaceId: wsId, status: "RUNNING", OR: [{ lockedAt: { lt: new Date(Date.now() - 20 * 60_000) } }, { startedAt: { lt: new Date(Date.now() - 20 * 60_000) } }] } }).catch(() => 0),
  ])
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count.id]))
  return json({
    ok: true,
    counts: byStatus,
    stale,
    jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      priority: j.priority,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      workerId: j.workerId,
      lockedAt: j.lockedAt,
      scheduledAt: j.scheduledAt,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      createdAt: j.createdAt,
      durationMs: j.startedAt && j.completedAt ? j.completedAt.getTime() - j.startedAt.getTime() : null,
      errorMessage: j.errorMessage,
      result: (j.result as { message?: string } | null)?.message?.slice(0, 240) ?? null,
      payload: j.payload,
    })),
  })
}

export async function POST(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  if (!rateLimit(`queue:${auth.user.id}`, 30, 60_000)) return jsonError("محاولات كتير — استنى شوية", 429)
  const wsId = auth.workspace.id
  const body = await readBody<{ action?: string; jobId?: string }>(req)
  const action = body?.action
  const jobId = body?.jobId
  if (!action || !jobId) return jsonError("action و jobId مطلوبان", 400)

  const job = await db.job.findFirst({ where: { id: jobId, workspaceId: wsId } })
  if (!job) return jsonError("جوب غير موجود", 404)

  let updated: { id: string; status: string } | null = null
  if (action === "retry") {
    if (!["FAILED", "CANCELLED"].includes(job.status)) return jsonError("إعادة المحاولة للفاشل/الملغي فقط", 400)
    const r = await db.job.update({
      where: { id: job.id },
      data: { status: "QUEUED", scheduledAt: new Date(), errorMessage: null, completedAt: null, attempts: 0 },
    })
    updated = { id: r.id, status: r.status }
  } else if (action === "cancel") {
    if (!["QUEUED", "RETRYING"].includes(job.status)) return jsonError("الإلغاء لطابور الانتظار فقط — الجاري ينتهي أو يُفك قفله", 400)
    const r = await db.job.update({ where: { id: job.id }, data: { status: "CANCELLED", completedAt: new Date() } })
    updated = { id: r.id, status: r.status }
  } else if (action === "unlock") {
    // فك قفل جوب عالق: RUNNING قديم → QUEUED — نفس منطق النبضة لكن يدوي فوري
    if (job.status !== "RUNNING") return jsonError("فك القفل للجاري فقط", 400)
    const age = Date.now() - (job.startedAt ?? job.createdAt).getTime()
    if (age < 15 * 60_000) return jsonError("الجوب لسه جديد (<15 دقيقة) — استنى قبل فك القفل", 400)
    const r = await db.job.update({
      where: { id: job.id },
      data: { status: "QUEUED", lockedAt: null, workerId: null, startedAt: null },
    })
    updated = { id: r.id, status: r.status }
  } else {
    return jsonError("action غير معروف — المسموح: retry | cancel | unlock", 400)
  }

  await db.auditLog.create({
    data: {
      workspaceId: wsId,
      userId: auth.user.id,
      action: `JOB_${action.toUpperCase()}`,
      entityType: "Job",
      entityId: job.id,
      before: { status: job.status, attempts: job.attempts },
      after: { status: updated.status },
    },
  }).catch(() => undefined)

  return json({ ok: true, job: { id: updated.id, status: updated.status } })
}
