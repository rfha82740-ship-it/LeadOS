// LeadOS — DB-backed Job Queue + Orchestrator (doc §8, §52)
// Replaces Redis/Celery for the free-tier deployment: the Job table IS the queue.
// A cron ping hits /api/cron/tick which calls processTick() — idempotent, batched.
import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { asArray } from "@/lib/constants"
import { buildSearchPlan, runDiscovery, expandSourceTypes, competitorAdQueries, detectAdPixels, type DiscoveredItem } from "@/lib/discovery"
import { classifyContent } from "@/lib/classification"
import { findDuplicateLead, normalizePhone } from "@/lib/dedup"
import { recomputeLeadScore } from "@/lib/scoring"
import { runDeepResearch } from "@/lib/research"
import { enrollLead, processDueEnrollments, reactivationSweep } from "@/lib/sequences"
import { PLATFORM_SITES, PLATFORM_QUERY_SHAPES } from "@/lib/discovery"
import { skillStatsSnapshot, recordSkillRun, recordSkillResults, recordSkillDryRun, recordSkillNoLeads, recordSkillLead, recordLesson } from "@/lib/skills/learning"
import { SKILL_BY_PLATFORM } from "@/lib/skills/registry"
import { queriesForPlatform, freshAiQueries, aiSelectPlatforms } from "@/lib/skills/selector"
import { graphPlatformPriorities } from "@/lib/skills/graph"
import { harvestGitSkills, rewardGitSkillsTactics } from "@/lib/skills/gitskills"
import { harvestClawHub, rewardHubTactics } from "@/lib/skills/hub"
const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
/** ميزانية وقت الجوبة الواحدة — لازم تخلص قبل maxDuration=120 بتاع الـtick */
// (كانت 110ث — الجوبة الواحدة بتاكل العنب والجوبة التانية كانت بيموت نصها في الـtimeout)
const DISCOVERY_TIME_BUDGET_MS = 75_000

export async function enqueueJob(
  workspaceId: string,
  type: string,
  payload: Prisma.InputJsonValue,
  priority = 50,
  scheduledAt?: Date,
) {
  return db.job.create({
    data: { workspaceId, type: type as never, payload, priority, scheduledAt: scheduledAt ?? new Date() },
  })
}

/** Claim up to N queued jobs (atomic-ish: lock via lockedAt + status). */
async function claimJobs(limit: number) {
  const jobs = await db.job.findMany({
    where: {
      status: { in: ["QUEUED", "RETRYING"] },
      scheduledAt: { lte: new Date() },
    },
    orderBy: [{ priority: "desc" }, { scheduledAt: "asc" }],
    take: limit,
  })
  const claimed: string[] = []
  for (const job of jobs) {
    const updated = await db.job.updateMany({
      where: { id: job.id, status: { in: ["QUEUED", "RETRYING"] } },
      data: { status: "RUNNING", startedAt: new Date(), lockedAt: new Date(), workerId: WORKER_ID, attempts: { increment: 1 } },
    })
    if (updated.count > 0) claimed.push(job.id)
  }
  if (!claimed.length) return []
  return db.job.findMany({ where: { id: { in: claimed } } })
}

interface DiscoveryPayload {
  ruleId?: string
  sourceId?: string
  query?: string
  sourceTypes?: string[]
  fullSweep?: boolean // مسح شامل: كل المنصات في جوبة واحدة — لبذر الـ16 مصدر فورًا
}

/** Process one DISCOVERY job: search → normalize → dedup → classify → score → maybe research.
 * ميزانية وقت: الـtick ليه maxDuration=120s على Vercel — الجوب اللي يعديها بيتقتل نص شغل
 * ويرجع RUNNING معلق للأبد (كان بيحصل مع المسح الشامل + تصنيف AI). الدايدلاين بيخلي
 * الجوب يقفل نفسه بنجاح جزئي — والباقي بياخده الجوب الجاي (الديديب بيوفر التكرار). */
