// LeadOS — جسر مكتبة ClawHub العالمية (clawhub.ai — سجل OpenClaw الرسمي)
// «الريبو التاني»: مكتبة منسّقة ببحث وتصنيفات وفلتر isSuspicious من الموقع نفسه.
// القاعدة: بحث موجّه (مش عشوائي زي GitSkills) → تحميل الحزمة → استخراج SKILL.md →
// بوابة أمان صارمة → تخزين نصي فقط («تعليمات فقط»: مفيش أي سكريبت بيتنفذ أبدًا).
// التغذية: أعلى التكتيكات وزنًا بتدخل برومبتات الـAI زي GitSkills بالظبط، والليدز بتكافئها.
import { inflateRawSync } from "node:zlib"
import { db } from "@/lib/db"
import { scoreSkill, MIN_RELEVANCE } from "./gitskills"

const CLAWHUB_BASE = (process.env.SKILLS_HUB_BASE || "https://clawhub.ai").replace(/\/$/, "")
const HUB_GAP_MS = 6 * 3_600_000 // حصاد كل 6 ساعات على الأقل
const HARVEST_BUDGET_MS = 25_000 // سقف زمن للحصاد الواحد
const MAX_NEW_PER_HARVEST = 6 // سقف مهارات جديدة لكل حصاد — نمو هادي ومفحوص

