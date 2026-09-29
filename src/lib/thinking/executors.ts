// LeadOS — منفذو عقد خريطة التفكير (Node Executors — مواصفة 43.5 / 43.26)
// كل نوع عقدة له منفذ واحد حتمي فوق قدرات LeadOS المثبتة (lead_hunt / crawl_page /
// الذاكرة / التقييم / البحث العميق / سلاسل المتابعة / زيزو). المنفذ بيرجع نتيجة
// بأدلة — والتحقق بيبقى على معايير العقدة، مش على إحساس الـAI (43.21).
// ملاحظة الأمان: المهارات الخارجية بتيجي كسياق مقترح فقط — التنفيذ دايمًا بأدواتنا.
import { db } from "@/lib/db"
import { lookupSearchMemory, isMemoryUsable } from "@/lib/agent/memory"
import { planQueries, choosePlatforms } from "@/lib/agent/loop"
import { recomputeLeadScore } from "@/lib/scoring"
import { enqueueJob } from "@/lib/queue"
import { recordLesson } from "@/lib/skills/learning"
import { recordSkillOutcome, type SkillKind } from "@/lib/skills/dsi/memory"
import type { SelectedSkillRef } from "@/lib/skills/dsi/retriever"
import type { GraphFacts, NodeType } from "./types"

export interface NodeCtx {
  wsId: string
  graphId: string
  graphCreatedAt: Date
  goal: string
  nodeId: string
  objective: string
  type: NodeType
  facts: GraphFacts
  skills: SelectedSkillRef[] // المختارات لهذه العقدة (من الريتريفر)
  platformsHint?: string[]
}

export interface NodeExecResult {
  outcome: string // SUCCESS | PARTIAL | FAILURE | INSUFFICIENT_EVIDENCE | SOURCE_FAILURE | ACCOUNT_FAILURE | AUTH_REQUIRED | POLICY_BLOCK | MISSING_CAPABILITY
  note: string
  data?: unknown
  factsPatch?: GraphFacts
  durationMs: number
}

/** استدعاء أداة الأيجنت (تحميل مؤجل لقطع أي دورة استيراد وقت الإقلاع) */
async function callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; note: string; data?: unknown }> {
  try {
    const { AGENT_TOOLS } = await import("@/lib/agent/tools")
    const tool = AGENT_TOOLS.find((t) => t.name === name)
    if (!tool) return { ok: false, note: `أداة ${name} غير موجودة` }
    const gated = tool.gate === "env" && !(tool.envKeys ?? []).every((k) => Boolean(process.env[k]))
    if (gated) return { ok: false, note: `أداة ${name} متعطلة — تحتاج متغيرات بيئة` }
    return await tool.run(args)
  } catch (err) {
    return { ok: false, note: `فشل ${name}: ${err instanceof Error ? err.message.slice(0, 100) : "خطأ"}` }
  }
}

/** سطر السياق من المهارات المختارة — يدخل برومبت الـAI الحقيقي (دمج 43.1 #7) */
export function skillContextLines(skills: SelectedSkillRef[]): string {
  return skills.map((s) => s.contextLine).join("\n")
}

type Executor = (ctx: NodeCtx) => Promise<NodeExecResult>

const now = () => Date.now()

