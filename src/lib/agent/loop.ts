// LeadOS — Agent Loop (العقل المنظم)
// دورة تشغيل كاملة: فهم الهدف → سرش للسرش (ذاكرة) → تخطيط استعلامات → اختيار منصات
// → صيد ليدز → حصاد بيانات تواصل → حفظ الذاكرة + الاستنتاجات → تقرير مفصل بخطوات
import { db } from "@/lib/db"
import { AGENT_TOOLS } from "@/lib/agent/tools"
import {
  lookupSearchMemory, isMemoryUsable, saveSearchMemory, recordInsight, type MemoryHit,
} from "@/lib/agent/memory"

export interface AgentRunOptions {
  platforms?: string[]
  forceFresh?: boolean // تجاهل الذاكرة واعمل صيد جديد
  exportCsv?: boolean
  maxSteps?: number
}

export interface AgentStepTrace {
  idx: number
  tool: string
  note: string
  status: string
  durationMs: number
  data?: unknown
}

// ---------- فهم الهدف: استخراج مدينة/صناعة/خدمة ----------
const CITY_MAP: Array<[RegExp, string]> = [
  [/التجمع الخامس|التجمع/, "التجمع الخامس"],
  [/مدينة نصر/, "مدينة نصر"],
  [/المعادي/, "المعادي"],
  [/الشيخ زايد|زايد/, "الشيخ زايد"],
  [/6 اكتوبر|السادس من اكتوبر|اكتوبر/, "6 أكتوبر"],
  [/المهندسين/, "المهندسين"],
  [/مصر الجديدة|هليوبوليس/, "مصر الجديدة"],
  [/وسط البلد|وسط القاهرة/, "وسط القاهرة"],
  [/الزمالك/, "الزمالك"],
  [/القاهرة|cairo/i, "القاهرة"],
  [/الجيزة|جيزة|giza/i, "الجيزة"],
  [/الاسكندريه|الإسكندرية|اسكندرية|alexandria/i, "الإسكندرية"],
  [/المنصورة/, "المنصورة"],
  [/طنطا/, "طنطا"],
  [/أسيوط|اسيوط/, "أسيوط"],
  [/السويس/, "السويس"],
  [/بورسعيد/, "بورسعيد"],
  [/الشرقية|الزقازيق/, "الشرقية"],
  [/المنيا/, "المنيا"],
  [/أسوان|اسوان/, "أسوان"],
  [/الأقصر|اقصر/, "الأقصر"],
  [/بني سويف/, "بني سويف"],
  [/دمياط/, "دمياط"],
]
const INDUSTRY_MAP: Array<[RegExp, string]> = [
  [/عياد|دكتور|دكاترة|أسنان|اسنان|dentist|clinic|طبيب|أطباء|اطباء/, "عيادات"],
  [/مطعم|مطاعم|كافيه|قهوة|كوفي|restaurant|cafe|coffee/, "مطاعم وكافيهات"],
  [/متجر|تجارة|بيع|retail|store|ecommerce|تجارة إلكترونية|انستجرام/, "متاجر"],
  [/جيم|نادي|جيمز|gym|fitness|فيتنس/, "جيمات"],
  [/صالون|حلاق|barber|salon|تجميل/, "صالونات"],
  [/عقار|عقارات|real estate|مكتب عقاري/, "عقارات"],
  [/صيدلي|صيدلية|pharmacy/, "صيدليات"],
  [/شركة|شركات|startups?|سوفتوير|برمجيات/, "شركات"],
  [/مصنع|مصانع|factory/, "مصانع"],
  [/محامي|محاماة|law|legal/, "مكاتب محاماة"],
]
const SERVICE_MAP: Array<[RegExp, string]> = [
  [/حجز|حجوزات|booking|reservation/, "نظام حجز"],
  [/كاشير|pos|نقاط بيع/, "كاشير POS"],
  [/موقع|website|ويب/, "موقع إلكتروني"],
  [/تطبيق|app|موبايل/, "تطبيق موبايل"],
  [/crm|إدارة عملاء|ادارة عملاء|علاقات/, "CRM"],
  [/erp|محاسبة|accounting/, "ERP"],
  [/متجر إلكتروني|متجر الكتروني|ecommerce|ستور/, "متجر إلكتروني"],
  [/تسويق|marketing|اعلانات|إعلانات|ads/, "تسويق رقمي"],
  [/دليفري|طلبات|ordering|delivery/, "نظام طلبات"],
  [/برمج|تطوير|developer|software|نظام/, "برمجيات"],
]

function extractEntity(objective: string, map: Array<[RegExp, string]>): string | null {
  for (const [re, val] of map) {
    const m = objective.match(re)
    if (m) return typeof val === "string" ? val : (val as (s: string) => string)(m[0])
  }
  return null
}