// ═══ بوابة الأمان: أنماط مرفوضة في محتوى SKILL.md (سياسة «تعليمات فقط») ═══
const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/curl\s+[^\n]*\|\s*(ba)?sh|wget\s+[^\n]*\|\s*(ba)?sh/i, "تحميل وتنفيذ سكريبت من الإنترنت"],
  [/\b(bash|sh|zsh)\s+-c\b/i, "تنفيذ أوامر شل مباشرة"],
  [/\beval\s*\(|new\s+Function\s*\(/i, "تنفيذ كود ديناميكي"],
  [/os\.system|subprocess\.(run|call|Popen)|child_process|execSync|spawnSync/i, "تشغيل عمليات نظام/سكريبتات"],
  [/\.ssh\b|\.aws\b|\.netrc\b|\.npmrc\b|\.gnupg\b|id_rsa/i, "الوصول لمفاتيح النظام"],
  [/(api[_-]?key|apikey|access[_-]?token|secret)[^\n]{0,40}(curl|fetch|https?:\/\/|post\b)/i, "محاولة تسريب مفاتيح"],
  [/\brm\s+-rf\s+[~\/]/i, "أمر حذف خطير"],
  [/keystore|metamask|seed\s*phrase|wallet\s*(seed|mnemonic)/i, "محاولة الوصول لمحافظ"],
  [/xox[baprs]-[a-zA-Z0-9-]{10,}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{30,}/, "أنماط مفاتيح حقيقية داخل المحتوى"],
]

export interface HubCandidate {
  slug: string
  owner: string
  name: string
  summary: string
  installs: number
  stars: number
  downloads: number
  sourceUrl: string
}

export interface HubHarvestResult {
  added: number
  checked: number
  skipped: boolean
  note: string
}

/** فصل الـfrontmatter عن الجسم (نفس صيغة registry/gitskills) */
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

/**
 * بوابة الأمان: فحص محتوى SKILL.md — أي نمط تنفيذ/تسريب = رفض فوري.
 * النص المرشح لازم يكون تعليمات فعلية (طول معقول) — مش ملف سكريبت متنكر.
 */
export function gateSkillMarkdown(content: string): { ok: boolean; reason: string } {
  if (!content || content.length < 200) return { ok: false, reason: "محتوى ضئيل — مش مهارة تعليمات" }
  if (content.length > 120_000) return { ok: false, reason: "محتوى ضخم بشكل غير طبيعي" }
  for (const [re, why] of BLOCK_PATTERNS) {
    if (re.test(content)) return { ok: false, reason: `مرفوض أمانًا: ${why}` }
  }
  // لازم فيه بُنية ماركداون (عناوين/قوائم) — ده ملف تعليمات مش نص عشوائي
  const structure = (content.match(/^#{1,4}\s|\n[-*]\s|\n\d+\.\s/gm) ?? []).length
  if (structure < 2) return { ok: false, reason: "مفيش بنية تعليمات واضحة" }
  return { ok: true, reason: "عدّى البوابة" }
}

/** بحث موجّه في مكتبة ClawHub — بيرجع مرشحين غير مشبوهين بس (isSuspicious=false) + سبب الفشل لو حصل */
export interface HubSearchResult {
  candidates: HubCandidate[]
  httpStatus?: number
  error?: string
}
export async function hubSearch(query: string, limit = 8): Promise<HubSearchResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const res = await fetch(`${CLAWHUB_BASE}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "LeadOS-HubBridge/1.0", Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) return { candidates: [], httpStatus: res.status, error: `HTTP ${res.status}` }
    const data = (await res.json()) as {
      results?: Array<Record<string, unknown>>
    }
    const out: HubCandidate[] = []
    for (const r of data.results ?? []) {
      const install = r.install as { kind?: string; reference?: string } | undefined
      // التفاصيل جوه native.skill (شكل استجابة ClawHub) — و fallback للجذر لو اتغيّر الشكل
      const native = r.native as { skill?: Record<string, unknown> } | undefined
      const skillRaw = (native?.skill ?? r.skill) as
        | { slug?: string; displayName?: string; summary?: string; isSuspicious?: boolean; stats?: { installs?: number; stars?: number; downloads?: number } }
        | undefined
      if (!install || install.kind !== "clawhub" || !install.reference) continue
      if (!skillRaw || skillRaw.isSuspicious) continue // الموقع نفسه بيلمّ السكيلز الخبيثة — بنستمع لتحذيره
      const slug = String(install.reference)
      const slugTail = String(skillRaw.slug || slug.split("/")[1] || "")
      if (!slugTail) continue
      const stats = skillRaw.stats as { installs?: number; stars?: number; downloads?: number } | undefined
      out.push({
        slug,
        owner: String(r.ownerHandle ?? (native as { ownerHandle?: string } | undefined)?.ownerHandle ?? slug.split("/")[0] ?? ""),
        name: String(skillRaw.displayName || slugTail).slice(0, 120),
        summary: String(skillRaw.summary ?? "").slice(0, 400),
        installs: Number(stats?.installs ?? 0) || 0,
        stars: Number(stats?.stars ?? 0) || 0,
        downloads: Number(r.downloads ?? stats?.downloads ?? 0) || 0,
        sourceUrl: `${CLAWHUB_BASE}${String(r.canonicalUrl ?? `/${slug}`)}`.slice(0, 300),
      })
    }
    return { candidates: out, httpStatus: res.status }
  } catch (err) {
    return { candidates: [], error: err instanceof Error ? err.message.slice(0, 80) : "network" }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * استخراج SKILL.md من حزمة ZIP (تحليل Central Directory + zlib — بدون مكتبات خارجية).
 * بيرجع null لو: مفيش SKILL.md (سكريبتات بس → مش مهارة تعليمات) أو الحزمة فاسدة.
 */
export function extractSkillMdFromZip(buf: Buffer): string | null {
  if (buf.length < 22 || buf.length > 6 * 1024 * 1024) return null
  // End Of Central Directory: من الآخر — بيتحمل التعليقات اللي بعد التوقيع
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 65_536)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const total = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < total && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nlen = buf.readUInt16LE(off + 28)
    const elen = buf.readUInt16LE(off + 30)
    const clen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nlen).toString("utf8")
    const base = (name.split("/").pop() ?? "").toLowerCase()
    if (!name.endsWith("/") && base === "skill.md" && csize > 0 && lho + 30 <= buf.length) {
      const lnlen = buf.readUInt16LE(lho + 26)
      const lelen = buf.readUInt16LE(lho + 28)
      const start = lho + 30 + lnlen + lelen
      if (start + csize > buf.length) return null
      const raw = buf.slice(start, start + csize)
      try {
        const out = method === 0 ? raw : inflateRawSync(raw)
        const text = out.toString("utf8")
        return text.length >= 200 ? text.slice(0, 120_000) : null
      } catch {
        return null
      }
    }
    off += 46 + nlen + elen + clen
  }
  return null
}

/** تحميل حزمة مهارة واستخراج SKILL.md — مفيش تنفيذ لأي حاجة، قراءة نصية بس */
async function fetchSkillMarkdown(slug: string): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(`${CLAWHUB_BASE}/api/v1/download?slug=${encodeURIComponent(slug.split("/")[1] ?? slug)}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "LeadOS-HubBridge/1.0" },
      cache: "no-store",
    })
    if (!res.ok) return null
    const arr = new Uint8Array(await res.arrayBuffer())
    if (arr.length > 6 * 1024 * 1024) return null
    return extractSkillMdFromZip(Buffer.from(arr))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** حصاد ClawHub: بحث موجّه → أفضل المرشحين → SKILL.md → بوابة أمان → تخزين. بيرجع ملخص */
export async function harvestClawHub(opts?: { budgetMs?: number }): Promise<HubHarvestResult> {
  const started = Date.now()
  const budget = opts?.budgetMs ?? HARVEST_BUDGET_MS
  // التقييد: آخر حصاد قريب (من أي instance)؟ نستنى — النبضة أهم
  const latest = await db.hubSkill.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }).catch(() => null)
  if (latest && Date.now() - latest.createdAt.getTime() < HUB_GAP_MS) {
    return { added: 0, checked: 0, skipped: true, note: "حصاد ClawHub حديث موجود — المرة الجاية بعد فترة" }
  }

  // استعلامات موجّهة بالصيد — بتتلف عليها كل حصاد (shuffle) عشان تنوّع الكشف.
  // ⚠️ لازم تكون قصيرة (1-2 كلمة): بحث ClawHub بيطابق أسماء السكيلز حرفيًا،
  // والاستعلامات الطويلة بترجع صفر نتايج (اتثبت اختبارًا حيًا 2026-09-29).
  const QUERIES = [
    "lead generation",
    "cold email",
    "whatsapp",
    "instagram",
    "scraping",
    "crm",
    "outreach",
    "marketing",
    "seo",
    "facebook",
  ]
  const picked = [...QUERIES].sort(() => Math.random() - 0.5).slice(0, 3)

  // جمع المرشحين من البحث + ترتيب بالصلة (المكوّن المشترك مع GitSkills) والإحصائيات
  const seen = new Set<string>()
  const diag: string[] = [] // تشخيص كل استعلام — بيتكتب في نتيجة الجوب عشان الفشل مايتدفنش
  const scored: Array<{ c: HubCandidate; relevance: number; tags: string[] }> = []
  let checked = 0
  for (const q of picked) {
    if (Date.now() - started > budget) break
    const found = await hubSearch(q, 8)
    if (found.error || found.httpStatus !== 200) {
      diag.push(`q="${q}" ${found.error ?? `http=${found.httpStatus}`}`)
    } else if (!found.candidates.length) {
      diag.push(`q="${q}" 0-نتايج`)
    }
    checked += found.candidates.length
    for (const c of found.candidates) {
      if (seen.has(c.slug)) continue
      seen.add(c.slug)
      const existing = await db.hubSkill.findUnique({ where: { slug: c.slug }, select: { id: true } }).catch(() => null)
      if (existing) continue // عندي إياه بالفعل
      const hay = `${c.name} ${c.summary}`
      const { relevance, tags } = scoreSkill(c.name, c.summary, hay)
      if (relevance < MIN_RELEVANCE) continue
      scored.push({ c, relevance: relevance + Math.min(c.installs / 50, 8) + Math.min(c.stars, 5), tags })
    }
  }
  scored.sort((a, b) => b.relevance - a.relevance)

  // تحميل وتفحص أعلى المرشحين — لحد السقف أو نفاد الوقت
  let added = 0
  let gatedOut = 0
  for (const { c } of scored) {
    if (added >= MAX_NEW_PER_HARVEST || Date.now() - started > budget) break
    const md = await fetchSkillMarkdown(c.slug)
    if (!md) continue // حزمة سكريبتات بدون SKILL.md — مش مهارة تعليمات، بنستبعدها
    const gate = gateSkillMarkdown(md)
    if (!gate.ok) {
      gatedOut++
      continue
    }
    const { fm, body } = parseFrontmatter(md)
    const { relevance, tags } = scoreSkill(c.name, c.summary, md.slice(0, 4000))
    if (relevance < MIN_RELEVANCE) continue
    const res = await db.hubSkill
      .upsert({
        where: { slug: c.slug },
        create: {
          slug: c.slug,
          owner: c.owner,
          name: c.name,
          summary: c.summary,
          body: (body || md).slice(0, 2500),
          tags: [...new Set([...tags, ...String(fm.tags ?? "").split(/[,;]\s*/)])].filter(Boolean).slice(0, 6).join(","),
          relevance,
          installs: c.installs,
          stars: c.stars,
          downloads: c.downloads,
          sourceUrl: c.sourceUrl,
        },
        update: { relevance: { set: Math.max(relevance, 0) }, installs: c.installs, stars: c.stars, downloads: c.downloads },
      })
      .catch(() => null)
    if (res) added++
  }
  return {
    added,
    checked,
    skipped: false,
    note: added
      ? `حصاد ClawHub: ${added} مهارة جديدة (رُفضت ${gatedOut} أمانًا) من ${checked} نتيجة بحث`
      : `حصاد ClawHub: مفيش مرشحين عدّوا البوابة (${gatedOut} مرفوضة أمانًا من ${checked} نتيجة)${diag.length ? ` — ${diag.join(" | ")}` : ""}`,
  }
}

