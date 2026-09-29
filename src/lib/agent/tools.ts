// LeadOS — Agent Toolkit (الترسانة الداخلية)
// كل أداة: { name, description, gate?, run }
// Gates: أدوات تحتاج بنية خارجية (Worker/SearXNG/Ollama/Evolution) تتعطل بأمان بـ"not configured"
// وتتفعل تلقائيًا أول ما متغير البيئة يبقى موجود — بدون تعديل كود.
import { db } from "@/lib/db"
import { agentWebSearch, placesToItems, runDiscovery, type DiscoveredItem } from "@/lib/discovery"
import { ingestDiscoveredItems, enqueueJob } from "@/lib/queue"
import { NICHE_PACKS } from "@/lib/constants"
import { heuristicClassify } from "@/lib/classification"
import {
  ensureStealth,
  stealthAct,
  stealthExtract,
  stealthHealth,
  stealthInjectCookieHeader,
  stealthNavigate,
} from "@/lib/agent/stealth-browser"

export interface ToolResult {
  ok: boolean
  note: string
  data?: unknown
}

export interface AgentTool {
  name: string
  description: string
  gate: "ready" | "env"
  envKeys?: string[]
  run: (args: Record<string, unknown>) => Promise<ToolResult>
}

// ═══════════ أدوات مساعدة داخلية ═══════════

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
// تليفون مصري صارم: موبايل 01[0125]xxxxxxxx أو دولي +20، أو أرضي 02/03 — وليس أرقام عشوائية أو خطوط ساخنة قصيرة
const EG_PHONE_RE = /(?:(?:\+?20\s?|0)1[0125]\s?\d{4}\s?\d{4})|(?:(?:\+?20\s?)?0?2\s?2[2-4]\s?\d{7})/g
const SOCIAL_RE = /(https?:\/\/(?:www\.)?(facebook|instagram|linkedin|tiktok|x|twitter|youtube)\.com\/[^\s"'>)]+)/gi

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

async function fetchPage(url: string, timeoutMs = 12000): Promise<{ ok: boolean; status: number; html: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept-Language": "ar,en;q=0.8",
      },
      redirect: "follow",
    })
    const html = await res.text()
    return { ok: res.ok, status: res.status, html }
  } catch {
    return { ok: false, status: 0, html: "" }
  }
}

export function extractContacts(text: string): { emails: string[]; phones: string[]; socials: string[] } {
  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].slice(0, 5)
  const phones = [...new Set((text.match(EG_PHONE_RE) ?? []).map((p) => p.replace(/[\s-]/g, "")))]
    .filter((p) => p.replace(/\D/g, "").length >= 10 && p.replace(/\D/g, "").length <= 13)
    .slice(0, 5)
  const socials = [...new Set((text.match(SOCIAL_RE) ?? []).map((s) => s.replace(/[)\]},]$/, "")))].slice(0, 6)
  return { emails, phones, socials }
}

