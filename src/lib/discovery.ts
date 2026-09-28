// LeadOS — Discovery Layer (doc §6, §7, §9) — REAL DATA ONLY
// Every adapter searches the live web through a multi-provider chain
// (Serper → Tavily → SerpAPI → Exa → z-ai fallback) with platform-targeted
// `site:` operators, or Google Places when GOOGLE_MAPS_API_KEY is present.
// No sample/mock generators: if a platform returns nothing, it returns nothing.
import type { Prisma } from "@prisma/client"
import { asArray, seasonFor, EGYPT_GOVERNORATES } from "@/lib/constants"
import { searchBingViaZenrows } from "@/lib/serp-scrape"

export interface DiscoveredItem {
  externalId: string
  title: string
  body: string
  url: string
  authorName?: string
  authorHandle?: string
  publishedAt?: Date
  contentType: string
  language: string
  rawData?: Prisma.InputJsonValue
  // تتبع التعلم: أنهي مهارة (منصة) جابت العنصر ده + بأنهي استعلام — عشان
  // SkillStat/SkillLesson يتغذوا بالنتايج الحقيقية (عقل المهارات — doc §3)
  viaType?: string
  viaQuery?: string
}

export interface SearchPlan {
  goal: string
  queries: string[]
  sources: string[]
  freshness_days: number
  min_score: number
  language: string[]
}

// ---- Search Planner (doc §7): query expansion ----
export function buildSearchPlan(rule: {
  name: string
  cities?: unknown
  industries?: unknown
  services?: unknown
  keywords?: unknown
  countries?: unknown
}): SearchPlan {
  const cities = asArray(rule.cities)
  const industries = asArray(rule.industries)
  const services = asArray(rule.services)
  const keywords = asArray(rule.keywords)

  const templates = [
    (c: string, i: string, s: string) => `${c} ${i} محتاج ${s}`,
    (c: string, i: string, s: string) => `${c} ${i} عايز ${s}`,
    (c: string, i: string, s: string) => `${c} ${i} looking for ${s}`,
    (c: string, i: string, s: string) => `حد يعرف مبرمج ${s} في ${c} ${i}`,
    (c: string, i: string, s: string) => `${c} ${i} ترشيح شركة ${s}`,
  ]
  const cityList = cities.length ? cities : ["Cairo", "Giza", "Alexandria"]
  const industryList = industries.length ? industries : [""]
  const serviceList = services.length ? services : ["برمجة", "website", "تطبيق"]
  const queries: string[] = []
  // الكلمات المفتاحية الصريحة أهم — بتتحط الأول قبل قوالب المدن/الصناعات
  for (const k of keywords) queries.push(k)
  for (const c of cityList) {
    for (const i of industryList) {
      for (const s of serviceList) {
        queries.push(templates[queries.length % templates.length](c, i, s))
      }
    }
  }
  if (!queries.length) queries.push(rule.name)
  // ══ التوسيع الكبير (طلب: زود عدد الليدز) ══
  // 1) كل استعلام يتفتّح لأشكال عامية/دوركات/موسمية بدوران بالساعة — كل مسح يجيب نتائج جديدة
  // 2) التوسيع الجغرافي: محافظة مختلفة كل يوم — مسح مصر محافظة بمحافظة
  const govIdx = new Date().getUTCDate() % EGYPT_GOVERNORATES.length
  const gov = EGYPT_GOVERNORATES[govIdx]
  const expanded: string[] = []
  const seen = new Set<string>()
  // الاستعلامات الأصلية أهم — ثابتة أولًا بدون دوران
  for (const q of queries.slice(0, 4)) {
    if (!seen.has(q)) { seen.add(q); expanded.push(q) }
  }
  for (const q of queries.slice(0, 6)) {
    for (const v of expandQueryEgyptian(q, { max: 6, dorks: true })) {
      if (!seen.has(v)) { seen.add(v); expanded.push(v) }
    }
  }
  // نسخة المحافظة اليومية (توسيع جغرافي تدريجي)
  if (industries.length || services.length) {
    expanded.push(`${industries.join(" ") || "بيزنس"} ${services.join(" ") || "خدمات"} ${gov}`.replace(/\s+/g, " ").trim())
  }
  return {
    goal: rule.name,
    queries: expanded.slice(0, 14),
    sources: ["web", "social", "business"],
    freshness_days: 14,
    min_score: 50,
    language: ["ar", "en"],
  }
}

// ═══════════ مولّد الاستعلامات الموسّع (طلب: زود عدد الليدز — عامية + دوركينج + موسمية + جغرافيا) ═══════════

/** أشكال عصرية لنفس النية — كل استعلام واحد يطلع 10-15 طريقة بحث مختلفة بيوصّل لمنشورات مختلفة */
const INTENT_SLANG = [
  (x: string) => `محتاج ${x}`,
  (x: string) => `عايز ${x}`,
  (x: string) => `عاوز ${x}`,
  (x: string) => `محتاجين ${x}`,
  (x: string) => `حد يعرف حد ${x}`,
  (x: string) => `مين يعرف ${x}`,
  (x: string) => `مين ينصحني ${x}`,
  (x: string) => `بدور على ${x}`,
  (x: string) => `ترشيح ${x}`,
  (x: string) => `بديل ${x}`,
  (x: string) => `${x} كام`,
  (x: string) => `${x} فين`,
  (x: string) => `شركة ${x}`,
  (x: string) => `looking for ${x}`,
  (x: string) => `need recommendation ${x}`,
]

/** دوركات جوجل المتقدمة — بتوصل لمنشورات ومستندات البحث العادي مش بيطلعها */
const DORK_TEMPLATES = [
  (x: string) => `site:facebook.com/groups ${x}`,
  (x: string) => `site:facebook.com "${x}" ("محتاج" OR "عايز" OR "حد يعرف")`,
  (x: string) => `("${x}") ("الإيميل" OR "البريد الإلكتروني" OR "contact us" OR "email")`,
  (x: string) => `filetype:pdf OR filetype:xlsx "قائمة أسعار" ${x}`,
  (x: string) => `inurl:contact "${x}" مصر`,
]

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** بذرة دوران حسب الساعة — كل جولة اكتشاف تشوف شكل مختلف من الاستعلامات = ليدز جديدة من نفس المصدر */
function rotationSeed(): number {
  const now = new Date()
  return now.getUTCDate() * 24 + now.getUTCHours()
}

/**
 * توسيع استعلام واحد لأكبر عدد أشكال (عامية مصرية + إنجليزي + دوركات + موسمية).
 * بيدور النتايج بالساعة عشان كل مسح يجيب نتائج جديدة.
 */
export function expandQueryEgyptian(seed: string, opts?: { max?: number; dorks?: boolean }): string[] {
  const max = opts?.max ?? 14
  const useDorks = opts?.dorks ?? true
  const clean = seed.replace(/\s+/g, " ").trim()
  if (!clean) return []
  const variants = new Set<string>([clean])
  for (const f of INTENT_SLANG) variants.add(f(clean))
  if (useDorks) for (const f of DORK_TEMPLATES) variants.add(f(clean))
  // موسمية مصرية: كلمات التوب حسب الشهر
  const season = seasonFor(new Date().getMonth() + 1)
  if (season.boost.length) variants.add(`${clean} ${season.boost[variants.size % season.boost.length]}`)
  // دوران ثابت بالساعة: الخلط يضمن تغطية أشكال مختلفة عبر الجولات
  const rnd = mulberry32(rotationSeed() + clean.length)
  const list = [...variants]
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list.slice(0, max)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- Serper Places (خرائط جوجل بدون GOOGLE_MAPS_API_KEY — من gemان Serper نفسه) ---
export interface PlaceResult {
  title: string
  address?: string
  phone?: string
  website?: string
  rating?: number
  ratingCount?: number
  category?: string
  placeId?: string
  cid?: string
  latitude?: number
  longitude?: number
  priceLevel?: string
}

export async function placesSerper(query: string, limit = 10): Promise<PlaceResult[]> {
  const key = process.env.SERPER_API_KEY
  if (!key) throw new Error("no key")
  // ملاحظة حية: `location` + `hl:ar` معًا بيخلو Serper يرجع بيانات مبتورة (بدون تقييم/تليفون).
  // gl:eg وحده كفاية لتثبيت مصر وبيرجع الحقول كاملة.
  const data = (await fetchJson("https://google.serper.dev/places", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "eg" }),
  })) as {
    places?: Array<{
      title?: string; address?: string; phoneNumber?: string; website?: string
      rating?: number; ratingCount?: number; type?: string; placeId?: string; cid?: string
      latitude?: number; longitude?: number; priceLevel?: string
    }>
  }
  return (data.places ?? [])
    .filter((p) => p.title)
    .slice(0, limit)
    .map((p) => ({
      title: p.title!,
      address: p.address,
      phone: p.phoneNumber,
      website: p.website,
      rating: p.rating,
      ratingCount: p.ratingCount,
      category: p.type,
      placeId: p.placeId,
      cid: p.cid,
      latitude: p.latitude,
      longitude: p.longitude,
      priceLevel: p.priceLevel,
    }))
}