/** تكتيكات ClawHub لمنصة/نيش — سطور جاهزة للبرومبت (نفس شكل GitSkills) */
export async function hubTactics(platform: string, niche: string, k = 2): Promise<string[]> {
  try {
    const nicheTokens = niche.toLowerCase().split(/\s+/).filter((w) => w.length >= 4)
    const rank = (rows: Array<{ name: string; summary: string; tags: string; weight: number }>) =>
      rows
        .map((r) => {
          const hay = `${r.name} ${r.summary} ${r.tags}`.toLowerCase()
          const nicheHits = nicheTokens.filter((t) => hay.includes(t)).length
          return { r, score: nicheHits * 2 + r.weight }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ r }) => `- [ClawHub] ${r.name}: ${(r.summary || "").slice(0, 140)}`)
    if (!platform) {
      const top = await db.hubSkill.findMany({ orderBy: [{ weight: "desc" }, { relevance: "desc" }], take: k * 3 })
      return rank(top)
    }
    const platformTag = platform.toLowerCase()
    const rows = await db.hubSkill.findMany({
      where: {
        OR: [
          { tags: { contains: platformTag } },
          { body: { contains: platform.slice(0, 4).toLowerCase() } },
          { summary: { contains: platform.slice(0, 4).toLowerCase() } },
        ],
      },
      orderBy: [{ weight: "desc" }, { relevance: "desc" }],
      take: k * 4,
    })
    return rank(rows)
  } catch {
    return []
  }
}

