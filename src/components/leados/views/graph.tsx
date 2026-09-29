"use client";
// LeadOS — شاشة خرايط التفكير (TaskGraph / DSI): عرض حقيقي للعقد + «ليه اختار النظام المهارة دي؟»
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { apiGet, apiSend } from "../shared"

interface GraphRow { id: string; goal: string; status: string; trigger: string; createdAt: string; stats: { builtBy?: string; replans?: number } | null; finalResult: Record<string, unknown> | null }
interface NodeRow { nodeId: string; type: string; objective: string; status: string; outcome: string | null; attempts: number; skills: string[]; deps: string[]; failureReason?: string | null }
interface GraphDetail {
  graph: { id: string; goal: string; status: string; builtBy?: string; facts: Record<string, unknown>; finalResult: Record<string, unknown> | null; assumptions: string[] }
  nodes: NodeRow[]
  awareness: { whatAmIDoing: string; whyAmIDoingIt: string; currentSkill: { name: string; kind: string; why: string } | null; evidenceSummary: string; blocking: string | null; whatIsNext: string; progress: { done: number; failed: number; pending: number; total: number } }
}
interface RetrievalRow { id: string; at: string; objective: string; reason: string | null; nodeId: string | null; selected: Array<{ name?: string; kind?: string; key?: string; score?: number | null; reason?: string }> | null; rejected: Array<{ name?: string; kind?: string; reason?: string }> | null }

const STATUS_COLOR: Record<string, string> = {
  DONE: "bg-emerald-500/15 text-emerald-300", FAILED: "bg-rose-500/15 text-rose-300",
  RUNNING: "bg-sky-500/15 text-sky-300", PENDING: "bg-secondary text-secondary-foreground",
  SKIPPED: "bg-muted text-muted-foreground", BLOCKED: "bg-amber-500/15 text-amber-300",
}