function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/**
 * Parse search-engine date strings safely — providers return relative text
 * ("3 days ago", "منذ 3 أيام", "yesterday") that `new Date()` cannot parse,
 * producing InvalidDate and crashing ingestion. Returns undefined when unknown.
 */
export function parseSearchDate(s?: string | null): Date | undefined {
  if (!s || typeof s !== "string") return undefined
  const direct = new Date(s)
  if (!Number.isNaN(direct.getTime())) return direct
  const rel = s.match(/(\d+)\s*(دقيقة|دقائق|ساعة|ساعات|يوم|أيام|ايام|أسبوع|اسبوع|أسابيع|اسابيع|شهر|أشهر|minute|hour|day|week|month)s?/i)
    ?? s.match(/(منذ|قبل)\s*(\d+)/)
  const n = rel ? parseInt(rel[2] ?? rel[1], 10) : NaN
  if (!Number.isNaN(n)) {
    const unit = (rel?.[0] ?? "").toLowerCase()
    const ms = /دقيقة|minute/.test(unit) ? 60e3
      : /ساعة|hour/.test(unit) ? 3600e3
      : /أسبوع|اسبوع|أسابيع|اسابيع|week/.test(unit) ? 7 * 864e5
      : /شهر|أشهر|month/.test(unit) ? 30 * 864e5
      : 864e5
    return new Date(Date.now() - n * ms)
  }
  if (/أمس|امس|yesterday/i.test(s)) return new Date(Date.now() - 864e5)
  if (/اليوم|today|الآن|الان|just now|hours? ago|ساعة|ساعات/i.test(s)) return new Date(Date.now() - 2 * 3600e3)
  return undefined
}

// ---- Core: multi-provider live web search ----
// Chain: Serper (أقوى — Google SERP) → Tavily → SerpAPI → Exa → z-ai (مدمج)
// كل مزود له مفتاح في البيئة؛ أول فشل يتنقل تلقائيًا للمزود التالي، والمزود الشغال بيفضل مفضّل (sticky).
interface WebSearchResult {
  url: string
  name: string
  snippet: string
  host_name: string
  date?: string
  rank?: number
  /** إعلان ممول من SERP (حقل ads من Serper) — معلن بيصرف فلوس في نفس النيش = عميل ذهب */
  sponsored?: boolean
  /** الدومين الظاهر في الإعلان (ادvertiser domain) — بيستخدم كاسم/موقع المعلن */
  displayedLink?: string
}

type SearchProvider = "serper" | "exa" | "jina" | "zenrows" | "bing" | "tavily" | "serpapi" | "searxng" | "zai"

let preferredProvider: SearchProvider | null = null

export async function agentWebSearch(query: string, limit = 8, recencyDays = 30): Promise<{ results: WebSearchResult[]; provider: string }> {
  return rawWebSearch(query, limit, recencyDays)
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function googleTimeFilter(recencyDays: number): string | undefined {
  if (recencyDays <= 1) return "qdr:d"
  if (recencyDays <= 7) return "qdr:w"
  if (recencyDays <= 31) return "qdr:m"
  return undefined
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 9000): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// --- Serper (google.serper.dev — أعلى جودة وأرخص فشل) ---
// كاش الموت: لما الكريدت يخلص (400 Not enough credits) مفيش لازمة نكلف كل استعلام 0.5 ث فشل —
// بنعلّم المزود ميت 6 ساعات، وبنجرب تاني لما صاحبنا يجيب مفتاح جديد (الإعادة كل نشر جديد على أي حال)
const providerDeadUntil = new Map<string, number>()
function noteProviderDead(name: string, hours = 6): void {
  providerDeadUntil.set(name, Date.now() + hours * 3600_000)
}
function isProviderDead(name: string): boolean {
  return (providerDeadUntil.get(name) ?? 0) > Date.now()
}

async function searchSerper(query: string, limit: number, recencyDays: number): Promise<WebSearchResult[]> {
  const key = process.env.SERPER_API_KEY
  if (!key) throw new Error("no key")
  if (isProviderDead("serper")) throw new Error("serper dead-cache (credits خلصانة — كاش 6 ساعات)")
  const tbs = googleTimeFilter(recencyDays)
  try {
    const data = (await fetchJson("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: Math.min(limit, 20), gl: "eg", hl: "ar", ...(tbs ? { tbs } : {}) }),
    })) as {
      organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string; position?: number }>
      ads?: Array<{ title?: string; link?: string; snippet?: string; description?: string; displayed_link?: string; position?: number }>
    }
    const organic = (data.organic ?? [])
      .filter((r) => r.link)
      .map((r) => ({
        url: r.link!,
        name: r.title ?? "",
        snippet: r.snippet ?? "",
        host_name: hostnameOf(r.link!),
        date: r.date,
        rank: r.position,
      }))
    // الإعلانات الممولة: عنوان الإعلان + نصه + رابط الهبوط + الدومين الظاهر للمعلن
    const ads = (data.ads ?? [])
      .filter((a) => a.link)
      .slice(0, 4)
      .map((a) => ({
        url: a.link!,
        name: a.title ?? "",
        snippet: a.snippet ?? a.description ?? "",
        host_name: hostnameOf(a.link!),
        date: undefined,
        rank: 0, // فوق كل الـorganic — أعلى نية
        sponsored: true,
        displayedLink: a.displayed_link ?? hostnameOf(a.link!),
      }))
    return [...ads, ...organic]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // الكريدت خلص = موت شبه دائم — كاش 6 ساعات عشان ميتأخرش على السلسلة كل استعلام
    if (msg.includes("HTTP 400") || msg.includes("HTTP 402") || msg.includes("HTTP 403")) noteProviderDead("serper", 6)
    throw err
  }
}

// --- Tavily ---
async function searchTavily(query: string, limit: number, recencyDays: number): Promise<WebSearchResult[]> {
  const key = process.env.TAVILY_API_KEY
  if (!key) throw new Error("no key")
  if (isProviderDead("tavily")) throw new Error("tavily dead-cache (حصة الشهر خلصت — بترجع أول الشهر)")
  try {
    const data = (await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        max_results: Math.min(limit, 15),
        search_depth: "basic",
        include_answer: false,
        ...(recencyDays <= 90 ? { days: Math.max(1, recencyDays) } : {}),
      }),
    })) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>
    }
    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r, i) => ({
        url: r.url!,
        name: r.title ?? "",
        snippet: r.content ?? "",
        host_name: hostnameOf(r.url!),
        date: r.published_date,
        rank: i + 1,
      }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 432/429 = حصة الشهر خلصت — موت مؤقت معروف، كاش 6 ساعات
    if (msg.includes("HTTP 432") || msg.includes("HTTP 429")) noteProviderDead("tavily", 6)
    throw err
  }
}

// --- SerpAPI ---
async function searchSerpApi(query: string, limit: number, recencyDays: number): Promise<WebSearchResult[]> {
  const key = process.env.SERPAPI_API_KEY
  if (!key) throw new Error("no key")
  if (isProviderDead("serpapi")) throw new Error("serpapi dead-cache (الـ 41 بحث خلصوا)")
  const tbs = googleTimeFilter(recencyDays)
  try {
    const params = new URLSearchParams({ engine: "google", q: query, num: String(Math.min(limit, 20)), gl: "eg", hl: "ar", api_key: key })
    if (tbs) params.set("tbs", tbs)
    const data = (await fetchJson(`https://serpapi.com/search.json?${params.toString()}`, { method: "GET" })) as {
      organic_results?: Array<{ title?: string; link?: string; snippet?: string; date?: string; position?: number }>
    }
    return (data.organic_results ?? [])
      .filter((r) => r.link)
      .map((r) => ({
        url: r.link!,
        name: r.title ?? "",
        snippet: r.snippet ?? "",
        host_name: hostnameOf(r.link!),
        date: r.date,
        rank: r.position,
      }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("HTTP 401") || msg.includes("HTTP 429")) noteProviderDead("serpapi", 6)
    throw err
  }
}

// --- Exa ---
// ترقية بعد موت كريدت Serper: Exa بيفهم site: من خلال includeDomains (فلتر بنيوي مضمون —
// بينج بيتجاهل site: من سيرفرات الداتا سنتر، لكن Exa بيدومينات حرفيًا بيرجع المنصة الصح 100%)
function extractSiteDomains(query: string): { domains: string[]; clean: string } {
  const domains: string[] = []
  const stripped = query.replace(/\bsite:([^\s)]+)/g, (_, d: string) => {
    const dom = d.split("/")[0].replace(/^www\./, "")
    if (dom) domains.push(dom)
    return " "
  })
  const clean = stripped.replace(/[()]/g, " ").replace(/\bOR\b/g, " ").replace(/\s+/g, " ").trim()
  return { domains: [...new Set(domains)].slice(0, 10), clean }
}

