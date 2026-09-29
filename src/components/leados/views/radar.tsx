"use client";
// LeadOS — شاشة الرادار اللحظي: كشف حي + حالة التعليقات + صحة الجروبات — كل شيء قابل للتدقيق
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { apiGet } from "../shared"

interface RadarData {
  stats: { totalDetections: number; commentsPosted: number; commentsPending: number; commentsFailed: number; activeGroups: number; pausedGroups: number; limits: Record<string, string> }
  detections: Array<{ id: string; url: string | null; author: string | null; content: string; postedAt: string | null; score: number; matched: string[] | null; status: string; group: { name: string; status: string; activityScore: number | null } }>
  comments: Array<{ id: string; status: string; scheduledAt: string | null; attempts: number; groupName: string | null; author: string | null; errorMessage: string | null; lead: { id: string; status: string; score: number } | null }>
  groups: Array<{ id: string; name: string; status: string; activityScore: number | null; lastScannedAt: string | null; intentScore: number | null }>
}

const STATUS_CLS: Record<string, string> = {
  SUCCESS: "bg-emerald-500/15 text-emerald-300", FAILED: "bg-rose-500/15 text-rose-300",
  QUALIFIED: "bg-emerald-500/15 text-emerald-300", CONVERTED: "bg-sky-500/15 text-sky-300",
  QUEUED: "bg-secondary text-secondary-foreground", RUNNING: "bg-sky-500/15 text-sky-300",
  ACTIVE: "bg-secondary text-secondary-foreground", PAUSED: "bg-amber-500/15 text-amber-300",
}

export function RadarView({ onOpenLead }: { onOpenLead?: (id: string) => void }) {
  const [d, setD] = useState<RadarData | null>(null)
  useEffect(() => {
    const load = () => apiGet<RadarData>("/api/radar?take=25").then(setD).catch(() => undefined)
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { l: "كشف لحد دلوقتي", v: d?.stats.totalDetections ?? "—" },
          { l: "تعليقات منشورة", v: d?.stats.commentsPosted ?? "—" },
          { l: "تعليقات مجدولة", v: d?.stats.commentsPending ?? "—" },
          { l: "تعليقات فاشلة", v: d?.stats.commentsFailed ?? "—" },
          { l: "جروبات نشطة", v: d?.stats.activeGroups ?? "—" },
          { l: "جروبات موقوفة", v: d?.stats.pausedGroups ?? "—" },
        ].map((k) => (
          <Card key={k.l}><CardContent className="p-3">
            <p className="text-[10px] text-muted-foreground">{k.l}</p>
            <p className="mt-0.5 text-xl font-extrabold">{k.v}</p>
          </CardContent></Card>
        ))}
      </div>

      <Card><CardHeader className="pb-2"><CardTitle className="text-sm">حدود الرادار الحالية (شفافية كاملة — بدون تجاوز للمنصات)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          {Object.entries(d?.stats.limits ?? {}).map(([k, v]) => <Badge key={k} variant="outline" className="text-[10px]">{k}: {v}</Badge>)}
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">كشف لحظي (أحدث المنشورات المؤهلة)</CardTitle></CardHeader>
          <CardContent className="max-h-[50vh] space-y-1.5 overflow-y-auto">
            {d?.detections.map((x) => (
              <div key={x.id} className="rounded-lg border border-border/60 p-2">
                <div className="flex items-center gap-2">
                  <Badge className={STATUS_CLS[x.status] ?? "bg-secondary"}>{x.status}</Badge>
                  <span className="text-xs font-bold">{x.author ?? "مجهول"}</span>
                  <Badge variant="outline" className="text-[9px]">نية {x.score}</Badge>
                  <span className="ms-auto text-[9px] text-muted-foreground">{x.postedAt ? new Date(x.postedAt).toLocaleString("ar-EG", { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px]">{x.content}</p>
                <p className="text-[9px] text-muted-foreground">جروب: {x.group.name} · نشاط {x.group.activityScore ?? "—"}</p>
                {x.matched?.length ? <div className="mt-1 flex flex-wrap gap-1">{x.matched.slice(0, 4).map((m) => <Badge key={m} variant="outline" className="text-[9px]">{m}</Badge>)}</div> : null}
              </div>
            ))}
            {!d?.detections.length && <p className="text-xs text-muted-foreground">مفيش كشف لسه — الرادار بيدور على الجروبات النشطة</p>}
          </CardContent>
        </Card>

        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">التعليقات المجدولة وحالتها</CardTitle></CardHeader>
          <CardContent className="max-h-[50vh] space-y-1.5 overflow-y-auto">
            {d?.comments.map((c) => (
              <div key={c.id} className="rounded-lg border border-border/60 p-2">
                <div className="flex items-center gap-2">
                  <Badge className={STATUS_CLS[c.status] ?? "bg-secondary"}>{c.status}</Badge>
                  <span className="text-xs">{c.author ?? "—"} @ {c.groupName ?? "—"}</span>
                  {c.lead && (
                    <button className="ms-auto text-[10px] text-primary underline" onClick={() => onOpenLead?.(c.lead!.id)}>
                      الليد ({c.lead.status} · {c.lead.score})
                    </button>
                  )}
                </div>
                {c.scheduledAt && <p className="text-[9px] text-muted-foreground">مجدول: {new Date(c.scheduledAt).toLocaleString("ar-EG")}</p>}
                {c.errorMessage && <p className="text-[9px] text-rose-400">{c.errorMessage.slice(0, 120)}</p>}
              </div>
            ))}
            {!d?.comments.length && <p className="text-xs text-muted-foreground">مفيش تعليقات مجدولة — كل تعليق بيعدي ببوابة الاعتماد</p>}
          </CardContent>
        </Card>
      </div>

      <Card><CardHeader className="pb-2"><CardTitle className="text-sm">صحة الجروبات (نشاط + آخر مسح)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {d?.groups.map((g) => (
            <Badge key={g.id} variant="outline" className="max-w-64 truncate text-[10px]" title={g.name}>
              {g.name.slice(0, 30)} · نشاط {g.activityScore ?? 0} · {g.status}
            </Badge>
          ))}
          {!d?.groups.length && <p className="text-xs text-muted-foreground">مفيش جروبات فيسبوك مراقبة</p>}
        </CardContent>
      </Card>
    </div>
  )
}
