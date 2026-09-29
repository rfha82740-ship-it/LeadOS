"use client";
// LeadOS — App shell: لوحتين (كروت/أجنسي) + sidebar + topbar + view switching (SPA within /)
import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { apiGet, apiSend, type ViewKey, type Me } from "./shared"
import { OverviewView } from "./views/overview"
import { FeedView } from "./views/feed"
import { LeadsView } from "./views/leads"
import { LeadProfileView } from "./views/lead-profile"
import { PipelineView } from "./views/pipeline"
import { ResearchView } from "./views/research"
import { SourcesView } from "./views/sources"
import { RulesView } from "./views/rules"
import { SequencesView } from "./views/sequences"
import { ChatView } from "./views/chat"
import { AgentView } from "./views/agent"
import { EntityView } from "./views/entity"
import { ZizoView } from "./views/zizo"
import { AnalyticsView } from "./views/analytics"
import { TasksView } from "./views/tasks"
import { SettingsView } from "./views/settings"
import { GroupsView } from "./views/groups"
import { HealthView } from "./views/health"
import { OpsView } from "./views/ops"
import { GraphView } from "./views/graph"
import { SkillsView } from "./views/skills"
import { QueueView } from "./views/queue"
import { LogsView } from "./views/logs"
import { RadarView } from "./views/radar"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import {
  LayoutDashboard, Radar, Users, KanbanSquare, FlaskConical, Database,
  SlidersHorizontal, Bot, BarChart3, CheckSquare, Settings, LogOut,
  Crosshair, Bell, RefreshCw, MessageSquareDot, Coffee, Megaphone, BrainCircuit, MessagesSquare, Repeat,
  Activity, RadioTower, Network, Wrench, ListTree, ScrollText, Target, Power,
} from "lucide-react"

const NAV: Array<{ key: ViewKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "overview", label: "نظرة عامة", icon: LayoutDashboard },
  { key: "health", label: "مركز الصحة", icon: Activity },
  { key: "ops", label: "العمليات الحية", icon: RadioTower },
  { key: "graph", label: "خرايط التفكير DSI", icon: Network },
  { key: "skills", label: "مركز المهارات", icon: Wrench },
  { key: "groups", label: "تحدي الجروبات", icon: MessageSquareDot },
  { key: "radar", label: "الرادار اللحظي", icon: Target },
  { key: "feed", label: "البث المباشر", icon: Radar },
  { key: "leads", label: "العملاء المحتملون", icon: Users },
  { key: "pipeline", label: "خط المبيعات", icon: KanbanSquare },
  { key: "research", label: "مركز الأبحاث", icon: FlaskConical },
  { key: "sources", label: "المصادر", icon: Database },
  { key: "rules", label: "قواعد البحث", icon: SlidersHorizontal },
  { key: "sequences", label: "سلاسل المتابعة", icon: Repeat },
  { key: "chat", label: "AI Commander", icon: Bot },
  { key: "agent", label: "الأيجنت الذكي", icon: Crosshair },
  { key: "entity", label: "الكيان المستقل", icon: BrainCircuit },
  { key: "zizo", label: "زيزو — كيان البيع", icon: MessagesSquare },
  { key: "queue", label: "الطابور والجوبات", icon: ListTree },
  { key: "logs", label: "السجلات والتدقيق", icon: ScrollText },
  { key: "analytics", label: "التحليلات", icon: BarChart3 },
  { key: "tasks", label: "المهام", icon: CheckSquare },
  { key: "settings", label: "الإعدادات", icon: Settings },
]

export type Panel = "CARDS" | "AGENCY"

