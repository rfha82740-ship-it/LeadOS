// LeadOS — AI Commander Tools (doc §5.1, §26, §38-39)
// The AI plans/analyzes via these whitelisted tools; no raw SQL ever reaches the LLM.
import type { Prisma } from "@prisma/client"
import fs from "fs"
import path from "path"
import { db } from "@/lib/db"
import { asArray, LEAD_STATUS_LABELS } from "@/lib/constants"
import { enqueueJob } from "@/lib/queue"
import { runAgent } from "@/lib/agent/loop"
import { lookupSearchMemory, topMemoryQueries } from "@/lib/agent/memory"
import { aiVision, aiTranslate } from "@/lib/ai"

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, string>
}

export const AI_TOOLS: ToolDef[] = [
  { name: "search_crm", description: "ابحث في الـCRM بفلاتر: city, industry, service, min_score, stage/status, source, limit", parameters: { filters: "object" } },
  { name: "get_analytics", description: "إحصائيات: عدد الـLeads حسب المصدر/الحالة/الصناعة وأعلى Score", parameters: {} },
  { name: "create_search_rule", description: "أنشئ قاعدة بحث جديدة: name, cities[], industries[], services[], keywords[]", parameters: { name: "string", cities: "string[]", industries: "string[]", services: "string[]" } },
  { name: "pause_source", description: "أوقف/فعّل مصدر: name أو type + enabled", parameters: { name: "string", enabled: "boolean" } },
  { name: "research_lead", description: "ابدأ بحث عميق لعميل بالـid أو جزء من اسم الشركة", parameters: { lead_id: "string", company_name: "string" } },
  { name: "update_lead", description: "غيّر حالة/Stage عميل: lead_id + status (NEW|QUALIFIED|CONTACTED|REPLIED|INTERESTED|MEETING|PROPOSAL|WON|LOST|NURTURE)", parameters: { lead_id: "string", status: "string" } },
  { name: "create_task", description: "أنشئ مهمة متابعة: lead_id, title, due_days", parameters: { lead_id: "string", title: "string", due_days: "number" } },
  { name: "create_note", description: "أضف ملاحظة على عميل: lead_id, body", parameters: { lead_id: "string", body: "string" } },
  { name: "list_leads", description: "أفضل الـLeads حاليًا مرتبين بـScore", parameters: { limit: "number" } },
  { name: "run_lead_agent", description: "شغّل الأيجنت الذكي على هدف بحث (يستخدم الذاكرة أولاً ثم يصطاد من خرائط جوجل/الويب/فيسبوك/لينكدإن ويسجل ليدز): objective", parameters: { objective: "string", force_fresh: "boolean" } },
  { name: "search_agent_memory", description: "فحص ذاكرة البحث قبل الويب: استعلامات سابقة مشابهة وجودتها وأفضل نتايجها", parameters: { query: "string" } },
  { name: "analyze_image", description: "حلل صورة أو سكرين شوت بمحرك الرؤية: استخراج شعارات/أرقام/عروض/حالة محل. image = رابط http(s) أو data URL أو latest لآخر سكرين شوت من المتصفح الخفي", parameters: { image: "string", question: "string" } },
  { name: "translate_text", description: "ترجم نص لأي لغة بمحرك Riva المخصص (مفيد لرسائل العملاء الأجانب): text, target_lang مثل English", parameters: { text: "string", target_lang: "string" } },
  { name: "task_graph", description: "خريطة تفكير ديناميكية (Dynamic Skill Intelligence): أنشئ خريطة تنفيذ لمهمة وابنِ عقد مرتبطة بمهارات من المكتبات العالمية، أو افحص خريطة قائمة بإجابات الوعي. action='create' + objective، أو action='inspect' + graph_id", parameters: { action: "string", objective: "string", graph_id: "string" } },
]

export interface ToolResult {
  ok: boolean
  summary: string
  data?: unknown
}

async function resolveLead(workspaceId: string, leadId?: string, companyName?: string) {
  if (leadId) return db.lead.findFirst({ where: { id: leadId, workspaceId }, include: { business: true } })
  if (companyName) {
    const leads = await db.lead.findMany({
      where: { workspaceId, business: { name: { contains: companyName } } },
      include: { business: true },
      take: 1,
    })
    return leads[0] ?? null
  }
  return null
}