async function searchExa(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = process.env.EXA_API_KEY
  if (!key) throw new Error("no key")
  const { domains, clean } = extractSiteDomains(query)
  const data = (await fetchJson("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: clean || query,
      numResults: Math.min(limit, 10),
      type: "auto",
      contents: { text: { maxCharacters: 300 } },
      // استعلامات المنصة (site:) → فلتر دومينات صريح — بيحل مشكلة Bing اللي بيتجاهل العمليات
      ...(domains.length ? { includeDomains: domains } : {}),
    }),
  })) as {
    results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }>
  }
  return (data.results ?? [])
    .filter((r) => r.url)
    .map((r, i) => ({
      url: r.url!,
      name: r.title ?? "",
      snippet: r.text ?? "",
      host_name: hostnameOf(r.url!),
      date: r.publishedDate,
      rank: i + 1,
    }))
}

// --- z-ai المدمج (احتياطي أخير) ---
async function searchZai(query: string, limit: number, recencyDays: number): Promise<WebSearchResult[]> {
  const { default: ZAI } = await import("z-ai-web-dev-sdk")
  const zai = await ZAI.create()
  const delays = [0, 2000, 5000]
  let lastErr: unknown
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt])
    try {
      const results = (await zai.functions.invoke("web_search", {
        query,
        num: limit,
        recency_days: recencyDays,
      })) as WebSearchResult[]
      return Array.isArray(results) ? results : []
    } catch (err) {
      lastErr = err
      // استعلام من غير نتايج مش خطأ — رجّع فاضي عشان السلسلة تكمل
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("422") || msg.toLowerCase().includes("no search results")) return []
      // 429 → مفيش لازمة إعادة محاولة — التبريد العام بيتكفل (إعادة المحاولة بتحرق الكوتة المتعافية)
      if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) break
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("zai failed")
}

// --- SearXNG (ميتا-بحث مفتوح المصدر self-hosted — مجاني وغير محدود) ---
async function searchSearx(query: string, limit: number, recencyDays: number): Promise<WebSearchResult[]> {
  const base = process.env.SEARXNG_URL
  if (!base) throw new Error("no searxng url")
  const params = new URLSearchParams({
    q: query, format: "json", language: "ar-EG", safesearch: "1",
    ...(recencyDays <= 7 ? { time_range: "week" } : recencyDays <= 31 ? { time_range: "month" } : {}),
  })
  const data = (await fetchJson(`${base.replace(/\/$/, "")}/search?${params.toString()}`, {
    method: "GET",
    headers: { "X-Forwarded-For": "127.0.0.1" },
  })) as {
    results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>
  }
  return (data.results ?? [])
    .filter((r) => r.url)
    .slice(0, limit)
    .map((r, i) => ({
      url: r.url!,
      name: r.title ?? "",
      snippet: r.content ?? "",
      host_name: hostnameOf(r.url!),
      date: r.publishedDate,
      rank: i + 1,
    }))
}