export function planQueries(objective: string): { city: string | null; industry: string | null; service: string | null; queries: string[] } {
  const city = extractEntity(objective, CITY_MAP)
  const industry = extractEntity(objective, INDUSTRY_MAP)
  const service = extractEntity(objective, SERVICE_MAP)
  const queries: string[] = [objective]
  if (industry && city) queries.push(`${industry} ${city} محتاج ${service ?? "نظام"}`)
  else if (industry) queries.push(`${industry} مصر محتاج ${service ?? "نظام"}`)
  if (industry && city) queries.push(`${industry === "عيادات" ? "clinics" : industry === "مطاعم وكافيهات" ? "restaurants cafes" : "businesses"} in ${city} looking for ${service ?? "software"}`)
  if (industry && city) queries.push(`${industry} ${city} توصيل مواقع` ) // استعلام مكان لليدز المحلية
  return { city, industry, service, queries: [...new Set(queries)].slice(0, 5) }
}

export function choosePlatforms(objective: string, hinted?: string[]): string[] {
  if (hinted?.length) return hinted
  const platforms = new Set<string>(["GOOGLE_MAPS", "GOOGLE_SEARCH"])
  if (/انستجرام|instagram|براند/i.test(objective)) platforms.add("INSTAGRAM")
  if (/فيسبوك|facebook|جروب/i.test(objective)) platforms.add("FACEBOOK")
  if (/لينكدإن|لينكد|linkedin|توظيف|وظايف|hiring/i.test(objective)) { platforms.add("LINKEDIN"); platforms.add("JOBS") }
  if (/ريديت|reddit/i.test(objective)) platforms.add("REDDIT")
  if (/أخبار|اخبار|افتتاح|توسع|news/i.test(objective)) platforms.add("NEWS")
  if (/تيك توك|tiktok/i.test(objective)) platforms.add("TIKTOK")
  if (/يوتيوب|youtube/i.test(objective)) platforms.add("YOUTUBE")
  if (/دليل|أدلة|yellow|directory/i.test(objective)) platforms.add("DIRECTORY")
  return [...platforms].slice(0, 5)
}


