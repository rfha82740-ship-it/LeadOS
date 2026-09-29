"use client";
// LeadOS — شاشة الطابور: كل الجوبات بكل حالاتها + أفعال آمنة (retry/cancel/unlock)
import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { apiGet, apiSend } from "../shared"

interface JobRow {
  id: string; type: string; status: string; priority: number; attempts: number; maxAttempts: number
  workerId: string | null; lockedAt: string | null; scheduledAt: string | null; startedAt: string | null
  completedAt: string | null; createdAt: string; durationMs: number | null; errorMessage: string | null; result: string | null
}
const COLORS: Record<string, string> = {
  SUCCESS: "bg-emerald-500/15 text-emerald-300", FAILED: "bg-rose-500/15 text-rose-300",
  RUNNING: "bg-sky-500/15 text-sky-300", QUEUED: "bg-secondary text-secondary-foreground",
  RETRYING: "bg-amber-500/15 text-amber-300", CANCELLED: "bg-muted text-muted-foreground",
}
const fmt = (d: string | null) => d ? new Date(d).toLocaleString("ar-EG", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) : "—"

export function QueueView() {
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [stale, setStale] = useState(0)
  const [filter, setFilter] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = () => {
    apiGet<{ jobs: JobRow[]; counts: Record<string, number>; stale: number }>(`/api/queue?take=60${filter ? `&status=${filter}` : ""}`)
      .then((d) => { setJobs(d.jobs); setCounts(d.counts); setStale(d.stale) })
      .catch(() => undefined)
  }
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [filter])

  const doAct = async (jobId: string, action: "retry" | "cancel" | "unlock") => {
    setBusy(true); setMsg(null)
    try {
      const r = await apiSend<{ ok: boolean; error?: string }>("/api/queue", "POST", { action, jobId })
      setMsg(r.ok ? "✅ تم" : `❌ ${r.error}`)
      load()
    } catch (e) { setMsg(`خطأ: ${e instanceof Error ? e.message.slice(0, 100) : "غير معروف"}`) }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => setFilter("")} className={`rounded-full px-3 py-1 text-[11px] ${!filter ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>الكل</button>
        {["QUEUED", "RUNNING", "RETRYING", "SUCCESS", "FAILED", "CANCELLED"].map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={`rounded-full px-3 py-1 text-[11px] ${filter === s ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
            {s} {counts[s] ?? 0}
          </button>
        ))}
        {stale > 0 && <Badge className="bg-amber-500/20 text-amber-300">{stale} عالق &gt;20د</Badge>}
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>

      <Card><CardContent className="max-h-[70vh] space-y-1.5 overflow-y-auto p-3">
        {jobs.map((j) => (
          <div key={j.id} className="rounded-lg border border-border/60 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={COLORS[j.status] ?? "bg-secondary"}>{j.status}</Badge>
              <span className="text-xs font-extrabold">{j.type}</span>
              <span className="text-[10px] text-muted-foreground">أولوية {j.priority} · محاولات {j.attempts}/{j.maxAttempts}</span>
              {j.workerId && <span className="text-[9px] text-muted-foreground" dir="ltr">worker: {j.workerId.slice(0, 20)}</span>}
              <div className="ms-auto flex gap-1">
                {["FAILED", "CANCELLED"].includes(j.status) && <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={() => doAct(j.id, "retry")}>إعادة</Button>}
                {["QUEUED", "RETRYING"].includes(j.status) && <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={() => doAct(j.id, "cancel")}>إلغاء</Button>}
                {j.status === "RUNNING" && <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={() => doAct(j.id, "unlock")}>فك القفل</Button>}
              </div>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-muted-foreground">
              <span>أُنشئ: {fmt(j.createdAt)}</span>
              {j.startedAt && <span>بدأ: {fmt(j.startedAt)}</span>}
              {j.completedAt && <span>انتهى: {fmt(j.completedAt)}</span>}
              {j.durationMs != null && <span>المدة: {(j.durationMs / 1000).toFixed(0)}ث</span>}
            </div>
            {j.result && <p className="mt-0.5 line-clamp-2 text-[10px] text-emerald-300/80">{j.result}</p>}
            {j.errorMessage && <p className="mt-0.5 line-clamp-2 text-[10px] text-rose-400">{j.errorMessage}</p>}
          </div>
        ))}
        {!jobs.length && <p className="p-4 text-center text-xs text-muted-foreground">مفيش جوبات بالفلتر ده</p>}
      </CardContent></Card>
    </div>
  )
}
