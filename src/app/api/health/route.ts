// LeadOS — System Health API: مركز الصحة الحقيقي (طلب #18)
// Vercel (latency/tick) + Neon (connection/backlog/stale locks) + GitHub (budgets/last ingest)
// + AI (لكل مزود: حي/تبريد/مفاتيح/آخر نجاح/زمن استجابة) + حالة النظام العامة.
// الصدق أولًا: أي بيانات مش متاحة من البيئة بتترجع "unknown" — مش أرقام مخترعة.
import { db } from "@/lib/db"
import { json, requireAuth, isResponse } from "@/lib/api-helpers"
import { aiProviderStatus, keyPoolStatus, dahlKeyPoolStatus } from "@/lib/ai"

export const maxDuration = 30

async function timed<T>(p: Promise<T>): Promise<{ ms: number; value: T | null; error: string | null }> {
  const t0 = Date.now()
  try {
    return { ms: Date.now() - t0, value: await p, error: null }
  } catch (err) {
    return { ms: Date.now() - t0, value: null, error: err instanceof Error ? err.message.slice(0, 120) : "خطأ" }
  }
}

export async function GET() {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const wsId = auth.workspace.id

  // ═══ Neon: اتصال حقيقي + قياس زمن ═══
  const ping = await timed(db.$queryRaw`SELECT 1`)
  const [jobCounts, staleLocks, lastTick, lastIngest] = await Promise.all([
    db.job.groupBy({ by: ["status"], _count: { id: true } }).catch(() => []),
    db.job.count({ where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 20 * 60_000) } } }).catch(() => 0),
    db.job.findFirst({ where: { type: "DISCOVERY", status: "SUCCESS" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }).catch(() => null),
    db.contentItem.findFirst({ orderBy: { collectedAt: "desc" }, select: { collectedAt: true, sourceId: true } }).catch(() => null),
  ])
  const jobsByStatus = Object.fromEntries(jobCounts.map((j) => [j.status, j._count.id]))

  // ═══ AI: حالة المزودين + آخر نجاح لكل مزود ═══
  const ai = aiProviderStatus()
  const lastRuns = await db.aiRun.groupBy({
    by: ["provider"],
    where: { workspaceId: wsId },
    _count: { id: true },
    _max: { createdAt: true },
    _avg: { latencyMs: true },
  }).catch(() => [])
  const successRuns = await db.aiRun.groupBy({
    by: ["provider"],
    where: { workspaceId: wsId, success: true },
    _max: { createdAt: true },
  }).catch(() => [])

  // ═══ البحث: آخر جوبات البحث والمزودات المستخدمة (adaptersUsed) ═══
  const recentSearch = await db.searchJob.findMany({
    where: { source: { workspaceId: wsId } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { resultCount: true, status: true, completedAt: true, metadata: true },
  }).catch(() => [])
  const adapterHits: Record<string, number> = {}
  for (const s of recentSearch) {
    const m = (s.metadata ?? {}) as { adaptersUsed?: string[] }
    for (const a of m.adaptersUsed ?? []) adapterHits[a] = (adapterHits[a] ?? 0) + 1
  }

  // ═══ حالة النظام العامة: RUNNING / DEGRADED / UNKNOWN ═══
  const lastTickAgeMin = lastTick?.completedAt ? (Date.now() - lastTick.completedAt.getTime()) / 60_000 : null
  const systemState = lastTickAgeMin === null ? "UNKNOWN" : lastTickAgeMin <= 15 ? "RUNNING" : lastTickAgeMin <= 60 ? "DEGRADED" : "STOPPED"

  // ═══ STOP file عبر GitHub API لو التوكين موجود — بدون توكين: unknown بصدق ═══
  let stopFile: { status: string; checkedAt: string } = { status: "unknown", checkedAt: new Date().toISOString() }
  const ghToken = process.env.GITHUB_TOKEN
  const ghRepo = process.env.GITHUB_REPO
  if (ghToken && ghRepo) {
    try {
      const res = await fetch(`https://api.github.com/repos/${ghRepo}/contents/.github/STOP`, {
        headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8_000),
      })
      stopFile = { status: res.status === 200 ? "EXISTS" : res.status === 404 ? "ABSENT" : `HTTP_${res.status}`, checkedAt: new Date().toISOString() }
    } catch {
      stopFile = { status: "unreachable", checkedAt: new Date().toISOString() }
    }
  }

  const uptimeDays = ((Date.now() - Number(process.uptime ? Date.now() - process.uptime() * 1000 : Date.now())) / 86_400_000)

  return json({
    ok: true,
    system: {
      state: systemState,
      stopFile,
      lastSuccessfulTick: lastTick?.completedAt ?? null,
      lastIngest: lastIngest?.collectedAt ?? null,
      processUptimeDays: Number(uptimeDays.toFixed(2)),
      vercel: { region: process.env.VERCEL_REGION ?? "unknown", env: process.env.VERCEL_ENV ?? "unknown" },
    },
    neon: {
      connected: ping.error === null,
      latencyMs: ping.ms,
      error: ping.error,
      jobs: jobsByStatus,
      jobBacklog: (jobsByStatus["QUEUED"] ?? 0) + (jobsByStatus["RETRYING"] ?? 0),
      staleLocks,
    },
    ai: {
      providers: {
        dahl: { active: ai.dahl.active, keys: dahlKeyPoolStatus(), lastSuccess: successRuns.find((s) => s.provider === "DAHL")?._max.createdAt ?? null, avgLatencyMs: Math.round(lastRuns.find((r) => r.provider === "DAHL")?._avg.latencyMs ?? 0) },
        nvidia: { active: ai.hasKey, keys: keyPoolStatus(), lastSuccess: successRuns.find((s) => s.provider === "NVIDIA")?._max.createdAt ?? null, avgLatencyMs: Math.round(lastRuns.find((r) => r.provider === "NVIDIA")?._avg.latencyMs ?? 0) },
        zai: { active: true, note: "طوارئ دائمة (z-ai-web-dev-sdk) — بدون مفاتيح" },
      },
      note: ai.note,
      totalRuns: Object.fromEntries(lastRuns.map((r) => [r.provider, r._count.id])),
    },
    search: {
      recentJobs: recentSearch.length,
      adapterUsage: adapterHits,
      lastResultCount: recentSearch[0]?.resultCount ?? null,
      lastSearchAt: recentSearch[0]?.completedAt ?? null,
    },
  })
}