// --- Jina Search (s.jina.ai — بحث حقيقي بيفهم site: ويرجّع محتوى الصفحة نفسها لكل نتيجة) ---
// رصيد المفتاح ضخم (~10M) — بيشيل ضغط السلسلة لما serper/tavily يكونوا ميتين، ومحتوى الصفحة
// بيخلي التصنيف أدق (snippet بدل content) من غير جلب إضافي.
async function searchJina(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = process.env.JINA_API_KEY
  if (!key) throw new Error("no key")
  if (isProviderDead("jina")) throw new Error("jina dead-cache")
  try {
    const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "X-With-Generated-Alt": "false" },
      signal: AbortSignal.timeout(22000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      code?: number
      data?: Array<{ title?: string; url?: string; description?: string; content?: string; date?: string }>
    }
    const rows = (Array.isArray(data.data) ? data.data : []).filter((r): r is typeof r & { url: string } => Boolean(r.url))
    if (!rows.length) throw new Error("no results")
    return rows.slice(0, limit).map((r, i) => ({
      url: r.url,
      name: r.title ?? "",
      snippet: (r.description ?? r.content ?? "").slice(0, 600),
      host_name: hostnameOf(r.url),
      date: r.date,
      rank: i + 1,
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 401/403 = مفتاح بايظ → كاش موت 6 ساعات (نفس منطق serper)
    if (msg.includes("401") || msg.includes("403")) noteProviderDead("jina", 6)
    throw err
  }
}

const PROVIDER_ORDER: Array<{ name: SearchProvider; run: (q: string, l: number, r: number) => Promise<WebSearchResult[]> }> = [
  { name: "serper", run: searchSerper },
  // exa الأول بعد serper: حي + بيفهم site: بفلتر includeDomains — ده محرك المنصات الأساسي دلوقتي
  { name: "exa", run: (q, l) => searchExa(q, l) },
  // jina بعد exa: بيفهم site: + بيرجّع محتوى كامل — بيشيل الضغط لما serper/tavily موتاني ورصيده ضخم
  { name: "jina", run: (q, l) => searchJina(q, l) },
  // zenrows→Bing: كريدت 1/طلب، 3 مفاتيح دوران + ميزانية يومية — تغطية ويب عامة (مهم للصيغ من غير site:)
  { name: "zenrows", run: (q, l) => searchBingViaZenrows(q, l) },
  // serpapi بعد zenrows: 41 بحث فاضل بس — نحافظ عليهم للطوارئ (بيطلعوا لما zenrows يفشل/يخلص)
  { name: "serpapi", run: searchSerpApi },
  { name: "tavily", run: searchTavily },
  { name: "searxng", run: searchSearx },
  { name: "zai", run: searchZai },
]

// ─── تبريد بحث عام: لما ز-ai يضرب 429 بنستنى بدل ما نحرق محاولات المهام ───
// 429 → دقيقتين سكتة على مستوى النظام كله (مفيش نداءات بحث خالص)
// اللي بيلمح التبريد بيرجع نتيجة فاضية فورًا — والتابعة في الطابور بتتقفل بـ"مؤجلة بسبب التبريد"
let searchCooldownUntil = 0
export function searchCooldownRemaining(): number {
  return Math.max(0, searchCooldownUntil - Date.now())
}

export async function rawWebSearch(query: string, limit: number, recencyDays: number): Promise<{ results: WebSearchResult[]; provider: SearchProvider | "none" }> {
  // التبريد النشط → صفر نداءات (بندّخر الكوتة المتعافية للتابعة القادمة)
  if (searchCooldownRemaining() > 0) return { results: [], provider: "none" }
  const chain = preferredProvider
    ? [PROVIDER_ORDER.find((p) => p.name === preferredProvider)!, ...PROVIDER_ORDER.filter((p) => p.name !== preferredProvider)]
    : PROVIDER_ORDER
  for (const provider of chain) {
    try {
      const results = await provider.run(query, limit, recencyDays)
      preferredProvider = provider.name
      return { results, provider: provider.name }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[discovery] provider ${provider.name} failed: "${query.slice(0, 50)}" — ${msg.slice(0, 100)}`)
      // 429 من المزود الأخير (ز-ai عادةً) → تبريد عام دقيقتين
      if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
        searchCooldownUntil = Date.now() + 120_000
        console.warn("[discovery] rate-limit عام — تبريد بحث دقيقتين عشان الكوتة تتعافى")
      }
    }
  }
  console.warn(`[discovery] كل المزودين فشلوا: "${query.slice(0, 60)}"`)
  return { results: [], provider: "none" }
}

function toItem(
  r: WebSearchResult,
  opts: { contentType: string; platform: string; query: string; recencyDays: number; provider?: string },
): DiscoveredItem {
  return {
    externalId: `ws:${hashId(r.url)}`,
    title: r.name,
    body: r.snippet,
    url: r.url,
    contentType: opts.contentType,
    language: /[\u0600-\u06FF]/.test(`${r.name} ${r.snippet}`) ? "ar" : "en",
    publishedAt: parseSearchDate(r.date),
    rawData: {
      host: r.host_name,
      rank: r.rank ?? 0,
      query: opts.query,
      platform: opts.platform,
      adapter: "live_web",
      provider: opts.provider ?? "zai",
      freshnessDays: opts.recencyDays,
      // بصمة الإعلان الممول: المعلن ده بيصرف فلوس الآن — الابتلاع بيحوله AD_SPENDER تلقائيًا
      ...(r.sponsored ? { sponsored: true, advertiser: r.displayedLink ?? r.host_name, adChannel: "google_ads" } : {}),
    } as Prisma.InputJsonValue,
  }
}

/** Content type inferred from the result URL (posts vs profiles vs videos vs pages). */
function socialContentType(url: string): string {
  const u = url.toLowerCase()
  if (u.includes("facebook.com/groups") || u.includes("/posts/") || u.includes("/status/")) return "POST"
  if (u.includes("t.me/") || u.includes("telegram.me/")) return "POST"
  if (u.includes("reddit.com/r/")) return "POST"
  if (u.includes("linkedin.com/posts") || u.includes("linkedin.com/pulse")) return "POST"
  if (u.includes("youtube.com/watch") || u.includes("youtu.be") || u.includes("tiktok.com")) return "VIDEO"
  if (u.includes("instagram.com") || u.includes("tiktok.com")) return "POST"
  if (u.includes("linkedin.com/in/")) return "PROFILE"
  if (u.includes("facebook.com/")) return "PAGE"
  return "SEARCH_RESULT"
}

// ---- Platform adapter: live search restricted to a platform's domains ----
export const PLATFORM_SITES: Record<string, string[]> = {
  FACEBOOK: ["facebook.com"],
  INSTAGRAM: ["instagram.com"],
  X: ["x.com", "twitter.com"],
  LINKEDIN: ["linkedin.com"],
  REDDIT: ["reddit.com"],
  TIKTOK: ["tiktok.com"],
  YOUTUBE: ["youtube.com"],
  DIRECTORY: ["yellowpages.com.eg", "egypt-business.com", "industrydir.com", "egyptianfoods.com", "elwakf.com"],
  JOBS: ["wuzzuf.net", "forasna.com", "linkedin.com/jobs"],
  // منصات اضافية حقيقية (طلب: زيزو يوصل لأي مصدر): اوليكس/هاتلا + منصات العمل الحر العربية
  MARKETPLACE: ["olx.com.eg", "dubizzle.com.eg", "hatla2ee.com"],
  TELEGRAM: ["t.me", "telegram.me"],
  FREELANCE: ["mostaql.com", "khamsat.com", "bahr.sa"],
  // الموجة الجديدة: أعلى نية شراء بأقل خطر حظر (طلبات 24/25)
  // ═══ مكتبات الإعلانات من كل المنصات (طلب: العملاء من إعلانات المنافسين الممولة من كل المصادر) ═══
  // ميتا (فيسبوك+انستجرام) + جوجل/يوتيوب (مركز شفافية الإعلانات) + تيك توك (المحتوى التجاري) + لينكدإن (Ad Library)
  // ملحوظة دقة: «facebook.com/ads» الواسع اتشال — كان بيلقط صفحات عادية اسمها /ads.xxx (زي ads.egypt) مش المكتبة
  ADS_LIBRARY: ["facebook.com/ads/library", "adstransparency.google.com", "ads.tiktok.com", "linkedin.com/ad-library"],
  REVIEWS: ["google.com/maps", "tripadvisor.com", "elmenus.com"],
  EVENTS: ["facebook.com/events", "egyta.com", "cairoict.com", "egyfoodexpo.com", "eventbrite.com", "egyevent.com", "cafex-me.com"],
  QUORA: ["quora.com", "ar.quora.com"],
  // ديسكورد نفسه بيتفهرس ضعيف من جوجل — المجمّعات هي الباب: فيها سيرفرات عربية تجارية بوصف
  DISCORD: ["discord.com", "discord.gg", "disboard.org", "discord.me", "top.gg", "discords.com"],
}

/** سقف أنواع البحث المدفوعة في الجوبة الواحدة — مصادر الـJSON المجانية مش محسوبة معاه */
export const MAX_SOURCE_TYPES_PER_JOB = 6

/**
 * سرقة إعلانات المنافسين (طلب: «يسكراب العملاء من الإعلانات الممولة بتاعة المنافسين من كل المصادر»):
 * لكل منافس مسجل بنتجّد إعلاناته النشطة في كل مكتبات الإعلانات مرة واحدة —
 * ميتا (فيسبوك+انستجرام) + جوجل/يوتيوب (adstransparency) + تيك توك (ads.tiktok.com) + لينكدإن (ad-library).
 * الأدابتر بتضيف سلاسل site: تلقائيًا على الاستعلامات دي — والنتيجة كلها AD_SPENDER تلقائيًا.
 */
export function competitorAdQueries(names: string[], max = 5): string[] {
  const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))].slice(0, 3)
  const out: string[] = []
  for (const n of clean) {
    out.push(`${n} اعلانات`, `${n} اعلان ممول`)
  }
  return out.slice(0, max)
}

// ═════ أسئلة كل منصة بلغتها هي ═════
// (السبب: المنصات الدوارة كانت بتاخد أسئلة القاعدة العامة زي «كافيهات مدينة نصر»
//  — wuzzuf وOLX وQuora عمرها ما هيردوا على السؤال ده = صفر نتايج من 9 منصات)
const SUBJECT_CLEAN_RE = /^(محتاجين|محتاج|عاوزين|عاوز|عايزين|عايز|حد يعرف حد|حد يعرف|مين يعرف|مين ينصحني|بدور على|ببحث عن|ترشيح|بديل|شركة)\s+/

export const PLATFORM_QUERY_SHAPES: Record<string, { shape: (s: string) => string[]; seeds: string[] }> = {
  JOBS: {
    shape: (s) => [`مطلوب ${s}`, `${s} وظائف`],
    seeds: ["مطلوب مدير مبيعات", "مطلوب مصمم جرافيك", "مطلوب مسؤول تسويق", "شركة بتوظف مبرمج", "مطلوب محاسب مصر"],
  },
  MARKETPLACE: {
    shape: (s) => [`${s} للبيع`],
    seeds: ["كافيه للبيع", "مطعم للبيع", "محل ملابس للبيع", "معدات مطعم للبيع", "شركة سياحه للبيع", "مصنع صغير للبيع"],
  },
  ADS_LIBRARY: {
    shape: (s) => [`${s} اعلانات`, `${s} اعلان ممول`],
    seeds: ["اعلان متجر اونلاين", "اعلان عقارات مصر", "اعلان عيادة", "اعلان مطعم", "اعلان كورسات", "اعلانات المنافسين مصر"],
  },
  QUORA: {
    shape: (s) => [`افضل ${s}`, `ازاي اختار ${s}`],
    seeds: ["افضل شركة برمجة في مصر", "ازاي اعمل تطبيق لمشروعي", "افضل سيستم كاشير للمطاعم", "هعمل بيزنس محتاج ايه"],
  },
  EVENTS: {
    shape: (s) => [`معرض ${s}`, `مؤتمر ${s}`],
    seeds: ["معرض مطاعم وكافيهات", "مؤتمر تقنية مصر", "فعاليات ريادة الأعمال", "معرض اغذية مصر", "قمة تسويق مصر"],
  },
  DIRECTORY: {
    shape: (s) => [`${s} دليل شركات`],
    seeds: ["شركات برمجة القاهرة", "شركات تسويق الكتروني مصر", "مصانع أغذية مصر", "شركات اعلانات مصر"],
  },
  REVIEWS: {
    shape: (s) => [`${s} تقييمات`],
    seeds: ["افضل كافيهات القاهرة تقييم", "مطاعم اسكندرية تقييمات", "سوبر ماركت تقييمات عملاء", "عيادات تقييمات مرضى"],
  },
  TIKTOK: {
    shape: (s) => [`${s} تيك توك`],
    seeds: ["براند مصري تيك توك", "متجر اونلاين مصر", "كافيه القاهرة", "منتج مصري اعلان"],
  },
  YOUTUBE: {
    shape: (s) => [`${s} يوتيوب`],
    seeds: ["تجربة مطعم مصر", "مراجعة متجر الكتروني", "ازاي اسوق مشروعي", "رائد اعمال مصري"],
  },
  X: {
    shape: (s) => [`${s} تويتر`],
    seeds: ["محتاج مبرمج", "شكوى خدمة عملاء مصر", "بدور على مصمم", "مشروعي الجديد"],
  },
  DISCORD: {
    shape: (s) => [`${s} discord`],
    seeds: ["سيرفر برمجة عربي", "مجتمع ريادة اعمال مصر", "discord تسويق رقمي", "discord فريلانسرز عرب"],
  },
  FACEBOOK: {
    shape: (s) => [`${s} مجموعة`],
    seeds: ["جروب اصحاب البيزنس", "مجموعة تجار مصر", "جروب مطاعم وكافيهات", "مجموعة تسويق مصر"],
  },
  INSTAGRAM: {
    shape: (s) => [`${s} انستجرام`],
    seeds: ["متجر انستجرام مصري", "براند ملابس مصر", "كافيه مصر انستجرام", "عيادة تجميل انستجرام"],
  },
  LINKEDIN: {
    shape: (s) => [`${s} linkedin`],
    seeds: ["شركة ناشئة مصر linkedin", "مدير تسويق مصر", "startup egypt linkedin", "شركة برمجة القاهرة"],
  },
  FREELANCE: {
    shape: (s) => [`${s} مشروع مستقل`],
    seeds: ["مطلوب مبرمج تطبيق مستقل", "اريد تصميم متجر الكتروني", "محتاج مونتير فيديو", "مطلوب كاتب محتوى"],
  },
}

/**
 * الاستعلامات المخصصة لمنصة معينة:
 * 1) تحويل استعلام القاعدة للغة المنصة (كافيهات → «كافيهات للبيع» على OLX)
 * 2) استعلامان مضمونان من بذور المنصة بالدوران بالساعة — المصدر يفضل نابض حتى لو
 *    استعلام القاعدة ملوش أي علاقة بالمنصة.
 */
export function platformQueries(platform: string, baseQuery: string, max = 3): string[] {
  const shape = PLATFORM_QUERY_SHAPES[platform]
  if (!shape) return [baseQuery]
  const subject = baseQuery.replace(SUBJECT_CLEAN_RE, "").replace(/\s*(مصر|Egypt)$/i, "").trim() || baseQuery
  const hour = Math.floor(Date.now() / 3_600_000)
  const seeds = [shape.seeds[hour % shape.seeds.length], shape.seeds[(hour + 1) % shape.seeds.length]]
  // الاستعلام العام الطويل (زي مسح «عملاء محتاجين خدمات رقمية في مصر») بيخلي الأشكال هرج
  // («مطلوب عملاء محتاجين خدمات رقمية في») — ساعتها البذور المضمونة أذكى من التشكيل
  const useShape = subject.split(/\s+/).length <= 3
  return [...(useShape ? shape.shape(subject) : []), ...seeds].slice(0, max)
}

/** المصادر اللي بتتصطاد بأدوات JSON/HTML مجانية من غير بحث أصلًا — مبتحرقش كوتة البحث */
export const FREE_SOURCE_TYPES = ["REDDIT", "TELEGRAM", "RSS"] as const

/**
 * موجة المنصات الكاملة (طلب: شغّل باقي المصادر):
 * القاعدة في الداتابيز ممكن تكون متسجلة بـ3-4 أنواع بس — لكن المشروع مبني 16+ منصة.
 * الدالة دي بتوسّع الأنواع لكل نبضة:
 * 1) REDDIT/TELEGRAM دايمًا لو مش مستخدمين — أدوات JSON مجانية، صفر كوتة بحث
 * 2) موجة 4 منصات بالساعة — مع أوزان متعلمة (weighted): المنتِج بيتقدم والأعور بيتأخر
 * كده زيزو بيصطاد على كل المصادر بدون أي تعديل على قواعد الداتابيز.
 */
export function expandSourceTypes(types: string[], opts?: { all?: boolean; weighted?: Record<string, number>; starved?: string[] }): string[] {
  const base = types.filter(Boolean)
  const used = new Set(base)
  const all = Object.keys(PLATFORM_SITES)

  // مصادر JSON المجانية الأول — رخيصة وقوية ومش بتحسب من السقف
  const freeStrong = ["REDDIT", "TELEGRAM"].filter((t) => !used.has(t))

  // المسح الشامل (full=1): كل المنصات مرة واحدة — لبذر الليدز على كل المصادر فورًا
  if (opts?.all) {
    const paid = all.filter((t) => !used.has(t) && !(FREE_SOURCE_TYPES as readonly string[]).includes(t))
    return [...freeStrong, ...base, ...paid]
  }

  // الدوران بالساعة: 4 منصات بحث جديدة كل نبضة من اللي مش مستخدمة
  // مع أوزان متعلمة (weighted): المنتِج بيتقدم والأعور بيتأخر — والتعادل بيفضل دوّار بالساعة
  // (اللف الدوري حول النهاية بيمنع نزع المنصات الآخرة لما start يقرب من الآخر)
  const searchUnused = all.filter((t) => !used.has(t) && !(FREE_SOURCE_TYPES as readonly string[]).includes(t))
  const hour = Math.floor(Date.now() / 3_600_000)
  const start = searchUnused.length ? (hour * 4) % searchUnused.length : 0
  const rotated = searchUnused.length ? [...searchUnused.slice(start), ...searchUnused.slice(0, start)] : []
  const weighted = opts?.weighted
  const byWeight = weighted
    ? [...rotated].sort((a, b) => (weighted[b] ?? 1) - (weighted[a] ?? 1))
    : rotated
  // ═══ حق الضعيف (حق الجعان): 3 مقاعد للأقوى وزنًا + مقعد مضمون للجعان (صفر ليدز أطول فترة)
  // — من غير كده الأوزان المتعلمة بتخنق الاستكشاف والمنصة الصامطة بتنام للأبد.
  // الجعان بيتحدد من stats الجايين من الجراف (ليدز=0 أو أقدم lastLead) — والدوران بيفضل شغال جواه.
  const starved = opts?.starved
  const wave: string[] = []
  for (const p of byWeight) {
    if (wave.length >= 3) break
    if (!starved?.includes(p)) wave.push(p)
  }
  if (starved?.length) {
    const rescue = starved.find((p) => searchUnused.includes(p) && !wave.includes(p))
    if (rescue) wave.push(rescue)
  } else {
    wave.push(byWeight.find((p) => !wave.includes(p)) ?? "")
  }

  // الأنواع الأصلية + حصة الدوران حسب السقف (المصادر المجانية مش بتتحاسب)
  const budget = Math.max(0, MAX_SOURCE_TYPES_PER_JOB - base.length)
  // المجاني الأول: Reddit/Telegram JSON بياخدوا نصيبهم المضمون قبل أي نوع بحث —
  // (لو البحث العام اتخنق بكوتة العناصر، المصادر المجانية تفضل شغالة برضه)
  return [...freeStrong, ...base, ...wave.filter(Boolean).slice(0, budget)]
}

// تثبيت جغرافي ذكي: مصر افتراضيًا — إلا لو الاستعلام خليجي (الرياض/دبي...) ساعتها من غير تثبيت
const GULF_RE = /الرياض|جدة|الدمام|السعودية|دبي|أبوظبي|ابوظبي|الشارقة|الشارقه|الإمارات|الامارات|قطر|الدوحة|الكويت|مسقط|المنامة|خليج|riyadh|dubai|jeddah|ksa|uae|qatar|kuwait|doha|bahrain|oman/i
export function geoPin(query: string): string {
  if (/Egypt|مصر/.test(query)) return query
  if (/[\u0600-\u06FF]/.test(query)) return GULF_RE.test(query) ? query : `${query} مصر`
  return `${query} Egypt`
}

/**
 * مطابقة رابط بموقع المنصة — بتدعم مسارات كاملة مش بس دومينات
 * (زي "facebook.com/events" و"linkedin.com/jobs"): الهوست لازم يتطابق والمسار لو موجود.
 * بتمنع نتايج المزودات اللي بتهمل operator الـsite: من التسرب لمنصة غلط.
 */
export function matchesSite(url: string, site: string): boolean {
  try {
    const u = new URL(url)
    const h = u.hostname.replace(/^www\./, "").toLowerCase()
    const clean = site.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase()
    const [siteHost, ...sitePath] = clean.split("/")
    if (!(h === siteHost || h.endsWith(`.${siteHost}`))) return false
    if (!sitePath.length) return true
    return `/${u.pathname.replace(/^\/+/, "")}`.startsWith(`/${sitePath.join("/")}`)
  } catch {
    return false
  }
}

async function platformAdapter(platform: string, query: string, limit: number, recencyDays: number): Promise<DiscoveredItem[]> {
  const sites = PLATFORM_SITES[platform]
  if (!sites) return []
  const pinned = geoPin(query)
  const siteQuery = sites.map((s) => `site:${s}`).join(" OR ")
  const onPlatform = (r: WebSearchResult) => sites.some((s) => matchesSite(r.url, s))
  // ═══ الإعلانات الممولة بتتجاوز فلتر المنصة ═══
  // إعلان ظهر في بحث المنصة = معلن بيستهدف نفس الجمهور/النيش الآن — دومين هبوطه مش لازم
  // يكون جوه المنصة. ده بالظبط «العملاء من إعلانات المنافسين من كل المصادر» — ببلاش من نفس النداء.
  const sponsoredOf = (rs: WebSearchResult[]) => rs.filter((r) => r.sponsored).slice(0, 3)
  const mapItems = (rs: WebSearchResult[], provider: string) =>
    rs.map((r) => toItem(r, { contentType: socialContentType(r.url), platform, query, recencyDays, provider }))

  // المحاولة 1: الصيغة الكاملة (site: OR) — شغالة مع serper/tavily/serpapi
  const first = await rawWebSearch(`(${siteQuery}) ${pinned}`, limit, recencyDays)
  const sponsoredFirst = sponsoredOf(first.results)
  const cleanFirst = first.results.filter(onPlatform)
  if (cleanFirst.length || sponsoredFirst.length) return mapItems([...sponsoredFirst, ...cleanFirst], first.provider)

  // المحاولة 2: استعلام نحيف + دومين رئيسي واحد — مزودات ز-ai بترفض سلاسل site: OR الطويلة
  const slim = pinned.split(/\s+/).slice(0, 5).join(" ")
  const second = await rawWebSearch(`site:${sites[0]} ${slim}`, limit, recencyDays)
  const sponsoredSecond = sponsoredOf(second.results)
  const cleanSecond = second.results.filter(onPlatform)
  if (cleanSecond.length || sponsoredSecond.length) return mapItems([...sponsoredSecond, ...cleanSecond], second.provider)

  // المحاولة 3: بحث عام بدون site: + فلترة على دومينات المنصة — أوسع تغطية لأي مزود
  const third = await rawWebSearch(slim, limit * 2, recencyDays)
  const sponsoredThird = sponsoredOf(third.results)
  const filtered = third.results.filter(onPlatform)
  return mapItems([...sponsoredThird, ...filtered.slice(0, limit)], third.provider)
}

// ---- Reddit JSON adapter (بدون مفاتيح: منشورات حقيقية بنصها الكامل — أقوى من site: search) ----
async function redditJsonAdapter(query: string, limit: number): Promise<DiscoveredItem[]> {
  const clean = query.replace(/^(ريديت|reddit)\s*/i, "").trim()
  const subMatch = clean.match(/r\/([A-Za-z0-9_]+)/)
  const path = subMatch
    ? `https://www.reddit.com/r/${subMatch[1]}/new.json?limit=${Math.min(50, limit * 3)}`
    : `https://www.reddit.com/search.json?q=${encodeURIComponent(clean)}&limit=${Math.min(50, limit * 3)}`
  try {
    const data = (await fetchJson(path, { headers: { "User-Agent": "LeadOS-Agent/1.0 (lead discovery)" } })) as {
      data?: { children?: Array<{ data?: { id?: string; title?: string; selftext?: string; subreddit?: string; author?: string; created_utc?: number; permalink?: string; num_comments?: number } }> }
    }
    const posts = (data.data?.children ?? []).map((c) => c.data).filter((p): p is NonNullable<typeof p> => Boolean(p?.title))
    return posts.slice(0, limit).map((p) => ({
      externalId: `reddit:${p.id}`,
      title: p.title ?? "",
      body: (p.selftext ?? "").slice(0, 600) || "(منشور رابط/صورة)",
      url: `https://www.reddit.com${p.permalink ?? ""}`,
      authorName: p.author ?? undefined,
      contentType: "POST",
      language: /[\u0600-\u06FF]/.test(`${p.title} ${p.selftext ?? ""}`) ? "ar" : "en",
      publishedAt: p.created_utc ? new Date(p.created_utc * 1000) : undefined,
      rawData: { platform: "REDDIT", adapter: "reddit_json", subreddit: p.subreddit, comments: p.num_comments } as Prisma.InputJsonValue,
    }))
  } catch {
    return []
  }
}

// ---- Telegram public channels adapter (t.me/s/<channel> — بدون مفاتيح، بوستات حقيقية) ----
// قنوات أعمال/اقتصاد مصرية حية (تم التحقق منها بالفحص الحي — كلها بترجع بوستات)
const TELEGRAM_CHANNELS = [
  "egyptbusiness", // أعمال ومشاريع مصرية
  "AlBorsaNews", // جريدة البورصة
  "AlmalNews", // المال نيوز
  "AkhbarEconomy", // أخبار الاقتصاد
  "BusinessEgypt", // بيزنس إيجيبت
  "marketing_egypt", // تسويق مصر
  "sadany", // ريادة أعمال
  "telegram", // قناة رسمية (احتياط آمن دايمًا موجود)
]

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

// ═══ ماسح البصمات الإعلانية (طبقة سرقة الإعلانات الممولة — تعمل من كل المصادر) ═══
// أي بيزنس موقعه فيه بيكسل إعلاني حي = بيصرف فلوس على إعلانات الآن — دليل مباشر بدون مكتبات
// إعلانات محجوبة من السيرفر. دقة عالية: البيكسل مابيتحطش إلا لما حد يشغّل حملة فعلًا.
const AD_PIXEL_SIGNATURES: Array<{ channel: string; re: RegExp }> = [
  { channel: "meta", re: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\s*\(\s*['"]init/i },
  { channel: "google_ads", re: /googletagmanager\.com\/gtag\/js\?id=AW-|google_conversion_id|googlesyndication\.com|gtag\s*\(\s*['"]config['"]\s*,\s*['"]AW-|doubleclick\.net|google-ads.*conversion/i },
  { channel: "tiktok", re: /analytics\.tiktok\.com\/i18n\/pixel|ttq\.load\s*\(/i },
  { channel: "linkedin", re: /snap\.licdn\.com\/li\.lms-analytics|_linkedin_partner_id/i },
  { channel: "snapchat", re: /sc-static\.net\/scevent\.min\.js|snaptr\s*\(\s*['"]init/i },
  { channel: "x", re: /static\.ads-twitter\.com|twq\s*\(\s*['"]init/i },
]

/** فحص موقع بيزنس: بيرجع قنوات الإعلانات الحية اللي بيكسلاتها ظاهرة (فارغ = لا دليل/محجوب) */
export async function detectAdPixels(url: string): Promise<string[]> {
  const target = url.startsWith("http") ? url : `https://${url}`
  // المحاولة 1: جلب مباشر (أسرع وأرخص) — نجاح حتى بدون بيكسلات = كفاية
  const direct = await detectAdPixelsDirect(target)
  if (direct.ok) return direct.channels
  // المحاولة 2 (جديدة): قارئ Jina — بيرندر الصفحة بالجافاسكريبت على سيرفراتهم ويرجّع HTML مكتمل
  // المواقع اللي بتحجب سيرفرات الداتا سنتر بتنجح من عندهم، والبيكسلات عايشة في الرندر
  // (مثبت حيًا: dubizzle → 6 بصمات إعلانية في الرندر)
  const key = process.env.JINA_API_KEY
  if (!key) return []
  try {
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: { Authorization: `Bearer ${key}`, "X-Return-Format": "html" },
      signal: AbortSignal.timeout(18000),
    })
    if (!res.ok) return []
    const html = (await res.text()).slice(0, 900_000)
    return AD_PIXEL_SIGNATURES.filter((p) => p.re.test(html)).map((p) => p.channel)
  } catch {
    return []
  }
}

async function detectAdPixelsDirect(target: string): Promise<{ ok: boolean; channels: string[] }> {
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "ar,en;q=0.8" },
      signal: AbortSignal.timeout(7000),
      redirect: "follow",
    })
    if (!res.ok) return { ok: false, channels: [] }
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("html")) return { ok: false, channels: [] }
    const html = (await res.text()).slice(0, 400_000)
    return { ok: true, channels: AD_PIXEL_SIGNATURES.filter((p) => p.re.test(html)).map((p) => p.channel) }
  } catch {
    return { ok: false, channels: [] }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** استخراج الكلمات الدالة من الاستعلام للفلترة داخل البوستات/الأخبار */
function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/site:\S+|filetype:\S+|inurl:\S+/g, " ")
    .split(/[\s,"'()«»]+/)
    .filter((w) => w.length > 2 && !["وthe", "the", "for", "and", "في", "من", "على", "عن", "فين", "كام"].includes(w))
    .slice(0, 8)
}

async function telegramAdapter(query: string, limit: number): Promise<DiscoveredItem[]> {
  // لو الاستعلام بيحدد قناة بعينها (@channel أو t.me/channel) نبدأ بيها
  const explicit = query.match(/(?:t\.me\/s?\/|@)([A-Za-z0-9_]{3,32})/)
  const targets = explicit ? [explicit[1], ...TELEGRAM_CHANNELS.filter((c) => c !== explicit![1])] : TELEGRAM_CHANNELS
  const all: DiscoveredItem[] = []
  for (const ch of targets.slice(0, 6)) {
    try {
      const res = await fetch(`https://t.me/s/${ch}`, {
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "ar,en;q=0.8" },
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) continue
      const html = await res.text()
      // كل رسالة كتلة تبدأ بـ data-post="<channel>/<id>" — نصها ووقتها جوا الكتلة
      const chunks = html.split('data-post="').slice(1)
      for (const chunk of chunks) {
        const postId = chunk.slice(0, chunk.indexOf('"'))
        if (!postId) continue
        const textMatch = chunk.match(/tgme_widget_message_text[^>]*>([\s\S]{20,4000}?)<\/div>/)
        const text = textMatch ? stripHtml(textMatch[1]) : ""
        if (text.length < 25) continue // ستيكر/توجيه فاضي — مفيش نية
        const timeMatch = chunk.match(/<time[^>]+datetime="([^"]+)"/)
        const publishedAt = timeMatch && !Number.isNaN(new Date(timeMatch[1]).getTime()) ? new Date(timeMatch[1]) : undefined
        const url = `https://t.me/${postId}`
        all.push({
          externalId: `telegram:${postId}`,
          title: text.slice(0, 90),
          body: text.slice(0, 900),
          url,
          contentType: "POST",
          language: /[\u0600-\u06FF]/.test(text) ? "ar" : "en",
          publishedAt,
          rawData: {
            platform: "TELEGRAM", adapter: "telegram_public", channel: postId.split("/")[0],
            postId, telegramViews: chunk.match(/tgme_widget_message_views[^>]*>([^<]+)</)?.[1] ?? null,
          } as Prisma.InputJsonValue,
        })
      }
      if (all.length >= limit * 3) break
    } catch {
      /* قناة فاشلة مش بتوقف الباقي */
    }
  }
  // فلترة بالكلمات الدالة — لو فيه توافق ناخد المناسب، وإلا نرجع كل حاجة (التصنيف هيصفّي)
  const tokens = queryTokens(query)
  const relevant = tokens.length ? all.filter((i) => tokens.some((t) => `${i.title} ${i.body}`.toLowerCase().includes(t))) : []
  return (relevant.length >= 3 ? relevant : all).slice(0, limit)
}

// ---- RSS adapter (فيدات أخبار أعمال مصرية حقيقية — تم التحقق بالفحص الحي) ----
const RSS_FEEDS: Array<{ name: string; url: string }> = [
  { name: "جريدة البورصة", url: "https://alborsaanews.com/feed/" },
  { name: "Wamda — شركات ناشئة", url: "https://www.wamda.com/feed" },
  { name: "أموال الغد English", url: "https://en.amwalalghad.com/feed/" },
  { name: "Egyptian Streets", url: "https://egyptianstreets.com/feed/" },
]

function parseFeedXml(xml: string, feedName: string): DiscoveredItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)].map((m) => m[0])
  return blocks.map((block) => {
    const title = stripHtml(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "")
    const desc = stripHtml(block.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/)?.[1] ?? "")
    const link =
      block.match(/<link[^>]*href="([^"]+)"/)?.[1]?.trim() ??
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.trim() ??
      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() ??
      ""
    const dateStr = block.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)</)?.[1]?.trim()
    const publishedAt = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : undefined
    return {
      externalId: `rss:${hashId(link || title)}`,
      title,
      body: (desc || title).slice(0, 900),
      url: link,
      contentType: "ARTICLE",
      language: /[\u0600-\u06FF]/.test(`${title} ${desc}`) ? "ar" : "en",
      publishedAt,
      rawData: { platform: "RSS", adapter: "rss_feed", feed: feedName } as Prisma.InputJsonValue,
    }
  }).filter((i) => i.title.length > 5 && i.url.startsWith("http"))
}

async function rssAdapter(query: string, limit: number): Promise<DiscoveredItem[]> {
  const all: DiscoveredItem[] = []
  await Promise.all(
    RSS_FEEDS.map(async (f) => {
      try {
        const res = await fetch(f.url, {
          headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
          signal: AbortSignal.timeout(12000),
        })
        if (!res.ok) return
        all.push(...parseFeedXml(await res.text(), f.name))
      } catch {
        /* فيد فاشل مش بيوقف الباقي */
      }
    }),
  )
  const tokens = queryTokens(query)
  const relevant = tokens.length ? all.filter((i) => tokens.some((t) => `${i.title} ${i.body}`.toLowerCase().includes(t))) : []
  return (relevant.length >= 3 ? relevant : all).slice(0, limit)
}

// ---- Plain web adapter (GOOGLE_SEARCH / WEBSITE / NEWS / fallback) ----
async function webAdapter(query: string, limit: number, recencyDays: number, news = false): Promise<DiscoveredItem[]> {
  const pinned = geoPin(query)
  const q = news ? `أخبار ${pinned} افتتاح توسع استثمار` : pinned
  const { results, provider } = await rawWebSearch(q, limit, news ? Math.min(7, recencyDays) : recencyDays)
  return results.map((r) => {
    const item = toItem(r, { contentType: news ? "ARTICLE" : "SEARCH_RESULT", platform: news ? "NEWS" : "WEB", query, recencyDays, provider })
    return item
  })
}

// ---- Google Places adapter (activates only with GOOGLE_MAPS_API_KEY — real data or nothing) ----
async function googlePlacesAdapter(query: string, limit: number): Promise<DiscoveredItem[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return []
  try {
    const textRes = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`,
      { signal: AbortSignal.timeout(15000) },
    )
    const textData = (await textRes.json()) as {
      results?: Array<{
        place_id: string; name: string; formatted_address?: string; rating?: number
        user_ratings_total?: number; website?: string; formatted_phone_number?: string
        types?: string[]; geometry?: { location?: { lat: number; lng: number } }
      }>
      status?: string
    }
    if (textData.status !== "OK" || !textData.results) return []
    return textData.results.slice(0, limit).map((r) => ({
      externalId: `gmaps:${r.place_id}`,
      title: r.name,
      body: `${r.name} — ${r.formatted_address ?? ""} — تقييم ${r.rating ?? "N/A"} من ${r.user_ratings_total ?? 0} مراجعة. ${r.website ? "لديه موقع إلكتروني." : "لا يوجد موقع إلكتروني ظاهر."}`,
      url: `https://www.google.com/maps/place/?q=place_id:${r.place_id}`,
      contentType: "BUSINESS",
      language: "ar",
      rawData: {
        placeId: r.place_id, address: r.formatted_address, rating: r.rating,
        reviewCount: r.user_ratings_total, website: r.website, phone: r.formatted_phone_number,
        types: r.types, location: r.geometry?.location, platform: "GOOGLE_MAPS", adapter: "google_places",
      } as Prisma.InputJsonValue,
    }))
  } catch {
    return []
  }
}

