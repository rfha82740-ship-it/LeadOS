import { db } from "@/lib/db"
import { json, requireAuth, isResponse } from "@/lib/api-helpers"
import { segmentFilter } from "@/lib/monitors/segments"
import type { Prisma } from "@prisma/client"

export async function GET(req: Request) {
  const auth = await requireAuth()
  if (isResponse(auth)) return auth
  const wsId = auth.workspace.id
  const panel = new URL(req.url).searchParams.get("panel")
  const leadWhere: Prisma.LeadWhereInput = { workspaceId: wsId }
  const seg = segmentFilter(panel)
  if (seg) leadWhere.segment = seg as never

  const [hotLeads, newLeads, runningResearch, unreadAlerts, dueTasks, activeSources, totalLeads, totalJobs] =
    await Promise.all([
      db.lead.count({ where: { ...leadWhere, temperature: "HOT" } }),
      db.lead.count({ where: { ...leadWhere, status: "NEW" } }),
      db.researchRun.count({ where: { workspaceId: wsId, status: { in: ["RUNNING", "QUEUED"] } } }),
      db.alert.count({ where: { workspaceId: wsId, isRead: false } }),
      db.task.count({ where: { workspaceId: wsId, status: "TODO" } }),
      db.source.count({ where: { workspaceId: wsId, status: "ACTIVE" } }),
      db.lead.count({ where: leadWhere }),
      db.job.count({ where: { workspaceId: wsId, status: { in: ["QUEUED", "RUNNING", "RETRYING"] } } }),
    ])

  const topLeads = await db.lead.findMany({
    where: leadWhere,
    include: { business: { select: { name: true, city: true, industry: true } } },
    orderBy: { score: "desc" },
    take: 5,
  })
  const recentAlerts = await db.alert.findMany({
    where: { workspaceId: wsId },
    orderBy: { createdAt: "desc" },
    take: 5,
  })
  const sources = await db.source.findMany({
    where: { workspaceId: wsId },
    select: { id: true, name: true, type: true, status: true, lastRunAt: true, lastError: true },
    take: 8,
  })
  const recentJobs = await db.job.findMany({
    where: { workspaceId: wsId },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { id: true, type: true, status: true, createdAt: true, result: true },
  })
  const upcomingTasks = await db.task.findMany({
    where: { workspaceId: wsId, status: "TODO", ...(seg ? { lead: { segment: seg as never } } : {}) },
    include: { lead: { include: { business: { select: { name: true } } } } },
    orderBy: { dueAt: "asc" },
    take: 5,
  })

  return json({
    // Data freshness #14: كل رد overview يحمل لحظة التوليد — الـUI بيعرضها
    generatedAt: new Date().toISOString(),
    kpis: { hotLeads, newLeads, runningResearch, unreadAlerts, dueTasks, activeSources, totalLeads, activeJobs: totalJobs },
    topLeads,
    recentAlerts,
    sources,
    recentJobs,
    upcomingTasks,
  })
}
