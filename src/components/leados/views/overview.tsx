"use client";
// LeadOS — Overview dashboard (doc §48.1)
import { useApi, apiSend, fmtNum, timeAgo, ScoreBadge, TempBadge, StatusBadge, SourceBadge, LoadingBlock, EmptyState, type ViewKey } from "../shared"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useToast } from "@/hooks/use-toast"
import { CommandBar } from "./command-bar"
import { Flame, UserPlus, FlaskConical, Bell, CheckSquare, Radio, Flame as FlameIcon, Activity, Zap } from "lucide-react"
import { SkillsBrainCard } from "./skills-card"

interface OverviewData {
  kpis: { hotLeads: number; newLeads: number; runningResearch: number; unreadAlerts: number; dueTasks: number; activeSources: number; totalLeads: number; activeJobs: number }
  topLeads: Array<{ id: string; score: number; temperature: string; status: string; summary: string | null; business: { name: string; city: string; industry: string } | null }>
  recentAlerts: Array<{ id: string; title: string; message: string; severity: string; isRead: boolean; createdAt: string }>
  sources: Array<{ id: string; name: string; type: string; status: string; lastRunAt: string | null; lastError: string | null }>
  recentJobs: Array<{ id: string; type: string; status: string; createdAt: string; result: { message?: string } | null }>
  upcomingTasks: Array<{ id: string; title: string; dueAt: string | null; lead: { business: { name: string } | null } | null }>
}

interface KpiCardProps {
  title: string; value: number; icon: React.ReactNode; tone: string; onClick?: () => void
}
function KpiCard({ title, value, icon, tone, onClick }: KpiCardProps) {
  return (
    <Card
      className={`cursor-pointer border-border/70 transition-transform hover:-translate-y-0.5 ${onClick ? "" : "pointer-events-none"}`}
      onClick={onClick}
    >
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${tone}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-extrabold leading-none">{fmtNum(value)}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{title}</p>
        </div>
      </CardContent>
    </Card>
  )
}

