// LeadOS — GitSkills Retriever (مواصفة 43.1 / 43.7 / 43.2)
// المكتبات الخارجية (GitSkills 3.8M + ClawHub) مكتبة معرفة عالمية — مش قائمة ثابتة.
// ممنوع تحميل كل المكتبة أو نسخ ملايين المهارات للبرومبت. بدلًا من ذلك:
//
//   GitSkills Retriever → Task Understanding → Node Understanding →
//   Skill Retrieval → Skill Ranking → Trust / Compatibility Gate → Skill Activation
//
// القاعدة: NO NEED → NO SKILL / NEED → SEARCH / MATCH → RANK / HIGH → LOAD / LOW → IGNORE.
// ترتيب الأولوية (43.12): CORE فوق المكتبات الخارجية دايمًا — والسياسة فوق الكل.
import { db } from "@/lib/db"
import { aiEmbed, cosineSim } from "@/lib/ai"
import { SKILLS } from "@/lib/skills/registry"
import { DSI_BUDGET } from "./budget"
import { assessSkillTrust, trustCacheValid, contentHashOf } from "./trust"
import { recordRetrieval, skillUtilities, type SkillKind } from "./memory"

// ═══ المرحلة 1 — Task Parsing (حتمية — بدون نداء AI) ═══
export interface ParsedTask {
  domain: string // restaurants-cafes | clinics | retail | gyms | salons | real-estate | pharmacies | general
  action: string // discover | qualify | enrich | research | contact | analyze | verify | followup | recover | decide | learn
  platform: string // FACEBOOK | GOOGLE_MAPS | INSTAGRAM | LINKEDIN | WEB | ... | ""
  dataType: string // leads | contacts | businesses | posts | buying-signals
  constraints: string[] // كلمات القيد (مدينة/نيش/خدمة)
  requiredTools: string[]
  riskLevel: "LOW" | "MEDIUM" | "HIGH"
  language: string
  region: string
}

const PLATFORM_RES: Array<[RegExp, string]> = [
  [/فيسبوك|جروبات?|facebook|fb groups/i, "FACEBOOK"],
  [/خرايط|خريطة|google\s*maps|maps/i, "GOOGLE_MAPS"],
  [/انستجرام|إنستجرام|instagram/i, "INSTAGRAM"],
  [/لينكد|linkedin/i, "LINKEDIN"],
  [/ريديت|reddit/i, "REDDIT"],
  [/تيك\s?توك|tiktok/i, "TIKTOK"],
  [/يوتيوب|youtube/i, "YOUTUBE"],
  [/تليجرام|telegram/i, "TELEGRAM"],
  [/واتس|whatsapp/i, "WHATSAPP"],
]

const DOMAIN_RES: Array<[RegExp, string]> = [
  [/كافيه|قهوة|كوفي|مطعم|مطاعم|restaurant|cafe|coffee/i, "restaurants-cafes"],
  [/عياد|دكتور|أسنان|اسنان|clinic|dentist|طبيب/i, "clinics"],
  [/متجر|تجارة|بيع|retail|store|ecommerce/i, "retail"],
  [/جيم|نادي|gym|fitness/i, "gyms"],
  [/صالون|حلاق|barber|تجميل/i, "salons"],
  [/عقار|عقارات|real\s*estate/i, "real-estate"],
  [/صيدلي|pharmacy/i, "pharmacies"],
  [/شركة|شركات|startup|برمج/i, "companies"],
]

const SERVICE_RES: Array<[RegExp, string]> = [
  [/كروت?\s?نت|انترنت|نت\b|internet[\s-]?card/i, "internet-cards"],
  [/كاشير|pos|نقاط\s?بيع/i, "pos"],
  [/موقع|website|ويب/i, "website"],
  [/تطبيق|app\b|موبايل/i, "mobile-app"],
  [/حجز|booking|reservation/i, "booking"],
  [/تسويق|اعلانات|إعلانات|marketing|ads/i, "digital-marketing"],
  [/دليفري|طلبات|delivery|ordering/i, "delivery"],
  [/crm|إدارة عملاء|ادارة عملاء/i, "crm"],
]

