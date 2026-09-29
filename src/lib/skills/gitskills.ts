// LeadOS — حصّاد قاعدة GitSkills العالمية (دمج مشروع GitSkills — داتابيز MSR'27)
// القاعدة: 3,797,117 ملف SKILL.md من 282,200 repo على GitHub (صيغة Anthropic Agent Skills
// المفتوحة) — منشورة على HuggingFace datasets: mvaccargiu/gitskills.
// الوصول: datasets-server REST (/rows بعشوائية عميقة — مفيش فهرس ولا استضافة).
// كل حصاد: 3 عينات عشوائية × 100 صف → تفريغ frontmatter → فلترة صلة بالصيد → تخزين أفضلها.
// التعلم: اللي بيظهر في سياق AI ويجيب ليدز وزنه بيرتفع (وزن مشترك عالمي).
import { db } from "@/lib/db"

const HF_DATASET = "mvaccargiu/gitskills"
const HF_ROWS_URL = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(HF_DATASET)}&config=artifacts&split=train`
const TOTAL_ROWS = 3_797_117

// كلمات الصلة بالصيد — اللي بيلمس أي واحدة منها بياخد نقاط (المجموع = relevance)
// \b حدود كلمات صارمة — "wholesale" مبتلقطش "sales"، والإنذارات الكاذبة تتمنع
const RELEVANCE_TERMS: Array<[RegExp, number, string]> = [
  [/lead[\s-]?generat|prospect(ing|us)?\b|client acquisition|customer acquisition/i, 30, "lead-gen"],
  [/\boutreach\b|\bcold[\s-]?(email|message|dm|calling)\b|\bprospecting\b/i, 28, "outreach"],
  [/\bsales\b|\bselling\b|\bup sell(ing)?\b|\bclosing\b(deals?)?|\bsales ?pipeline/i, 22, "sales"],
  [/\bmarketing\b|growth[\s-]?hack|\bpromotion(al)?\b|\badvertis(e|ing|ements?)\b/i, 18, "marketing"],
  [/\bseo\b|search engine optim|\bbacklink(s)?\b|keyword research/i, 16, "seo"],
  [/social[\s-]?media|\bsmm\b|\bengagement rate\b|\binfluencer(s)?\b/i, 14, "social"],
  [/content (marketing|strategy|creation)|\bcopywriting\b/i, 12, "content"],
  [/\bcrm\b|customer relationship|\bcontact management\b/i, 12, "crm"],
  [/\breddit\b|\blinkedin\b|\binstagram\b|\bfacebook\b|\btiktok\b|\byoutube\b|\btelegram\b|\bdiscord\b|\bquora\b/i, 12, "platform"],
  [/small business(es)?|local business(es)?|\brestaurant(s)?\b|\bclinic(s)?\b|\bsalon(s)?\b|\bretail(ers?)?\b/i, 10, "local-biz"],
  [/\bfunnel(s)?\b|landing page(s)?|\bnewsletter(s)?\b|mailing list(s)?/i, 10, "funnel"],
  [/\bfreelanc(e|er|ing|ers)\b|\bgig economy\b/i, 8, "freelance"],
  [/market research|competitor analysis|niche research/i, 8, "research"],
]

export const MIN_RELEVANCE = 24 // تحت كده المهارة عامة جدًا أو إنذار كاذب — مش بتدخل المكتبة

export interface HarvestedSkill {
  repo: string
  path: string
  name: string
  description: string
  body: string
  tags: string[]
  relevance: number
}

/** فصل الـfrontmatter عن الجسم (نفس صيغة registry — سطر `key: value`) */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {}
  let body = raw
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3)
    if (end > 0) {
      const head = raw.slice(3, end)
      body = raw.slice(end + 4).trim()
      for (const line of head.split("\n")) {
        const m = line.match(/^(\w[\w-]*):\s*(.+)$/)
        if (m) fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "")
      }
    }
  }
  return { fm, body }
}

/** حوسبة الصلة + الوسوم من (الاسم + الوصف + المحتوى) — مشتركة مع جسر ClawHub (hub.ts) */
export function scoreSkill(name: string, description: string, body: string): { relevance: number; tags: string[] } {
  // 4000 حرف: الـfrontmatter الطويل + مقدمات المهارات — من غير ما نكلف أنفسنا بالملف كله
  const hay = `${name} ${description} ${body.slice(0, 4000)}`
  let relevance = 0
  const tags: string[] = []
  for (const [re, pts, tag] of RELEVANCE_TERMS) {
    if (re.test(hay)) {
      relevance += pts
      if (!tags.includes(tag)) tags.push(tag)
    }
  }
  return { relevance, tags }
}

/** أول سطر مفهوم من الجسم (بدون رموز الماركداون) — بديل الوصف لو frontmatter ناقص */
function firstMeaningfulLine(body: string): string {
  for (const line of body.split("\n").slice(0, 12)) {
    const clean = line.replace(/^[#>*|\-\s]+/, "").replace(/[|`]/g, " ").replace(/\s+/g, " ").trim()
    if (clean.length >= 25 && !/^\d+$/.test(clean)) return clean
  }
  return ""
}