export function AppShell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [view, setView] = useState<ViewKey>("overview")
  const [leadId, setLeadId] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)
  const [ticking, setTicking] = useState(false)
  const [panel, setPanel] = useState<Panel>("CARDS")

  // Load persisted panel
  useEffect(() => {
    const saved = window.localStorage.getItem("leados:panel")
    if (saved === "AGENCY" || saved === "CARDS") setPanel(saved)
  }, [])

  const switchPanel = (p: Panel) => {
    setPanel(p)
    setLeadId(null)
    window.localStorage.setItem("leados:panel", p)
  }

  // Poll unread alerts + system state
  const [sysState, setSysState] = useState<{ state: string; stopFile: string }>({ state: "...", stopFile: "unknown" })
  const [stopOpen, setStopOpen] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  useEffect(() => {
    let stop = false
    const load = () => {
      apiGet<{ unread: number }>("/api/alerts")
        .then((d) => { if (!stop) setUnread(d.unread) })
        .catch(() => undefined)
      apiGet<{ systemState: string; stopFile: string }>("/api/system/stop")
        .then((d) => { if (!stop) setSysState({ state: d.systemState, stopFile: d.stopFile }) })
        .catch(() => undefined)
    }
    load()
    const t = setInterval(load, 30000)
    return () => { stop = true; clearInterval(t) }
  }, [view])

  // Autonomous heartbeat: drive the discovery/research queue + group scan every 5 minutes
  // while the app is open (in-sandbox companion to external cron in production).
  useEffect(() => {
    const beat = () => {
      apiSend("/api/cron/tick?max=2", "POST").catch(() => undefined)
    }
    const t = setInterval(beat, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  const openLead = (id: string) => {
    setLeadId(id)
    setView("leads")
  }

  const runTick = async () => {
    setTicking(true)
    try {
      await apiSend("/api/cron/tick?max=3", "POST")
      // Re-navigate to refresh current view data
      setView((v) => v)
      window.dispatchEvent(new CustomEvent("leados:refresh"))
    } finally {
      setTimeout(() => setTicking(false), 800)
    }
  }

  const doStop = async (mode: "stop" | "resume") => {
    setStopBusy(true)
    try {
      await apiSend("/api/system/stop", "POST", mode === "stop" ? { confirm: "STOP", mode } : { mode })
      window.dispatchEvent(new CustomEvent("leados:refresh"))
      setSysState((s) => ({ ...s, state: mode === "stop" ? "STOPPED" : "RUNNING", stopFile: mode === "stop" ? "EXISTS" : "ABSENT" }))
    } catch {
      // الخطأ بيظهر من الـAPI نفسه — الحالة هتتحدث من الـpolling
    } finally {
      setStopBusy(false)
      setStopOpen(false)
    }
  }

  const logout = async () => {
    await apiSend("/api/auth/logout", "POST").catch(() => undefined)
    onLogout()
  }

  const panelMeta: Record<Panel, { label: string; sub: string; icon: typeof Coffee }> = {
    CARDS: { label: "نظام الكروت", sub: "كافيهات وكروت النت", icon: Coffee },
    AGENCY: { label: "الأجنسي", sub: "تسويق وميديا بينج وبرمجة", icon: Megaphone },
  }

  return (
    <div className={cn("leados-backdrop flex min-h-screen bg-background", panel === "CARDS" ? "panel-cards" : "panel-agency")} dir="rtl">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-l border-sidebar-border bg-sidebar md:flex">
        <div className="flex items-center gap-3 border-b border-sidebar-border px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/30 bg-primary/15">
            <Crosshair className="h-6 w-6 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold">LeadOS</p>
            <p className="truncate text-[11px] text-muted-foreground">{me.workspace.name}</p>
          </div>
        </div>

        <ScrollArea className="flex-1 px-3 py-3">
          <nav className="space-y-1">
            {NAV.map((item) => {
              const Icon = item.icon
              const active = view === item.key && !(item.key === "leads" && leadId)
              return (
                <button
                  key={item.key}
                  onClick={() => { if (item.key === "leads") setLeadId(null); setView(item.key) }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-primary/12 font-bold text-primary"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <Icon className="h-4.5 w-4.5 shrink-0" />
                  <span>{item.label}</span>
                  {item.key === "tasks" && unread > 0 && (
                    <span className="ms-auto rounded-full bg-rose-500/20 px-1.5 text-[10px] font-bold text-rose-300">{unread}</span>
                  )}
                </button>
              )
            })}
          </nav>
        </ScrollArea>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-sm font-bold text-secondary-foreground">
              {(me.user.name || me.user.email)[0]}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold">{me.user.name}</p>
              <p dir="ltr" className="truncate text-[10px] text-muted-foreground">{me.user.email}</p>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={logout} aria-label="تسجيل الخروج">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/80 px-4 py-2.5 backdrop-blur md:px-6">
          <div className="flex items-center gap-3">
            {/* ===== زرارين اللوحتين — أعلى الشاشة ===== */}
            <div className="flex shrink-0 items-center gap-1 rounded-xl border border-border bg-card/70 p-1" role="tablist" aria-label="تبديل اللوحات">
              {(Object.keys(panelMeta) as Panel[]).map((p) => {
                const P = panelMeta[p]
                const Icon = P.icon
                const active = panel === p
                return (
                  <button
                    key={p}
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchPanel(p)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-extrabold transition-all sm:px-3.5 sm:text-[13px]",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                    title={P.sub}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{P.label}</span>
                  </button>
                )
              })}
            </div>

            <h2 className="hidden text-sm font-bold text-muted-foreground lg:block">
              {leadId && view === "leads" ? "ملف العميل" : NAV.find((n) => n.key === view)?.label}
            </h2>

            <div className="ms-auto flex items-center gap-2">
              <span className={cn("hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold xl:flex",
                sysState.state === "RUNNING" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                sysState.state === "DEGRADED" && "border-amber-500/30 bg-amber-500/10 text-amber-300",
                sysState.state === "STOPPED" && "border-rose-500/30 bg-rose-500/10 text-rose-300",
                !["RUNNING", "DEGRADED", "STOPPED"].includes(sysState.state) && "border-muted bg-secondary text-muted-foreground")}>
                <span className={cn("h-1.5 w-1.5 rounded-full", sysState.state === "RUNNING" ? "bg-emerald-500" : sysState.state === "DEGRADED" ? "bg-amber-500" : "bg-rose-500")} />
                {sysState.state === "RUNNING" ? "النظام يعمل" : sysState.state === "DEGRADED" ? "متدهور — تحقق من النبضة" : sysState.state === "STOPPED" ? "موقوف (STOP)" : `الحالة: ${sysState.state}`}
              </span>
              {sysState.stopFile === "EXISTS" ? (
                <Button variant="outline" size="sm" className="gap-1.5 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10" onClick={() => doStop("resume")} disabled={stopBusy}>
                  <RefreshCw className={cn("h-3.5 w-3.5", stopBusy && "animate-spin")} />
                  <span className="hidden sm:inline">استئناف النظام</span>
                </Button>
              ) : (
                <Button variant="outline" size="sm" className="gap-1.5 border-rose-500/40 text-rose-300 hover:bg-rose-500/10" onClick={() => setStopOpen(true)}>
                  <Power className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">إيقاف الطوارئ</span>
                </Button>
              )}
              <Button variant="outline" size="sm" className="gap-1.5" onClick={runTick} disabled={ticking || sysState.stopFile === "EXISTS"}>
                <RefreshCw className={cn("h-3.5 w-3.5", ticking && "animate-spin")} />
                <span className="hidden sm:inline">تشغيل دورة اكتشاف</span>
              </Button>
              <Button variant="outline" size="icon" className="relative h-8 w-8" aria-label="التنبيهات" onClick={() => setView("overview")}>
                <Bell className="h-4 w-4" />
                {unread > 0 && (
                  <span className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[9px] font-bold text-white">
                    {unread}
                  </span>
                )}
              </Button>
            </div>
          </div>

          {/* Mobile nav */}
          <div className="pt-2 md:hidden">
            <select
              value={leadId && view === "leads" ? "leads" : view}
              onChange={(e) => { if (e.target.value === "leads") setLeadId(null); setView(e.target.value as ViewKey) }}
              className="w-full rounded-lg border border-input bg-card px-2 py-1.5 text-xs"
              aria-label="التنقل"
            >
              {NAV.map((n) => <option key={n.key} value={n.key}>{n.label}</option>)}
            </select>
          </div>
        </header>

        <main className="min-h-0 flex-1 p-4 md:p-6">
          {view === "overview" && <OverviewView panel={panel} onOpenLead={openLead} onGoTo={(v) => setView(v)} />}
          {view === "groups" && <GroupsView panel={panel} onOpenLead={openLead} />}
          {view === "feed" && <FeedView panel={panel} onOpenLead={openLead} />}
          {view === "leads" && (leadId
            ? <LeadProfileView leadId={leadId} onBack={() => setLeadId(null)} />
            : <LeadsView panel={panel} onOpenLead={openLead} />)}
          {view === "pipeline" && <PipelineView panel={panel} onOpenLead={openLead} />}
          {view === "research" && <ResearchView onOpenLead={openLead} />}
          {view === "sources" && <SourcesView />}
          {view === "rules" && <RulesView />}
          {view === "sequences" && <SequencesView />}
          {view === "chat" && <ChatView />}
          {view === "agent" && <AgentView onOpenLead={openLead} />}
          {view === "entity" && <EntityView />}
          {view === "zizo" && <ZizoView />}
          {view === "analytics" && <AnalyticsView />}
          {view === "tasks" && <TasksView onOpenLead={openLead} />}
          {view === "settings" && <SettingsView me={me} />}
          {view === "health" && <HealthView />}
          {view === "ops" && <OpsView />}
          {view === "graph" && <GraphView />}
          {view === "skills" && <SkillsView />}
          {view === "queue" && <QueueView />}
          {view === "logs" && <LogsView />}
          {view === "radar" && <RadarView onOpenLead={openLead} />}
        </main>
      </div>

      {/* ═══ تأكيد الإيقاف الطارئ — الإجراء أخطر شيء في النظام فالتأكيد صريح ═══ */}
      <AlertDialog open={stopOpen} onOpenChange={setStopOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-rose-400">إيقاف طارئ للنظام بالكامل؟</AlertDialogTitle>
            <AlertDialogDescription>
              هذا سينشئ ملف <code dir="ltr" className="rounded bg-secondary px-1">.github/STOP</code> في الريبو — كل السلاسل الستة (المزرعة، العامل، الإعلانات، النبضة، الجروبات، الرادار) ستتوقف عند أقرب دورة، ولن تنطلق جيل جديد.
              للاستئناف لاحقًا اضغط زر «استئناف النظام» أو احذف الملف من GitHub.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopBusy}>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700"
              disabled={stopBusy}
              onClick={(e) => { e.preventDefault(); doStop("stop") }}
            >
              {stopBusy ? "جارٍ الإيقاف…" : "نعم — أوقف كل شيء"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