// ═══════════ الترسانة ═══════════

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "web_search",
    description: "بحث ويب حي عبر سلسلة مزودين (Serper→Tavily→SerpAPI→Exa→SearXNG→z-ai) مع تثبيت جغرافي مصري",
    gate: "ready",
    run: async (args) => {
      const query = String(args.query ?? "")
      if (!query) return { ok: false, note: "استعلام مفقود" }
      const limit = Number(args.limit ?? 8)
      const recencyDays = Number(args.recency_days ?? 30)
      const { results, provider } = await agentWebSearch(query, limit, recencyDays)
      return {
        ok: results.length > 0,
        note: `«${query.slice(0, 40)}» → ${results.length} نتيجة عبر ${provider}`,
        data: results.slice(0, 10).map((r) => ({ title: r.name, url: r.url, snippet: r.snippet.slice(0, 140), provider })),
      }
    },
  },
  {
    name: "maps_places",
    description: "منجم الليدز المحلي: بيزنسات من خرائط جوجل (اسم/تليفون/موقع/تقييم/عنوان) — بيشتغل بمفتاح Serper",
    gate: "ready",
    run: async (args) => {
      const query = String(args.query ?? "").replace(/[\n\r"؟]/g, " ").trim().slice(0, 120)
      if (!query) return { ok: false, note: "استعلام مفقود" }
      const limit = Number(args.limit ?? 10)
      try {
        const places = await placesToItems(query, limit)
        return {
          ok: places.length > 0,
          note: places.length
            ? `«${query.slice(0, 40)}» → ${places.length} بيزنس من الخرائط`
            : `«${query.slice(0, 40)}» → صفر نتائج من الخرائط`,
          data: places.map((p) => ({
            title: p.title,
            phone: (p.rawData as { phone?: string }).phone,
            website: (p.rawData as { website?: string }).website,
            rating: (p.rawData as { rating?: number }).rating,
            reviews: (p.rawData as { reviewCount?: number }).reviewCount,
            address: (p.rawData as { address?: string }).address,
          })),
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, note: /credits|400/i.test(msg) ? "رصيد Serper خلص — خرائط جوجل معطلة مؤقتًا، اعتمد على web_search و lead_hunt" : `الخرائط فشلت: ${msg.slice(0, 100)}` }
      }
    },
  },
  {
    name: "crawl_page",
    description: "عين الأيجنت: يزور صفحة ويب ويستخرج النص + الإيميلات والتليفونات وروابط السوشيال (Markdown-ready)",
    gate: "ready",
    run: async (args) => {
      const url = String(args.url ?? "")
      if (!/^https?:\/\//.test(url)) return { ok: false, note: "URL غير صالح" }
      const { ok, status, html } = await fetchPage(url)
      if (!ok || !html) return { ok: false, note: `فشل الوصول (${status || "network"})` }
      const text = htmlToText(html).slice(0, 4000)
      const contacts = extractContacts(html)
      return {
        ok: true,
        note: `تمت قراءة الصفحة (${html.length} حرف) — إيميلات ${contacts.emails.length}، تليفونات ${contacts.phones.length}`,
        data: { url, textPreview: text.slice(0, 400), ...contacts },
      }
    },
  },
  {
    name: "deep_crawl",
    description: "حصادة المواقع: يزور موقع كامل (حتى 8 صفحات داخلية) ويجمع بيانات التواصل من كل صفحة",
    gate: "ready",
    run: async (args) => {
      const startUrl = String(args.url ?? "")
      if (!/^https?:\/\//.test(startUrl)) return { ok: false, note: "URL غير صالح" }
      const maxPages = Math.min(8, Number(args.max_pages ?? 5))
      const origin = new URL(startUrl).origin
      const first = await fetchPage(startUrl)
      if (!first.ok) return { ok: false, note: "فشل الوصول للموقع" }
      // خريطة الروابط الداخلية (mini /map)
      const links = [...new Set(
        [...first.html.matchAll(/href="((?:https?:\/\/)?[^"'\s>]+)"/g)]
          .map((m) => m[1])
          .map((l) => { try { return new URL(l, origin).toString() } catch { return null } })
          .filter((l): l is string => Boolean(l) && l!.startsWith(origin) && !/\.(pdf|jpg|png|zip|mp4)$/i.test(l!)),
      )].slice(0, maxPages - 1)
      const pages: Array<{ url: string; contacts: ReturnType<typeof extractContacts> }> = []
      const allEmails = new Set<string>()
      const allPhones = new Set<string>()
      for (const url of [startUrl, ...links]) {
        const page = url === startUrl ? first : await fetchPage(url)
        if (!page.ok) continue
        const contacts = extractContacts(page.html)
        contacts.emails.forEach((e) => allEmails.add(e))
        contacts.phones.forEach((p) => allPhones.add(p))
        pages.push({ url, contacts })
        if (url !== startUrl) await new Promise((r) => setTimeout(r, 400)) // لطفًا
      }
      return {
        ok: true,
        note: `تم حصاد ${pages.length} صفحة من ${origin} — إيميلات: ${[...allEmails].slice(0, 3).join(", ") || "لا شيء"}`,
        data: { origin, pagesCrawled: pages.length, emails: [...allEmails], phones: [...allPhones] },
      }
    },
  },
  {
    name: "lead_qualify",
    description: "فلتر الجودة: يصنف نص/منشور/صفحة (نية شراء، صناعة، خدمات، سكور 0-100) بمنطق LeadOS",
    gate: "ready",
    run: async (args) => {
      const title = String(args.title ?? "")
      const body = String(args.body ?? "")
      if (!title && !body) return { ok: false, note: "نص مفقود" }
      const classification = heuristicClassify(title, body)
      return {
        ok: true,
        note: classification.is_lead
          ? `ليد صالح — نية ${classification.intent} — سكور ${classification.score} — ${classification.reason}`
          : `غير ليد — ${classification.reason}`,
        data: classification,
      }
    },
  },
  {
    name: "lead_hunt",
    description: "المحرك الكامل: استعلامات → بحث في منصات → تصنيف → تسجيل ليدز في CRM. المنصات: GOOGLE_MAPS | GOOGLE_SEARCH | FACEBOOK | INSTAGRAM | X | LINKEDIN | REDDIT | TIKTOK | YOUTUBE | DIRECTORY | JOBS | NEWS (مثال: platforms:[\"GOOGLE_SEARCH\",\"FACEBOOK\"])",
    gate: "ready",
    run: async (args) => {
      const wsId = String(args.workspace_id ?? "")
      const queries = (Array.isArray(args.queries) ? args.queries : [args.queries]).map(String).filter(Boolean)
      // تطبيع المنصات: صيغ عربي/إنجليزي شائعة → الأنواع الصحيحة (وإلا المصدر مش هيتلاقي)
      const PLATFORM_ALIASES: Record<string, string> = {
        "ويب": "GOOGLE_SEARCH", "بحث": "GOOGLE_SEARCH", "WEB": "GOOGLE_SEARCH", "GOOGLE": "GOOGLE_SEARCH", "GOOGLE_SEARCH": "GOOGLE_SEARCH",
        "خرائط": "GOOGLE_MAPS", "الخرائط": "GOOGLE_MAPS", "MAPS": "GOOGLE_MAPS", "GOOGLE_MAPS": "GOOGLE_MAPS",
        "فيسبوك": "FACEBOOK", "FACEBOOK": "FACEBOOK", "انستجرام": "INSTAGRAM", "انستا": "INSTAGRAM", "INSTAGRAM": "INSTAGRAM",
        "لينكدإن": "LINKEDIN", "لينكدن": "LINKEDIN", "LINKEDIN": "LINKEDIN", "تويتر": "X", "X": "X", "ريديت": "REDDIT", "REDDIT": "REDDIT",
        "تيك توك": "TIKTOK", "تيكتوك": "TIKTOK", "TIKTOK": "TIKTOK", "يوتيوب": "YOUTUBE", "YOUTUBE": "YOUTUBE",
        "أدلة": "DIRECTORY", "ادلة": "DIRECTORY", "DIRECTORY": "DIRECTORY", "وظايف": "JOBS", "JOBS": "JOBS", "أخبار": "NEWS", "اخبار": "NEWS", "NEWS": "NEWS",
        "أوليكس": "MARKETPLACE", "اوليكس": "MARKETPLACE", "olx": "MARKETPLACE", "OLX": "MARKETPLACE", "هاتلا": "MARKETPLACE", "هاتلا2ee": "MARKETPLACE", "سوق": "MARKETPLACE", "MARKETPLACE": "MARKETPLACE",
        "مستقل": "FREELANCE", "خمسات": "FREELANCE", "بحر": "FREELANCE", "فريلانس": "FREELANCE", "عمل حر": "FREELANCE", "FREELANCE": "FREELANCE",
      }
      const rawPlatforms = (Array.isArray(args.platforms) ? args.platforms : ["GOOGLE_SEARCH"]).map(String).filter(Boolean)
      const platforms = Array.from(new Set(rawPlatforms.map((p) => PLATFORM_ALIASES[p.trim()] ?? PLATFORM_ALIASES[p.trim().toUpperCase()] ?? p.toUpperCase()))).filter(Boolean)
      if (!wsId || !queries.length) return { ok: false, note: "workspace_id أو queries مفقود" }
      let created = 0, duplicates = 0, scanned = 0
      const perPlatform: Array<{ platform: string; items: number; created: number; topItems: Array<{ title: string; url: string }> }> = []
      const sourceTypeOf: Record<string, string> = { JOBS: "WEBSITE", WEB: "GOOGLE_SEARCH", NEWS: "NEWS", GOOGLE_SEARCH: "GOOGLE_SEARCH", FACEBOOK: "FACEBOOK", INSTAGRAM: "INSTAGRAM", X: "X", LINKEDIN: "LINKEDIN", REDDIT: "REDDIT", TIKTOK: "TIKTOK", YOUTUBE: "YOUTUBE", DIRECTORY: "DIRECTORY", GOOGLE_MAPS: "GOOGLE_MAPS", MARKETPLACE: "MARKETPLACE", FREELANCE: "FREELANCE" }
      for (const platform of platforms) {
        // المصدر النوعي الأول — ولو مش موجود في الورشة نرجع لمصدر البحث العام (المهم زيزو يجيب، مش يتعطل)
        let source = await db.source.findFirst({ where: { workspaceId: wsId, type: sourceTypeOf[platform] ?? platform } })
        if (!source && platform !== "GOOGLE_MAPS") source = await db.source.findFirst({ where: { workspaceId: wsId, type: "GOOGLE_SEARCH" } })
        if (!source) { perPlatform.push({ platform, items: 0, created: 0, topItems: [] }); continue }
        let items: DiscoveredItem[] = []
        try {
          const res = await runDiscovery([platform], queries, 5)
          items = res.items
        } catch { /* provider fail → next */ }
        const r = await ingestDiscoveredItems(wsId, source, null, items)
        scanned += items.length
        created += r.created
        duplicates += r.duplicates
        perPlatform.push({
          platform,
          items: items.length,
          created: r.created,
          topItems: items.slice(0, 6).map((i) => ({ title: (i.title ?? "").slice(0, 80), url: i.url })),
        })
      }
      return {
        ok: true,
        note: `مَسح ${scanned} عنصر → ${created} ليد جديد (${duplicates} مكرر)`,
        data: { scanned, created, duplicates, perPlatform },
      }
    },
  },
  {
    name: "export_leads_csv",
    description: "تصدير ليدز CRM لملف Excel/CSV (اسم/تليفون/موقع/سيتي/سكور/مصدر) محفوظ في مجلد التحميلات",
    gate: "ready",
    run: async (args) => {
      const wsId = String(args.workspace_id ?? "")
      const minScore = Number(args.min_score ?? 0)
      const leads = await db.lead.findMany({
        where: { workspaceId: wsId, score: { gte: minScore } },
        include: { business: { select: { name: true, phone: true, websiteUrl: true, city: true, industry: true, rating: true } } },
        orderBy: { score: "desc" },
        take: 500,
      })
      const rows = [["name", "phone", "website", "city", "industry", "rating", "score", "source_type", "summary"]]
      for (const l of leads) {
        rows.push([
          l.business?.name ?? "", l.business?.phone ?? "", l.business?.websiteUrl ?? "",
          l.business?.city ?? "", l.business?.industry ?? "", String(l.business?.rating ?? ""),
          String(l.score), l.leadSourceType, (l.summary ?? "").replace(/[",\n]/g, " ").slice(0, 120),
        ])
      }
      const csv = "\uFEFF" + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")
      const { mkdir, writeFile } = await import("fs/promises")
      const path = await import("path")
      const dir = process.env.EXPORT_DIR ?? path.join(process.cwd(), "download")
      await mkdir(dir, { recursive: true }).catch(() => undefined)
      const filename = `leados-export-${new Date().toISOString().slice(0, 10)}-${Date.now() % 100000}.csv`
      await writeFile(path.join(dir, filename), csv, "utf8")
      return {
        ok: true,
        note: `تم حفظ ${leads.length} ليد في ${filename} (سكور ≥ ${minScore})`,
        data: { filename, path: `${dir}/${filename}`, count: leads.length },
      }
    },
  },
  {
    name: "stealth_browse",
    description:
      "أيد الستيلث (Camoufox): متصفح Firefox حقيقي مضاد للبصمة يفتح أي موقع — فيسبوك/انستجرام/مواقع محمية — تصفح + استخراج عناصر + تفاعل (كليك/كتابة) + سكرين شوت + حقن كوكيز جلسة",
    gate: "env",
    envKeys: ["CAMOUFOX_URL"],
    run: async (args) => {
      const url = String(args.url ?? "")
      const action = String(args.action ?? "goto").toLowerCase()
      // الحالة فقط
      if (action === "status") {
        const h = await stealthHealth()
        return {
          ok: h.online,
          note: h.online ? `الستيلث شغال (${h.browser})` : "خدمة Camoufox غير متاحة",
          data: h,
        }
      }
      // تشغيل الخدمة تلقائيًا لو معطلة
      const ready = await ensureStealth(90_000)
      if (!ready) {
        return { ok: false, note: "خدمة Camoufox مش متاحة — محتاجة سيرفر يشتغل عليه المتصفح (محليًا بتتشغل تلقائيًا، وعلى Vercel اضبط CAMOUFOX_URL)" }
      }
      // حقن كوكيز جلسة فيسبوك لو موجودة (مرة واحدة لكل تشغيل)
      if (String(args.inject_fb_session ?? "") === "1" && process.env.FACEBOOK_SESSION_COOKIE) {
        const injected = await stealthInjectCookieHeader(process.env.FACEBOOK_SESSION_COOKIE)
        if (injected) return { ok: true, note: "تم حقن كوكيز فيسبوك في بروفايل المتصفح" }
      }
      if (action === "goto") {
        if (!/^https?:\/\//.test(url)) return { ok: false, note: "URL غير صالح" }
        const nav = await stealthNavigate({
          url,
          screenshot: Boolean(args.screenshot),
          scroll_times: Number(args.scroll_times ?? 0),
          timeout: Number(args.timeout ?? 45_000),
        })
        if (!nav.ok) return { ok: false, note: `فشل التصفح: ${nav.error}` }
        // استخراج اختياري لعناصر في نفس النداء
        const selector = String(args.selector ?? "")
        const items = selector ? (await stealthExtract({ selector, limit: Number(args.limit ?? 30) })).items : undefined
        // سكرين شوت محفوظ كملف
        let savedShot: string | undefined
        if (nav.screenshot) {
          try {
            const { mkdir, writeFile } = await import("fs/promises")
            const path = await import("path")
            const dir = path.join(process.cwd(), "download", "stealth")
            await mkdir(dir, { recursive: true })
            const filename = `shot-${Date.now()}.png`
            await writeFile(`${dir}/${filename}`, Buffer.from(nav.screenshot, "base64"))
            savedShot = `${dir}/${filename}`
          } catch {
            /* Vercel read-only — تجاهل */
          }
        }
        return {
          ok: true,
          note: `تم فتح «${(nav.title ?? "").slice(0, 60) || url}» — ${nav.text?.length ?? 0} حرف${savedShot ? " + سكرين شوت" : ""}`,
          data: { url: nav.url, http_status: nav.http_status, title: nav.title, text: nav.text?.slice(0, 3000), extracted: items?.slice(0, 10), screenshot: savedShot },
        }
      }
      if (action === "extract") {
        const selector = String(args.selector ?? "")
        if (!selector) return { ok: false, note: "extract يحتاج selector" }
        const r = await stealthExtract({ selector, attr: String(args.attr ?? "innerText"), limit: Number(args.limit ?? 30) })
        return { ok: r.ok, note: r.ok ? `${r.count} عنصر من ${selector.slice(0, 40)}` : `فشل: ${r.error}`, data: r.items?.slice(0, 20) }
      }
      if (action === "click" || action === "type" || action === "press" || action === "scroll" || action === "eval" || action === "wait") {
        const r = await stealthAct({
          action,
          selector: String(args.selector ?? "") || undefined,
          text: String(args.text ?? "") || undefined,
          key: String(args.key ?? "") || undefined,
          script: String(args.script ?? "") || undefined,
          amount: args.amount ? Number(args.amount) : undefined,
        })
        return { ok: r.ok, note: r.ok ? r.note ?? "تم التنفيذ" : `فشل: ${r.error}`, data: r.result }
      }
      if (action === "cookies") {
        const header = String(args.cookie_header ?? "") || process.env.FACEBOOK_SESSION_COOKIE || ""
        if (!header) return { ok: false, note: "لا يوجد cookie_header ولا FACEBOOK_SESSION_COOKIE" }
        const okDone = await stealthInjectCookieHeader(header, String(args.domain ?? ".facebook.com"))
        return { ok: okDone, note: okDone ? "تم حقن الكوكيز في المتصفح" : "فشل الحقن" }
      }
      return { ok: false, note: `عملية غير معروفة: ${action} (المتاح: goto/extract/click/type/press/scroll/wait/eval/cookies/status)` }
    },
  },
  {
    name: "browser_task",
    description: "إيد الأيجنت: مهام متصفح حقيقية (فيسبوك جروبات/سكرول/كوكيز) عبر Worker Botasaurus الخارجي",
    gate: "env",
    envKeys: ["WORKER_URL"],
    run: async (args) => {
      const base = process.env.WORKER_URL
      if (!base) return { ok: false, note: "Worker غير مربوط — اضبط WORKER_URL (شوف worker/README-ar.md)" }
      const res = await fetch(`${base.replace(/\/$/, "")}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.WORKER_TOKEN ? { "x-api-key": process.env.WORKER_TOKEN } : {}) },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as { queued?: boolean }
      return { ok: res.ok, note: res.ok ? "تم إرسال المهمة للـWorker" : `فشل (${res.status})`, data }
    },
  },
  {
    name: "linkedin_hunt",
    description: "صياد اللينكدإن: بحث أعضاء/شركات/وظايف وصيد profiles عبر Worker (كوكيز لينكدإن)",
    gate: "env",
    envKeys: ["WORKER_URL"],
    run: async (args) => {
      const base = process.env.WORKER_URL
      if (!base) return { ok: false, note: "Worker غير مربوط — اضبط WORKER_URL" }
      const res = await fetch(`${base.replace(/\/$/, "")}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.WORKER_TOKEN ? { "x-api-key": process.env.WORKER_TOKEN } : {}) },
        body: JSON.stringify({ task: "linkedin", ...(args as object) }),
        signal: AbortSignal.timeout(15000),
      })
      return { ok: res.ok, note: res.ok ? "مهمة لينكدإن في الطريق" : `فشل (${res.status})` }
    },
  },
  {
    name: "whatsapp_send",
    description: "بوق التواصل: إرسال واتساب مخصص لليد عبر Evolution API (self-hosted)",
    gate: "env",
    envKeys: ["EVOLUTION_API_URL", "EVOLUTION_API_KEY"],
    run: async (args) => {
      const base = process.env.EVOLUTION_API_URL
      const key = process.env.EVOLUTION_API_KEY
      if (!base || !key) return { ok: false, note: "Evolution API غير مربوطة — اضبط EVOLUTION_API_URL وEVOLUTION_API_KEY" }
      const instance = process.env.EVOLUTION_INSTANCE ?? "leados"
      const to = String(args.phone ?? "").replace(/[^\d]/g, "")
      const message = String(args.message ?? "")
      if (!to || !message) return { ok: false, note: "تليفون أو رسالة مفقودة" }
      const res = await fetch(`${base.replace(/\/$/, "")}/message/sendText/${instance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key },
        body: JSON.stringify({ number: `${to}@s.whatsapp.net`, text: message }),
        signal: AbortSignal.timeout(15000),
      })
      return { ok: res.ok, note: res.ok ? "تم إرسال الواتساب ✅" : `فشل الإرسال (${res.status})` }
    },
  },
  {
    name: "local_llm_status",
    description: "المخ المحلي: فحص Ollama (LLM محلي صفر تكلفة) وتوافره للتفكير والتحليل",
    gate: "env",
    envKeys: ["OLLAMA_BASE_URL"],
    run: async () => {
      const base = process.env.OLLAMA_BASE_URL
      if (!base) return { ok: false, note: "Ollama غير مربوط — اضبط OLLAMA_BASE_URL (مثلاً http://localhost:11434)" }
      try {
        const res = await fetch(`${base.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) })
        const data = (await res.json()) as { models?: Array<{ name: string }> }
        return { ok: res.ok, note: res.ok ? `Ollama شغال — ${data.models?.length ?? 0} موديل محلي` : "Ollama لا يستجيب", data }
      } catch {
        return { ok: false, note: "Ollama غير قابل للوصول" }
      }
    },
  },
  // ═══════════ الموجة الجديدة: قنوات تواصل وأدوات حصاد إضافية ═══════════
  {
    name: "call_script",
    description: "سكريبت مكالمة مبيعات مصري جاهز لأي ليد — مبني على بحث الليد واحتياجاته (قناة تواصل جديدة بالكامل)",
    gate: "ready",
    run: async (args) => {
      const leadId = String(args.lead_id ?? "")
      if (!leadId) return { ok: false, note: "lead_id مفقود" }
      const lead = await db.lead.findUnique({
        where: { id: leadId },
        include: {
          business: { select: { name: true, industry: true, city: true, phone: true, rating: true, reviewCount: true } },
          person: { select: { fullName: true } },
        },
      })
      if (!lead) return { ok: false, note: "الليد غير موجود" }
      const name = lead.person?.fullName?.split(" ")[0] || "باشا"
      const biz = lead.business
      const needs = Array.isArray(lead.serviceNeeds) ? (lead.serviceNeeds as string[]).slice(0, 3).join(" و") : ""
      const script = [
        `📋 سكريبت مكالمة — ${biz?.name ?? "العميل"} (${biz?.city ?? "مصر"})`,
        ``,
        `1) الافتتاحية:`,
        `«مساء الخير، مع ${name}؟ أنا من فريق بيساعد ${biz?.industry ?? "البيزنسات"} في ${biz?.city ?? "مصر"} على ${needs || "تنظيم الشغل بالأنظمة"}. مش هاخد من وقتك غير دقيقة.»`,
        ``,
        `2) الخطاف (من بحث الليد):`,
        lead.whyNow
          ? `«بصيت على شغلكم ولقيت: ${lead.whyNow.slice(0, 120)} — ده اللي خلااني أتصل.»`
          : `«شفت ${biz?.name ?? "نشاطكم"} ${biz?.rating ? `بتقييم ${biz.rating} من ${biz.reviewCount ?? 0} — ده رقم محترم` : "واحد من الأسماء الممتازة في المجال"} وقولت لازم أتواصل.»`,
        ``,
        `3) سؤال التشخيص:`,
        `«دلوقتي ${biz?.name ?? "عندكم"} — الحاجات بتدار إزاي؟ كاشير؟ حجوزات؟ ولا كله على الورق لسه؟»`,
        ``,
        `4) العرض المختصر:`,
        `«إحنا بنعمل بالظبط ده — ${needs || "نظام متكامل"} بيتظبط على مقاس ${biz?.industry ?? "البيزنس"}، وبتشوف النتيجة من أول أسبوع.»`,
        ``,
        `5) إغلاق الموعد:`,
        `«تحب أبعتلك على الواتساب أمثلة من شغلنا مع ${biz?.industry ?? "مجالك"}؟ أو نظبط ميعاد 15 دقيقة أشرحلك بالراحة؟»`,
        ``,
        `⚠️ ملاحظات: اتكلم بصبر وسيب العميل يتكلم — لو قال «مش مهتم» اشكره واسأل إمتى وقت مناسب، وسيب الموضوع.`,
      ].join("\n")
      return { ok: true, note: `سكريبت المكالمة جاهز لـ ${biz?.name ?? name}`, data: { script } }
    },
  },
  {
    name: "find_email",
    description: "منجم إيميلات: يدور على موقع بيزنس الليد وصفحة التواصل ويستخرج الإيميل والتليفونات ويسجلهم",
    gate: "ready",
    run: async (args) => {
      const leadId = String(args.lead_id ?? "")
      if (!leadId) return { ok: false, note: "lead_id مفقود" }
      const lead = await db.lead.findUnique({ where: { id: leadId }, include: { business: true } })
      if (!lead?.business) return { ok: false, note: "الليد من غير بيزنس" }
      const site = lead.business.websiteUrl
      if (!site) return { ok: false, note: "البيزنس من غير موقع — جرب مصادر تانية للإيميل" }
      const candidates = [site, `${site.replace(/\/$/, "")}/contact`, `${site.replace(/\/$/, "")}/contact-us`, `${site.replace(/\/$/, "")}/about`]
      let found: { emails: string[]; phones: string[]; socials: string[] } = { emails: [], phones: [], socials: [] }
      for (const url of candidates.slice(0, 3)) {
        const page = await fetchPage(url, 10000)
        if (!page.ok) continue
        const text = htmlToText(page.html)
        found = extractContacts(text)
        if (found.emails.length) break
      }
      if (found.emails.length && !lead.business.email) {
        await db.business.update({ where: { id: lead.business.id }, data: { email: found.emails[0] } }).catch(() => undefined)
      }
      return {
        ok: found.emails.length > 0,
        note: found.emails.length
          ? `لقيت ${found.emails.length} إيميل من موقع ${site}`
          : `مفيش إيميل ظاهر على ${site} — جرب صفحة التواصل يدوي أو الرسايل`,
        data: found,
      }
    },
  },
  {
    name: "niche_hunt",
    description: "حزم النيتش الجاهزة: مسح نيتش كامل (مطاعم/صيدليات/عيادات/جيمات/مصانع...) بضغطة — بيعمل قاعدة بحث وجدولة اكتشاف فوري",
    gate: "ready",
    run: async (args) => {
      const wsId = String(args.workspace_id ?? "")
      const nicheKey = String(args.niche ?? "").toLowerCase()
      if (!wsId || !nicheKey) return { ok: false, note: "workspace_id أو niche مفقود" }
      const pack = NICHE_PACKS.find((p) => p.key === nicheKey || p.ar === args.niche)
      if (!pack) {
        return { ok: false, note: `نيتش غير معروف — المتاح: ${NICHE_PACKS.map((p) => `${p.key} (${p.ar})`).join("، ")}` }
      }
      const ruleName = `حزمة نيتش: ${pack.ar}`
      let rule = await db.searchRule.findFirst({ where: { workspaceId: wsId, name: ruleName } })
      if (!rule) {
        rule = await db.searchRule.create({
          data: {
            workspaceId: wsId,
            name: ruleName,
            description: `مسح آلي لنيتش ${pack.ar} عبر ${pack.sourceTypes.join("، ")}`,
            enabled: true,
            priority: 110,
            industries: pack.industries as unknown as import("@prisma/client").Prisma.InputJsonValue,
            services: pack.services as unknown as import("@prisma/client").Prisma.InputJsonValue,
            keywords: pack.keywords as unknown as import("@prisma/client").Prisma.InputJsonValue,
            sourceTypes: pack.sourceTypes as unknown as import("@prisma/client").Prisma.InputJsonValue,
          },
        })
      }
      await enqueueJob(wsId, "DISCOVERY", { ruleId: rule.id, sourceTypes: pack.sourceTypes }, 70)
      return { ok: true, note: `نيتش ${pack.ar}: القاعدة جاهزة وأول مسح اتطلّب فورًا (${pack.sourceTypes.length} منصات)`, data: { ruleId: rule.id, sources: pack.sourceTypes } }
    },
  },
  {
    name: "competitor_sweep",
    description: "مسح أثر المنافس: يجيب كل اللي بيتكلم عن منافس معين (متابعين/مراجعات/شكاوى) — عملاء المنافس أصدق قايمة ليدز",
    gate: "ready",
    run: async (args) => {
      const wsId = String(args.workspace_id ?? "")
      const competitor = String(args.competitor ?? "").trim()
      if (!wsId || !competitor) return { ok: false, note: "workspace_id أو competitor مفقود" }
      let source = await db.source.findFirst({ where: { workspaceId: wsId, type: "REVIEWS" } })
        ?? await db.source.findFirst({ where: { workspaceId: wsId, type: "GOOGLE_SEARCH" } })
      if (!source) {
        source = await db.source.create({ data: { workspaceId: wsId, type: "GOOGLE_SEARCH", name: "مسح المنافسين" } })
      }
      const queries = [
        `"${competitor}" (شكوى OR زعلان OR مشكلة OR سيء)`,
        `"${competitor}" (بديل OR ترشيح OR أفضل من)`,
        `site:google.com/maps "${competitor}" تقييم`,
        `"${competitor}" (محتاج OR عايز OR بيدور على)`,
      ]
      const { items } = await runDiscovery(["GOOGLE_SEARCH", "REVIEWS"], queries, 5)
      if (!items.length) return { ok: true, note: `مفيش نتائج ظاهرة دلوقتي عن «${competitor}» — جرب تاني بعد فترة` }
      const { created, duplicates } = await ingestDiscoveredItems(wsId, source, null, items)
      return { ok: true, note: `مسح «${competitor}»: ${items.length} إشارة → ${created} ليد جديد (${duplicates} مكرر)`, data: { created, duplicates } }
    },
  },

  // ═══════════ Dynamic Skill Intelligence Layer — أدوات الخريطة والمهارات (مواصفة 43.23) ═══════════
  // كل الأدوات DB-backed (gate: ready) — والفشل بيرجع note واضح بدون كسر اللوب.
  {
    name: "create_thinking_graph",
    description: "ابنِ خريطة تفكير ديناميكية لهدف (Thinking Graph): تُقسّم الهدف لعقد مرتبطة بمهارات وتُنفّذ أول شريحة. args: objective",
    gate: "ready",
    run: async (args) => {
      const { runAgentGraph } = await import("@/lib/thinking/engine")
      const wsId = String(args.workspace_id ?? "")
      const objective = String(args.objective ?? "").trim()
      if (!wsId || objective.length < 5) return { ok: false, note: "workspace_id أو objective مفقود/قصير" }
      const r = await runAgentGraph(wsId, objective, { trigger: "TOOL", budgetMs: 60_000 })
      return { ok: true, note: `خريطة ${r.graphId.slice(0, 8)} (${r.builtBy}): ${r.status} — ${r.steps.length} عقدة تنفتذت، النتيجة: ${JSON.stringify(r.finalResult).slice(0, 160)}`, data: { graphId: r.graphId, status: r.status, steps: r.steps.slice(0, 12), finalResult: r.finalResult } }
    },
  },
  {
    name: "inspect_thinking_graph",
    description: "افحص خريطة تفكير: إجابات الوعي (بعمل إيه/ليه/إيه الدليل/إيه البلوكر) + كل العقد. args: graph_id",
    gate: "ready",
    run: async (args) => {
      const { inspectThinkingGraph } = await import("@/lib/thinking/engine")
      const r = await inspectThinkingGraph(String(args.graph_id ?? ""))
      if (!r) return { ok: false, note: "خريطة غير موجودة" }
      const a = r.awareness
      return { ok: true, note: `${a.whatAmIDoing} | ${a.evidenceSummary} | تقدم ${a.progress.done}/${a.progress.total}`, data: r }
    },
  },
  {
    name: "update_thinking_graph",
    description: "حدّث عقدة في خريطة: غيّر status (PENDING|SKIPPED) أو objective — لإعادة التخطيط اليدوي. args: graph_id, node_id, status?, objective?",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const nodeId = String(args.node_id ?? "")
      const graphId = String(args.graph_id ?? "")
      if (!graphId || !nodeId) return { ok: false, note: "graph_id/node_id مفقود" }
      const data: Record<string, unknown> = {}
      if (args.status && ["PENDING", "SKIPPED"].includes(String(args.status))) data.status = String(args.status)
      if (args.objective) data.objective = String(args.objective).slice(0, 300)
      if (!Object.keys(data).length) return { ok: false, note: "مفيش تعديلات صالحة (status=PENDING/SKIPPED أو objective)" }
      const res = await dbx.db.taskGraphNode.updateMany({ where: { graphId, nodeId }, data: data as never })
      return { ok: res.count > 0, note: res.count ? `اتحدّثت العقدة ${nodeId}` : "العقدة غير موجودة" }
    },
  },
  {
    name: "get_current_route",
    description: "إيه العقدة الجاية القانونية في الخريطة دلوقتي؟ (الفacts بتحدد الroute). args: graph_id",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const graphId = String(args.graph_id ?? "")
      const nodes = await dbx.db.taskGraphNode.findMany({ where: { graphId }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] })
      if (!nodes.length) return { ok: false, note: "خريطة فاضية/غير موجودة" }
      const settled = new Set(nodes.filter((n) => ["DONE", "SKIPPED", "FAILED"].includes(n.status)).map((n) => n.nodeId))
      const ready = nodes.find((n) => n.status === "PENDING" && ((n.dependencies as string[] | null) ?? []).every((d) => settled.has(d)))
      return { ok: true, note: ready ? `الroute الحالي: ${ready.nodeId} (${ready.type}) — ${ready.objective.slice(0, 100)}` : `مفيش عقدة جاهزة — الحالة: ${nodes[0].status}`, data: { ready: ready?.nodeId ?? null, pending: nodes.filter((n) => n.status === "PENDING").length } }
    },
  },
  {
    name: "search_gitskills",
    description: "ابحث في المكتبات العالمية (GitSkills 3.8M المحصودة + ClawHub) عن مهارات لاستعلام حر — ترتيب بالصلة والثقة. args: query, limit?",
    gate: "ready",
    run: async (args) => {
      const { searchExternalSkills } = await import("@/lib/skills/dsi/retriever")
      const q = String(args.query ?? "").trim()
      if (q.length < 3) return { ok: false, note: "استعلام قصير جدًا" }
      const found = await searchExternalSkills(q, Math.min(Number(args.limit ?? 5), 10))
      return { ok: true, note: found.length ? `${found.length} مهارة: ${found.map((f) => `[${f.kind}] ${f.name} (${f.finalScore.toFixed(2)})`).join("، ")}` : "مفيش مهارة مطابقة في المكتبات المحصودة — الحصاد الدوري هيوسّع الفهرس", data: found.map((f) => ({ kind: f.kind, key: f.key, name: f.name, score: f.finalScore, trust: f.trustScore, source: f.sourceUrl })) }
    },
  },
  {
    name: "rank_gitskills",
    description: "رتّب مرشحي مهارات لعقدة معينة بخط الاسترجاع الكامل (دلالي+لغوي+ثقة+ذاكرة). args: workspace_id, objective, node_type?",
    gate: "ready",
    run: async (args) => {
      const { retrieveSkillsForNode } = await import("@/lib/skills/dsi/retriever")
      const wsId = String(args.workspace_id ?? "")
      const objective = String(args.objective ?? "")
      if (!wsId || objective.length < 5) return { ok: false, note: "workspace_id/objective مفقود" }
      const r = await retrieveSkillsForNode({ workspaceId: wsId, objective, nodeType: String(args.node_type ?? "DISCOVER") })
      return { ok: true, note: `فهم: ${r.parsed.domain}/${r.parsed.action}${r.parsed.platform ? `/${r.parsed.platform}` : ""} — مختار ${r.selected.length}، مرفوض ${r.rejected.length}، مرشح ${r.candidatesChecked}${r.semanticUsed ? " (دلالي شغال)" : " (لغوي بس)"}`, data: { selected: r.selected, rejected: r.rejected, parsed: r.parsed } }
    },
  },
  {
    name: "inspect_skill",
    description: "افحص مهارة من المكتبات: منشأ كامل (ريبو/بصمة/رخصة) + نص التعليمات. args: kind (GITSKILLS|CLAWHUB|CORE), key",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const kind = String(args.kind ?? "").toUpperCase()
      const key = String(args.key ?? "")
      if (kind === "GITSKILLS") {
        const s = await dbx.db.gitSkill.findFirst({ where: { OR: [{ path: key }, { name: key }] } })
        if (!s) return { ok: false, note: "مش موجودة في GitSkills المحصودة" }
        return { ok: true, note: `[GitSkills] ${s.name} — ${s.repo}/${s.path} (ثقة ${s.trustScore}، ${s.status})`, data: { repo: s.repo, path: s.path, url: `https://github.com/${s.repo}/blob/main/${s.path}`, trustScore: s.trustScore, status: s.status, contentHash: s.contentHash, license: s.license, weight: s.weight, body: s.body.slice(0, 800) } }
      }
      if (kind === "CLAWHUB") {
        const s = await dbx.db.hubSkill.findFirst({ where: { OR: [{ slug: key }, { name: key }] } })
        if (!s) return { ok: false, note: "مش موجودة في ClawHub المحصود" }
        return { ok: true, note: `[ClawHub] ${s.name} — ${s.slug} (ثقة ${s.trustScore}، ${s.status})`, data: { slug: s.slug, url: s.sourceUrl, trustScore: s.trustScore, status: s.status, contentHash: s.contentHash, license: s.license, weight: s.weight, body: s.body.slice(0, 800) } }
      }
      const { SKILL_BY_PLATFORM } = await import("@/lib/skills/registry")
      const s = SKILL_BY_PLATFORM[key.toUpperCase()]
      if (!s) return { ok: false, note: `مش مهارة CORE معروفة: ${key}` }
      return { ok: true, note: `[CORE] ${s.platform}: ${s.description.slice(0, 100)}`, data: { platform: s.platform, path: s.path, body: s.body.slice(0, 800) } }
    },
  },
  {
    name: "validate_skill",
    description: "شغّل بوابة الثقة الكاملة (9 مراحل) على مهارة وسجل النتيجة — بدون تفعيل. args: kind, key",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const { assessSkillTrust, contentHashOf } = await import("@/lib/skills/dsi/trust")
      const kind = String(args.kind ?? "").toUpperCase()
      const key = String(args.key ?? "")
      let input: { name: string; description: string; body: string; sourceRef: string; license?: string } | null = null
      if (kind === "GITSKILLS") { const s = await dbx.db.gitSkill.findFirst({ where: { OR: [{ path: key }, { name: key }] } }); if (s) input = { name: s.name, description: s.description, body: s.body, sourceRef: s.repo, license: s.license } }
      else if (kind === "CLAWHUB") { const s = await dbx.db.hubSkill.findFirst({ where: { OR: [{ slug: key }, { name: key }] } }); if (s) input = { name: s.name, description: s.summary, body: s.body, sourceRef: s.slug, license: s.license } }
      if (!input) return { ok: false, note: "المهارة غير موجودة (kind=GITSKILLS|CLAWHUB)" }
      const t = assessSkillTrust({ kind: kind as "GITSKILLS" | "CLAWHUB", ...input })
      const hash = contentHashOf(`${input.name}\n${input.description}\n${input.body}`)
      if (kind === "GITSKILLS") await dbx.db.gitSkill.updateMany({ where: { name: input.name }, data: { trustScore: t.score, status: t.verdict === "FAIL" ? "REJECTED" : "ACTIVE", contentHash: hash } })
      else await dbx.db.hubSkill.updateMany({ where: { name: input.name }, data: { trustScore: t.score, status: t.verdict === "FAIL" ? "REJECTED" : "ACTIVE", contentHash: hash } })
      return { ok: t.verdict === "PASS", note: `بوابة الثقة: ${t.verdict} (${t.score}/100)${t.reasons.length ? ` — ${t.reasons.join("؛ ")}` : ""}`, data: { score: t.score, verdict: t.verdict, hardReject: t.hardReject, checks: t.checks } }
    },
  },
  {
    name: "activate_skill",
    description: "فعّل مهارة خارجية مرفوضة سابقًا (status→ACTIVE) بعد إعادة الفحص — السياسة بتظل فوقها. args: kind, key",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const kind = String(args.kind ?? "").toUpperCase()
      const key = String(args.key ?? "")
      if (kind === "GITSKILLS") { const r = await dbx.db.gitSkill.updateMany({ where: { OR: [{ path: key }, { name: key }] }, data: { status: "ACTIVE" } }); return { ok: r.count > 0, note: r.count ? "اتفعّلت (زي ما هي مش بتفوّت بوابة الثقة عند الاسترجاع)" : "غير موجودة" } }
      if (kind === "CLAWHUB") { const r = await dbx.db.hubSkill.updateMany({ where: { OR: [{ slug: key }, { name: key }] }, data: { status: "ACTIVE" } }); return { ok: r.count > 0, note: r.count ? "اتفعّلت" : "غير موجودة" } }
      return { ok: false, note: "kind لازم يكون GITSKILLS أو CLAWHUB" }
    },
  },
  {
    name: "deactivate_skill",
    description: "عطّل مهارة خارجية (status→BLOCKED) — مش هتظهر في أي استرجاع. args: kind, key",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const kind = String(args.kind ?? "").toUpperCase()
      const key = String(args.key ?? "")
      if (kind === "GITSKILLS") { const r = await dbx.db.gitSkill.updateMany({ where: { OR: [{ path: key }, { name: key }] }, data: { status: "BLOCKED" } }); return { ok: r.count > 0, note: r.count ? "اتعطّلت (BLOCKED)" : "غير موجودة" } }
      if (kind === "CLAWHUB") { const r = await dbx.db.hubSkill.updateMany({ where: { OR: [{ slug: key }, { name: key }] }, data: { status: "BLOCKED" } }); return { ok: r.count > 0, note: r.count ? "اتعطّلت (BLOCKED)" : "غير موجودة" } }
      return { ok: false, note: "kind لازم يكون GITSKILLS أو CLAWHUB" }
    },
  },
  {
    name: "inspect_skill_history",
    description: "سجل استرجاعات مهارة: امتى اتجّابت واتختارت واترفضت ولية. args: key, limit?",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const key = String(args.key ?? "")
      const rows = await dbx.db.skillRetrieval.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(Number(args.limit ?? 10), 30) })
      const hits = rows.filter((r) => {
        const sel = (r.selected as Array<{ key?: string }> | null) ?? []
        const rej = (r.rejected as Array<{ key?: string }> | null) ?? []
        return sel.some((s) => s.key === key) || rej.some((s) => s.key === key)
      })
      return { ok: true, note: hits.length ? `${hits.length} استرجاع فيه المهارة دي` : "مفيش سجل استرجاع للمهارة دي لسه", data: hits.map((h) => ({ at: h.createdAt, nodeId: h.nodeId, objective: h.objective.slice(0, 80), reason: h.reason })) }
    },
  },
  {
    name: "inspect_skill_trust",
    description: "درجة ثقة مهارة + تفصيل فحوصاتها التسعة. args: kind, key",
    gate: "ready",
    run: async (args) => {
      const { AGENT_TOOLS } = await import("@/lib/agent/tools")
      const validate = AGENT_TOOLS.find((t) => t.name === "validate_skill")
      if (!validate) return { ok: false, note: "أداة الفحص غير متاحة" }
      return validate.run(args)
    },
  },
  {
    name: "get_skill_outcomes",
    description: "نتايج مهارة/مهارات من الذاكرة: معدل نجاح، جودة، زمن (حلقة التعلم 43.11). args: workspace_id, key?",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const wsId = String(args.workspace_id ?? "")
      const key = args.key ? String(args.key) : undefined
      const where: Record<string, unknown> = { workspaceId: wsId, ...(key ? { skillKey: key } : {}) }
      const rows = await dbx.db.skillOutcome.groupBy({
        by: ["skillKind", "skillKey"],
        where: where as never,
        _count: { _all: true },
        _avg: { quality: true, latencyMs: true },
        orderBy: { _count: { skillKey: "desc" } },
        take: 15,
      }).catch(() => [])
      if (!rows.length) return { ok: true, note: "مفيش نتايج مسجلة لسه — الحلقة بتتغذى أول ما الخرايط تتنفذ" }
      return { ok: true, note: rows.slice(0, 5).map((r) => `${r.skillKind}:${r.skillKey.slice(0, 24)} ×${r._count._all}`).join("، "), data: rows.map((r) => ({ kind: r.skillKind, key: r.skillKey, uses: r._count._all, avgQuality: Math.round(r._avg.quality ?? 0), avgLatencyMs: Math.round(r._avg.latencyMs ?? 0) })) }
    },
  },
  {
    name: "find_skill_for_node",
    description: "أفضل مهارة واحدة لعقدة بالهدف المحدد (استرجاع مصغّر). args: workspace_id, objective",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const { retrieveSkillsForNode } = await import("@/lib/skills/dsi/retriever")
      const wsId = String(args.workspace_id ?? "")
      const objective = String(args.objective ?? "")
      if (!wsId || objective.length < 5) return { ok: false, note: "workspace_id/objective مفقود" }
      const r = await retrieveSkillsForNode({ workspaceId: wsId, objective, nodeType: "DISCOVER", maxSkills: 1 })
      const s = r.selected[0]
      return { ok: Boolean(s), note: s ? `أفضل مهارة: [${s.kind}] ${s.name} (${s.finalScore}) — ${s.selectionReason}` : "مفيش مهارة عدّت الحد — NO NEED → NO SKILL", data: s ?? null }
    },
  },
  {
    name: "replace_skill",
    description: "استبدل مهارة مفعّلة في عقدة بأخرى من المرشحين: سجل الرفض والبديل. args: graph_id, node_id, remove_key, add_key?",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const graphId = String(args.graph_id ?? "")
      const nodeId = String(args.node_id ?? "")
      const removeKey = String(args.remove_key ?? "")
      const addKey = args.add_key ? String(args.add_key) : null
      const node = await dbx.db.taskGraphNode.findFirst({ where: { graphId, nodeId } })
      if (!node) return { ok: false, note: "العقدة غير موجودة" }
      const selected = ((node.selectedSkills as Array<{ key: string }> | null) ?? []).filter((s) => s.key !== removeKey)
      if (addKey) selected.push({ key: addKey } as never)
      await dbx.db.taskGraphNode.update({ where: { id: node.id }, data: { selectedSkills: selected as never } })
      return { ok: true, note: `استبدال مسجل: -${removeKey || "(فاضي)"}${addKey ? ` +${addKey}` : ""}`, data: { selected } }
    },
  },
  {
    name: "record_skill_outcome",
    description: "سجّل نتيجة يدوية لمهارة (للتعلم خارج الخرايط): SUCCESS|PARTIAL|FAILURE. args: workspace_id, kind, key, outcome, quality?",
    gate: "ready",
    run: async (args) => {
      const { recordSkillOutcome } = await import("@/lib/skills/dsi/memory")
      const wsId = String(args.workspace_id ?? "")
      const kind = String(args.kind ?? "").toUpperCase()
      const key = String(args.key ?? "")
      const outcome = String(args.outcome ?? "").toUpperCase()
      if (!wsId || !key || !["SUCCESS", "PARTIAL", "FAILURE", "UNKNOWN"].includes(outcome)) return { ok: false, note: "متغيرات ناقصة أو outcome غير معروف" }
      await recordSkillOutcome({ workspaceId: wsId, skillKind: kind as "CORE" | "GITSKILLS" | "CLAWHUB" | "WORKSPACE", skillKey: key, outcome: outcome as "SUCCESS" | "PARTIAL" | "FAILURE" | "UNKNOWN", quality: Number(args.quality ?? 0), notes: "تسجيل يدوي" })
      return { ok: true, note: `اتسجلت نتيجة ${outcome} لـ${kind}:${key} — الوزن هيتحدّث في المكتبة` }
    },
  },
  {
    name: "replan_task",
    description: "أجبر خريطة على إعادة تخطيط: أرجّع العقد الفاشلة PENDING وأضف مسار بديل. args: graph_id",
    gate: "ready",
    run: async (args) => {
      const dbx = await import("@/lib/db")
      const graphId = String(args.graph_id ?? "")
      const g = await dbx.db.taskGraph.findUnique({ where: { id: graphId } })
      if (!g) return { ok: false, note: "خريطة غير موجودة" }
      const revived = await dbx.db.taskGraphNode.updateMany({ where: { graphId, status: "FAILED" }, data: { status: "PENDING" } })
      if (g.status !== "ACTIVE") await dbx.db.taskGraph.update({ where: { id: graphId }, data: { status: "ACTIVE" } })
      return { ok: true, note: `إعادة تخطيط: ${revived.count} عقدة فاشلة رجعت PENDING والخريطة ${g.status !== "ACTIVE" ? "رجعت ACTIVE" : "مازالت ACTIVE"}` }
    },
  },
  {
    name: "recover_task",
    description: "استئناف تنفيذ خريطة متوقفة (شريحة جديدة بميزانية قصيرة). args: graph_id",
    gate: "ready",
    run: async (args) => {
      const { runGraphSlice } = await import("@/lib/thinking/engine")
      const graphId = String(args.graph_id ?? "")
      const slice = await runGraphSlice(graphId, { budgetMs: 45_000, maxNodes: 4 })
      return { ok: slice.steps.length > 0, note: slice.steps.length ? `اتنفذت ${slice.steps.length} عقدة — الحالة ${slice.status}: ${slice.steps.map((s) => `${s.type}=${s.outcome}`).join("، ")}` : `مفيش عقد قابلة للتنفيذ — الحالة ${slice.status}`, data: slice }
    },
  },
]

export function toolStatus() {
  return AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    ready: t.gate === "ready" || (t.envKeys ?? []).every((k) => Boolean(process.env[k])),
    needs: t.gate === "env" ? (t.envKeys ?? []) : [],
  }))
}