export function OverviewView({ panel, onOpenLead, onGoTo }: { panel: string; onOpenLead: (id: string) => void; onGoTo: (v: ViewKey) => void }) {
  const { data, loading, error, refresh } = useApi<OverviewData>(`/api/overview?panel=${panel}`, [], 30_000)
  const { toast } = useToast()

  const markAllRead = async () => {
    await apiSend("/api/alerts", "PATCH").catch(() => undefined)
    refresh()
  }

  if (loading && !data) return <LoadingBlock />
  if (error) return <EmptyState title="تعذر تحميل البيانات" hint={error} />
  if (!data) return null

  const k = data.kpis

  return (
    <div className="space-y-5">
      {/* شريط القيادة المركزي — SYSTEM/QUEUE/AI/SEARCH/FARM/RADAR/ZIZO */}
      <CommandBar onGoTo={onGoTo} />
      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Leads ساخنة 🔥" value={k.hotLeads} tone="border-rose-500/30 bg-rose-500/10" icon={<Flame className="h-5 w-5 text-rose-400" />} onClick={() => onGoTo("leads")} />
        <KpiCard title="جدد لم يتم التواصل" value={k.newLeads} tone="border-amber-500/30 bg-amber-500/10" icon={<UserPlus className="h-5 w-5 text-amber-400" />} onClick={() => onGoTo("leads")} />
        <KpiCard title="أبحاث عميقة جارية" value={k.runningResearch} tone="border-violet-500/30 bg-violet-500/10" icon={<FlaskConical className="h-5 w-5 text-violet-400" />} onClick={() => onGoTo("research")} />
        <KpiCard title="تنبيهات غير مقروءة" value={k.unreadAlerts} tone="border-sky-500/30 bg-sky-500/10" icon={<Bell className="h-5 w-5 text-sky-400" />} onClick={() => onGoTo("tasks")} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="مهام مستحقة" value={k.dueTasks} tone="border-primary/30 bg-primary/10" icon={<CheckSquare className="h-5 w-5 text-primary" />} onClick={() => onGoTo("tasks")} />
        <KpiCard title="مصادر نشطة" value={k.activeSources} tone="border-emerald-500/30 bg-emerald-500/10" icon={<Radio className="h-5 w-5 text-emerald-400" />} onClick={() => onGoTo("sources")} />
        <KpiCard title="إجمالي الـLeads" value={k.totalLeads} tone="border-teal-500/30 bg-teal-500/10" icon={<Activity className="h-5 w-5 text-teal-400" />} onClick={() => onGoTo("analytics")} />
        <KpiCard title="وظائف في الطابور" value={k.activeJobs} tone="border-indigo-500/30 bg-indigo-500/10" icon={<Zap className="h-5 w-5 text-indigo-400" />} onClick={() => onGoTo("research")} />
      </div>

      {/* عقل المهارات — التعلم والانتقاء الحي */}
      <SkillsBrainCard />

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Top leads */}
        <Card className="border-border/70 xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <FlameIcon className="h-4 w-4 text-rose-400" />
              أعلى الـLeads حاليًا
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onGoTo("leads")}>عرض الكل</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.topLeads.length === 0 && <EmptyState title="لا توجد Leads بعد" hint="شغّل دورة اكتشاف من الزر بالأعلى أو أضف قاعدة بحث" />}
            {data.topLeads.map((l) => (
              <button
                key={l.id}
                onClick={() => onOpenLead(l.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card p-3 text-start transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <ScoreBadge score={l.score} className="text-sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{l.business?.name ?? "بدون اسم"}</p>
                  <p className="truncate text-xs text-muted-foreground">{l.business?.city} • {l.business?.industry}</p>
                </div>
                <div className="hidden sm:block"><TempBadge temp={l.temperature} /></div>
                <StatusBadge status={l.status} />
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Alerts */}
        <Card className="border-border/70">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">التنبيهات</CardTitle>
            <Button variant="ghost" size="sm" onClick={markAllRead}>تعليم الكل كمقروء</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.recentAlerts.length === 0 && <EmptyState title="لا توجد تنبيهات" />}
            {data.recentAlerts.map((a) => (
              <div key={a.id} className={`rounded-xl border p-3 ${a.isRead ? "border-border/50 opacity-60" : "border-amber-500/30 bg-amber-500/5"}`}>
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${a.severity === "CRITICAL" ? "bg-rose-400" : a.severity === "WARNING" ? "bg-amber-400" : "bg-sky-400"}`} />
                  <p className="text-sm font-bold">{a.title}</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{a.message}</p>
                <p className="mt-1 text-[10px] text-muted-foreground/70">{timeAgo(a.createdAt)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Source health */}
        <Card className="border-border/70">
          <CardHeader className="pb-2"><CardTitle className="text-base">صحة المصادر</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {data.sources.map((s) => (
              <div key={s.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold">{s.name}</p>
                    <div className="mt-0.5"><SourceBadge type={s.type} /></div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    s.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-300" :
                    s.status === "PAUSED" ? "bg-amber-500/15 text-amber-300" :
                    s.status === "ERROR" ? "bg-rose-500/15 text-rose-300" : "bg-slate-500/15 text-slate-400"
                  }`}>
                    {s.status === "ACTIVE" ? "سليم" : s.status === "PAUSED" ? "موقوف" : s.status === "ERROR" ? "خطأ" : "معطل"}
                  </span>
                </div>
                <Progress value={s.status === "ACTIVE" ? 100 : s.status === "PAUSED" ? 50 : 15} className="h-1" />
                <p className="text-[10px] text-muted-foreground/70">آخر تشغيل: {timeAgo(s.lastRunAt)}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Jobs */}
        <Card className="border-border/70">
          <CardHeader className="pb-2"><CardTitle className="text-base">آخر الوظائف (Workers)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.recentJobs.map((j) => (
              <div key={j.id} className="rounded-lg border border-border/50 bg-secondary/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold">{j.type === "DISCOVERY" ? "اكتشاف" : j.type === "DEEP_RESEARCH" ? "بحث عميق" : j.type}</span>
                  <span className={`text-[10px] font-bold ${
                    j.status === "SUCCESS" ? "text-emerald-300" : j.status === "RUNNING" ? "text-sky-300" : j.status === "FAILED" ? "text-rose-300" : "text-amber-300"
                  }`}>
                    {j.status === "SUCCESS" ? "نجح" : j.status === "RUNNING" ? "جارٍ" : j.status === "FAILED" ? "فشل" : "في الطابور"}
                  </span>
                </div>
                {j.result?.message && <p dir="ltr" className="mt-1 truncate text-[10px] text-muted-foreground">{j.result.message}</p>}
                <p className="text-[10px] text-muted-foreground/70">{timeAgo(j.createdAt)}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Tasks */}
        <Card className="border-border/70">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">مهام قادمة</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onGoTo("tasks")}>الكل</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.upcomingTasks.length === 0 && <EmptyState title="لا مهام مستحقة 🎉" />}
            {data.upcomingTasks.map((t) => (
              <div key={t.id} className="rounded-lg border border-border/50 bg-secondary/30 p-2.5">
                <p className="text-xs font-bold">{t.title}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t.lead?.business?.name ?? "—"} • مستحقة {timeAgo(t.dueAt)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
