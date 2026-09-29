// LeadOS — Command Bar (Final Hardening #19/#20/#21): شريط القيادة المركزي
// SYSTEM / QUEUE / AI / SEARCH / FARM / RADAR / ZIZO + أزرار آمنة (Refresh/Tick/Stop/Resume/Queue/Alerts)
// + Data Freshness («آخر تحديث: قبل X») + أهم التنبيهات (CRITICAL/HIGH/MEDIUM)
"use client"
import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, OctagonX, Play, ListTree, BellRing, Zap } from "lucide-react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { apiSend } from "../shared"
import { useToast } from "@/hooks/use-toast"
import type { ViewKey } from "../shared"

interface StopState { ok?: boolean; systemState?: string; stopFile?: string; stopControlReady?: boolean; stopMeta?: { stoppedAt?: string | null; stoppedBy?: string | null; reason?: string | null; resumedAt?: string | null; resumedBy?: string | null }; metrics?: { lastSuccessfulTick?: string | null; runningJobs?: number; failedJobs24h?: number; activeGraphs?: number }; checkedAt?: string }
interface Capacity { ok?: boolean; limit?: number; runningJobs?: number; availableSlots?: number; activeRuns?: number; chains?: Array<{ event: string; name: string; activeRuns: number; activeJobs: number; lastRunAt: string | null }>; farm?: { browserInstances: number; serpWorkers: number; httpWorkers: number; flaresolverrInstances: number; farmWorkerProcesses: number }; checkedAt?: string }
interface Health { ok?: boolean; system?: { state?: string; lastSuccessfulTick?: string | null; processUptimeDays?: number }; neon?: { connected?: boolean; latencyMs?: number; jobBacklog?: number; staleLocks?: number }; ai?: { providers?: Record<string, { active?: boolean; lastSuccess?: string | null }> }; search?: { lastSearchAt?: string | null; recentJobs?: number } }