async function processDiscoveryJob(jobId: string): Promise<string> {
  const jobStart = Date.now()
  const deadline = jobStart + (DISCOVERY_TIME_BUDGET_MS - 20_000) // احتفظ 20s للإقفال والتسجيل
  const job = await db.job.findUnique({ where: { id: jobId } })
  if (!job) return "job missing"
  const wsId = job.workspaceId
  const payload = (job.payload ?? {}) as DiscoveryPayload

  let rule: { id: string; name: string; cities: unknown; industries: unknown; services: unknown; keywords: unknown; countries: unknown; sourceTypes: unknown; startResearch: boolean; researchDepth: string; minLeadScore: number; workspaceId: string; priority: number } | null = null
  if (payload.ruleId) {
    rule = await db.searchRule.findUnique({ where: { id: payload.ruleId } })
  }
  const plan = rule
    ? buildSearchPlan(rule)
    : { queries: [payload.query ?? "عملاء محتاجين خدمات برمجية في مصر"], sources: ["web"], freshness_days: 14, min_score: 50, goal: "ad-hoc", language: ["ar", "en"] }

  // موجة المنصات الكاملة: الأنواع المسجلة + دوران بالساعة على باقي المنصات المبنية (شغّل باقي المصادر)
  // fullSweep: كل المنصات مرة واحدة — بذرة فورية للـ16 مصدر
  // ═══ عقل المهارات (doc §3) ═══
  // 1) أوزان متعلمة من السوق الحقيقي: مين بيجيب ليدز فعلًا للورشة دي
  // 2) إعادة ترتيب بالـAI (تكتوم 30 دقيقة) — «العقل اللي بيختار الاسكل المناسب للنيش»
  const declared = payload.sourceTypes ?? asArray(rule?.sourceTypes)
  const niche = (plan.queries[0] ?? "عملاء في مصر").trim()
  const stats = await skillStatsSnapshot(wsId).catch(() => ({} as Record<string, { leads: number; runs: number; weight: number }>))
  // ═══ خريطة المهارات (skill-map): الأولويات من الجراف الحتمي — بيشتغل كل نبضة من غير ما يوقع ═══
  // الجراف = وزن متعلم × تكتيكات GitSkills المرتبطة × شركاء co-use المنتِجين × صلة النيش من الدروس
  const graphPriorities = await graphPlatformPriorities(wsId, niche).catch(() => ({}) as Record<string, number>)
  const weighted: Record<string, number> = {}
  const allPlatforms = Object.keys(PLATFORM_SITES)
  for (const p of allPlatforms) {
    const learned = stats[p]?.weight ?? 1
    const graph = graphPriorities[p] ?? learned
    // الدمج: 40% وزن متعلم مباشر + 60% قراءة الجراف (التكتيكات + الشركاء + صلة النيش)
    weighted[p] = Math.round((learned * 0.4 + graph * 0.6) * 100) / 100
  }
  let selectedBy = "skill-graph"
  // حق الجعان: مصادر صفر ليدز (أو أقدم ليد) بياخدوا مقعد الدوران مضمون — الاستكشاف ميتوقفش
  const starved = allPlatforms
    .filter((p) => (stats[p]?.leads ?? 0) === 0)
    .sort((a, b) => (stats[a]?.runs ?? 0) - (stats[b]?.runs ?? 0))
    .slice(0, 3)
  const aiPicks: string[] = [] // مين الـAI اختار — للسجل الموجز لكل مهمة (doc §3)
  try {
    const free = ["REDDIT", "TELEGRAM", "RSS"]
    const declaredSet = new Set(declared.filter(Boolean))
    const candidates = Object.keys(PLATFORM_SITES).filter((t) => !declaredSet.has(t) && !free.includes(t))
    const picks = await aiSelectPlatforms(wsId, niche, candidates, 4, stats)
    if (picks?.length) {
      for (const [i, p] of picks.entries()) weighted[p] = Math.max(weighted[p] ?? 1, 5 - i)
      aiPicks.push(...picks)
      selectedBy = "ai-selector"
    }
  } catch { /* الـAI وقع — جراف المهارات والأوزان المتعلمة تكفي */ }
  let sourceTypes = expandSourceTypes(declared, { all: Boolean(payload.fullSweep), weighted, starved })
  // ═══ أولوية الإعلانات في المسح الشامل ═══
  // سقف البحث (18-20) ممكن يخلص قبل أواخر الموجة بسبب الأدابترز الصامية — فأعلى المنصات نية
  // (مكتبات الإعلانات + فريلانس + وظايف) بتتصعد أول الموجة — الأولوية بالترتيب مش بالحظ
  if (payload.fullSweep) {
    const adsPriority = ["ADS_LIBRARY", "FREELANCE", "JOBS"]
    sourceTypes = [...adsPriority.filter((p) => sourceTypes.includes(p)), ...sourceTypes.filter((p) => !adsPriority.includes(p))]
  }
  // سرقة العملاء من المنافسين: لو في منافسين مسجلين، استعلامات «بديل/توصية + المنافس» بتتقدم الأول
  // — اللي بيسأل عن بديل منافس = عميل جاهز للتحويل حالًا
  let queries = plan.queries
  // ═══ سرقة إعلانات المنافسين الممولة (طلب: من كل مصادر الإعلانات) ═══
  // لكل منافس مسجل: استعلامات مكتبات الإعلانات (ميتا + جوجل/يوتيوب + تيك توك + لينكدإن)
  // — ADS_LIBRARY بياخد مقعد مضمون في الموجة لو في منافسين، وكل نتيجة = AD_SPENDER تلقائيًا
  let adPoach: string[] = []
  const competitorAdEvidence: Array<{ name: string; site: string; channels: string[] }> = []
  try {
    const comps = await db.competitor.findMany({
      where: { competitor: { workspaceId: wsId } },
      include: { competitor: { select: { name: true, websiteUrl: true, id: true } } },
      take: 4,
    })
    const names = [...new Set(comps.map((c) => c.competitor?.name?.trim()).filter(Boolean))] as string[]
    if (names.length) {
      const poach = names.slice(0, 2).map((n) => `بديل ${n} توصية`) as string[]
      queries = [...poach, ...queries]
      adPoach = competitorAdQueries(names)
      if (adPoach.length && !sourceTypes.includes("ADS_LIBRARY")) sourceTypes.push("ADS_LIBRARY")
      // ═══ استطلاع المنافسين مباشرة: ماسح البيكسلات على مواقعهم ═══
      // قنوات إعلانات المنافس الحية = خريطة رسالته وميزانيته — بتتحفظ في Competitor.evidence
      for (const c of comps.slice(0, 4)) {
        const comp = c.competitor
        if (!comp?.websiteUrl) continue
        const channels = await detectAdPixels(comp.websiteUrl).catch(() => [] as string[])
        if (channels.length) {
          competitorAdEvidence.push({ name: comp.name, site: comp.websiteUrl, channels })
          await db.competitor.updateMany({
            where: { competitorId: comp.id },
            data: { evidence: { ...(typeof c.evidence === "object" && c.evidence ? c.evidence : {}), adChannels: channels, adChannelsCheckedAt: new Date().toISOString(), adEvidence: "pixel_scan" } },
          }).catch(() => undefined)
        }
      }
      if (competitorAdEvidence.length) {
        console.log(`[ads-poach] 🎯 إعلانات منافسين حية: ${competitorAdEvidence.map((e) => `${e.name} (${e.channels.join("+")})`).join(" | ")}`)
      }
    }
  } catch { /* بدون منافسين — البحث العادي */ }

  // ═══ ذاكرة الاستعلامات + حدّاد AI ═══
  // كل منصة بتاخد استعلاماتها المتعلمة (دروس جابت ليدز قبل كده) فوق الأشكال الثابتة
  // + منصة واحدة كل جوب (دوّارة بالساعة) بتاخد استعلامات AI جديدة للنيش — بتحفظ دروس
  await recordSkillRun(wsId, sourceTypes).catch(() => undefined)
  const queriesByType: Record<string, string[]> = {}
  for (const st of sourceTypes) {
    if (st === "GOOGLE_MAPS" || PLATFORM_QUERY_SHAPES[st]) {
      queriesByType[st] = await queriesForPlatform(wsId, st, niche).catch(() => [] as string[])
    }
  }
  // ═══ استعلامات إعلانات المنافسين أولًا في ADS_LIBRARY — قبل الأشكال الثابتة ═══
  // الأدابتر بيضيف سلاسل site: لمكتبات الإعلانات (ميتا/جوجل/تيك توك/لينكدإن) على استعلامات المنافسين دي
  if (adPoach.length) {
    queriesByType["ADS_LIBRARY"] = [...adPoach, ...(queriesByType["ADS_LIBRARY"] ?? [])].slice(0, 6)
  }
  let aiSmithTarget: string | null = null
  const smithPool = sourceTypes.filter((t) => PLATFORM_QUERY_SHAPES[t])
  if (smithPool.length) {
    const hour = Math.floor(Date.now() / 3_600_000)
    aiSmithTarget = smithPool[hour % smithPool.length]
    const fresh = await freshAiQueries(wsId, niche, aiSmithTarget).catch(() => null)
    if (fresh?.length) {
      queriesByType[aiSmithTarget] = [...new Set([...fresh, ...(queriesByType[aiSmithTarget] ?? [])])].slice(0, 5)
    }
  }

  // ═══ سجل الاسكلز المناسبة للمهمة دي (طلب: «مع كل مهمة أعرف أي الاسكلز المناسبة») ═══
  // كل منصة في الموجة: اسم الاسكل + ليه اتاختار + استعلاماتها الجاهزة — بيتسجل في SearchJob.metadata
  // وبيتعرض في كارت عقل المهارات + /api/skills (tasks) — الشفافية الكاملة لقرار الاختيار.
  const FREE_SET = new Set(["REDDIT", "TELEGRAM", "RSS"])
  const declaredSetAll = new Set(declared.filter(Boolean))
  const skillsUsed = sourceTypes.map((st) => {
    const skill = SKILL_BY_PLATFORM[st]
    const why = declaredSetAll.has(st)
      ? "من قاعدة البحث"
      : FREE_SET.has(st)
        ? "مجاني دايمًا (JSON بلا مفاتيح)"
        : st === "ADS_LIBRARY" && adPoach.length
          ? "سرقة إعلانات المنافسين الممولة"
          : aiPicks.includes(st)
          ? "اختيار AI للنيش"
          : starved.includes(st)
            ? "حق الجعان — صفر ليدز"
            : (weighted[st] ?? 0) >= 3
              ? "أعلى وزن (تعلم + جراف)"
              : "دوران الموجة"
    return {
      platform: st,
      skill: skill?.name ?? (st === "GOOGLE_MAPS" ? "maps-hunter" : null),
      why,
      weight: weighted[st] ?? null,
      aiSmith: st === aiSmithTarget,
      queries: (queriesByType[st] ?? []).slice(0, 3),
    }
  })

  // قسمة الميزانية: البحث له سقف خاص — لو أكلها كلها الابتلاع بياخد صفر وكل النتايج بتضيع في الديديب لاحقًا
  const searchDeadline = jobStart + 35_000
  const { items, adaptersUsed } = await runDiscovery(
    sourceTypes,
    queries,
    payload.fullSweep ? 10 : 4, // المسح الشامل محتاج مساحة أكبر عشان كل منصة تاخد نصيبها
    payload.fullSweep
      ? { maxSearches: 20, passes: 1, queriesByType, deadline: searchDeadline }
      : { queriesByType, deadline: searchDeadline },
  )
  const timeLeft = deadline - Date.now()
  // الابتلاع ضمن الميزانية كمان — التصنيف AI بياخد ~3s للعنصر
  const ingestable = timeLeft > 15_000 ? items : timeLeft > 0 ? items.slice(0, 6) : []
  if (ingestable.length < items.length) console.log(`[discovery] time budget: ingesting ${ingestable.length}/${items.length} — الباقي جوبات جاية`)

  // ═══ تغذية التعلم: نتايج كل مهارة (الليدز بتتحسب في الابتلاع — هون العناصر بس) ═══
  const byType: Record<string, number> = {}
  for (const it of items) if (it.viaType) byType[it.viaType] = (byType[it.viaType] ?? 0) + 1
  await recordSkillResults(wsId, byType).catch(() => undefined)
  for (const st of sourceTypes) {
    if (!byType[st]) await recordSkillDryRun(wsId, st).catch(() => undefined)
  }

  // Persist a SearchJob record for observability
  const source = payload.sourceId
    ? await db.source.findUnique({ where: { id: payload.sourceId } })
    : (await db.source.findFirst({ where: { workspaceId: wsId, status: "ACTIVE" } }))
  if (source) {
    await db.searchJob.create({
      data: {
        sourceId: source.id,
        searchRuleId: rule?.id,
        query: plan.queries[0],
        status: "SUCCESS",
        startedAt: new Date(Date.now() - 60000),
        completedAt: new Date(),
        resultCount: items.length,
        metadata: { adaptersUsed, plan: plan.queries, queriesByType, selectedBy, aiSmithTarget, byType, skills: skillsUsed, ...(competitorAdEvidence.length ? { competitorAdChannels: competitorAdEvidence } : {}) },
      },
    })
    await db.source.update({ where: { id: source.id }, data: { lastRunAt: new Date(), lastError: null } })
  }

  const ingest = source
    ? await ingestDiscoveredItems(wsId, source, rule, ingestable, deadline)
    : { created: 0, duplicates: 0, adPixelLeads: 0, leadsByPlatform: {} as Record<string, number> }
  // مهارات جابت عناصر من غير ليدز = هدم أخف (الليدز اتكافأت جوه الابتلاع)
  for (const st of sourceTypes) {
    if (!ingest.leadsByPlatform[st] && byType[st]) await recordSkillNoLeads(wsId, st).catch(() => undefined)
  }
  const took = ((Date.now() - jobStart) / 1000).toFixed(0)
  return `discovered=${items.length} ingested=${ingestable.length} leadsCreated=${ingest.created} duplicates=${ingest.duplicates} adPixelLeads=${ingest.adPixelLeads}${competitorAdEvidence.length ? ` competitorsAds=[${competitorAdEvidence.map((e) => `${e.name}:${e.channels.join("+")}`).join("; ")}]` : ""} took=${took}s adapters=${adaptersUsed.join(",") || "none"}`
}