// ---- Serper Places → DiscoveredItem (بيزنسات محلية ببيانات كاملة: تليفون/موقع/تقييم) ----
// تبسيط استعلام النيّة لاستعلام مناسِب لخرائط جوجل:
// الخرائط بتفهم «نوع البيزنس + المكان» بس — جُمَل النيّة (محتاجة/عايز...) بترجّع صفر
export function simplifyPlacesQuery(q: string): string {
  const markers = ["محتاجة", "محتاج", "عايز", "عايزين", "مطلوب", "بيدور", "محتاجين", "looking for", "needs", "need", "wants", "want"]
  let cut = -1
  const lower = q.toLowerCase()
  for (const m of markers) {
    const i = lower.indexOf(m.toLowerCase())
    if (i > 3 && (cut === -1 || i < cut)) cut = i
  }
  const simplified = (cut > 3 ? q.slice(0, cut) : q).replace(/\s+/g, " ").trim()
  return simplified || q
}

export async function placesToItems(query: string, limit = 8): Promise<DiscoveredItem[]> {
  const places = await placesSerper(simplifyPlacesQuery(query), limit)
  return places.map((p) => ({
    externalId: p.placeId ? `gmaps:${p.placeId}` : p.cid ? `gmaps_cid:${p.cid}` : `maps:${hashId(`${p.title}|${p.address ?? ""}`)}`,
    title: p.title,
    body: `${p.title} — ${p.address ?? ""} — تقييم ${p.rating ?? "N/A"} من ${p.ratingCount ?? 0} مراجعة${p.phone ? ` — تليفون ${p.phone}` : ""}${p.website ? " — لديه موقع إلكتروني." : " — لا يوجد موقع إلكتروني (فرصة)."} ${p.category ? `التصنيف: ${p.category}.` : ""}`,
    url: p.placeId
      ? `https://www.google.com/maps/place/?q=place_id:${p.placeId}`
      : p.website ?? `https://www.google.com/maps/search/${encodeURIComponent(p.title)}`,
    contentType: "BUSINESS",
    language: /[\u0600-\u06FF]/.test(p.title) ? "ar" : "en",
    rawData: {
      placeId: p.placeId, cid: p.cid, address: p.address, rating: p.rating,
      reviewCount: p.ratingCount, website: p.website, phone: p.phone,
      category: p.category, latitude: p.latitude, longitude: p.longitude,
      priceLevel: p.priceLevel, platform: "GOOGLE_MAPS", adapter: "serper_places",
    } as never,
  }))
}