function ago(iso?: string | null): string {
  if (!iso) return "—"
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s} ثانية`
  if (s < 3600) return `${Math.floor(s / 60)} دقيقة`
  if (s < 86400) return `${Math.floor(s / 3600)} ساعة`
  return `${Math.floor(s / 86400)} يوم`
}

const STATE_TONE: Record<string, string> = {
  RUNNING: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  STOPPING: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  STOPPED: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  DEGRADED: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  IDLE: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  UNKNOWN: "border-slate-500/40 bg-slate-500/10 text-slate-400",
}

export function CommandBar({ onGoTo }: { onGoTo?: (v: ViewKey) => void }) {
  const { toast } = useToast()
  const [stop, setStop] = useState<StopState | null>(null)
  const [cap, setCap] = useState<Capacity | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [updated, setUpdated] = useState<Date>(new Date())
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [stopReason, setStopReason] = useState("")
  const [confirmResume, setConfirmResume] = useState(false)

  const load = useCallback(async () => {
    const [s, c, h] = await Promise.all([
      fetch("/api/system/stop").then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/system/capacity").then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/health").then(r => (r.ok ? r.json() : null)).catch(() => null),
    ])
    setStop(s); setCap(c); setHealth(h); setUpdated(new Date())
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 20_000)
    return () => clearInterval(t)
  }, [load])

  const state = stop?.systemState ?? "UNKNOWN"
  const farmChains = cap?.chains ?? []
  const radar = farmChains.find(c => c.event === "beat_radar")
  const farm = farmChains.find(c => c.event === "beat_farm")
  const aiActive = Object.values(health?.ai?.providers ?? {}).filter(p => p.active).length
  const aiTotal = Object.keys(health?.ai?.providers ?? {}).length
  const backlog = health?.neon?.jobBacklog ?? 0
  const stale = health?.neon?.staleLocks ?? 0

  // تنبيهات مشتقة (الأهم يظهر فوق)
  const alerts: Array<{ level: "CRITICAL" | "HIGH" | "MEDIUM"; text: string }> = []
  if (state === "STOPPED") alerts.push({ level: "CRITICAL", text: "النظام موقوف (STOP فعال) — كل السلاسل واقفة" })
  if (stop?.stopControlReady === false) alerts.push({ level: "MEDIUM", text: "زر الإيقاف غير مفعّل (GITHUB_TOKEN غير متوفر) — الإيقاف يدوي من GitHub" })
  if (health?.neon?.connected === false) alerts.push({ level: "CRITICAL", text: "قاعدة البيانات Neon غير متصلة" })
  if (stale > 0) alerts.push({ level: "HIGH", text: `${stale} جوب عالقة (stale) — بتترجع تلقائيًا في النبضة` })
  if (backlog > 30) alerts.push({ level: "HIGH", text: `تكدس في الطابور: ${backlog} جوب منتظرة` })
  if (cap && cap.availableSlots !== undefined && cap.availableSlots <= 1 && cap.runningJobs !== undefined && cap.runningJobs > 0) alerts.push({ level: "MEDIUM", text: `سعة GitHub مشبعة (${cap.runningJobs}/${cap.limit})` })

  const doStop = async () => {
    setBusy(true)
    try {
      const r = await apiSend<{ performed?: boolean; state?: string; reason?: string }>("/api/system/stop", "POST", { mode: "stop", confirm: "STOP", reason: stopReason || "Emergency Stop من شريط القيادة" })
      toast({ title: r?.performed ? "🛑 أمر الإيقاف نُفذ" : "فشل الإيقاف", description: r?.state ? `الحالة: ${r.state}` : (r?.reason ?? ""), variant: r?.performed ? "default" : "destructive" })
      setConfirmStop(false); setStopReason(""); await load()
    } finally { setBusy(false) }
  }
  const doResume = async () => {
    setBusy(true)
    try {
      const r = await apiSend<{ performed?: boolean; dispatched?: string[]; reason?: string }>("/api/system/stop", "POST", { mode: "resume" })
      toast({ title: r?.performed ? "▶️ النظام رجع يشتغل" : "فشل التشغيل", description: r?.dispatched ? `انطلقت: ${r.dispatched.join("، ")}` : (r?.reason ?? ""), variant: r?.performed ? "default" : "destructive" })
      setConfirmResume(false); await load()
    } finally { setBusy(false) }
  }
  const doTick = async () => {
    setBusy(true)
    try {
      const r = await apiSend<{ ok?: boolean }>("/api/cron/tick", "POST", {})
      toast({ title: r?.ok ? "⚡ نبضة انطلقت (خلفية)" : "فشل تنفيذ النبضة" })
      await load()
    } finally { setBusy(false) }
  }

  const Chip = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div className="flex min-w-0 flex-col rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
      <span className="text-[10px] font-semibold text-muted-foreground">{label}</span>
      <span className={`truncate text-xs font-bold ${tone ?? ""}`}>{value}</span>
    </div>
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-stretch gap-2 rounded-xl border border-primary/20 bg-primary/5 p-2">
        <Chip label="SYSTEM" value={state} tone={STATE_TONE[state]?.split(" ").find(c => c.startsWith("text-"))} />
        <Chip label="QUEUE" value={`${backlog} منتظرة${stale ? ` · ${stale} عالقة` : ""}`} />
        <Chip label="AI" value={aiTotal ? `${aiActive}/${aiTotal} مزود نشط` : "—"} />
        <Chip label="SEARCH" value={health?.search?.lastSearchAt ? `آخر بحث ${ago(health.search.lastSearchAt)}` : "—"} />
        <Chip label="FARM" value={cap ? `${farm?.activeRuns ? "شغالة" : "واقفة"} · ${cap.runningJobs}/${cap.limit} جوب` : "—"} />
        <Chip label="RADAR" value={radar?.lastRunAt ? `آخر تشغيل ${ago(radar.lastRunAt)}` : "—"} />
        <Chip label="ZIZO" value={stop?.metrics?.activeGraphs !== undefined ? `${stop.metrics.activeGraphs} خريطة نشطة` : "—"} />
        <div className="ms-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={load} title="تحديث"><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={doTick} title="تشغيل نبضة الآن"><Zap className="h-4 w-4" /></Button>
          {onGoTo && <Button size="sm" variant="ghost" onClick={() => onGoTo("queue")} title="الطابور"><ListTree className="h-4 w-4" /></Button>}
          {onGoTo && <Button size="sm" variant="ghost" onClick={() => onGoTo("logs")} title="التنبيهات"><BellRing className="h-4 w-4" /></Button>}
          {state === "STOPPED" || state === "STOPPING" ? (
            <Button size="sm" variant="outline" className="border-emerald-500/40 text-emerald-300" disabled={busy} onClick={() => setConfirmResume(true)}><Play className="me-1 h-3.5 w-3.5" /> تشغيل</Button>
          ) : (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmStop(true)}><OctagonX className="me-1 h-3.5 w-3.5" /> إيقاف طوارئ</Button>
          )}
        </div>
      </div>

      {/* شريط الفريشن + تعريف المزرعة الصادق */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
        <span>آخر تحديث: <b className="text-foreground">{ago(updated.toISOString())}</b></span>
        <span>الفارم: <b className="text-foreground">{cap?.farm ? `${cap.farm.browserInstances} متصفح كروم · ${cap.farm.serpWorkers} SERP · ${cap.farm.httpWorkers} HTTP · ${cap.farm.flaresolverrInstances} FlareSolverr` : "—"}</b> (مش كل العمال متصفحات)</span>
        <span>آخر نبضة ناجحة: <b className="text-foreground">{ago(stop?.metrics?.lastSuccessfulTick ?? health?.system?.lastSuccessfulTick)}</b></span>
        {stop?.stopMeta?.stoppedAt && <span>أوقفة: <b className="text-foreground">{stop.stopMeta.stoppedBy} · {ago(stop.stopMeta.stoppedAt)} · {stop.stopMeta.reason}</b></span>}
        {stop?.stopMeta?.resumedAt && <span>استئنت: <b className="text-foreground">{stop.stopMeta.resumedBy} · {ago(stop.stopMeta.resumedAt)}</b></span>}
      </div>

      {/* أعلى التنبيهات */}
      {alerts.length > 0 && (
        <div className="space-y-1">
          {alerts.slice(0, 3).map((a, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-1.5 text-xs">
              <Badge variant="outline" className={a.level === "CRITICAL" ? "border-rose-500/40 text-rose-300" : a.level === "HIGH" ? "border-amber-500/40 text-amber-300" : "border-sky-500/40 text-sky-300"}>{a.level}</Badge>
              <span>{a.text}</span>
            </div>
          ))}
        </div>
      )}

      <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><OctagonX className="h-5 w-5 text-rose-400" /> إيقاف طوارئ للنظام؟</DialogTitle>
            <DialogDescription>
              هيكتب ملف <code>.github/STOP</code> — كل السلاسل الستة هتتوقف (بداية/أثناء اللوب/قبل أي dispatch)، ومفيش جيل جديد هيطلع. الجوب الآمنة الشغالة هتكمل وتخرج. للتشغيل تاني اضغط «تشغيل» بعد كده.
            </DialogDescription>
          </DialogHeader>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            placeholder="السبب (اختياري) — يُسجل في التدقيق"
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>إلغاء</Button>
            <Button variant="destructive" disabled={busy} onClick={doStop}>تأكيد الإيقاف</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmResume} onOpenChange={setConfirmResume}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Play className="h-5 w-5 text-emerald-400" /> تشغيل النظام من جديد؟</DialogTitle>
            <DialogDescription>
              هيتشال ملف STOP (بتأكيد قراءة) ويتولّد جيل واحد لكل سلسلة عبر بوابة السعة — بدون عاصفة dispatch ولا تكرار. السلاسل المؤجلة هتُحيا بأول نبضة.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmResume(false)}>إلغاء</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={doResume}>تأكيد التشغيل</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