export interface IngestRuleLite {
  id?: string
  startResearch?: boolean
  researchDepth?: string
}

// Noise patterns: scraped SERP titles / aggregator pages / clickbait ads — never businesses
const NOISE_PATTERNS: RegExp[] = [
  /^title\s+/i, // scraper artifact prefix
  /^(real\s+)?(estate\s+)?jobs?\s+in\s+.{3,60}(governorate|egypt|cairo|giza|alexandria)/i, // job aggregator listings
  /^(وظائف|وظيفة)\s+.{0,40}(مصر|القاهرة|الجيزة|الاسكندرية)/, // Arabic job aggregators
  /^(\s*#\w+\s*)+$/, // hashtag-only names
  /^https?:\/\/\S+$|^www\.\S+$|^\S+\.(com|net|org|eg|io)(\/\S*)?$/i, // URL as business name
  /^(try|swipe|check out|download now|subscribe|follow us|limited offer)\b/i, // clickbait
  /^(أفضل|افضل)\s*\d+\s|^best\s+\d+\s/i, // directory listicles "أفضل 302 دكتور..." — category pages, not businesses
  // عقارات وإيجارات من مجموعات فيسبوك — مش بيزنسات
  /^(شقه|شقة|غرفه|غرفة|استوديو|فيله|فيلا|أرض|ارض)\s/u,
  /^(محتاج|محتاجة|عايز|عاوز|مطلوب)\s+(شقه|شقة|غرفه|غرفة|استوديو)/u,
  /(للإيجار|للايجار|إيجار يومي|ايجار يومي|شقه مفروشه|شقة مفروشه|غرفه مفروشه|غرفة مفروشه)/u,
  // لاحقات نتائج البحث لصفحات شخصية: "فلان - LinkedIn" إلخ
  /\s[-–—]\s*(Facebook|LinkedIn|Instagram|YouTube|Twitter|X)\s*$/iu,
  // قواميس/ترجمة/ويكي وصفحات تعريفية — مش بيزنسات
  /cambridge|dictionary|wikipedia|wiktionary|reverso|traduction|المعنى|معنى\s*كلمة|قاموس/i,
  /^(what is|what's)\s+(this|the|a|an)\b/i, // أسئلة تعريفية عامة
]

/** Clean a SERP title into a usable business name (strip truncation artifacts). */
function cleanName(raw: string): string {
  return raw
    .replace(/[\u200E\u200F\u202A-\u202E]/g, "") // علامات اتجاه النص من نتائج SERP
    .replace(/^(title\s+)+/i, "")
    .replace(/\s*[-–—|]\s*(Facebook|LinkedIn|Instagram|YouTube|Twitter|X)\s*$/i, "")
    .replace(/\s*(\.\.\.|…)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Derive a clean business name from a social-platform profile URL handle. */
function socialHandleName(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, "")
    const seg = u.pathname.split("/").filter(Boolean)
    if (!seg.length) return null
    // instagram.com/<brand> | tiktok.com/@<brand> | x.com/<handle> | youtube.com/@<channel>
    if (/(^|\.)instagram\.com$|(^|\.)tiktok\.com$|(^|\.)(x|twitter)\.com$|(^|\.)youtube\.com$/.test(host)) {
      let name = seg[0].replace(/^@/, "")
      if (/^(p|reel|reels|watch|shorts|video|status|explore)$/i.test(name)) return null
      if (seg[0] === "c" && seg[1]) name = seg[1] // facebook.com/c/<name>
      if (name.length < 3 || /^\d+$/.test(name)) return null
      return name.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    }
    // facebook.com/pages/<Name>/<id> or facebook.com/<PageName> (not groups/profile)
    if (/(^|\.)facebook\.com$/.test(host)) {
      if (seg[0] === "pages" && seg[1]) return seg[1].replace(/[-_]+/g, " ")
      // ads/library وغيرها = مسارات مكتبات الإعلانات/المساعدة — مش أسماء صفحات (كانت بتحول اسم المعلن لـ"Ads")
      if (["groups", "profile.php", "people", "share", "story", "watch", "photo", "permalink", "hashtag", "ads", "library", "ad_library", "help", "policies", "business", "events", "reel", "gaming"].includes(seg[0])) return null
      if (seg[0] && !/^\d+$/.test(seg[0]) && seg[0].length >= 3) return seg[0].replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      return null
    }
    // linkedin.com/company/<name>
    if (/(^|\.)linkedin\.com$/.test(host) && seg[0] === "company" && seg[1]) {
      return seg[1].replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    }
    return null
  } catch {
    return null
  }
}

/**
 * Shared ingestion pipeline used by BOTH the internal DISCOVERY jobs and the
 * external webhook (/api/ingest/webhook — e.g. the Botasaurus worker).
 * Normalizes items → ContentItems → classify → dedup → Business/Lead → score → research.
 */
export async function ingestDiscoveredItems(
  wsId: string,
  source: { id: string; type: string; name: string },
  rule: IngestRuleLite | null,
  items: DiscoveredItem[],
  deadline = Number.MAX_SAFE_INTEGER,
): Promise<{ created: number; duplicates: number; adPixelLeads: number; leadsByPlatform: Record<string, number> }> {
  let leadsCreated = 0
  let duplicates = 0
  let adPixelLeads = 0 // ليدز اتأكد إنها بتصرف إعلانات (بصمة بيكسل حية على موقعها)
  let pixelScans = 0 // ميزانية الفحص في الجوبة — الفحص بياخد ~2-6s
  const PIXEL_SCAN_BUDGET = 5
  const leadsByPlatform: Record<string, number> = {}
  for (const item of items) {
    if (Date.now() > deadline) break // ميزانية وقت — الباقي بياخده الجوب الجاي
    // Quality guard: skip hashtag-only titles / empty-ish names (social noise, not businesses)
    const title = cleanName(item.title ?? "")
    if (!title || title.length < 5 || title.split(/\s+/).every((w) => w.startsWith("#"))) continue
    if (NOISE_PATTERNS.some((re) => re.test(title))) continue
    // بروفايلات لينكدإن الشخصية مش بيزنسات — الشركات بتتجمع من /company/ بس
    if (/linkedin\.com\/(in|pub)\//i.test(item.url)) continue
    // بيزنسات خرائط جوجل: قائمة استهداف مباشرة — مش شرط فيها نية شراء صريحة
    const itemPlatform = typeof (item.rawData as { platform?: string } | null)?.platform === "string"
      ? (item.rawData as { platform?: string }).platform
      : undefined
    const isMapsBusiness = item.contentType === "BUSINESS" || itemPlatform === "GOOGLE_MAPS"
    // أدلة الأعمال + صفحات التقييمات = قوائم بيزنس حقيقية زي الخرايط بالظبط (اصلاح: كانوا بيرفضوا كليدز)
    const isListingBusiness = isMapsBusiness || itemPlatform === "DIRECTORY" || itemPlatform === "REVIEWS"
    // (كاشير/شيف/مطبخ اتضافوا: مطعم بيظبط طاقمه = عميل POS/أنظمة مثالي)
    if (itemPlatform === "JOBS" && !/مدير|manager|مبرمج|developer|مطور|مسؤول|sales|مبيعات|تسويق|marketing|محاسب|accountant|مصمم|designer|hr|موارد بشرية|كاشير|cashier|شيف|chef|كابتن|مطبخ|كهربائي|فني/i.test(title)) continue
    // ═══ مكتبات الإعلانات: صفحات المساعدة/المقالات/السياسات مش معلنين ═══
    // العنصر لازم يكون صفحة إعلان فعلي أو صفحة معلن — إلا يترفض (كان بيتسرب محتوى تعليمي زي ads.tiktok.com/resources)
    // الإعلانات الممولة المسرقة من SERP (sponsored) مستثنية — رابط هبوطها دومين المعلن نفسه مش المكتبة
    const isSponsored = (item.rawData as { sponsored?: boolean } | null)?.sponsored === true
    if (itemPlatform === "ADS_LIBRARY" && !isSponsored) {
      const u = item.url.toLowerCase()
      const realAd =
        (/facebook\.com\/ads\/library/.test(u) && /[?&]id=/.test(u)) || // إعلان ميتا فعلي بمعرّف
        (/adstransparency\.google\.com/.test(u) && !/\/(about|faq|help|support)/.test(u)) || // إعلان جوجل/يوتيوب محدد
        (/ads\.tiktok\.com/.test(u) && !/\/(resources|help|business|creativecenter|policies)/.test(u)) || // إعلان تيك توك
        (/linkedin\.com\/ad-library/.test(u) && /advertiser/.test(u)) // صفحة معلن لينكدإن
      if (!realAd) continue
    }
    // تصنيف إشارة النية (أولوية الصياد): صاحب الحاجة الصريحة → اللي بيقارن بالمنافسين → اللي بيصرف إعلانات → قوائم السوق
    // ═══ الإعلانات الممولة من كل المصادر (طلب: العملاء من إعلانات المنافسين الممولة) ═══
    // أي عنصر ببصمة sponsored من Serper ads = معلن بيصرف فلوس على جوجل الآن — AD_SPENDER تلقائيًا
    // مهما كانت المنصة اللي جابه منها (فيسبوك/انستجرام/ويب/مكتبات الإعلانات...) — أعلى قدرة دفع.
    const hay = `${item.title ?? ""} ${item.body}`
    const intentSignal: string | null = itemPlatform === "ADS_LIBRARY" || isSponsored
      ? "AD_SPENDER"
      : isListingBusiness
        ? "MARKET_LIST"
        : /محتاج|عايز|عاوز|مطلوب|أبحث|ابحث|ببحث|بحاجة|ناقص|دور علي|بيدور|need|looking for|seeking|we need/i.test(hay)
          ? "EXPLICIT_NEED"
          : /بديل|توصية|مين يعرف|أنصح|تنصحوا|اقترحوا|مقارنة|أحسن من|recommend|alternative|switch/i.test(hay)
            ? "COMPETITOR_ENGAGER"
            : null
    // Normalize + store ContentItem (unique per source+externalId)
    let content
    try {
      content = await db.contentItem.create({
        data: {
          workspaceId: wsId,
          sourceId: source.id,
          externalId: item.externalId,
          canonicalUrl: item.url,
          authorName: item.authorName,
          authorHandle: item.authorHandle,
          title: item.title,
          body: item.body,
          contentType: item.contentType as never,
          status: "PROCESSED",
          publishedAt: item.publishedAt,
          language: item.language,
          rawData: item.rawData,
          contentHash: item.externalId,
        },
      })
    } catch {
      // متجمع قبل كده — لو بيزنس خرائط لسه منغير Lead، كمّل تسجيله؛ وإلا تجاوز
      if (!isListingBusiness) continue
      const existing = await db.contentItem.findUnique({
        where: { sourceId_externalId: { sourceId: source.id, externalId: item.externalId } },
      }).catch(() => null)
      if (!existing) continue
      const alreadyLinked = await db.leadContent.findFirst({ where: { contentId: existing.id }, select: { id: true } })
      if (alreadyLinked) continue
      content = existing
    }

    // Classify (AI if available, heuristic otherwise)
    const { classification } = await classifyContent(wsId, item.title, item.body, item.rawData ? JSON.stringify(item.rawData) : undefined)
    if (!classification.is_lead && isListingBusiness) {
      // بيزنس حقيقي من خرائط جوجل — يتحفظ كـ lead (قائمة اتصال لبيع الأنظمة حتى من غير نية معلنة)
      classification.is_lead = true
      classification.business_type = classification.business_type || (item.rawData as { category?: string })?.category || ""
      if (classification.intent === "NONE") classification.intent = "LOW"
      classification.score = Math.max(classification.score, 45)
      classification.reason = classification.reason || "بيزنس حقيقي من خرائط جوجل (قائمة استهداف)"
    }
    if (!classification.is_lead && (isSponsored || itemPlatform === "ADS_LIBRARY")) {
      // معلن ممول في نفس النيش — بيصرف على إعلانات الآن (AD_SPENDER): أقوى قائمة استهداف — عنده ميزانية ومقتنع بالتسويق
      // (يشمل نتايج مكتبات الإعلانات نفسها — جوّة مكتبة = دليل إنفاق فعلي، مفيش داعي لحكم AI)
      classification.is_lead = true
      if (classification.intent === "NONE" || classification.intent === "LOW") classification.intent = "HIGH"
      classification.score = Math.max(classification.score, 55)
      classification.reason = classification.reason || `معلن ممول ${((item.rawData as { advertiser?: string })?.advertiser ?? "").slice(0, 40)} — بيصرف إعلانات في نفس النيش`
    }
    if (!classification.is_lead) continue

    // Dedup by business identity signals — name must match what we'd store (handle > title)
    const handleName = socialHandleName(item.url)
    const candidateName = handleName ?? title
    const candidate = {
      id: "",
      name: item.authorName ?? candidateName,
      phone: typeof (item.rawData as { phone?: string })?.phone === "string" ? (item.rawData as { phone?: string }).phone : null,
      email: null,
      websiteUrl: typeof (item.rawData as { website?: string })?.website === "string" ? (item.rawData as { website?: string }).website : null,
      mapsPlaceId: typeof (item.rawData as { placeId?: string })?.placeId === "string" ? (item.rawData as { placeId?: string }).placeId : null,
      city: null as string | null,
    }
    const dup = await findDuplicateLead(wsId, candidate)
    if (dup) {
      duplicates++
      await db.contentItem.update({ where: { id: content.id }, data: { status: "DUPLICATE" } })
      await db.leadContent.create({
        data: { leadId: dup.leadId, contentId: content.id, relationship: "duplicate_evidence", relevanceScore: 60 },
      }).catch(() => undefined)
      await db.lead.update({ where: { id: dup.leadId }, data: { lastSeenAt: new Date() } })
      continue
    }

    // Create Business + Lead — prefer the platform handle (clean page name) over SERP title
    const businessName = candidateName
    const business = await db.business.create({
      data: {
        workspaceId: wsId,
        name: businessName,
        industry: classification.business_type || (item.rawData as { category?: string })?.category || null,
        category: (item.rawData as { category?: string })?.category ?? null,
        city: (item.rawData as { city?: string })?.city ?? null,
        address: (item.rawData as { address?: string })?.address ?? null,
        latitude: (item.rawData as { latitude?: number })?.latitude ?? undefined,
        longitude: (item.rawData as { longitude?: number })?.longitude ?? undefined,
        country: "Egypt",
        phone: normalizePhone(candidate.phone) ? candidate.phone : null,
        websiteUrl: candidate.websiteUrl,
        mapsPlaceId: candidate.mapsPlaceId,
        mapsUrl: candidate.mapsPlaceId
          ? `https://www.google.com/maps/place/?q=place_id:${candidate.mapsPlaceId}`
          : (typeof (item.rawData as { cid?: string })?.cid === "string" && (item.rawData as { cid?: string }).cid
            ? `https://maps.google.com/?cid=${(item.rawData as { cid?: string }).cid}`
            : null),
        rating: (item.rawData as { rating?: number })?.rating ?? null,
        reviewCount: (item.rawData as { reviewCount?: number })?.reviewCount ?? null,
        businessSources: {
          create: { sourceType: (source.type as string), sourceUrl: item.url, externalId: item.externalId },
        },
      },
    })
    const lead = await db.lead.create({
      data: {
        workspaceId: wsId,
        businessId: business.id,
        status: "NEW",
        leadSourceType: (typeof (item.rawData as { platform?: string } | null)?.platform === "string"
          ? (["FACEBOOK", "INSTAGRAM", "X", "LINKEDIN", "REDDIT", "TIKTOK", "YOUTUBE"].includes((item.rawData as { platform?: string }).platform as string) ? "SOCIAL" : (item.rawData as { platform?: string }).platform === "GOOGLE_MAPS" ? "GOOGLE_MAPS" : "DISCOVERY")
          : source.type === "GOOGLE_MAPS" ? "GOOGLE_MAPS" : "DISCOVERY") as never,
        sourcePlatform: itemPlatform ?? (source.type === "GOOGLE_MAPS" ? "GOOGLE_MAPS" : null),
        intentSignal,
        metadata: { platform: itemPlatform ?? null, intentSignal, discoveredVia: source.name } as Prisma.InputJsonValue,
        intent: classification.intent,
        intentScore: classification.intent === "VERY_HIGH" ? 95 : classification.intent === "HIGH" ? 80 : 55,
        urgencyScore: classification.urgency === "high" ? 90 : classification.urgency === "medium" ? 60 : 30,
        serviceNeeds: classification.services,
        painPoints: [],
        summary: `${item.title ?? candidate.name}: ${item.body.slice(0, 160)}`,
        whyNow: classification.reason,
        contentLinks: { create: { contentId: content.id, relationship: "primary", relevanceScore: 95 } },
      },
    })
    const leadPlatform = itemPlatform ?? source.type
    const isSocial = ["FACEBOOK", "INSTAGRAM", "X", "LINKEDIN", "REDDIT", "TIKTOK", "YOUTUBE"].includes(leadPlatform)
    await db.leadSource.create({
      data: { leadId: lead.id, sourceType: (isSocial ? "SOCIAL" : leadPlatform === "GOOGLE_MAPS" ? "GOOGLE_MAPS" : "DISCOVERY") as never, sourceUrl: item.url, label: `${source.name} — ${leadPlatform}` },
    })
    leadsCreated++
    await recomputeLeadScore(lead.id, { workspaceId: wsId })
    // مكافأة أولوية الصياد: صاحب الحاجة الصريحة +8 واللي بيقارن بالمنافسين +5
    if (intentSignal === "EXPLICIT_NEED" || intentSignal === "COMPETITOR_ENGAGER") {
      await db.lead.update({ where: { id: lead.id }, data: { score: { increment: intentSignal === "EXPLICIT_NEED" ? 8 : 5 } } }).catch(() => undefined)
    }

    // ═══ ماسح البصمات الإعلانية (طبقة سرقة الإعلانات من كل المصادر) ═══
    // أي ليد له موقع بيتفحص بيكسلات الإعلانات الحية (ميتا/جوجل/تيك توك/لينكدإن/سناب/إكس)
    // — بيكسل حي = بيصرف فلوس على إعلانات الآن → AD_SPENDER بقنوات مُثبتة +8 سكور.
    // (المصدر: إعلانات جوجل الممولة من SERP تحتاج رصيد Serper — الفحص ده الدليل البديل الدائم)
    const sponsoredAdvertiser = (item.rawData as { advertiser?: string } | null)?.advertiser
    const siteUrl = candidate.websiteUrl
      ?? (sponsoredAdvertiser && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(sponsoredAdvertiser) ? `https://${sponsoredAdvertiser}` : null)
      ?? (/^https?:\/\//.test(item.url)
        && !/facebook\.com|instagram\.com|tiktok\.com|youtu|x\.com|twitter\.com|linkedin\.com|reddit\.com|t\.me|quora\.com|google\.|wikipedia\.org|yellowpages\.com\.eg|egypt-business\.com|mostaql\.com|khamsat\.com|olx\.com\.eg|hatla2ee\.com/i.test(item.url)
        && /\.(com|eg|net|org|io|co|shop|store)([\/\?]|$)/i.test(item.url)
        ? item.url : null)
    if (siteUrl && pixelScans < PIXEL_SCAN_BUDGET) {
      pixelScans++
      const channels = await detectAdPixels(siteUrl).catch(() => [] as string[])
      if (channels.length) {
        adPixelLeads++
        const upgradeTo = intentSignal === "EXPLICIT_NEED" || intentSignal === "COMPETITOR_ENGAGER" ? intentSignal : "AD_SPENDER"
        await db.lead.update({
          where: { id: lead.id },
          data: {
            intentSignal: upgradeTo,
            score: { increment: 8 },
            metadata: { platform: itemPlatform ?? null, intentSignal: upgradeTo, adChannels: channels, adEvidence: "pixel_scan", adSite: siteUrl.slice(0, 120), discoveredVia: source.name } as Prisma.InputJsonValue,
            whyNow: `${classification.reason ?? ""} — بيتصرف إعلانات حاليًا عبر: ${channels.join(" + ")}`.slice(0, 240),
          },
        }).catch(() => undefined)
      }
    }

    // ═══ عقل المهارات: الليد ده جه من مهارة/استعلام معين — اتسجل في الإحصاء والدروس ═══
    // (من هنا التعلم بيحصل: المهارة اللي بتجيب ليدز وزنها بيزيد، والاستعلام الفايت بيرجع أولًا)
    const viaType = item.viaType ?? itemPlatform ?? null
    const viaQuery = item.viaQuery ?? null
    if (viaType) {
      const win = intentSignal === "EXPLICIT_NEED" || intentSignal === "COMPETITOR_ENGAGER" || classification.score >= 55
      await recordSkillLead(wsId, viaType, { win, qualityScore: classification.score }).catch(() => undefined)
      if (viaQuery) await recordLesson(wsId, viaType, viaQuery, { qualityScore: classification.score }).catch(() => undefined)
      // مكافأة المكتبتين العالميتين: التكتيكات المرتبطة بالمنصة اللي جابت الليد بتاخد وزن —
      // (دي الحلقة اللي كانت ناقصة: التكتيك اللي بيجيب ليدز بيبقى أقوى في البرومبتات الجاية)
      if (win) {
        rewardGitSkillsTactics(viaType).catch(() => undefined)
        rewardHubTactics(viaType).catch(() => undefined)
      }
      leadsByPlatform[viaType] = (leadsByPlatform[viaType] ?? 0) + 1
    }

    // سلاسل المتابعة: تجنيد تلقائي للليد الجديد في سلسلة النشر (لو مفعّلة)
    // سياسة الرد-فقط: الخطوات بتطلع مهام بنص جاهز — مفيش إرسال آلي استباقي
    try {
      const nurtureSeq = await db.sequence.findFirst({
        where: { workspaceId: wsId, enabled: true, kind: "NURTURE" },
        select: { id: true, steps: { where: { active: true }, select: { id: true }, take: 1 } },
      })
      if (nurtureSeq?.steps.length) await enrollLead(wsId, lead.id, nurtureSeq.id)
    } catch { /* السلاسل اختيارية — فشل التجنيد ميوقفش الاكتشاف */ }

    // Hot leads go straight to Deep Research (doc §70)
    if (rule?.startResearch !== false && classification.score >= 80) {
      const run = await db.researchRun.create({
        data: { workspaceId: wsId, leadId: lead.id, depth: (rule?.researchDepth ?? "DEEP") as never, status: "QUEUED" },
      })
      await enqueueJob(wsId, "DEEP_RESEARCH", { researchRunId: run.id, leadId: lead.id }, 80)
    }
  }

  return { created: leadsCreated, duplicates, adPixelLeads, leadsByPlatform }
}

async function processResearchJob(jobId: string): Promise<string> {
  const job = await db.job.findUnique({ where: { id: jobId } })
  if (!job) return "job missing"
  const payload = (job.payload ?? {}) as { researchRunId?: string; leadId?: string }
  if (!payload.researchRunId || !payload.leadId) return "bad payload"
  const run = await db.researchRun.findUnique({ where: { id: payload.researchRunId } })
  if (!run) return "run missing"
  if (run.status === "COMPLETED") return "already done"
  await runDeepResearch(job.workspaceId, payload.leadId, payload.researchRunId, run.depth)
  return "research completed"
}

// ══════════ الموجة الجديدة: إعادة التفعيل + التقييم الذاتي للمصادر ══════════

async function processReactivationJob(jobId: string): Promise<string> {
  const job = await db.job.findUnique({ where: { id: jobId } })
  if (!job) return "job missing"
  const { enrolled, skipped } = await reactivationSweep(job.workspaceId)
  return `reactivation enrolled=${enrolled} skipped=${skipped}`
}

/** التقييم الذاتي للمصادر (طلب: زيزو يطور مصادره لوحده) — أسبوعيًا */
async function processSourceEvaluationJob(jobId: string): Promise<string> {
  const job = await db.job.findUnique({ where: { id: jobId } })
  if (!job) return "job missing"
  const wsId = job.workspaceId
  const sources = await db.source.findMany({
    where: { workspaceId: wsId },
    select: { id: true, name: true, type: true, status: true, _count: { select: { contents: true } } },
  })
  const stats: Array<{ name: string; type: string; contents: number; leads: number; conversions: number }> = []
  for (const s of sources) {
    const leads = await db.leadContent.count({ where: { content: { sourceId: s.id } } })
    const conversions = leads
      ? await db.lead.count({ where: { status: "WON", contentLinks: { some: { content: { sourceId: s.id } } } } })
      : 0
    stats.push({ name: s.name, type: s.type, contents: s._count.contents, leads, conversions })
  }
  const usedTypes = new Set(sources.map((s) => s.type))
  const unused = Object.keys(PLATFORM_SITES).filter((t) => !usedTypes.has(t))
  const zeroYield = stats.filter((s) => s.contents >= 20 && s.leads === 0)
  const top = [...stats].sort((a, b) => b.leads - a.leads)[0]

  const summary = [
    `مصادر نشطة: ${sources.length}`,
    top && top.leads > 0 ? `أعلى مصدر: «${top.name}» بـ ${top.leads} ليد` : "مفيش مصدر جاب ليدز لسه",
    zeroYield.length ? `مصادر ضعيفة (${zeroYield.length}): ${zeroYield.slice(0, 3).map((s) => s.name).join("، ")}` : "",
    unused.length ? `أنواع مش مستخدمة ممكن تجيب ليدز: ${unused.slice(0, 6).join("، ")}` : "",
  ].filter(Boolean).join(" | ")

  await db.agentInsight.create({
    data: {
      workspaceId: wsId,
      kind: "platform_signal",
      pattern: "source_evaluation_weekly",
      note: summary,
      evidence: { stats, unusedSourceTypes: unused } as Prisma.InputJsonValue,
      weight: 2,
    },
  })
  if (zeroYield.length || unused.length) {
    await db.alert.create({
      data: {
        workspaceId: wsId,
        type: "SOURCE_EVALUATION",
        title: "تقرير زيزو الأسبوعي عن المصادر",
        message: summary,
        severity: "INFO",
        actionUrl: "/sources",
      },
    })
  }
  return summary.slice(0, 200)
}

/** حصاد GitSkills (3.8M مهارة): جوب مستقل كل 4 ساعات — ميزانية زمن داخلية 30s */
async function processGitSkillsHarvestJob(): Promise<string> {
  const h = await harvestGitSkills()
  return `added=${h.added} checked=${h.checked} skipped=${h.skipped} — ${h.note}`
}

/** حصاد ClawHub (المكتبة المنسّقة clawhub.ai): جوب مستقل كل 6 ساعات — تعليمات فقط بعد بوابة أمان */
async function processClawHubHarvestJob(): Promise<string> {
  const h = await harvestClawHub()
  return `added=${h.added} checked=${h.checked} skipped=${h.skipped} — ${h.note}`
}

/** Main tick: create scheduled discovery jobs from rules, then process a batch. */
export async function processTick(
  maxJobs = 6,
  opts?: { fullSweep?: boolean },
): Promise<{ processed: number; details: string[]; scheduledRules: number }> {
  const details: string[] = []
  // 0) Recover stale RUNNING jobs (worker crashed mid-job)
  await db.job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
    data: { status: "QUEUED", lockedAt: null, workerId: null },
  })

  // 0.5) المسح الشامل: جوبة اكتشاف لكل ورشة على كل المنصات دفعة واحدة (؟full=1)
  // — بتزرع الـ16 مصدر بالليدز فورًا بدل ما الموجة الدوارة تاخد ساعات
  if (opts?.fullSweep) {
    const wsIds = await db.workspace.findMany({ where: { isActive: true }, select: { id: true }, take: 3 })
    for (const w of wsIds) {
      // أولوية 100: فوق كل حاجة — جوبات البحث العميق القديمة (أولوية 80) كانت بتتعطسها
      await enqueueJob(w.id, "DISCOVERY", { fullSweep: true, query: "عملاء محتاجين خدمات رقمية في مصر" }, 100)
    }
  }

  // 0.6) إحياء الجوبات العالقة: instance اتقتل وقت النشر/التجميد (serverless)
  // → RUNNING أقدم من 20 دقيقة من غير اكتمال يرجع QUEUED ويتعالج تاني
  try {
    const revived = await db.job.updateMany({
      where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - 20 * 60_000) } },
      data: { status: "QUEUED", startedAt: null, lockedAt: null, workerId: null },
    })
    if (revived.count) console.log(`[tick] revived ${revived.count} stale RUNNING job(s)`)
  } catch { /* best-effort */ }

  // 0.7) حصاد GitSkills (دمج قاعدة 3.8M مهارة): مرة كل 4 ساعات — في بداية النبضة
  // عشان أولوية الـdiscovery العالية ما تأكلش عليه لو اتحط في الآخر. بتاعه 15-30s بس،
  // وجوبات الـdiscovery ليها ديدلاين خاص بيها بتتعامل مع التأخير بأمان.
  try {
    const recentHarvest = await db.job.findFirst({
      where: { type: "GIT_SKILLS_HARVEST", createdAt: { gte: new Date(Date.now() - 4 * 3600_000) }, status: { in: ["SUCCESS", "RUNNING"] } },
      select: { id: true, status: true, result: true },
    })
    if (!recentHarvest) {
      const ws = await db.workspace.findFirst({ where: { isActive: true }, select: { id: true } })
      if (ws) {
        const job = await enqueueJob(ws.id, "GIT_SKILLS_HARVEST", {}, 15)
        await db.job.update({ where: { id: job.id }, data: { status: "RUNNING", startedAt: new Date(), lockedAt: new Date(), workerId: "inline-harvest", attempts: { increment: 1 } } })
        const h = await harvestGitSkills()
        await db.job.update({ where: { id: job.id }, data: { status: "SUCCESS", completedAt: new Date(), result: { message: `added=${h.added} checked=${h.checked} — ${h.note}` } as Prisma.InputJsonValue } })
        if (h.added) details.push(`GIT_SKILLS: ${h.note}`)
      }
    }
  } catch (err) {
    // الحصاد best-effort — ميفشّلش النبضة، بس مندفنوش صامت: اللوج على Vercel
    console.error("[tick] GIT_SKILLS_HARVEST failed:", err instanceof Error ? err.message.slice(0, 160) : err)
  }

  // 0.75) حصاد ClawHub (المكتبة المنسّقة): مرة كل 6 ساعات — نفس منطق 0.7 بالظبط.
  // بحث موجّه في clawhub.ai → SKILL.md بعد بوابة أمان («تعليمات فقط») → مكتبة HubSkill
  try {
    const recentHubHarvest = await db.job.findFirst({
      where: { type: "CLAWHUB_HARVEST", createdAt: { gte: new Date(Date.now() - 6 * 3600_000) }, status: { in: ["SUCCESS", "RUNNING"] } },
      select: { id: true },
    })
    if (!recentHubHarvest) {
      const ws = await db.workspace.findFirst({ where: { isActive: true }, select: { id: true } })
      if (ws) {
        const job = await enqueueJob(ws.id, "CLAWHUB_HARVEST", {}, 15)
        await db.job.update({ where: { id: job.id }, data: { status: "RUNNING", startedAt: new Date(), lockedAt: new Date(), workerId: "inline-hub-harvest", attempts: { increment: 1 } } })
        const h = await harvestClawHub()
        await db.job.update({ where: { id: job.id }, data: { status: "SUCCESS", completedAt: new Date(), result: { message: `added=${h.added} checked=${h.checked} — ${h.note}` } as Prisma.InputJsonValue } })
        if (h.added) details.push(`CLAWHUB: ${h.note}`)
      }
    }
  } catch (err) {
    // حصاد المكتبة best-effort — ميفشّلش النبضة، بس اللوج لازم يظهر (كان بيبلع أخطاء الـenum صامت)
    console.error("[tick] CLAWHUB_HARVEST failed:", err instanceof Error ? err.message.slice(0, 160) : err)
  }

  // 0.8) استئناف خرايط التفكير النشطة (Dynamic Skill Intelligence — 43.17):
  // خريطة اتحطت نص تنفيذ (serverless اتقتل/انتهى budget) → شريحة استئناف صغيرة
  // عقدتين لكل نبضة بميزانية 25s — مفيش ضغط على باقي النبضة، والخرايط بتكمل لوحدها.
  try {
    const { resumeActiveGraphs } = await import("@/lib/thinking/engine")
    const resumed = await resumeActiveGraphs(1, 25_000)
    for (const r of resumed) {
      if (r.resumed) details.push(`TASK_GRAPH resume: ${r.note}`)
    }
  } catch { /* استئناف best-effort — ميفشّلش النبضة */ }

  // 1) Scheduler: enqueue due rules (every tick checks; jobs are cheap and idempotent)
  const rules = await db.searchRule.findMany({ where: { enabled: true }, orderBy: { priority: "desc" } })
  let scheduledRules = 0
  for (const rule of rules) {
    // نظافة الطابور: القاعدة ليها جوب حي (QUEUED/RUNNING)؟ متزرعش تاني —
    // (القديم كان بيعتمد على 10 دقايق فقط: الطابور يتزحزح → جوبات جديدة فوق المتراكم = طابور يتضخم بلا نهاية)
    try {
      const pending = await db.job.findFirst({
        where: {
          workspaceId: rule.workspaceId,
          type: "DISCOVERY",
          status: { in: ["QUEUED", "RETRYING", "RUNNING"] },
          payload: { path: "ruleId", equals: rule.id },
        },
        select: { id: true },
      })
      if (pending) continue
    } catch { /* sqlite dev — يكمل على حد 10 دقايق تحت */ }
    const recentJobs = await db.job.findMany({
      where: {
        workspaceId: rule.workspaceId,
        type: "DISCOVERY",
        createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
      },
      select: { payload: true },
    })
    const hasRecent = recentJobs.some((j) => (j.payload as { ruleId?: string } | null)?.ruleId === rule.id)
    // Rate-limit: one discovery job per rule per 10 minutes
    if (hasRecent) continue
    const sources = await db.source.findMany({ where: { workspaceId: rule.workspaceId, status: "ACTIVE" }, take: 1 })
    await enqueueJob(rule.workspaceId, "DISCOVERY", {
      ruleId: rule.id,
      sourceId: sources[0]?.id,
      sourceTypes: asArray(rule.sourceTypes),
    }, rule.priority > 100 ? 70 : 50)
    scheduledRules++
    if (scheduledRules >= 3) break
  }

  // 2) Process queued jobs — واحد واحد مع ميزانية وقت إجمالية:
  // الـtick ليه maxDuration=120s — الجوبة الواحدة ممكن تاكل 75ث؛ الجوبة التانية متبدأش إلا لو لسه بدري جدًا
  const tickStart = Date.now()
  let processed = 0
  for (let i = 0; i < maxJobs; i++) {
    if (i > 0 && Date.now() - tickStart > 35_000) {
      details.push(`tick time budget: وقفنا بعد ${i} جوب — الباقي النبضة الجاية`)
      break
    }
    const jobs = await claimJobs(1)
    if (!jobs.length) break
    const job = jobs[0]
    processed++
    try {
      let result = ""
      if (job.type === "DISCOVERY") result = await processDiscoveryJob(job.id)
      else if (job.type === "DEEP_RESEARCH") result = await processResearchJob(job.id)
      else if (job.type === "REACTIVATION") result = await processReactivationJob(job.id)
      else if (job.type === "SOURCE_EVALUATION") result = await processSourceEvaluationJob(job.id)
      else if (job.type === "GIT_SKILLS_HARVEST") result = await processGitSkillsHarvestJob()
      else if (job.type === "CLAWHUB_HARVEST") result = await processClawHubHarvestJob()
      else result = `no handler for type ${job.type}`
      await db.job.update({
        where: { id: job.id },
        data: { status: "SUCCESS", completedAt: new Date(), result: { message: result } as Prisma.InputJsonValue },
      })
      details.push(`${job.type}: ${result}`)
    } catch (err) {
      const attempts = job.attempts + 1
      const permanent = attempts >= job.maxAttempts
      await db.job.update({
        where: { id: job.id },
        data: {
          status: permanent ? "FAILED" : "RETRYING",
          completedAt: permanent ? new Date() : null,
          errorMessage: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
          scheduledAt: new Date(Date.now() + Math.min(600000, 60000 * Math.pow(2, attempts))), // exponential backoff
        },
      })
      details.push(`${job.type}: FAILED (${err instanceof Error ? err.message.slice(0, 120) : err})`)
    }
  }
  // 3) سلاسل المتابعة: معالجة الخطوات المستحقة (لكل ورشة عليها مستحق)
  const dueWs = await db.sequenceEnrollment.findMany({
    where: { status: "ACTIVE", nextStepAt: { lte: new Date() } },
    distinct: ["workspaceId"],
    select: { workspaceId: true },
    take: 5,
  })
  for (const { workspaceId } of dueWs) {
    try {
      const r = await processDueEnrollments(workspaceId, 10)
      if (r.processed || r.completed) details.push(`SEQUENCE: steps=${r.processed} completed=${r.completed} tasks=${r.tasks}`)
    } catch (err) {
      details.push(`SEQUENCE: FAILED (${err instanceof Error ? err.message.slice(0, 100) : err})`)
    }
  }

  // 4) إعادة التفعيل: مسح يومي للليدز الباردة (كل 20 ساعة)
  const lastReactivation = await db.job.findFirst({
    where: { type: "REACTIVATION", createdAt: { gte: new Date(Date.now() - 20 * 3600_000) } },
    select: { id: true },
  })
  if (!lastReactivation) {
    const wsIds = await db.workspace.findMany({ where: { isActive: true }, select: { id: true }, take: 5 })
    for (const w of wsIds) await enqueueJob(w.id, "REACTIVATION", {}, 30, new Date(Date.now() + 60_000))
    details.push("REACTIVATION sweep scheduled")
  }

  // 5) التقييم الذاتي للمصادر: أسبوعيًا (كل 7 أيام)
  const lastEval = await db.job.findFirst({
    where: { type: "SOURCE_EVALUATION", createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } },
    select: { id: true },
  })
  if (!lastEval) {
    const wsIds = await db.workspace.findMany({ where: { isActive: true }, select: { id: true }, take: 5 })
    for (const w of wsIds) await enqueueJob(w.id, "SOURCE_EVALUATION", {}, 20, new Date(Date.now() + 120_000))
    details.push("SOURCE_EVALUATION scheduled")
  }

  // 6) سجل الحصاد: آخر نتيجة GIT_SKILLS_HARVEST (التنفيذ نفسه في 0.7 أعلاه)
  const lastHarvestDone = await db.job.findFirst({
    where: { type: "GIT_SKILLS_HARVEST", status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
    select: { result: true, completedAt: true },
  })
  if (lastHarvestDone?.completedAt && Date.now() - lastHarvestDone.completedAt.getTime() < 4 * 3600_000) {
    const msg = (lastHarvestDone.result as { message?: string } | null)?.message
    if (msg && !details.some((d) => d.startsWith("GIT_SKILLS"))) details.push(`GIT_SKILLS: ${msg.slice(0, 120)}`)
  }

  return { processed, details, scheduledRules }
}
