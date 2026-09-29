"use client";
// LeadOS — العمليات الحية (Live Operations): جوبات راكضة + خرايط نشطة + آخر أحداث الابتلاع
// auto-refresh كل 15 ثانية — لقطة حية لما بيحصل دلوقتي
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { apiGet } from "../shared"

interface OpsData {
  running: Array<{ id: string; type: string; workerId: string | null; startedAt: string | null; priority: number; attempts: number }>
  queued: number
  stale: number
  activeGraphs: Array<{ id: string; goal: string; currentNode: { type: string; objective: string } | null; progress: { done: number; failed: number; pending: number; total: number } }>
  latestContent: Array<{ id: string; title: string; platform: string | null; at: string }>
  groupsScanning: Array<{ id: string; name: string; lastScannedAt: string | null; status: string }>
}

type JobRowLite = OpsData["running"][number] & { status: string }

const rel = (d: string | null) => {
  if (!d) return "—"
  const s = (Date.now() - new Date(d).getTime()) / 1000
  if (s < 60) return `قبل ${Math.max(1, Math.round(s))}ث`
  if (s < 3600) return `قبل ${Math.round(s / 60)}د`
  return `قبل ${Math.round(s / 3600)}س`
}

export function OpsView() {
  const [d, setD] = useState<OpsData | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const [queue, graphs, content, groups] = await Promise.all([
          apiGet<{ jobs: Array<JobRowLite>; counts: Record<string, number>; stale: number }>("/api/queue?take=30"),
          apiGet<{ graphs: Array<Record<string, unknown>> }>("/api/graph"),
          apiGet<{ rows?: Array<{ id: string; title: string; at: string; platform: string | null }> }>("/api/logs?type=search&take=8"),
          apiGet<{ groups: OpsData["groupsScanning"] }>("/api/radar?take=10").catch(() => ({ groups: [] })),
        ])
        if (stop) return
        const running: OpsData["running"] = queue.jobs.filter((j) => j.status === "RUNNING")
        // خرايط نشطة: جيب تفاصيل أول خريطة نشطة
        const activeGraphs: OpsData["activeGraphs"] = []
        for (const g of (graphs.graphs ?? []).slice(0, 6)) {
          if ((g as { status?: string }).status !== "ACTIVE") continue
          const det = await apiGet<{ nodes: Array<{ status: string; type: string; objective: string; nodeId: string }> }>(`/api/graph?id=${(g as { id?: string }).id}`).catch(() => null)
          if (!det) continue
          const runningNode = det.nodes.find((n) => n.status === "RUNNING") ?? det.nodes.find((n) => n.status === "PENDING") ?? null
          const progress = {
            done: det.nodes.filter((n) => n.status === "DONE").length,
            failed: det.nodes.filter((n) => n.status === "FAILED").length,
            pending: det.nodes.filter((n) => n.status === "PENDING").length,
            total: det.nodes.length,
          }
          activeGraphs.push({ id: (g as { id?: string }).id ?? "", goal: (g as { goal?: string }).goal ?? "", currentNode: runningNode ? { type: runningNode.type, objective: runningNode.objective } : null, progress })
        }
        const latestContent = (content.rows ?? []).map((r) => ({ id: r.id, title: r.title ?? r.id, platform: r.platform ?? null, at: r.at }))
        setD({ running, queued: (queue.counts["QUEUED"] ?? 0) + (queue.counts["RETRYING"] ?? 0), stale: queue.stale, activeGraphs, latestContent, groupsScanning: groups.groups ?? [] })
      } catch {
        // النبضة الجاية بتجرب تاني
      }
      setTick((t) => t + 1)
    }
    load()
    const t = setInterval(load, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="live-dot h-2 w-2 rounded-full bg-emerald-500" />
        <p className="text-xs text-muted-foreground">تحديث تلقائي كل 15 ثانية — لقطة #{tick}</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {/* جوبات راكضة */}
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">جوبات راكضة الآن ({d?.running.length ?? 0})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {d?.running.length
              ? d.running.map((j) => (
                <div key={j.id} className="rounded-lg border border-border/60 p-2">
                  <div className="flex items-center justify-between">
                    <Badge className="bg-primary/15 text-primary">{j.type}</Badge>
                    <span className="text-[10px] text-muted-foreground">{rel(j.startedAt)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">worker: {j.workerId ?? "—"} · أولوية {j.priority} · محاولة {j.attempts}</p>
                </div>
              ))
              : <p className="text-xs text-muted-foreground">مفيش جوب راكض حاليًا — الطابور بيشتغل بنبضة كل 10 دقايق</p>}
            <p className="pt-1 text-[11px] text-muted-foreground">في الانتظار: {d?.queued ?? 0} · عالق: {d?.stale ?? 0}</p>
          </CardContent>
        </Card>

        {/* خرايط نشطة */}
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">خرايط تفكير نشطة ({d?.activeGraphs.length ?? 0})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {d?.activeGraphs.length
              ? d.activeGraphs.map((g) => (
                <div key={g.id} className="rounded-lg border border-border/60 p-2">
                  <p className="truncate text-xs font-bold">{g.goal}</p>
                  {g.currentNode && <p className="mt-0.5 text-[11px] text-primary">⟶ {g.currentNode.type}: {g.currentNode.objective.slice(0, 60)}</p>}
                  <p className="text-[10px] text-muted-foreground">{g.progress.done}/{g.progress.total} خلصت · {g.progress.failed} فشلت · {g.progress.pending} مستنية</p>
                </div>
              ))
              : <p className="text-xs text-muted-foreground">مفيش خريطة شغالة — انطلق واحدة من شاشة DSI أو الأيجنت</p>}
          </CardContent>
        </Card>

        {/* آخر ابتلاع */}
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">آخر أحداث البحث والابتلاع</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {d?.latestContent.length
              ? d.latestContent.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{c.title.slice(0, 48)}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{rel(c.at)}</span>
                </div>
              ))
              : <p className="text-xs text-muted-foreground">مفيش أحداث حديثة</p>}
          </CardContent>
        </Card>
      </div>

      {/* جروبات بتمسح */}
      <Card><CardHeader className="pb-2"><CardTitle className="text-sm">جروبات قيد المسح/المراقبة</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {d?.groupsScanning.length
            ? d.groupsScanning.slice(0, 15).map((g) => (
              <Badge key={g.id} variant="outline" className="max-w-56 truncate text-[10px]" title={g.name}>
                {g.name} · {rel(g.lastScannedAt)}
              </Badge>
            ))
            : <p className="text-xs text-muted-foreground">مفيش جروبات مسجلة أو مفيش مسح حديث</p>}
        </CardContent>
      </Card>
    </div>
  )
}