// ═══ المنفذون — واحد لكل نوع عقدة ═══
const EXECUTORS: Record<string, Executor> = {
  OBSERVE: async (ctx) => {
    const t = now()
    try {
      const hits = await lookupSearchMemory(ctx.wsId, ctx.goal)
      const usable = hits.find(isMemoryUsable)
      return {
        outcome: "SUCCESS",
        note: usable ? `ذاكرة قابلة لإعادة الاستخدام: «${usable.query}» (${usable.leadCount} ليد)` : hits.length ? `${hits.length} ذكرى قريبة غير كافية` : "الذاكرة فاضية — صيد جديد مطلوب",
        data: { hits: hits.length, usable: Boolean(usable) },
        factsPatch: { memoryHits: hits.length, reusedMemory: Boolean(usable) },
        durationMs: now() - t,
      }
    } catch (err) {
      return { outcome: "SUCCESS", note: `فحص ذاكرة فشل (${err instanceof Error ? err.message.slice(0, 60) : "خطأ"}) — نكمل صيدًا جديدًا`, factsPatch: { memoryHits: 0 }, durationMs: now() - t }
    }
  },

  ANALYZE: async (ctx) => {
    const t = now()
    const plan = planQueries(ctx.goal)
    return {
      outcome: "SUCCESS",
      note: [plan.industry && `صناعة=${plan.industry}`, plan.city && `مدينة=${plan.city}`, plan.service && `خدمة=${plan.service}`].filter(Boolean).join(" | ") || "هدف عام — بدون كيانات محددة",
      data: plan,
      factsPatch: { city: plan.city, industry: plan.industry, service: plan.service },
      durationMs: now() - t,
    }
  },

  PLAN: async (ctx) => {
    const t = now()
    const plan = planQueries(ctx.goal)
    const platforms = choosePlatforms(ctx.goal, ctx.platformsHint)
    const queries = plan.queries.length ? plan.queries : [ctx.goal.slice(0, 120)]
    return {
      outcome: queries.length ? "SUCCESS" : "FAILURE",
      note: `${queries.length} استعلام × ${platforms.length} منصة (${platforms.slice(0, 3).join(", ")})${ctx.skills.length ? ` — مهارات مدمجة: ${ctx.skills.map((s) => s.name).slice(0, 2).join("، ")}` : ""}`,
      data: { queries, platforms },
      factsPatch: { queries, platforms },
      durationMs: now() - t,
    }
  },

  RETRIEVE_SKILLS: async (ctx) => {
    const t = now()
    return {
      outcome: ctx.skills.length ? "SUCCESS" : "MISSING_CAPABILITY",
      note: ctx.skills.length ? `اتجّابت ${ctx.skills.length} مهارة للعقدة: ${ctx.skills.map((s) => `[${s.kind}] ${s.name}`).join("، ")}` : "مفيش مهارة عدّت بوابة الصلة/الثقة — العقدة هتشتغل بالقدرات الأساسية",
      data: { selected: ctx.skills.map((s) => ({ kind: s.kind, key: s.key, score: s.finalScore, why: s.selectionReason })) },
      durationMs: now() - t,
    }
  },

  DISCOVER: async (ctx) => {
    const t = now()
    const queries = (ctx.facts.queries?.length ? ctx.facts.queries : [ctx.goal.slice(0, 120)]).slice(0, 5)
    const platforms = (ctx.facts.platforms?.length ? ctx.facts.platforms : ctx.facts.altPlatforms?.length ? ctx.facts.altPlatforms : ["GOOGLE_SEARCH"]).slice(0, 6)
    const res = await callTool("lead_hunt", { workspace_id: ctx.wsId, queries, platforms })
    const d = (res.data ?? {}) as { scanned?: number; created?: number; duplicates?: number }
    const scanned = d.scanned ?? 0
    const created = d.created ?? 0
    const outcome = created > 0 ? "SUCCESS" : scanned > 0 ? "PARTIAL" : "SOURCE_FAILURE"
    return {
      outcome,
      note: `${res.note.slice(0, 120)} — مسح=${scanned} ليدز=${created}`,
      data: { ...(typeof res.data === "object" && res.data ? res.data : {}), scanned, created, platforms },
      factsPatch: { itemsScanned: scanned, leadsCreated: created },
      durationMs: now() - t,
    }
  },

  VERIFY: async (ctx) => {
    const t = now()
    const leads = await db.lead.count({ where: { workspaceId: ctx.wsId, createdAt: { gte: ctx.graphCreatedAt } } }).catch(() => 0)
    const scanned = Number(ctx.facts.itemsScanned ?? 0)
    const outcome = leads >= 1 ? "SUCCESS" : scanned >= 3 ? "PARTIAL" : "INSUFFICIENT_EVIDENCE"
    return {
      outcome,
      note: `أدلة فعلية: ${leads} ليد جديد من ${scanned} عنصر ممسوح`,
      data: { leads, scanned },
      factsPatch: { leadsCreated: leads },
      durationMs: now() - t,
    }
  },

  ENRICH: async (ctx) => {
    const t = now()
    const candidates = await db.lead.findMany({
      where: { workspaceId: ctx.wsId, createdAt: { gte: ctx.graphCreatedAt } },
      include: { business: { select: { id: true, websiteUrl: true, phone: true } } },
      take: 12,
    }).catch(() => [])
    const crawlable = candidates.filter((l) => l.business?.websiteUrl && !l.business?.phone).slice(0, 4)
    let harvested = 0
    for (const l of crawlable) {
      const res = await callTool("crawl_page", { url: l.business!.websiteUrl! })
      const contacts = (res.data ?? {}) as { phones?: string[] }
      if (res.ok && contacts.phones?.length) {
        await db.business.update({ where: { id: l.business!.id }, data: { phone: contacts.phones[0] } }).catch(() => undefined)
        harvested++
      }
    }
    const outcome = !crawlable.length ? "SUCCESS" : harvested > 0 ? "SUCCESS" : "PARTIAL"
    return {
      outcome,
      note: crawlable.length ? `إثراء: ${harvested}/${crawlable.length} موقع رجّع تليفون` : "مفيش مواقع محتاجة إثراء بين الجدد",
      data: { harvested, attempted: crawlable.length },
      factsPatch: { contactsHarvested: harvested },
      durationMs: now() - t,
    }
  },

  QUALIFY: async (ctx) => {
    const t = now()
    const leads = await db.lead.findMany({ where: { workspaceId: ctx.wsId, createdAt: { gte: ctx.graphCreatedAt } }, select: { id: true }, take: 12 }).catch(() => [])
    let scored = 0
    for (const l of leads) {
      const s = await recomputeLeadScore(l.id, { workspaceId: ctx.wsId }).catch(() => null)
      if (s) scored++
    }
    return {
      outcome: scored > 0 ? "SUCCESS" : "SUCCESS", // صفر ليدز = نجاح شكلي (التحقق مسؤولية VERIFY)
      note: scored ? `تأهيل: ${scored} ليد اتحسبت درجاتهم` : "مفيش ليدز جديدة للتأهيل",
      data: { scored },
      durationMs: now() - t,
    }
  },

  SCORE: async (ctx) => {
    const t = now()
    const rows = await db.lead.findMany({ where: { workspaceId: ctx.wsId, createdAt: { gte: ctx.graphCreatedAt } }, select: { score: true }, take: 50 }).catch(() => [] as Array<{ score: number }>)
    const avg = rows.length ? Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length) : 0
    const best = rows.length ? Math.max(...rows.map((r) => r.score)) : 0
    return {
      outcome: "SUCCESS",
      note: `درجات: متوسط=${avg} أعلى=${best} على ${rows.length} ليد`,
      data: { avg, best, count: rows.length },
      factsPatch: { avgScore: avg, bestScore: best },
      durationMs: now() - t,
    }
  },

  RESEARCH: async (ctx) => {
    const t = now()
    const best = Number(ctx.facts.bestScore ?? 0)
    if (best < 80) {
      return { outcome: "SUCCESS", note: `بوابة البحث العميق: أعلى درجة ${best} < 80 — استبعاد بالسبب (توفير ميزانية)`, data: { gate: "below-threshold" }, durationMs: now() - t }
    }
    const lead = await db.lead.findFirst({ where: { workspaceId: ctx.wsId, createdAt: { gte: ctx.graphCreatedAt } }, orderBy: { score: "desc" }, select: { id: true } }).catch(() => null)
    if (!lead) return { outcome: "INSUFFICIENT_EVIDENCE", note: "درجة عالية لكن مفيش ليد محدد للبحث العميق", durationMs: now() - t }
    const run = await db.researchRun.create({ data: { workspaceId: ctx.wsId, leadId: lead.id, depth: "DEEP", status: "QUEUED" } }).catch(() => null)
    if (!run) return { outcome: "SOURCE_FAILURE", note: "فشل إنشاء تشغيلة بحث", durationMs: now() - t }
    await enqueueJob(ctx.wsId, "DEEP_RESEARCH", { researchRunId: run.id, leadId: lead.id }, 80).catch(() => null)
    return {
      outcome: "SUCCESS",
      note: `بحث عميق اتفتح لأعلى ليد (score=${best}) — تشغيلة ${run.id.slice(0, 8)}`,
      data: { researchRunId: run.id, leadId: lead.id },
      factsPatch: { researchEnqueued: true },
      durationMs: now() - t,
    }
  },

  DECIDE: async (ctx) => {
    const t = now()
    const leads = Number(ctx.facts.leadsCreated ?? 0)
    const best = Number(ctx.facts.bestScore ?? 0)
    if (!leads) {
      return {
        outcome: "INSUFFICIENT_EVIDENCE",
        note: "قرار: صفر ليدز — إعادة تخطيط بمصادر بديلة (السياسة: مش بنكرر نفس الاستعلامين)",
        data: { decision: "REPLAN_ALT_SOURCES" },
        durationMs: now() - t,
      }
    }
    const decision = best >= 80 ? "PROCEED_SALES" : leads >= 3 ? "PROCEED_NURTURE" : "PROCEED_REVIEW"
    return {
      outcome: "SUCCESS",
      note: `قرار: ${decision} (${leads} ليد، أعلى=${best})`,
      data: { decision, leads, best },
      durationMs: now() - t,
    }
  },

  CONTACT: async (ctx) => {
    const t = now()
    // بوابة STRICT: مفيش إرسال مباشر من الخريطة — زيزو (بوابته النفسية/السياساتية) هو صاحب القرار
    const top = await db.lead.findMany({ where: { workspaceId: ctx.wsId, createdAt: { gte: ctx.graphCreatedAt } }, orderBy: { score: "desc" }, take: 3, select: { id: true, score: true } }).catch(() => [])
    return {
      outcome: "SUCCESS",
      note: top.length ? `تسليم ${top.length} ليد لزيزو للبادرية (بوابته هي اللي تقرر الإرسال — لا إرسال مزدوج)` : "مفيش ليدز للتسليم — زيزو مش هيبادر",
      data: { handoff: "ZIZO", leadIds: top.map((l) => l.id) },
      durationMs: now() - t,
    }
  },

  FOLLOWUP: async (ctx) => {
    const t = now()
    return {
      outcome: "SKIPPED",
      note: "المتابعة ملك سلاسل المتابعة الدائمة — الخريطة مش بتعمل فعل مزدوج",
      durationMs: now() - t,
    }
  },

  LEARN: async (ctx) => {
    const t = now()
    const leads = Number(ctx.facts.leadsCreated ?? 0)
    if (leads > 0) {
      const q = ctx.facts.queries?.[0]
      if (q) await recordLesson(ctx.wsId, ctx.facts.platforms?.[0] ?? "WEB", q, { qualityScore: Number(ctx.facts.avgScore ?? 0), source: "learned" }).catch(() => undefined)
    }
    return {
      outcome: "SUCCESS",
      note: `تثبيت التعلم: نتايج ${ctx.skills.length} مهارة مسجلة + ${leads > 0 ? "درس استعلام محفوظ" : "بدون درس (صفر ليدز)"}`,
      data: { leads, lessons: leads > 0 ? 1 : 0 },
      durationMs: now() - t,
    }
  },

  RECOVER: async (ctx) => {
    const t = now()
    const [paused, blocked] = await Promise.all([
      db.monitoredGroup.count({ where: { workspaceId: ctx.wsId, status: "PAUSED" } }).catch(() => 0),
      db.monitoredGroup.count({ where: { workspaceId: ctx.wsId, status: "BLOCKED" } }).catch(() => 0),
    ])
    return {
      outcome: "SUCCESS",
      note: `فحص صحة الحسابات: ${paused} جروب موقوف مؤقتًا، ${blocked} محجوب — المصادر البديلة متاحة`,
      data: { paused, blocked },
      factsPatch: { pausedGroups: paused },
      durationMs: now() - t,
    }
  },

  HUMAN_REVIEW: async (ctx) => {
    const t = now()
    return {
      outcome: "AUTH_REQUIRED",
      note: "العقدة تحتاج مراجعة بشرية — الخريطة متوقفة مؤقتًا عند نقطة البوابة دي",
      durationMs: now() - t,
    }
  },

  END: async (ctx) => {
    const t = now()
    return {
      outcome: "SUCCESS",
      note: `الخريطة خلصت: ${ctx.facts.leadsCreated ?? 0} ليد، أعلى درجة ${ctx.facts.bestScore ?? 0}`,
      durationMs: now() - t,
    }
  },
}