const ACTION_RES: Array<[RegExp, string]> = [
  [/ qualifier|تأهيل|تصنيف|classify|qualify/i, "qualify"],
  [/إثراء|اثراء|enrich|بيانات تواصل|تليفونات|ايميلات|contacts?\b/i, "enrich"],
  [/بحث عميق|research|تحليل منافس|deep\s?research/i, "research"],
  [/تواصل|رسائل|outreach|contact|ابعث/i, "contact"],
  [/متابعة|follow\s?up|تابع/i, "followup"],
  [/صيد|اكتشاف|ابحث|find|discover|search/i, "discover"],
]

const STOPWORDS = new Set([
  "في","من","على","عن","الى","إلى","اللي","علي","مع","ده","دي","التي","الذي","يكون","تكون","ان","إن","او","أو","تحتاج","محتاج","محتاجة","عايز","عايزين",
  "the","a","an","for","with","that","need","needs","looking","who","are","in","on","of","to","and","or","find","get","want",
])

export function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )]
}

/** فهم المهمة + العقدة (43.7 Stage 1) — حتمي وسريع، وصفر تكلفة AI */
export function parseTaskObjective(objective: string, nodeType?: string): ParsedTask {
  const platform = PLATFORM_RES.find(([re]) => re.test(objective))?.[1] ?? ""
  const domain = DOMAIN_RES.find(([re]) => re.test(objective))?.[1] ?? "general"
  const service = SERVICE_RES.find(([re]) => re.test(objective))?.[1] ?? ""
  const action =
    (nodeType && NODE_ACTION[nodeType]) ||
    ACTION_RES.find(([re]) => re.test(objective))?.[1] ||
    "discover"
  const dataType = /نيه|شراء|intent|signal/i.test(objective) ? "buying-signals" : action === "enrich" ? "contacts" : action === "qualify" ? "posts" : "leads"
  const constraints = tokenize(objective).slice(0, 8)
  return {
    domain,
    action,
    platform,
    dataType,
    constraints: service && !constraints.includes(service) ? [...constraints, service] : constraints,
    requiredTools: platform ? [platform] : [],
    riskLevel: action === "contact" ? "MEDIUM" : "LOW",
    language: /[\u0600-\u06FF]/.test(objective) ? "ar" : "en",
    region: /مصر|مصري|cairo|egypt/i.test(objective) ? "EG" : "",
  }
}

const NODE_ACTION: Record<string, string> = {
  OBSERVE: "analyze",
  ANALYZE: "analyze",
  PLAN: "plan",
  RETRIEVE_SKILLS: "discover",
  DISCOVER: "discover",
  VERIFY: "verify",
  ENRICH: "enrich",
  QUALIFY: "qualify",
  SCORE: "score",
  RESEARCH: "research",
  DECIDE: "decide",
  CONTACT: "contact",
  FOLLOWUP: "followup",
  LEARN: "learn",
  RECOVER: "recover",
  HUMAN_REVIEW: "verify",
  END: "analyze",
}

// ═══ المرشح والترتيب ═══
export interface CandidateSkill {
  kind: SkillKind
  key: string
  name: string
  description: string
  body: string
  tags: string[]
  // منشأ (43.10):
  repository: string
  skillPath: string
  sourceUrl: string
  contentHash: string
  license: string
  trustScore: number
  // مكونات الترتيب (43.7 Stage 4):
  semantic: number | null // تشابه دلالي 0-1 (null = مفيش إيمبدنج النهاردة)
  taskRelevance: number // تطابق لغوي مع الهدف 0-1
  platformRelevance: number // 0-1
  quality: number // 0-1 من وزن التعلم
  successHistory: number // 0-1 من نتايج حقيقية
  recency: number // 0-1
  compatibility: number // أولوية المصدر (CORE فوق الخارجي — 43.12)
  finalScore: number
  selectionReason?: string
  rejectionReason?: string
}

export interface SelectedSkillRef {
  kind: SkillKind
  key: string
  name: string
  finalScore: number
  trustScore: number
  repository: string
  skillPath: string
  sourceUrl: string
  contentHash: string
  license: string
  selectionReason: string
  contextLine: string // السطر الجاهز للبرومبت (progressive disclosure)
}

export interface RetrievalResult {
  parsed: ParsedTask
  selected: SelectedSkillRef[]
  rejected: Array<{ key: string; name: string; kind: string; reason: string; finalScore: number }>
  candidatesChecked: number
  semanticUsed: boolean
  budgetMs: number
}

function lexicalScore(tokens: string[], hay: string): number {
  if (!tokens.length) return 0
  const low = hay.toLowerCase()
  const hits = tokens.filter((t) => low.includes(t)).length
  return hits / tokens.length
}