export function GraphView() {
  const [graphs, setGraphs] = useState<GraphRow[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [det, setDet] = useState<GraphDetail | null>(null)
  const [why, setWhy] = useState<{ open: boolean; rows: RetrievalRow[]; node?: NodeRow }>({ open: false, rows: [] })
  const [busy, setBusy] = useState(false)

  const load = () => apiGet<{ graphs: GraphRow[] }>("/api/graph").then((d) => setGraphs(d.graphs)).catch(() => undefined)
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [])
  useEffect(() => {
    if (!sel) { setDet(null); return }
    apiGet<GraphDetail>(`/api/graph?id=${sel}`).then(setDet).catch(() => undefined)
  }, [sel])

  const openWhy = async (node: NodeRow) => {
    setBusy(true)
    try {
      const rows = await apiGet<{ rows: RetrievalRow[] }>(`/api/logs?type=retrieval&take=60`)
      const mine = (rows.rows ?? []).filter((r) => r.nodeId === node.nodeId).slice(0, 3)
      setWhy({ open: true, rows: mine.length ? mine : (rows.rows ?? []).slice(0, 3), node })
    } finally { setBusy(false) }
  }

  const [goalText, setGoalText] = useState("")
  const newGraph = async () => {
    if (goalText.trim().length < 5) return
    setBusy(true)
    try {
      const r = await apiSend<{ graphId: string }>("/api/graph", "POST", { objective: goalText.trim() })
      setGoalText("")
      await load()
      setSel(r.graphId)
    } catch {
      // رسالة الخطأ بترجع من الـAPI
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-[340px_1fr]">
        {/* ═══ قائمة الخرايط ═══ */}
        <Card className="self-start"><CardHeader className="pb-2"><CardTitle className="text-sm">آخر الخرايط</CardTitle></CardHeader>
          <CardContent className="max-h-[70vh] space-y-1.5 overflow-y-auto">
            {graphs.map((g) => (
              <button key={g.id} onClick={() => setSel(g.id)}
                className={`w-full rounded-lg border p-2 text-right transition-colors ${sel === g.id ? "border-primary bg-primary/10" : "border-border/60 hover:bg-secondary/50"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-bold">{g.goal.slice(0, 46)}</span>
                  <Badge variant="outline" className="shrink-0 text-[9px]">{g.status}</Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">{g.trigger} · بنيت بـ{g.stats?.builtBy ?? "TEMPLATE"} · إعادة تخطيط {g.stats?.replans ?? 0}</p>
              </button>
            ))}
            {!graphs.length && <p className="text-xs text-muted-foreground">مفيش خرايط — انطلق واحدة من زر «خريطة جديدة» أو الأيجنت</p>}
          </CardContent>
        </Card>

        {/* ═══ تفاصيل الخريطة المختارة ═══ */}
        <div className="space-y-3">
          {!sel && <Card><CardContent className="p-6 text-sm text-muted-foreground">اختار خريطة من القائمة لعرض عقدتها بأدلتها ومهاراتها.</CardContent></Card>}
          {sel && !det && <Card><CardContent className="p-6 text-sm text-muted-foreground">جارٍ تحميل الخريطة…</CardContent></Card>}
          {det && (
            <>
              <Card><CardContent className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-extrabold">{det.graph.goal}</p>
                    <p className="text-[11px] text-muted-foreground">{det.awareness.whyAmIDoingIt}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{det.graph.status}</Badge>
                  </div>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <input
                    value={goalText}
                    onChange={(e) => setGoalText(e.target.value)}
                    placeholder="هدف خريطة جديدة… مثال: صيد مطاعم محتاجة نظام طلبات في الجيزة"
                    className="w-full rounded-lg border border-input bg-card px-3 py-1.5 text-xs"
                  />
                  <Button size="sm" onClick={newGraph} disabled={busy || goalText.trim().length < 5}>انطلق</Button>
                </div>
                <p className="mt-2 text-xs"><span className="text-muted-foreground">بعمل إيه دلوقتي:</span> {det.awareness.whatAmIDoing}</p>
                <p className="text-xs"><span className="text-muted-foreground">الأدلة:</span> {det.awareness.evidenceSummary}</p>
                <p className="text-xs"><span className="text-muted-foreground">التالي:</span> {det.awareness.whatIsNext}</p>
                {det.awareness.blocking && <p className="text-xs text-amber-400">{det.awareness.blocking}</p>}
              </CardContent></Card>

              <Card><CardHeader className="pb-2"><CardTitle className="text-sm">العقد ({det.nodes.length}) — اضغط «ليه المهارات دي؟» لأي عقدة</CardTitle></CardHeader>
                <CardContent className="max-h-[55vh] space-y-2 overflow-y-auto">
                  {det.nodes.map((n) => (
                    <div key={n.nodeId} className="rounded-lg border border-border/60 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={STATUS_COLOR[n.status] ?? "bg-secondary"}>{n.status}</Badge>
                        <span className="text-xs font-extrabold">{n.type}</span>
                        <span className="text-[10px] text-muted-foreground">#{n.nodeId} · محاولات {n.attempts}</span>
                        <Button size="sm" variant="ghost" className="ms-auto h-6 gap-1 text-[10px]" disabled={busy} onClick={() => openWhy(n)}>
                          ليه المهارات دي؟
                        </Button>
                      </div>
                      <p className="mt-1 text-xs">{n.objective}</p>
                      {n.outcome && <p className="text-[10px] text-muted-foreground">النتيجة: {n.outcome}{n.failureReason ? ` — ${n.failureReason.slice(0, 100)}` : ""}</p>}
                      {n.skills.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {n.skills.map((s) => <Badge key={s} variant="outline" className="text-[9px]">{s}</Badge>)}
                        </div>
                      )}
                      {n.deps.length > 0 && <p className="text-[9px] text-muted-foreground">اعتمادات: {n.deps.join("، ")}</p>}
                    </div>
                  ))}
                </CardContent></Card>
            </>
          )}
        </div>
      </div>

      {/* ═══ «ليه اختار النظام هذه المهارة؟» — منشأ كامل: مرشحون/مختارون/مرفوضون/درجات ═══ */}
      <Dialog open={why.open} onOpenChange={(o) => setWhy((s) => ({ ...s, open: o }))}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>ليه اختار النظام هذه المهارة؟ {why.node ? `— عقدة ${why.node.type} (${why.node.nodeId})` : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {why.rows.length === 0 && <p className="text-muted-foreground">مفيش سجل استرجاع محفوظ للعقدة دي (العقدة ممكن تكون اشتغلت بالقدرات الأساسية).</p>}
            {why.rows.map((r) => (
              <div key={r.id} className="space-y-1.5 rounded-lg border border-border/60 p-2.5">
                <p className="text-xs font-bold">{r.objective.slice(0, 100)}</p>
                {r.reason && <p className="text-[11px] text-muted-foreground">الحكم: {r.reason}</p>}
                {r.selected?.length ? (
                  <div>
                    <p className="text-[11px] font-bold text-emerald-300">المختار:</p>
                    {r.selected.map((s, i) => (
                      <p key={i} className="text-[11px]">✅ [{s.kind}] {s.name ?? s.key} — درجة {s.score ?? "—"}{s.reason ? ` · ${s.reason}` : ""}</p>
                    ))}
                  </div>
                ) : <p className="text-[11px] text-muted-foreground">NO NEED → NO SKILL — مفيش مهارة عدّت حد الصلة/الثقة</p>}
                {r.rejected?.length ? (
                  <div>
                    <p className="text-[11px] font-bold text-rose-300">المرفوض وأسبابه:</p>
                    {r.rejected.slice(0, 5).map((s, i) => (
                      <p key={i} className="text-[11px]">❌ [{s.kind}] {s.name} — {s.reason}</p>
                    ))}
                  </div>
                ) : null}
                <p className="text-[9px] text-muted-foreground">{new Date(r.at).toLocaleString("ar-EG")}</p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