// ---------- الحلقة (Graph-First — مواصفة 43.5/43.26) ----------
// Master AI مش بيبدأ تنفيذ مباشرة: كل مهمة بتتبني لها خريطة تفكير (AI أو قالب حتمي)،
// وبعدين العقد تتنفذ بالترتيب القانوني — استرجاع مهارات لكل عقدة، تنفيذ، تحقق بالأدلة،
// وإعادة تخطيط عند الفشل. الشكل الخارجي للدالة محفوظ للأدوات والمسارات الحية.
export async function runAgent(
  wsId: string,
  objective: string,
  opts: AgentRunOptions = {},
): Promise<{ runId: string; status: string; summary: string; steps: AgentStepTrace[]; leadsCreated: number; reusedMemory: boolean }> {
  const t0 = Date.now()
  const maxSteps = opts.maxSteps ?? 14
  const run = await db.agentRun.create({
    data: { workspaceId: wsId, objective, status: "RUNNING", platforms: (opts.platforms ?? []) as never },
  })
  const steps: AgentStepTrace[] = []
  let idx = 0

  async function step(tool: string, note: string, status: string, durationMs: number, data?: unknown, input?: unknown) {
    idx++
    if (idx > maxSteps) return
    const s: AgentStepTrace = { idx, tool, note, status, durationMs }
    if (data !== undefined) s.data = data
    steps.push(s)
    await db.agentStep.create({
      data: { runId: run.id, idx, tool, note: note.slice(0, 500), status, durationMs, input: (input ?? undefined) as never, output: (data ?? undefined) as never },
    }).catch(() => undefined)
  }

  try {
    // 1) بناء خريطة التفكير أولًا — ممنوع تنفيذ عقدة لم تُقيَّم احتياجاتها (43.5)
    const { buildThinkingGraph, runGraphSlice } = await import("@/lib/thinking/engine")
    const tGraph = Date.now()
    const built = await buildThinkingGraph(wsId, objective, {
      trigger: "AGENT",
      sourceRunId: run.id,
      platforms: opts.platforms,
    })
    await step(
      "thinking_graph",
      `خريطة تنفيذ اتبنت (${built.builtBy === "AI" ? "بواسطة Master AI" : "بالقالب الحتمي"}): ${built.nodes} عقدة`,
      "OK", Date.now() - tGraph,
      { graphId: built.graphId, assumptions: built.assumptions.slice(0, 4) },
    )

    // 2) التنفيذ عقدة عقدة: استرجاع مهارات → تنفيذ → تحقق → إعادة تخطيط (جوه المحرك)
    const slice = await runGraphSlice(built.graphId, { budgetMs: 95_000, platformsHint: opts.platforms })
    for (const s of slice.steps) {
      if (steps.length >= maxSteps) break
      const ok = s.outcome === "SUCCESS" || s.outcome === "PARTIAL" || s.outcome === "SKIPPED"
      await step(`${s.nodeId}:${s.type}`, s.note.slice(0, 300), ok ? "OK" : "FAILED", 0, { outcome: s.outcome })
    }

    // 3) الحقايق النهائية من الخريطة
    const g = await db.taskGraph.findUnique({
      where: { id: built.graphId },
      select: { facts: true, status: true },
    })
    const facts = (g?.facts ?? {}) as Record<string, unknown>
    const reusedMemory = Boolean(facts.reusedMemory)
    const leadsCreated = Number(facts.leadsCreated ?? 0)
    const itemsScanned = Number(facts.itemsScanned ?? 0)
    const graphStatus = g?.status ?? "ACTIVE"

    // 4) آثار إعادة استخدام الذاكرة (سلوك محفوظ من قبل — عدّاد + استنتاج)
    if (reusedMemory) {
      const hits = await lookupSearchMemory(wsId, objective)
      const usable = hits.find(isMemoryUsable)
      if (usable) {
        await db.searchMemory.update({ where: { id: usable.id }, data: { hitCount: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => undefined)
        await recordInsight(wsId, "positive", `reuse:${usable.query}`, `الذاكرة غطت الهدف «${objective.slice(0, 50)}» بدون ويب (مسار خريطة مختصر)`, { hitCount: usable.hitCount + 1 })
        await step("memory_reuse", `أعدنا استخدام نتايج «${usable.query}» من الذاكرة — صفر بحث ويب`, "OK", 0)
      }
    }

    // 5) حفظ ذاكرة البحث لكل منصة (من أدلة عقدة DISCOVER — زي قبل بالظبط)
    if (leadsCreated > 0 || itemsScanned > 0) {
      const disc = await db.taskGraphNode.findFirst({
        where: { graphId: built.graphId, type: "DISCOVER" },
        select: { outcomeData: true },
      })
      const perPlatform = ((disc?.outcomeData as { perPlatform?: Array<{ platform: string; items: number; created: number }> } | null)?.perPlatform ?? []) as Array<{ platform: string; items: number; created: number }>
      const avgScore = Number(facts.avgScore ?? 0)
      const bestScore = Number(facts.bestScore ?? 0)
      for (const p of perPlatform) {
        await saveSearchMemory(wsId, {
          query: objective,
          platform: p.platform,
          resultCount: p.items,
          leadCount: p.created,
          avgScore,
          bestScore,
          provider: "agent",
          bestResults: (p as { topItems?: Array<{ title: string; url: string }> }).topItems ?? [],
        }).catch(() => undefined)
      }
      if (perPlatform.length) {
        await step("memory_save", `اتحفظت الذاكرة: ${perPlatform.length} منصة — جودة محسوبة من الليدز الجديدة`, "OK", 0, { avgScore, bestScore, leadsCreated })
      }
    }

    // 6) تصدير اختياري
    if (opts.exportCsv) {
      const { AGENT_TOOLS } = await import("@/lib/agent/tools")
      const tool = AGENT_TOOLS.find((x) => x.name === "export_leads_csv")
      const r = tool ? await tool.run({ workspace_id: wsId, min_score: 0 }).catch(() => null) : null
      await step("export_leads_csv", r?.note ?? "أداة التصدير غير متاحة", r?.ok ? "OK" : "FAILED", 0)
    }

    const durationMs = Date.now() - t0
    const fr = (await db.taskGraph.findUnique({ where: { id: built.graphId }, select: { finalResult: true } }))?.finalResult as Record<string, unknown> | null
    const summary = reusedMemory
      ? `ذاكرة: استخدمنا نتايج محفوظة (${steps.length} خطوة، صفر بحث ويب)`
      : `خريطة ${graphStatus === "COMPLETED" ? "اكتملت" : graphStatus}: ${leadsCreated} ليد من ${itemsScanned} عنصر (${steps.length} خطوة، ${(durationMs / 1000).toFixed(1)}s${fr?.researchEnqueued ? "، بحث عميق مفتوح" : ""})`
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: graphStatus === "FAILED" ? "FAILED" : "SUCCESS",
        summary,
        leadsCreated,
        itemsScanned,
        memoryHits: Number(facts.memoryHits ?? 0),
        reusedMemory,
        durationMs,
        completedAt: new Date(),
      },
    })
    return { runId: run.id, status: graphStatus === "FAILED" ? "FAILED" : "SUCCESS", summary, steps, leadsCreated, reusedMemory }
  } catch (err) {
    const durationMs = Date.now() - t0
    const msg = err instanceof Error ? err.message.slice(0, 300) : String(err)
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", errorMessage: msg, durationMs, completedAt: new Date() },
    }).catch(() => undefined)
    return { runId: run.id, status: "FAILED", summary: `فشل: ${msg}`, steps, leadsCreated: 0, reusedMemory: false }
  }
}