function platformScore(platform: string, hay: string, tags: string[]): number {
  if (!platform) return 0.35 // مهارة عامة بتصلح لأي منصة بنص الدرجة
  const low = `${hay} ${tags.join(" ")}`.toLowerCase()
  if (low.includes(platform.toLowerCase())) return 1
  return low.includes(platform.slice(0, 4).toLowerCase()) ? 0.6 : 0.1
}

/** خط الاسترجاع الكامل لعقدة واحدة — كل الميزانيات محترمة، وفشل أي مرحلة مش بيفشّل العقدة */
export async function retrieveSkillsForNode(opts: {
  workspaceId: string
  objective: string // هدف العقدة (Node Understanding)
  nodeType: string
  graphId?: string
  nodeId?: string
  taskId?: string
  maxSkills?: number
}): Promise<RetrievalResult> {
  const started = Date.now()
  const parsed = parseTaskObjective(opts.objective, opts.nodeType)
  const tokens = tokenize(`${opts.objective} ${parsed.domain} ${parsed.dataType}`)
  const rejected: RetrievalResult["rejected"] = []
  let semanticUsed = false

  // ═══ المرحلة 2 — Candidate Retrieval (CORE + المكتبتين العالميتين بالتوازي) ═══
  // CORE أصلًا في الباندل — بيتحفظ في الذاكرة، والخارجي من المكتبة المحلية المشتركة
  // (المحصود مسبقًا من GitSkills 3.8M وClawHub — الاسترجاع بيتم من الفهرس المحلي،
  // مفيش تحميل مكتبة وقت التشغيل — 43.1 حرفيًا).
  const coreCandidates: CandidateSkill[] = SKILLS.filter((s) => {
    if (!s.platform || !s.description) return false
    const hay = `${s.name} ${s.description} ${s.body.slice(0, 600)}`.toLowerCase()
    return (
      (parsed.platform && hay.includes(parsed.platform.toLowerCase())) ||
      lexicalScore(tokens, `${s.name} ${s.description} ${s.body.slice(0, 1500)}`) >= 0.12
    )
  }).map((s) => ({
    kind: "CORE" as const,
    key: `CORE:${s.platform}`,
    name: s.name,
    description: s.description,
    body: s.body,
    tags: [s.platform.toLowerCase()],
    repository: "leados/skills-bundle",
    skillPath: s.path,
    sourceUrl: s.path,
    contentHash: contentHashOf(s.body),
    license: "MIT",
    trustScore: 100,
    semantic: null,
    taskRelevance: lexicalScore(tokens, `${s.name} ${s.description} ${s.body.slice(0, 1500)}`),
    platformRelevance: platformScore(parsed.platform, `${s.name} ${s.description}`, [s.platform.toLowerCase()]),
    quality: 1,
    successHistory: 0.5,
    recency: 0.6,
    compatibility: 1.15, // أولوية CORE (43.12)
    finalScore: 0,
  }))

  let gitRows: Awaited<ReturnType<typeof db.gitSkill.findMany>> = []
  let hubRows: Awaited<ReturnType<typeof db.hubSkill.findMany>> = []
  try {
    ;[gitRows, hubRows] = await Promise.all([
      db.gitSkill.findMany({
        where: { status: "ACTIVE" },
        orderBy: [{ weight: "desc" }, { relevance: "desc" }],
        take: 60,
      }),
      db.hubSkill.findMany({
        where: { status: "ACTIVE" },
        orderBy: [{ weight: "desc" }, { relevance: "desc" }],
        take: 40,
      }),
    ])
  } catch { /* قاعدة تعطلت → CORE يكفي (43.28 #21) */ }

  // فلترة لغوية سريعة قبل الترتيب الكامل (سقف المرشحين — 43.19)
  const extRaw = [
    ...gitRows.map((r) => ({ kind: "GITSKILLS" as const, key: r.path, name: r.name, description: r.description, body: r.body, tags: r.tags.split(",").filter(Boolean), repository: r.repo, skillPath: r.path, sourceUrl: `https://github.com/${r.repo}/blob/main/${r.path}`, contentHash: r.contentHash, license: r.license, trustScore: r.trustScore, status: r.status, weight: r.weight, useCount: r.useCount, leadCount: r.leadCount, updatedAt: r.updatedAt })),
    ...hubRows.map((r) => ({ kind: "CLAWHUB" as const, key: r.slug, name: r.name, description: r.summary, body: r.body, tags: r.tags.split(",").filter(Boolean), repository: "clawhub.ai", skillPath: r.slug, sourceUrl: r.sourceUrl, contentHash: r.contentHash, license: r.license, trustScore: r.trustScore, status: r.status, weight: r.weight, useCount: r.useCount, leadCount: r.leadCount, updatedAt: r.updatedAt })),
  ]
  const lexicalHit = extRaw.filter((c) => {
    const hay = `${c.name} ${c.description} ${c.tags.join(" ")} ${c.body.slice(0, 800)}`
    return lexicalScore(tokens, hay) >= 0.1 || (parsed.platform && hay.toLowerCase().includes(parsed.platform.toLowerCase()))
  })
  const prefiltered = lexicalHit.sort((a, b) => b.weight - a.weight).slice(0, DSI_BUDGET.maxRetrievalCandidates)

  // ذاكرة الاستخدام (43.11) — معدلات نجاح حقيقية بتدخل الترتيب
  const utilities = await skillUtilities(opts.workspaceId, extRaw.slice(0, 100).map((c) => c.key)).catch(() => ({} as Record<string, { successRate: number; attempts: number }>))

  const now = Date.now()
  const extCandidates: CandidateSkill[] = prefiltered.map((c) => {
    const ut = utilities[c.key]
    const ageDays = (now - c.updatedAt.getTime()) / 86_400_000
    return {
      kind: c.kind,
      key: c.key,
      name: c.name,
      description: c.description,
      body: c.body,
      tags: c.tags,
      repository: c.repository,
      skillPath: c.skillPath,
      sourceUrl: c.sourceUrl,
      contentHash: c.contentHash,
      license: c.license,
      trustScore: c.trustScore,
      semantic: null,
      taskRelevance: lexicalScore(tokens, `${c.name} ${c.description} ${c.tags.join(" ")} ${c.body.slice(0, 800)}`),
      platformRelevance: platformScore(parsed.platform, `${c.name} ${c.description}`, c.tags),
      quality: Math.min(1, c.weight / 3),
      successHistory: ut && ut.attempts >= 2 ? ut.successRate : Math.min(1, c.leadCount / Math.max(c.useCount, 1) || 0.15),
      recency: Math.max(0, 1 - ageDays / 30),
      compatibility: c.kind === "CLAWHUB" ? 1.0 : 0.95, // ترتيب الأولوية بعد CORE
      finalScore: 0,
    }
  })

  // ═══ التشابه الدلالي (43.7 Stage 2 — semantic similarity) — بيتعطل بأمان لو مفيش إيمبدنج ═══
  const all = [...coreCandidates, ...extCandidates]
  let embedDone = false
  try {
    const texts = [opts.objective, ...all.map((c) => `${c.name}. ${c.description}`.slice(0, 400))]
    const res = await aiEmbed(texts, { inputType: "passage" })
    if (res?.vectors?.length === texts.length) {
      const qv = res.vectors[0]
      for (let i = 0; i < all.length; i++) {
        all[i].semantic = Math.max(0, cosineSim(qv, res.vectors[i + 1]))
      }
      embedDone = true
      semanticUsed = true
    }
  } catch { /* بدون دلالي → لغوي بس (43.28 #20) */ }

  // ═══ المرحلة 4 — Ranking: finalSkillScore مكوّن موزون ═══
  for (const c of all) {
    const sem = c.semantic ?? 0
    const parts = [
      { w: 0.34, v: sem },
      { w: 0.20, v: c.taskRelevance },
      { w: 0.14, v: c.platformRelevance },
      { w: 0.12, v: c.quality },
      { w: 0.10, v: c.successHistory },
      { w: 0.05, v: c.recency },
      { w: 0.05, v: c.trustScore / 100 },
    ]
    const sumW = embedDone ? 1 : 1 - 0.34 // بدون دلالي: بنعيد توزيع وزنه
    c.finalScore = (parts.reduce((a, p) => a + p.w * p.v, 0) / sumW) * c.compatibility
  }
  all.sort((a, b) => b.finalScore - a.finalScore)

  // ═══ المرحلة 3 + 5 — Trust Gate ثم الاختيار (Minimum Sufficient Skill Set) ═══
  // كوتية المهارات الخارجية للمهمة كلها (43.19) — بتتحسب من عقد الخريطة الحية
  let externalUsed = 0
  if (opts.graphId) {
    try {
      const nodes = await db.taskGraphNode.findMany({ where: { graphId: opts.graphId }, select: { selectedSkills: true } })
      const keys = new Set<string>()
      for (const n of nodes) {
        for (const s of (n.selectedSkills as SelectedSkillRef[] | null) ?? []) {
          if (s.kind && s.kind !== "CORE") keys.add(`${s.kind}:${s.key}`)
        }
      }
      externalUsed = keys.size
    } catch { externalUsed = 0 }
  }
  let externalBudgetLeft = Math.max(0, DSI_BUDGET.maxSkillsPerTask - externalUsed)
  const maxSkills = Math.min(opts.maxSkills ?? DSI_BUDGET.maxSkillsPerNode, DSI_BUDGET.maxSkillsPerNode)

  const selected: SelectedSkillRef[] = []
  for (const c of all) {
    if (selected.length >= maxSkills) break
    if (c.finalScore < DSI_BUDGET.minFinalScore) {
      if (selected.length === 0 && rejected.length < 3) rejected.push({ key: c.key, name: c.name, kind: c.kind, reason: `الصلة أقل من الحد (${c.finalScore.toFixed(2)} < ${DSI_BUDGET.minFinalScore})`, finalScore: c.finalScore })
      continue
    }
    // بوابة الثقة للخارجي وقت التفعيل — CACHE HIT ≠ PERMANENT TRUST (43.8/43.18)
    if (c.kind !== "CORE") {
      if (externalBudgetLeft <= 0) {
        rejected.push({ key: c.key, name: c.name, kind: c.kind, reason: "كوتية المهارات الخارجية للمهمة خلصت", finalScore: c.finalScore })
        continue
      }
      if (c.trustScore < DSI_BUDGET.minTrustScore) {
        rejected.push({ key: c.key, name: c.name, kind: c.kind, reason: `ثقة منخفضة (${c.trustScore} < ${DSI_BUDGET.minTrustScore})`, finalScore: c.finalScore })
        continue
      }
      // البصمة متغيرة/ناقصة؟ إعادة فحص فورية وتثبيت النتيجة على الصف
      if (!c.contentHash) {
        const t = assessSkillTrust({ kind: c.kind, name: c.name, description: c.description, body: c.body, sourceRef: c.skillPath, license: c.license })
        c.contentHash = contentHashOf(`${c.name}\n${c.description}\n${c.body}`)
        c.trustScore = t.score
        try {
          if (c.kind === "GITSKILLS") await db.gitSkill.updateMany({ where: { path: c.key }, data: { contentHash: c.contentHash, trustScore: t.score, status: t.verdict === "FAIL" ? "REJECTED" : "ACTIVE" } })
          else await db.hubSkill.updateMany({ where: { slug: c.key }, data: { contentHash: c.contentHash, trustScore: t.score, status: t.verdict === "FAIL" ? "REJECTED" : "ACTIVE" } })
        } catch { /* best-effort */ }
        if (t.verdict === "FAIL") {
          rejected.push({ key: c.key, name: c.name, kind: c.kind, reason: `فشل بوابة الثقة: ${t.reasons[0] ?? "غير معروف"}`, finalScore: c.finalScore })
          continue
        }
      }
      externalBudgetLeft--
    }
    const why = [
      c.semantic != null ? `دلالي ${c.semantic.toFixed(2)}` : null,
      `لغوي ${c.taskRelevance.toFixed(2)}`,
      parsed.platform ? `منصة ${parsed.platform}` : "عام",
      c.successHistory >= 0.3 ? `نجاح تاريخي ${(c.successHistory * 100).toFixed(0)}%` : null,
    ].filter(Boolean).join(" + ")
    c.selectionReason = why
    selected.push({
      kind: c.kind,
      key: c.key,
      name: c.name,
      finalScore: Number(c.finalScore.toFixed(3)),
      trustScore: c.trustScore,
      repository: c.repository,
      skillPath: c.skillPath,
      sourceUrl: c.sourceUrl,
      contentHash: c.contentHash,
      license: c.license || "غير معلنة",
      selectionReason: why,
      contextLine: `- [${c.kind}] ${c.name}: ${c.description.slice(0, 140)}`,
    })
  }
  // المرفوضون: أعلى المرشحين اللي ما اتفعّلوش — بأسبابهم (43.28 #19)
  for (const c of all) {
    if (rejected.length >= 6) break
    if (selected.some((s) => s.key === c.key)) continue
    rejected.push({ key: c.key, name: c.name, kind: c.kind, reason: rejectionReason(c, selected.length >= maxSkills), finalScore: c.finalScore })
  }

  const result: RetrievalResult = {
    parsed,
    selected,
    rejected,
    candidatesChecked: all.length,
    semanticUsed,
    budgetMs: Date.now() - started,
  }

  // سجل المنشأ الكامل (43.10) — «ليه اتستخدمت؟ وليه اترفضت؟»
  await recordRetrieval({
    workspaceId: opts.workspaceId,
    graphId: opts.graphId,
    nodeId: opts.nodeId,
    taskId: opts.taskId,
    objective: opts.objective,
    parsed,
    candidates: all.slice(0, 12).map((c) => ({ key: c.key, kind: c.kind, name: c.name, final: Number(c.finalScore.toFixed(3)), sem: c.semantic, lex: Number(c.taskRelevance.toFixed(2)), trust: c.trustScore })),
    selected: selected.map((s) => ({ key: s.key, kind: s.kind, name: s.name, score: s.finalScore, reason: s.selectionReason, repository: s.repository, path: s.skillPath, hash: s.contentHash, license: s.license, trustScore: s.trustScore })),
    rejected,
    reason: selected.length ? `اختيار ${selected.length} مهارة (أقل مجموعة كافية) لـ${opts.nodeType}` : "NO NEED → NO SKILL — مفيش مهارة عدّت حد الصلة",
  }).catch(() => undefined)

  return result
}