/** صف واحد من الـdataset → مهارة مرشحة (أو null لو عامة/فاضية) */
export function toHarvested(row: Record<string, unknown>): HarvestedSkill | null {
  const repo = String(row.repo_full_name ?? "").trim()
  const path = String(row.path ?? "").trim()
  const content = String(row.content ?? "")
  if (!repo || !path || content.length < 80) return null
  const { fm, body } = parseFrontmatter(content)
  const name = String(fm.name || row.name || "").trim() || path.split("/").slice(-2, -1)[0] || ""
  const description = String(fm.description || row.description || "").trim() || firstMeaningfulLine(body)
  if (!name || name.length < 3) return null
  if (description.length < 20 && body.length < 200) return null // مهارة هيكل فاضي
  // التسجيل على المحتوى الخام — الـfrontmatter (الوصف المطوي) جزء من المهارة وكلماته مفتاحية
  const { relevance, tags } = scoreSkill(name, description, content)
  if (relevance < MIN_RELEVANCE) return null
  return {
    repo,
    path,
    name: name.slice(0, 120),
    description: description.slice(0, 400),
    body: body.slice(0, 2500),
    tags: tags.slice(0, 6),
    relevance,
  }
}

/** عينة عشوائية عميقة من الـdataset (offset عشوائي — كل حصاد بيكشف مهارات جديدة) */
async function fetchRandomBatch(length = 100, timeoutMs = 12_000): Promise<HarvestedSkill[]> {
  const offset = Math.floor(Math.random() * (TOTAL_ROWS - length))
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${HF_ROWS_URL}&offset=${offset}&length=${length}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "LeadOS-GitSkills-Harvester/1.0" },
      cache: "no-store",
    })
    if (!res.ok) return []
    const data = (await res.json()) as { rows?: Array<{ row?: Record<string, unknown> }> }
    const out: HarvestedSkill[] = []
    for (const r of data.rows ?? []) {
      if (!r?.row) continue
      const skill = toHarvested(r.row)
      if (skill) out.push(skill)
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** بحث موجّه في فهرس الـdataset (إنتاجية أعلى بكتير) — لو الفهرس مش جاهز بيرجع null */
async function fetchSearchBatch(query: string, length = 60, timeoutMs = 12_000): Promise<HarvestedSkill[] | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const url = `https://datasets-server.huggingface.co/search?dataset=${encodeURIComponent(HF_DATASET)}&config=artifacts&split=train&query=${encodeURIComponent(query)}&offset=0&length=${length}`
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "LeadOS-GitSkills-Harvester/1.0" },
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = (await res.json()) as { rows?: Array<{ row?: Record<string, unknown> }>; error?: string }
    if (data.error || !data.rows) return null // الفهرس بيتبني/خطأ → عشوائية
    const out: HarvestedSkill[] = []
    for (const r of data.rows) {
      if (!r?.row) continue
      const skill = toHarvested(r.row)
      if (skill) out.push(skill)
    }
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ═══ التحكم في الوتيرة (داخل الـserverless instance) ═══
let lastHarvestAt = 0
const HARVEST_GAP_MS = 4 * 3_600_000 // حصاد كل 4 ساعات على الأقل
const HARVEST_MAX_MS = 30_000 // سقف زمن للحصاد — بعده بنسحب (النبضة أهم)