export async function executeTool(workspaceId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "search_crm": {
        const f = (args.filters ?? args) as Record<string, unknown>
        const where: Prisma.LeadWhereInput = { workspaceId }
        let bizFilter: Prisma.BusinessWhereInput | undefined
        if (typeof f.city === "string" && f.city) bizFilter = { ...bizFilter, city: { contains: f.city } }
        if (typeof f.industry === "string" && f.industry) bizFilter = { ...bizFilter, industry: { contains: f.industry } }
        if (bizFilter) where.business = bizFilter
        if (typeof f.min_score === "number") where.score = { gte: f.min_score }
        if (typeof f.stage === "string" || typeof f.status === "string") where.status = (f.stage ?? f.status) as never
        if (typeof f.source === "string" && f.source) where.leadSourceType = f.source as never
        const fetched = await db.lead.findMany({
          where,
          include: { business: { select: { name: true, city: true, industry: true, rating: true } } },
          orderBy: { score: "desc" },
          take: 60,
        })
        const leads = (
          typeof f.service === "string" && f.service
            ? fetched.filter((l) => asArray(l.serviceNeeds).some((s) => s.toLowerCase().includes(String(f.service).toLowerCase())))
            : fetched
        ).slice(0, Math.min(20, typeof f.limit === "number" ? f.limit : 10))
        return {
          ok: true,
          summary: `تم العثور على ${leads.length} عميل مطابق`,
          data: leads.map((l) => ({
            id: l.id, company: l.business?.name, city: l.business?.city,
            industry: l.business?.industry, score: l.score, temperature: l.temperature,
            stage: LEAD_STATUS_LABELS[l.status] ?? l.status, services: asArray(l.serviceNeeds),
          })),
        }
      }
      case "list_leads": {
        const leads = await db.lead.findMany({
          where: { workspaceId },
          include: { business: { select: { name: true, city: true, industry: true } } },
          orderBy: { score: "desc" },
          take: Math.min(20, typeof args.limit === "number" ? args.limit : 10),
        })
        return {
          ok: true,
          summary: `أفضل ${leads.length} عميل حاليًا`,
          data: leads.map((l) => ({ id: l.id, company: l.business?.name, score: l.score, temperature: l.temperature, stage: l.status })),
        }
      }
      case "get_analytics": {
        const [total, byStatus, bySource, hot] = await Promise.all([
          db.lead.count({ where: { workspaceId } }),
          db.lead.groupBy({ by: ["status"], where: { workspaceId }, _count: true }),
          db.lead.groupBy({ by: ["leadSourceType"], where: { workspaceId }, _count: true, _avg: { score: true } }),
          db.lead.count({ where: { workspaceId, temperature: "HOT" } }),
        ])
        return {
          ok: true,
          summary: `إجمالي ${total} عميل، منهم ${hot} ساخن`,
          data: {
            total, hot,
            byStatus: byStatus.map((s) => ({ status: LEAD_STATUS_LABELS[s.status] ?? s.status, count: s._count })),
            bySource: bySource.map((s) => ({ source: s.leadSourceType, count: s._count, avgScore: Math.round(s._avg.score ?? 0) })),
          },
        }
      }
      case "create_search_rule": {
        const rule = await db.searchRule.create({
          data: {
            workspaceId,
            name: String(args.name ?? "قاعدة جديدة"),
            cities: asArray(args.cities) as unknown as Prisma.InputJsonValue,
            industries: asArray(args.industries) as unknown as Prisma.InputJsonValue,
            services: asArray(args.services) as unknown as Prisma.InputJsonValue,
            keywords: asArray(args.keywords) as unknown as Prisma.InputJsonValue,
            enabled: true,
          },
        })
        return { ok: true, summary: `تم إنشاء قاعدة البحث "${rule.name}" وستبدأ الاكتشاف في الدورة القادمة`, data: { ruleId: rule.id } }
      }
      case "pause_source": {
        const enabled = args.enabled !== false
        const where: Prisma.SourceWhereInput = { workspaceId }
        if (typeof args.name === "string" && args.name) where.name = { contains: args.name }
        else if (typeof args.type === "string" && args.type) where.type = args.type as never
        const updated = await db.source.updateMany({ where, data: { status: enabled ? "ACTIVE" : "PAUSED" } })
        return { ok: true, summary: `${enabled ? "تفعيل" : "إيقاف"} ${updated.count} مصدر` }
      }
      case "research_lead": {
        const lead = await resolveLead(workspaceId, args.lead_id as string | undefined, args.company_name as string | undefined)
        if (!lead) return { ok: false, summary: "لم أجد العميل المطلوب" }
        const run = await db.researchRun.create({
          data: { workspaceId, leadId: lead.id, depth: "DEEP", status: "QUEUED" },
        })
        await enqueueJob(workspaceId, "DEEP_RESEARCH", { researchRunId: run.id, leadId: lead.id }, 80)
        return { ok: true, summary: `بدأت بحثًا عميقًا لـ "${lead.business?.name ?? lead.id}" — تقدر تتابع من مركز الأبحاث`, data: { researchRunId: run.id } }
      }
      case "update_lead": {
        const lead = await resolveLead(workspaceId, args.lead_id as string | undefined, args.company_name as string | undefined)
        if (!lead) return { ok: false, summary: "لم أجد العميل المطلوب" }
        const status = String(args.status ?? args.stage ?? "")
        if (!LEAD_STATUS_LABELS[status]) return { ok: false, summary: `حالة غير معروفة: ${status}` }
        await db.lead.update({ where: { id: lead.id }, data: { status: status as never } })
        await db.activity.create({
          data: { workspaceId, leadId: lead.id, type: "STATUS_CHANGE", subject: "تغيير مرحلة", body: `تم النقل إلى: ${LEAD_STATUS_LABELS[status]}` },
        })
        return { ok: true, summary: `تم نقل "${lead.business?.name}" إلى ${LEAD_STATUS_LABELS[status]}` }
      }
      case "create_task": {
        const lead = await resolveLead(workspaceId, args.lead_id as string | undefined, args.company_name as string | undefined)
        if (!lead) return { ok: false, summary: "لم أجد العميل المطلوب" }
        const dueDays = typeof args.due_days === "number" ? args.due_days : 1
        const task = await db.task.create({
          data: {
            workspaceId, leadId: lead.id,
            title: String(args.title ?? "متابعة عميل"),
            dueAt: new Date(Date.now() + dueDays * 86400000),
          },
        })
        return { ok: true, summary: `تم إنشاء مهمة "${task.title}" للعميل ${lead.business?.name ?? ""}`, data: { taskId: task.id } }
      }
      case "create_note": {
        const lead = await resolveLead(workspaceId, args.lead_id as string | undefined, args.company_name as string | undefined)
        if (!lead) return { ok: false, summary: "لم أجد العميل المطلوب" }
        await db.note.create({ data: { workspaceId, leadId: lead.id, body: String(args.body ?? "") } })
        return { ok: true, summary: `تمت إضافة ملاحظة على ${lead.business?.name ?? "العميل"}` }
      }
      case "run_lead_agent": {
        const objective = String(args.objective ?? "")
        if (objective.length < 5) return { ok: false, summary: "اكتب هدف بحث أوضح للأيجنت" }
        const result = await runAgent(workspaceId, objective, { forceFresh: Boolean(args.force_fresh) })
        return {
          ok: result.status === "SUCCESS",
          summary: `${result.summary} — ${result.leadsCreated} ليد. ${result.reusedMemory ? "(من الذاكرة بدون ويب)" : ""}`,
          data: { runId: result.runId, steps: result.steps.map((s) => `${s.tool}: ${s.note}`) },
        }
      }
      case "search_agent_memory": {
        const query = String(args.query ?? "")
        if (!query) return { ok: false, summary: "اكتب استعلام للفحص في الذاكرة" }
        const hits = await lookupSearchMemory(workspaceId, query, { minSimilarity: 0.3 })
        const top = await topMemoryQueries(workspaceId, 5)
        return {
          ok: true,
          summary: hits.length
            ? `لقيت في الذاكرة ${hits.length} استعلام قريب — الأقوى: «${hits[0].query}» (جودة ${hits[0].qualityScore}، ${hits[0].leadCount} ليد)`
            : "الذاكرة ما فيهاش استعلام قريب — ينفع تشغيل الأيجنت بصيد جديد",
          data: { hits, topQueries: top.map((m) => ({ query: m.query, quality: m.qualityScore, leads: m.leadCount })) },
        }
      }
      case "analyze_image": {
        let imageUrl = String(args.image ?? "")
        if (!imageUrl || imageUrl === "latest") {
          // آخر سكرين شوت حفظها المتصفح الخفي في download/stealth/
          try {
            const dir = path.join(process.cwd(), "download", "stealth")
            const files = fs.readdirSync(dir)
              .filter((f) => f.endsWith(".png"))
              .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
              .sort((a, b) => b.t - a.t)
            if (!files.length) return { ok: false, summary: "مفيش سكرين شوت محفوظة — شغّل stealth_browse الأول أو ابعت رابط صورة" }
            const b64 = fs.readFileSync(path.join(dir, files[0].f)).toString("base64")
            imageUrl = `data:image/png;base64,${b64}`
          } catch {
            return { ok: false, summary: "تعذر قراءة السكرين شوت — ابعت رابط صورة مباشر" }
          }
        } else if (!/^https?:\/\//.test(imageUrl) && !imageUrl.startsWith("data:")) {
          return { ok: false, summary: "الصورة لازم رابط http(s) أو data URL أو latest لآخر سكرين شوت" }
        }
        const question = String(args.question ?? "حلل الصورة: استخرج أي أسماء/أرقام تليفون/عروض/شعارات ووصف الموقف التجاري بإيجاز")
        const result = await aiVision(question, imageUrl, { workspaceId, runType: "OTHER" })
        if (!result) return { ok: false, summary: "محرك تحليل الصور مش متاح حاليًا" }
        return { ok: true, summary: `تحليل الصورة جاهز (${result.model.split("/").pop()})`, data: { analysis: result.text.slice(0, 2000) } }
      }
      case "translate_text": {
        const text = String(args.text ?? "")
        if (!text) return { ok: false, summary: "اكتب نص للترجمة" }
        const target = String(args.target_lang ?? "English")
        const result = await aiTranslate(text, target, { workspaceId, runType: "OTHER" })
        if (!result) return { ok: false, summary: "محرك الترجمة مش متاح حاليًا" }
        return { ok: true, summary: `الترجمة لـ${target} جاهزة`, data: { translation: result.text.slice(0, 2000) } }
      }
      case "task_graph": {
        // Dynamic Skill Intelligence — خريطة تفكير ديناميكية من الشات (مواصفة 43)
        const action = String(args.action ?? "create").toLowerCase()
        const { runAgentGraph, inspectThinkingGraph } = await import("@/lib/thinking/engine")
        if (action === "inspect") {
          const r = await inspectThinkingGraph(String(args.graph_id ?? ""))
          if (!r) return { ok: false, summary: "مفيش خريطة بالمعرف ده" }
          const a = r.awareness
          return {
            ok: true,
            summary: `${a.whatAmIDoing} — ${a.evidenceSummary} (تقدم ${a.progress.done}/${a.progress.total}${a.progress.failed ? `، فشل ${a.progress.failed}` : ""})${a.currentSkill ? ` — مهارة شغالة: [${a.currentSkill.kind}] ${a.currentSkill.name}` : ""}`,
            data: { awareness: a, nodes: r.nodes },
          }
        }
        const objective = String(args.objective ?? "").trim()
        if (objective.length < 5) return { ok: false, summary: "اكتب هدف واضح للمهمة (5 أحرف على الأقل)" }
        const r = await runAgentGraph(workspaceId, objective, { trigger: "CHAT", budgetMs: 60_000 })
        const fr = (r.finalResult ?? {}) as { leads?: number; bestScore?: number }
        return {
          ok: true,
          summary: `خريطة (${r.builtBy === "AI" ? "AI" : "قالب حتمي"}) ${r.status}: ${r.steps.length} عقدة تنفتذت، ${fr.leads ?? 0} ليد، أعلى درجة ${fr.bestScore ?? 0} — معرفها ${r.graphId.slice(0, 8)} (اسألني inspect بأي وقت`,
          data: { graphId: r.graphId, status: r.status, steps: r.steps.slice(0, 12), finalResult: r.finalResult },
        }
      }
      default:
        return { ok: false, summary: `أداة غير معروفة: ${name}` }
    }
  } catch (err) {
    return { ok: false, summary: `خطأ في تنفيذ الأداة: ${err instanceof Error ? err.message.slice(0, 150) : err}` }
  }
}

