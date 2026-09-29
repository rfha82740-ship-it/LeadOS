// LeadOS — Radar API: كل نشاط الرادار اللحظي قابل للتدقيق من اللوحة (طلب #11)
// detections (GroupPost) + comment jobs (FB_COMMENT) + approvals + outcomes
import { db } from "@/lib/db"
import { json, requireAuth, isResponse } from "@/lib/api-helpers"

export async function GET(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const wsId = auth.workspace.id
  const url = new URL(req.url)
  const take = Math.min(50, Math.max(5, Number(url.searchParams.get("take") ?? 25)))

  const [detections, commentJobs, groups, agg] = await Promise.all([
    db.groupPost.findMany({
      where: { group: { workspaceId: wsId } },
      orderBy: { postedAt: "desc" },
      take,
      include: { group: { select: { name: true, url: true, status: true, activityScore: true } } },
    }),
    db.job.findMany({
      where: { workspaceId: wsId, type: "FB_COMMENT" },
      orderBy: { createdAt: "desc" },
      take,
    }),
    db.monitoredGroup.findMany({
      where: { workspaceId: wsId, platform: "FACEBOOK" },
      select: { id: true, name: true, status: true, activityScore: true, lastScannedAt: true, intentScore: true },
      orderBy: { activityScore: "desc" },
      take: 30,
    }),
    Promise.all([
      db.groupPost.count({ where: { group: { workspaceId: wsId } } }),
      db.job.count({ where: { workspaceId: wsId, type: "FB_COMMENT", status: "SUCCESS" } }),
      db.job.count({ where: { workspaceId: wsId, type: "FB_COMMENT", status: { in: ["QUEUED", "RETRYING", "RUNNING"] } } }),
      db.job.count({ where: { workspaceId: wsId, type: "FB_COMMENT", status: "FAILED" } }),
    ]),
  ])

  // ربط التعليق المجدول بحالة الليد الناتج (outcome)
  const leadIds = commentJobs.map((j) => (j.payload as { leadId?: string } | null)?.leadId).filter(Boolean) as string[]
  const leads = leadIds.length
    ? await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, status: true, score: true } })
    : []
  const leadBy = Object.fromEntries(leads.map((l) => [l.id, l]))

  return json({
    ok: true,
    stats: {
      totalDetections: agg[0],
      commentsPosted: agg[1],
      commentsPending: agg[2],
      commentsFailed: agg[3],
      activeGroups: groups.filter((g) => g.status === "ACTIVE").length,
      pausedGroups: groups.filter((g) => g.status === "PAUSED").length,
      // حدود الرادار الفعلية من الكود (radar.ts RADAR_CONFIG) — بشفافية كاملة
      limits: { commentMinGapMin: "4-8 دقائق بين التعليقات", freshnessWindow: "المنشورات الطازجة فقط", perCycle: "2 جروب/نبضة (radar-pulse)" },
    },
    detections: detections.map((d) => ({
      id: d.id,
      url: d.url,
      author: d.author,
      content: d.content.slice(0, 240),
      postedAt: d.postedAt,
      score: d.score,
      matched: d.matchedKeywords,
      status: d.status,
      group: { name: d.group.name, url: d.group.url, status: d.group.status, activityScore: d.group.activityScore },
    })),
    comments: commentJobs.map((j) => {
      const p = (j.payload ?? {}) as { groupName?: string; author?: string; leadId?: string; postUrl?: string }
      const lead = p.leadId ? leadBy[p.leadId] : null
      return {
        id: j.id,
        status: j.status,
        scheduledAt: j.scheduledAt,
        attempts: j.attempts,
        groupName: p.groupName ?? null,
        author: p.author ?? null,
        postUrl: p.postUrl ?? null,
        errorMessage: j.errorMessage,
        lead: lead ? { id: lead.id, status: lead.status, score: lead.score } : null,
      }
    }),
    groups,
  })
}
