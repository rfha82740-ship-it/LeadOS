"use client";
// LeadOS — مركز الصحة (System Health Center): Vercel/Neon/GitHub/AI/بحث — أرقام حية من /api/health
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { apiGet } from "../shared"

interface HealthData {
  system: { state: string; stopFile: { status: string }; lastSuccessfulTick: string | null; lastIngest: string | null; processUptimeDays: number; vercel: { region: string; env: string } }
  neon: { connected: boolean; latencyMs: number; error: string | null; jobs: Record<string, number>; jobBacklog: number; staleLocks: number }
  ai: { providers: Record<string, { active?: boolean; keys?: { total: number; live: number; dead: number; cooling: number }; lastSuccess?: string | null; avgLatencyMs?: number; note?: string }>; note: string; totalRuns: Record<string, number> }
  search: { recentJobs: number; adapterUsage: Record<string, number>; lastSearchAt: string | null; lastResultCount: number | null }
}

function ok(v: boolean | null): "GOOD" | "BAD" | "UNKNOWN" { return v === null ? "UNKNOWN" : v ? "GOOD" : "BAD" }
function Dot({ s }: { s: "GOOD" | "BAD" | "UNKNOWN" }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${s === "GOOD" ? "bg-emerald-500" : s === "BAD" ? "bg-rose-500" : "bg-muted-foreground/50"}`} />
}
function fmt(d: string | null | undefined): string {
  if (!d) return "—"
  const diff = (Date.now() - new Date(d).getTime()) / 1000
  if (diff < 60) return `قبل ${Math.max(1, Math.round(diff))} ثانية`
  if (diff < 3600) return `قبل ${Math.round(diff / 60)} دقيقة`
  if (diff < 86400) return `قبل ${Math.round(diff / 3600)} ساعة`
  return `قبل ${Math.round(diff / 86400)} يوم`
}

export function HealthView() {
  const [d, setD] = useState<HealthData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const load = () => apiGet<HealthData>("/api/health").then(setD).catch((e) => setErr(String(e)))
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  if (err) return <p className="text-sm text-rose-400">فشل تحميل مركز الصحة: {err}</p>
  if (!d) return <p className="text-sm text-muted-foreground">جارٍ فحص النظام…</p>

  const jobChips = (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(d.neon.jobs).map(([k, v]) => (
        <Badge key={k} variant="outline" className="text-[10px]">{k}: {v}</Badge>
      ))}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* ═══ الحالة العامة ═══ */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">حالة النظام</p>
          <p className="mt-1 text-2xl font-extrabold">{d.system.state}</p>
          <p className="text-[11px] text-muted-foreground">STOP file: {d.system.stopFile.status}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">آخر نبضة ناجحة</p>
          <p className="mt-1 text-lg font-bold">{fmt(d.system.lastSuccessfulTick)}</p>
          <p className="text-[11px] text-muted-foreground">آخر ابتلاع: {fmt(d.system.lastIngest)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Vercel</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-bold"><Dot s={ok(true)} /> حية</p>
          <p className="text-[11px] text-muted-foreground">region: {d.system.vercel.region} · {d.system.vercel.env}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Neon (Postgres)</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-bold">
            <Dot s={ok(d.neon.connected)} /> {d.neon.connected ? `${d.neon.latencyMs}ms` : "منقطع"}
          </p>
          <p className="text-[11px] text-muted-foreground">طابور: {d.neon.jobBacklog} · قوافل عالقة: {d.neon.staleLocks}</p>
        </CardContent></Card>
      </div>

      {d.neon.error && <p className="text-xs text-rose-400">خطأ قاعدة البيانات: {d.neon.error}</p>}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ═══ الجوبات ═══ */}
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">الطابور (Job)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {jobChips}
            <p className="text-[11px] text-muted-foreground">
              الجوبات العالقة (&gt;20 دقيقة) بتترجع تلقائيًا QUEUED في كل نبضة — وإيدويًا من شاشة الطابور.
            </p>
          </CardContent>
        </Card>

        {/* ═══ AI providers ═══ */}
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">مزودو AI</CardTitle></CardHeader>
          <CardContent className="space-y-2.5">
            {Object.entries(d.ai.providers).map(([name, p]) => (
              <div key={name} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2">
                <div className="flex items-center gap-2">
                  <Dot s={ok(p.active ?? null)} />
                  <span className="text-sm font-bold">{name}</span>
                  {p.keys && <span className="text-[10px] text-muted-foreground">مفاتيح: {p.keys.live}/{p.keys.total} حية · {p.keys.dead} ميتة · {p.keys.cooling} مبردة</span>}
                </div>
                <div className="text-left text-[10px] text-muted-foreground">
                  <p>آخر نجاح: {fmt(p.lastSuccess)}</p>
                  {p.avgLatencyMs ? <p>متوسط الاستجابة: {p.avgLatencyMs}ms</p> : null}
                </div>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">{d.ai.note}</p>
          </CardContent>
        </Card>

        {/* ═══ البحث ═══ */}
        <Card className="lg:col-span-2"><CardHeader className="pb-2"><CardTitle className="text-sm">مزودو البحث (آخر 20 جوب بحث)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(d.search.adapterUsage).length
                ? Object.entries(d.search.adapterUsage).sort((a, b) => b[1] - a[1]).map(([a, n]) => (
                  <Badge key={a} variant="outline" className="text-[10px]">{a}: {n} جوب</Badge>
                ))
                : <p className="text-xs text-muted-foreground">مفيش جوبات بحث حديثة</p>}
            </div>
            <p className="text-[11px] text-muted-foreground">آخر بحث: {fmt(d.search.lastSearchAt)} · نتايجه: {d.search.lastResultCount ?? "—"}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
