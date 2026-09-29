"use client";
// LeadOS — مركز المهارات: CORE + WORKSPACE + GITSKILLS + CLAWHUB في مكان واحد
// للـWORKSPACE: إضافة/تفعيل/تعطيل/استبدال/حذف — كلها بعد بوابة الثقة (لا تنفيذ كود أبدًا)
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { apiGet, apiSend } from "../shared"

interface CoreSkill { platform: string; name: string; description: string; runs: number; leads: number; wins: number; weight: number; lastLeadAt: string | null }
interface GitSkill { name: string; repo: string; description: string; tags: string; relevance: number; weight: number; useCount: number; leadCount: number }
interface WsSkill { id: string; name: string; description: string; tags: string; status: string; sourceRef: string; license: string; version: number; trustScore: number; rejectReason: string | null; weight: number; useCount: number; leadCount: number; runs: number; avgQuality: number | null; bodyPreview: string; bodyLength: number; activatedAt: string | null }
interface SkillsData { skills: CoreSkill[]; git: { total: number; lastHarvestAt: string | null; top: GitSkill[] } }

export function SkillsView() {
  const [data, setData] = useState<SkillsData | null>(null)
  const [ws, setWs] = useState<WsSkill[]>([])
  const [q, setQ] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [inspect, setInspect] = useState<WsSkill | null>(null)
  const [form, setForm] = useState({ name: "", description: "", body: "", tags: "", license: "" })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = async () => {
    apiGet<SkillsData>("/api/skills").then(setData).catch(() => undefined)
    apiGet<{ skills: WsSkill[] }>("/api/skills/workspace").then((d) => setWs(d.skills)).catch(() => undefined)
  }
  useEffect(() => { load() }, [])

  const filt = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase())

  const addSkill = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await apiSend<{ ok: boolean; status: string; trust: { score: number; verdict: string; reasons: string[] } }>("/api/skills/workspace", "POST", form)
      setMsg(r.status === "ACTIVE" ? `✅ اتخزنت واتفعلت — ثقة ${r.trust.score}/100` : `❌ بوابة الثقة رفضت (ثقة ${r.trust.score}): ${r.trust.reasons.join(" | ")}`)
      setForm({ name: "", description: "", body: "", tags: "", license: "" })
      await load()
    } catch (e) {
      setMsg(`خطأ: ${e instanceof Error ? e.message.slice(0, 120) : "غير معروف"}`)
    } finally { setBusy(false) }
  }

  const act = async (id: string, action: "activate" | "deactivate" | "replace", body?: string) => {
    setBusy(true); setMsg(null)
    try {
      const r = await apiSend<{ ok: boolean; error?: string; trust?: { score: number; reasons?: string[] } }>(`/api/skills/workspace/${id}`, "PATCH", { action, body })
      setMsg(r.ok ? `✅ ${action} تم` : `❌ ${r.error ?? "فشل"}${r.trust?.reasons?.length ? `: ${r.trust.reasons.join(" | ")}` : ""}`)
      await load()
    } catch (e) { setMsg(`خطأ: ${e instanceof Error ? e.message.slice(0, 120) : "غير معروف"}`) }
    finally { setBusy(false) }
  }

  const del = async (id: string) => {
    setBusy(true)
    await apiSend(`/api/skills/workspace/${id}`, "DELETE").catch(() => undefined)
    await load()
    setBusy(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input dir="rtl" placeholder="بحث في كل الطبقات…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Button size="sm" onClick={() => setAddOpen(true)}>+ إضافة مهارة ورشة</Button>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </div>

      <Tabs defaultValue="core">
        <TabsList>
          <TabsTrigger value="core">CORE ({data?.skills.filter((s) => filt(s.name + s.description)).length ?? "…"})</TabsTrigger>
          <TabsTrigger value="workspace">WORKSPACE ({ws.filter((s) => filt(s.name)).length})</TabsTrigger>
          <TabsTrigger value="gitskills">GITSKILLS ({data?.git.total ?? "…"})</TabsTrigger>
          <TabsTrigger value="clawhub">CLAWHUB</TabsTrigger>
        </TabsList>

        {/* ═══ CORE ═══ */}
        <TabsContent value="core" className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {data?.skills.filter((s) => filt(s.name + s.description)).map((s) => (
            <Card key={s.platform}><CardContent className="p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-extrabold">{s.name}</p>
                <Badge variant="outline" className="text-[9px]">وزن {s.weight.toFixed(2)}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{s.description}</p>
              <div className="mt-2 flex gap-3 text-[10px] text-muted-foreground">
                <span>تشغيلات: {s.runs}</span><span>ليدز: {s.leads}</span><span>فوز: {s.wins}</span>
              </div>
            </CardContent></Card>
          ))}
        </TabsContent>

        {/* ═══ WORKSPACE ═══ */}
        <TabsContent value="workspace" className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {ws.filter((s) => filt(s.name + s.description)).map((s) => (
            <Card key={s.id}><CardContent className="p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-extrabold">{s.name}</p>
                <Badge className={s.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-300" : s.status === "REJECTED" ? "bg-rose-500/15 text-rose-300" : "bg-secondary text-secondary-foreground"}>{s.status}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{s.description || "بدون وصف"}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <span>ثقة {s.trustScore}/100</span><span>v{s.version}</span><span>وزن {s.weight.toFixed(2)}</span>
                <span>استخدام {s.useCount}</span><span>ليدز {s.leadCount}</span>
                {s.license && <span>رخصة {s.license}</span>}
              </div>
              {s.rejectReason && <p className="mt-1 text-[10px] text-rose-400">سبب الرفض: {s.rejectReason.slice(0, 120)}</p>}
              <div className="mt-2 flex flex-wrap gap-1">
                <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => setInspect(s)}>فحص</Button>
                {s.status !== "ACTIVE" && <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={() => act(s.id, "activate")}>تفعيل</Button>}
                {s.status === "ACTIVE" && <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={() => act(s.id, "deactivate")}>تعطيل</Button>}
                <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={busy} onClick={() => { const nb = prompt("المحتوى الجديد (80 حرف على الأقل):"); if (nb) act(s.id, "replace", nb) }}>استبدال</Button>
                <Button size="sm" variant="outline" className="h-6 text-[10px] text-rose-400" disabled={busy} onClick={() => del(s.id)}>حذف</Button>
              </div>
            </CardContent></Card>
          ))}
          {!ws.length && <p className="text-xs text-muted-foreground">مفيش مهارات ورشة — أضف أول واحدة ب الزر فوق (بتعدّي بوابة الثقة الكاملة).</p>}
        </TabsContent>

        {/* ═══ GITSKILLS ═══ */}
        <TabsContent value="gitskills">
          <Card><CardHeader className="pb-2">
            <CardTitle className="text-sm">المكتبة العالمية — المحصود منها {data?.git.total ?? 0} مهارة · آخر حصاد {data?.git.lastHarvestAt ? new Date(data.git.lastHarvestAt).toLocaleString("ar-EG") : "—"}</CardTitle>
          </CardHeader>
            <CardContent className="max-h-[60vh] space-y-2 overflow-y-auto">
              {data?.git.top.filter((s) => filt(s.name + s.description + s.tags)).map((s, i) => (
                <div key={i} className="rounded-lg border border-border/60 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-bold">{s.name}</p>
                    <Badge variant="outline" className="text-[9px]">وزن {s.weight.toFixed(2)}</Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{s.description}</p>
                  <p className="text-[9px] text-muted-foreground" dir="ltr">{s.repo}</p>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">أعلى {data?.git.top.length ?? 0} بالوزن من مكتبة 3.8M مهارة — الاسترجاع بيختار منها لحظة الحاجة (JUST IN TIME).</p>
            </CardContent></Card>
        </TabsContent>

        {/* ═══ CLAWHUB ═══ */}
        <TabsContent value="clawhub">
          <Card><CardContent className="p-4 text-sm text-muted-foreground">
            <p className="font-bold text-foreground">ClawHub (clawhub.ai) — المكتبة المنسّقة</p>
            <p className="mt-2">الحصاد تلقائي كل 6 ساعات في النبضة (جوب CLAWHUB_HARVEST) — كل مهارة بتعدي بوابة أمان «تعليمات فقط» (isSuspicious + 9 أنماط خبيثة) قبل التخزين.</p>
            <p className="mt-2">الطبوءة الباقية في أرقام الجوبات: شاشة الطابور → فلتر CLAWHUB_HARVEST، وفي السجلات → outcome.</p>
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      {/* ═══ إضافة مهارة ورشة ═══ */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl" dir="rtl">
          <DialogHeader><DialogTitle>مهارة ورشة جديدة — تمر بوابة الثقة قبل التخزين</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Input placeholder="اسم المهارة" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="وصف قصير" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <Textarea placeholder="المحتوى — تعليمات واستراتيجية فقط (80 حرف على الأقل). ممنوع: كود تنفيذ، curl، أسرار — البوابة هترفضه" rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            <div className="flex gap-2">
              <Input placeholder="كلمات مفتاحية (فاصلة)" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              <Input placeholder="الرخصة (MIT…)" value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} />
            </div>
            <Button className="w-full" onClick={addSkill} disabled={busy || form.name.length < 3 || form.body.length < 80}>{busy ? "جارٍ الفحص…" : "خزّن بعد بوابة الثقة"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══ فحص مهارة ═══ */}
      <Dialog open={Boolean(inspect)} onOpenChange={(o) => !o && setInspect(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl" dir="rtl">
          <DialogHeader><DialogTitle>{inspect?.name} — فحص كامل</DialogTitle></DialogHeader>
          {inspect && (
            <div className="space-y-2 text-xs">
              <p><span className="text-muted-foreground">الحالة:</span> {inspect.status} · <span className="text-muted-foreground">الثقة:</span> {inspect.trustScore}/100 · <span className="text-muted-foreground">الإصدار:</span> {inspect.version}</p>
              <p><span className="text-muted-foreground">المصدر:</span> {inspect.sourceRef} · <span className="text-muted-foreground">بصمة المحتوى:</span> <code dir="ltr">{inspect.id ? "sha256…" : ""}</code></p>
              <p><span className="text-muted-foreground">الاستخدام الحقيقي:</span> {inspect.runs} تشغيل · متوسط جودة {inspect.avgQuality ?? "—"}</p>
              <p className="whitespace-pre-wrap rounded-lg bg-secondary/50 p-2 leading-6">{inspect.bodyPreview}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