/** تسجيل استخدام تكتيكات (دخلت برومبت AI) */
export async function recordHubSkillUse(names: string[]): Promise<void> {
  if (!names.length) return
  try {
    for (const name of names) {
      await db.hubSkill.updateMany({ where: { name }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } })
    }
  } catch {
    // best-effort
  }
}

/** مكافأة الليد: التكتيكات المرتبطة بالمنصة اللي جاب الليد بتاخد وزن */
export async function rewardHubTactics(platform: string, k = 2): Promise<void> {
  try {
    const platformTag = platform.toLowerCase()
    const rows = await db.hubSkill.findMany({
      where: {
        OR: [
          { tags: { contains: platformTag } },
          { body: { contains: platform.slice(0, 4).toLowerCase() } },
          { summary: { contains: platform.slice(0, 4).toLowerCase() } },
        ],
      },
      orderBy: [{ weight: "desc" }, { relevance: "desc" }],
      take: k,
      select: { id: true },
    })
    for (const r of rows) {
      await db.hubSkill.update({ where: { id: r.id }, data: { leadCount: { increment: 1 }, weight: { increment: 0.2 } } }).catch(() => undefined)
    }
  } catch {
    // best-effort
  }
}

/** إحصائيات المكتبة — للوجز ولوحة الحالة */
export async function hubLibraryStats(): Promise<{ total: number; names: string[] }> {
  try {
    const total = await db.hubSkill.count()
    const top = await db.hubSkill.findMany({ orderBy: [{ weight: "desc" }, { relevance: "desc" }], take: 3, select: { name: true } })
    return { total, names: top.map((t) => t.name) }
  } catch {
    return { total: 0, names: [] }
  }
}