export function harvestCooldownRemaining(): number {
  return Math.max(0, HARVEST_GAP_MS - (Date.now() - lastHarvestAt))
}

/**
 * حصاد GitSkills: عينات عشوائية → أفضل المهارات الصلة بتتخزن في المكتبة المشتركة.
 * بيرجع عدد المهارات الجديدة. أمان زمني: بيقفل نفسه قبل ما يتعب النبضة.
 */
export async function harvestGitSkills(opts?: { batches?: number; budgetMs?: number }): Promise<{ added: number; checked: number; skipped: boolean; note: string }> {
  const started = Date.now()
  const budget = opts?.budgetMs ?? HARVEST_MAX_MS
  // التقييد: آخر حصاد قريب؟ (وفحص الداتابيز كمان — لو فيه حصاد حديث من instance تاني نستنى)
  const latest = await db.gitSkill
    .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
    .catch(() => null)
  if (latest && Date.now() - latest.createdAt.getTime() < HARVEST_GAP_MS) {
    return { added: 0, checked: 0, skipped: true, note: "حصاد حديث موجود — المرة الجاية بعد فترة" }
  }
  lastHarvestAt = Date.now()

  const batches = opts?.batches ?? 8
  const collected: HarvestedSkill[] = []
  let checked = 0
  // المحاولة الذكية الأول: بحث موجّه في الفهرس (لو جاهز) — إنتاجية أعلى بكتير
  for (const q of ["lead generation outreach", "social media marketing sales"]) {
    if (Date.now() - started > budget) break
    const found = await fetchSearchBatch(q, 50)
    if (found === null) break // الفهرس مش جاهز → العشوائية تكمل الشغل
    checked += 50
    collected.push(...found)
  }
  // العينات العشوائية الموازية: 8 دفعات في نفس الوقت (نفس زمن دفعة — والتباين بين
  // مناطق الداتابيز عالي، فكل ما العينة أكبر كل ما الحصاد مضمون أكتر)
  const randomBatches = await Promise.all(
    Array.from({ length: batches }, () => fetchRandomBatch(100)),
  )
  checked += batches * 100
  collected.push(...randomBatches.flat())
  if (!collected.length) return { added: 0, checked, skipped: false, note: "العينات مطلعتش مهارات صلة — عشوائية والمرة الجاية أوسع" }

  // الأعلى صلة أولًا — سقف 12 مهارة لكل حصاد (المكتبة تنمو هادية وقوية)
  const top = collected.sort((a, b) => b.relevance - a.relevance).slice(0, 12)
  let added = 0
  for (const s of top) {
    const res = await db.gitSkill
      .upsert({
        where: { repo_path: { repo: s.repo, path: s.path } },
        create: {
          repo: s.repo,
          path: s.path,
          name: s.name,
          description: s.description,
          body: s.body,
          tags: s.tags.join(","),
          relevance: s.relevance,
        },
        update: { relevance: { set: Math.max(s.relevance, 0) } }, // موجود بالفعل — نحدّث الصلة بس
      })
      .catch(() => null)
    if (res) added++
  }
  return { added, checked, skipped: false, note: `حصاد: ${added} مهارة جديدة من ${checked} صف (من 3.8M)` }
}