/** Try to extract a tool call from AI text using balanced-brace JSON parsing. */
export function extractToolCall(text: string): { tool: string; arguments: Record<string, unknown> } | null {
  let idx = text.indexOf("{")
  while (idx !== -1) {
    // Only consider objects that start with {"tool"
    const head = text.slice(idx, idx + 10)
    if (/^\{\s*"tool"/.test(head)) {
      // Walk balanced braces respecting strings/escapes
      let depth = 0
      let inString = false
      let escape = false
      for (let i = idx; i < text.length; i++) {
        const ch = text[i]
        if (escape) { escape = false; continue }
        if (ch === "\\") { escape = true; continue }
        if (ch === '"') inString = !inString
        if (inString) continue
        if (ch === "{") depth++
        if (ch === "}") {
          depth--
          if (depth === 0) {
            try {
              const parsed = JSON.parse(text.slice(idx, i + 1)) as { tool?: string; arguments?: Record<string, unknown> }
              if (parsed.tool && typeof parsed.tool === "string" && /^[a-z_]+$/.test(parsed.tool)) {
                return { tool: parsed.tool, arguments: parsed.arguments ?? {} }
              }
              return null
            } catch {
              break
            }
          }
        }
      }
    }
    idx = text.indexOf("{", idx + 1)
  }
  return null
}