// helpers صغيرة — تُبقي الكود أعلى قابلية للقراءة
function rejectionReason(c: CandidateSkill, quotaFull: boolean): string {
  if (quotaFull) return "سقف مهارات العقدة/المهمة اتملّى (Minimum Sufficient Set)"
  if (c.finalScore < DSI_BUDGET.minFinalScore) return `الصلة أقل من الحد (${c.finalScore.toFixed(2)})`
  if (c.semantic != null && c.semantic < 0.3) return "تشابه دلالي ضعيف"
  if (c.taskRelevance < 0.1) return "لا صلة لغوية بالهدف"
  if (c.trustScore < DSI_BUDGET.minTrustScore) return "ثقة منخفضة"
  return "درجة نهائية أقل من المختارين"
}

/** بحث حر في المكتبتين (لأداة search_gitskills) — لغوي + بوابة ثقة، بدون AI */
export async function searchExternalSkills(query: string, k = 5): Promise<CandidateSkill[]> {
  const tokens = tokenize(query)
  const out: CandidateSkill[] = []
  try {
    const [git, hub] = await Promise.all([
      db.gitSkill.findMany({ where: { status: "ACTIVE" }, orderBy: [{ weight: "desc" }, { relevance: "desc" }], take: 40 }),
      db.hubSkill.findMany({ where: { status: "ACTIVE" }, orderBy: [{ weight: "desc" }, { relevance: "desc" }], take: 30 }),
    ])
    for (const r of [...git.map((x) => ({ ...x, kind: "GITSKILLS" as const, slugOrPath: x.path, src: `https://github.com/${x.repo}/blob/main/${x.path}` })), ...hub.map((x) => ({ ...x, kind: "CLAWHUB" as const, slugOrPath: x.slug, src: x.sourceUrl, description: x.summary }))]) {
      const hay = `${r.name} ${r.description} ${r.tags} ${r.body.slice(0, 600)}`
      const score = lexicalScore(tokens, hay)
      if (score < 0.08) continue
      out.push({
        kind: r.kind, key: r.slugOrPath, name: r.name, description: r.description, body: r.body,
        tags: r.tags.split(",").filter(Boolean), repository: r.kind === "GITSKILLS" ? r.repo : "clawhub.ai",
        skillPath: r.slugOrPath, sourceUrl: r.src, contentHash: r.contentHash, license: r.license, trustScore: r.trustScore,
        semantic: null, taskRelevance: score, platformRelevance: 0, quality: Math.min(1, r.weight / 3),
        successHistory: Math.min(1, r.leadCount / Math.max(r.useCount, 1) || 0.15), recency: 0.5, compatibility: 1,
        finalScore: score,
      })
    }
  } catch { /* best-effort */ }
  return out.sort((a, b) => b.finalScore - a.finalScore).slice(0, k)
}