/** تكتيكات GitSkills لمنصة/نيش — سطور جاهزة للبرومبت (progressive disclosure: اسم + وصف بس)
 *  platform فاضية = أعلى التكتيكات عامة (لمنتقي المصادر) */
export async function gitSkillsTactics(platform: string, niche: string, k = 3): Promise<string[]> {
  try {
    if (!platform) {
      const top = await db.gitSkill.findMany({
        orderBy: [{ weight: "desc" }, { relevance: "desc" }],
        take: k * 3,
      })
      const nicheTokens = niche.toLowerCase().split(/\s+/).filter((w) => w.length >= 4)
      return top
        .map((r) => {
          const hay = `${r.name} ${r.description} ${r.tags}`.toLowerCase()
          const nicheHits = nicheTokens.filter((t) => hay.includes(t)).length
          return { r, score: nicheHits * 2 + r.weight }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ r }) => `- [GitSkills] ${r.name}: ${r.description.slice(0, 140)}`)
    }
    const platformTag = platform.toLowerCase()
    const rows = await db.gitSkill.findMany({
      where: {
        OR: [
          { tags: { contains: platformTag } },
          { body: { contains: platform.slice(0, 4).toLowerCase() } },
          { description: { contains: platform.slice(0, 4).toLowerCase() } },
        ],
      },
      orderBy: [{ weight: "desc" }, { relevance: "desc" }],
      take: k * 4,
    })
    // دعم النيش: مهارات اللي لمست كلمات النيش تتصدر (بسيط: تطابق token)
    const nicheTokens = niche.toLowerCase().split(/\s+/).filter((w) => w.length >= 4)
    const ranked = rows
      .map((r) => {
        const hay = `${r.name} ${r.description} ${r.tags}`.toLowerCase()
        const nicheHits = nicheTokens.filter((t) => hay.includes(t)).length
        return { r, score: nicheHits * 2 + r.weight }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
    return ranked.map(({ r }) => `- [GitSkills] ${r.name}: ${r.description.slice(0, 140)}`)
  } catch {
    return []
  }
}

/** تسجيل استخدام تكتيكات (دخلت برومبت AI) */
export async function recordGitSkillUse(names: string[]): Promise<void> {
  if (!names.length) return
  try {
    for (const name of names) {
      await db.gitSkill.updateMany({ where: { name }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } })
    }
  } catch {
    // best-effort
  }
}

/**
 * مكافأة المنصة: ليد نزل من منصة — أعلى التكتيكات المرتبطة بالمنصة بتاخد وزن.
 * (دي الحلقة اللي كانت ناقصة: التكتيكات اللي ساعدت في الاستعلام بيتكافأوا لو جابوا ليد)
 */
export async function rewardGitSkillsTactics(platform: string, k = 2): Promise<void> {
  try {
    const platformTag = platform.toLowerCase()
    const rows = await db.gitSkill.findMany({
      where: {
        OR: [
          { tags: { contains: platformTag } },
          { body: { contains: platform.slice(0, 4).toLowerCase() } },
          { description: { contains: platform.slice(0, 4).toLowerCase() } },
        ],
      },
      orderBy: [{ weight: "desc" }, { relevance: "desc" }],
      take: k,
      select: { id: true },
    })
    for (const r of rows) {
      await db.gitSkill.update({ where: { id: r.id }, data: { leadCount: { increment: 1 }, weight: { increment: 0.2 } } }).catch(() => undefined)
    }
  } catch {
    // best-effort
  }
}

/** مكافأة: ليد نزل والتكتيكات كانت في السياق */
export async function recordGitSkillLead(names: string[]): Promise<void> {
  if (!names.length) return
  try {
    for (const name of names) {
      await db.gitSkill.updateMany({
        where: { name },
        data: { leadCount: { increment: 1 }, weight: { increment: 0.2 } },
      })
    }
  } catch {
    // best-effort
  }
}