// ---- Orchestrator: run discovery for one batch of queries across requested platforms ----
export async function runDiscovery(
  sourceTypes: string[],
  queries: string[],
  limitPerQuery = 5,
  opts?: { maxSearches?: number; passes?: number; queriesByType?: Record<string, string[]>; deadline?: number },
): Promise<{ items: DiscoveredItem[]; adaptersUsed: string[] }> {
  const adaptersUsed: string[] = []
  const types = [...new Set(sourceTypes.length ? sourceTypes : ["GOOGLE_SEARCH"])]
  const RECENT = 14
  // فلتر النشر لكل منصة: المنصات اللي محتواها بعمر طويل (أسئلة كورا عمرها سنين،
  // سيرفرات ديسكورد، معارض معلنة بدري، أدلة أعمال) مبتتقصش بـ14 يوم — نافذة أوسع
  const RECENT_BY: Record<string, number> = {
    QUORA: 90, DISCORD: 90, EVENTS: 75, DIRECTORY: 60, REVIEWS: 60, ADS_LIBRARY: 30, MARKETPLACE: 30,
  }
  const recentFor = (st: string) => RECENT_BY[st] ?? RECENT

  const maxSearches = opts?.maxSearches ?? 10 // hard cap per job — المسح الشامل بيرفعه لـ18
  let searches = 0

  // ═══ عدالة التوزيع (إصلاح: المصادر المجانية كانت بتاكل الكوتة كلها) ═══
  // 1) كوتة لكل نوع: ريديت/تليجرام مش بيبلعوا 45 عنصر قبل ما المنصات المدفوعة توصل
  // 2) دمج متناوب في الآخر: كل منصة ليها حضور في النتيجة النهائية مهما كان ترتيبها
  const perTypeCap = limitPerQuery * 2
  const totalCap = limitPerQuery * 10
  const byType = new Map<string, DiscoveredItem[]>()
  const collected = () => { let n = 0; for (const b of byType.values()) n += b.length; return n }

  // جولات round-robin — كل نوع بياخد استعلام في الجولة قبل ما حد ياخد استعلام تاني:
  // البحث العام المنتِج مش بياكل الكوتة كلها قبل ما المنصات الدوارة (الموجة) والمجانية تاخد نصيبها
  // (الدليل من الإنتاج: نبضات كاملة طلعت adapters=web_search بس — الويب كان بيملى كوتة العناصر ويقفل)
  const FREE = FREE_SOURCE_TYPES as readonly string[]
  const passes = Math.min(opts?.passes ?? 4, Math.max(1, queries.length))
  for (let pass = 0; pass < passes; pass++) {
    if (opts?.deadline && pass > 0 && Date.now() > opts.deadline) break // ميزانية وقت — البحث العميق بياخد وقت
    for (const st of types) {
      if (searches >= maxSearches || collected() >= totalCap) break
      if (opts?.deadline && Date.now() > opts.deadline) break // سيب الباقي للجوب الجاي
      if (pass > 0 && FREE.includes(st)) continue // المجاني جولة واحدة تكفيه — الدوران تاني بيضيع وقته
      const q = queries[pass]
      if (!q) continue
      let batch: DiscoveredItem[] = []
      let chosen = q // الاستعلام اللي هيتساب بصمته على العناصر (للتعلم)
      try {
        if (st === "GOOGLE_MAPS") {
          // المسار الأساسي: Serper Places (مفتاح واحد يخدم الاثنين) — fallback: Google Places API الرسمي
          batch = await placesToItems(q, limitPerQuery).catch(() => [])
          if (!batch.length) batch = await googlePlacesAdapter(q, limitPerQuery)
          if (batch.length) adaptersUsed.push("google_places")
        } else if (st === "REDDIT") {
          // الأقوى أولًا: JSON API (منشورات بنصها الكامل بدون مفاتيح) — fallback: site: search
          batch = await redditJsonAdapter(q, limitPerQuery)
          if (batch.length) adaptersUsed.push("reddit_json")
          else {
            batch = await platformAdapter(st, q, limitPerQuery, RECENT)
            if (batch.length) adaptersUsed.push("site:reddit")
          }
        } else if (st === "TELEGRAM") {
          // الأقوى أولًا: قنوات عامة حية عبر t.me/s (بدون مفاتيح) — fallback: site: search
          batch = await telegramAdapter(q, limitPerQuery)
          if (batch.length) adaptersUsed.push("telegram_public")
          else {
            batch = await platformAdapter(st, q, limitPerQuery, RECENT)
            if (batch.length) adaptersUsed.push("site:telegram")
          }
        } else if (st === "RSS") {
          // الأقوى أولًا: فيدات أعمال مصرية حقيقية — fallback: بحث ويب
          batch = await rssAdapter(q, limitPerQuery)
          if (batch.length) adaptersUsed.push("rss_feeds")
          else {
            batch = await webAdapter(q, limitPerQuery, RECENT)
            if (batch.length) adaptersUsed.push("web_rss_fallback")
          }
        } else if (PLATFORM_SITES[st]) {
          // المنصة بتاخد استعلامات بلغتها هي — مش استعلام القاعدة العام
          // (السبب: «كافيهات مدينة نصر» على wuzzuf/OLX/Quora = صفر نتايج = 9 منصات ميتة)
          // الأولوية للدروس المتعلمة (queriesByType) — بعدين الأشكال الثابتة
          // التناوب: (جولة + ترتيب المنصة) % عدد الاستعلامات
          const qs = [...new Set([...(opts?.queriesByType?.[st] ?? []), ...platformQueries(st, q)])]
          const qq = qs[(pass + types.indexOf(st)) % qs.length]
          chosen = qq
          batch = await platformAdapter(st, qq, limitPerQuery, recentFor(st))
          if (batch.length) adaptersUsed.push(`site:${st.toLowerCase()}`)
        } else if (st === "NEWS") {
          batch = await webAdapter(q, limitPerQuery, RECENT, true)
          if (batch.length) adaptersUsed.push("web_news")
        } else {
          // GOOGLE_SEARCH / WEBSITE / RSS / OTHER → plain live web
          batch = await webAdapter(q, limitPerQuery, RECENT)
          if (batch.length) adaptersUsed.push("web_search")
        }
      } catch (err) {
        // استعلام واحد فاشل ميقتلش الجب كله — كمل على الباقي
        console.warn(`[discovery] adapter ${st} failed on "${q.slice(0, 60)}": ${err instanceof Error ? err.message.slice(0, 120) : err}`)
        batch = []
      }
      // تتبع التعلم: كل عنصر بيشيل بصمة المهارة + الاستعلام اللي جابه
      // (عشان SkillStat/SkillLesson يتغذوا بأي استعلام ومنصة بجيب ليدز فعلًا)
      if (batch.length) batch = batch.map((it) => ({ ...it, viaType: st, viaQuery: chosen }))
      // مصادر الـJSON/HTML المجانية (REDDIT/TELEGRAM/RSS) أساسها مجاني ومش بيحرق كوتة البحث — مش بتتحسب من السقف
      if (!FREE.includes(st)) {
        searches++
        if (searches < maxSearches) await sleep(1200) // be gentle with the upstream search API
      }
      if (batch.length) {
        const bucket = byType.get(st) ?? []
        bucket.push(...batch)
        byType.set(st, bucket.slice(0, perTypeCap))
      }
    }
    if (searches >= maxSearches || collected() >= totalCap) break
  }

  // دمج متناوب بين الأنواع (round-robin على الدلاء) + إزالة المكرر — تغطية كل المنصات أول بأول
  const seen = new Set<string>()
  const interleaved: DiscoveredItem[] = []
  const maxLen = Math.max(0, ...[...byType.values()].map((b) => b.length))
  for (let i = 0; i < maxLen && interleaved.length < limitPerQuery * 4; i++) {
    for (const bucket of byType.values()) {
      if (interleaved.length >= limitPerQuery * 4) break
      const it = bucket[i]
      if (it && !seen.has(it.externalId)) { seen.add(it.externalId); interleaved.push(it) }
    }
  }
  return { items: interleaved, adaptersUsed: [...new Set(adaptersUsed)] }
}