export function executorFor(type: NodeType): Executor | null {
  return EXECUTORS[type] ?? null
}

/** تنفيذ عقدة + تسجيل نتيجة كل مهارة استُخدمت فيها (حلقة التعلم 43.27) */
export async function executeNodeWithSkills(ctx: NodeCtx): Promise<NodeExecResult> {
  const executor = executorFor(ctx.type)
  if (!executor) {
    return { outcome: "MISSING_CAPABILITY", note: `مفيش منفذ لنوع العقدة ${ctx.type}`, durationMs: 0 }
  }
  const res = await executor(ctx)
  // تسجيل نتايج المهارات المدمجة (43.21: EXECUTE ≠ SUCCESS — النتيجة هي الحكم)
  const quality = ctx.type === "SCORE" ? Number(ctx.facts.avgScore ?? 0) : res.outcome === "SUCCESS" ? 80 : res.outcome === "PARTIAL" ? 50 : 10
  for (const s of ctx.skills) {
    const outcomeForSkill = res.outcome === "SUCCESS" ? "SUCCESS" : res.outcome === "PARTIAL" ? "PARTIAL" : "FAILURE"
    await recordSkillOutcome({
      workspaceId: ctx.wsId,
      skillKind: s.kind as SkillKind,
      skillKey: s.key,
      graphId: ctx.graphId,
      nodeId: ctx.nodeId,
      outcome: outcomeForSkill,
      quality,
      latencyMs: res.durationMs,
      notes: res.note.slice(0, 200),
    }).catch(() => undefined)
  }
  return res
}

/** أداة: هل النوع ده محتاج استرجاع مهارات أصلًا؟ (NO NEED → NO SKILL — 43.2) */
export function nodeNeedsSkills(type: string): boolean {
  return ["ANALYZE", "PLAN", "DISCOVER", "ENRICH", "QUALIFY", "SCORE", "RESEARCH", "DECIDE", "CONTACT", "RETRIEVE_SKILLS"].includes(type)
}
