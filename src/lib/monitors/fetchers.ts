// LeadOS — Group Post Fetchers (تحدي الجروبات)
// فيسبوك: بجلسة مسجلة (cookie) من env FACEBOOK_SESSION_COOKIE — أو Apify Actor مدفوع لو متوفر.
// تليجرام: قنوات/جروبات عامة عبر t.me/s/ — مجاني بدون تسجيل.
// ريديت: JSON API عام — مجاني.
// X: مراقبة كلمات عبر سلسلة البحث الحية (site:x.com) — شغال 10/10 حسب الاختبار الحي.
// كل الجالبات ترجع بنفس الشكل: RawPost[] + حالة واضحة.

import { agentWebSearch, parseSearchDate } from "@/lib/discovery"
import { stealthExtract, stealthInjectCookieHeader, stealthNavigate } from "@/lib/agent/stealth-browser"

export interface RawPost {
  externalId?: string
  url?: string
  author?: string
  content: string
  postedAt?: Date
}

export type FetchStatus = "OK" | "NEEDS_SESSION" | "BLOCKED" | "ERROR" | "EMPTY"

export interface FetchResult {
  posts: RawPost[]
  status: FetchStatus
  note?: string
  membersText?: string
}

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
// فيسبوك 2026: بيرفض UA الموبايل/القديم بصفحة «متصفح غير مدعوم» — لازم كروم سطح مكتب حديث
const FB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function decodeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`) as string
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\u([\dA-Fa-f]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([\dA-Fa-f]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .trim()
}

// ══════════ Facebook (جروبات) ══════════

/**
 * جلب منشورات جروب فيسبوك بجلسة مسجلة.
 * الاستراتيجية: جلب صفحة الجروب بكوكي الحساب وتفكيك بيانات الستوريز المدمجة في الصفحة.
 * لو فيسبوك رد بجدار تسجيل دخول → NEEDS_SESSION (الكوكي انتهى أو الحساب اتحجز).
 */
async function fetchFacebookDirect(externalId: string, membersWanted: boolean): Promise<FetchResult> {
  const cookie = process.env.FACEBOOK_SESSION_COOKIE
  if (!cookie) {
    return { posts: [], status: "NEEDS_SESSION", note: "لا يوجد FACEBOOK_SESSION_COOKIE — ضيف كوكي جلسة مسجلة من الإعدادات" }
  }
  const res = await fetch(`https://www.facebook.com/groups/${encodeURIComponent(externalId)}/posts/`, {
    headers: {
      Cookie: cookie,
      "User-Agent": FB_UA,
      "Accept-Language": "ar,eg;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Sec-Fetch-Mode": "navigate",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  })
  if (!res.ok) return { posts: [], status: "ERROR", note: `فيسبوك رجع HTTP ${res.status}` }
  const html = await res.text()

  // جدار تسجيل الدخول بدون بيانات ستوريز = الجلسة مش قادرة تشوف الجروب
  const hasStories = /"__typename":"Story"|"post_id":"/.test(html)
  const loginWall = /login_form|checkpoint|you\s+must\s+log\s+in|يجب.*تسجيل الدخول/i.test(html)
  if (!hasStories && loginWall) {
    return { posts: [], status: "NEEDS_SESSION", note: "فيسبوك طالب بتسجيل دخول — جدّد كوكي الجلسة أو استخدم Apify" }
  }
  if (/محتوى غير متوفر|content isn't available|this content isn't available/i.test(html)) {
    return { posts: [], status: "BLOCKED", note: "الجروب خاص أو محتواه غير متاح للحساب" }
  }

  const posts: RawPost[] = []
  const chunks = html.split(/\{"__typename":"Story"/)
  for (const chunk of chunks.slice(1)) {
    const postId = chunk.match(/"post_id":"([\w-]+)"/)?.[1]
    const textMatch = chunk.match(/"message":\{"text":"((?:\\.|[^"\\])*)"/)?.[1]
    const timeMatch = chunk.match(/"creation_time":(\d{9,11})/)?.[1]
    const authorMatch = chunk.match(/"author":\{[^{}]*?"name":"((?:\\.|[^"\\])*)"/)?.[1]
    if (!textMatch || textMatch.length < 5) continue
    const content = decodeJsonString(textMatch).trim()
    if (!content) continue
    posts.push({
      externalId: postId ?? undefined,
      url: postId ? `https://www.facebook.com/groups/${externalId}/posts/${postId}/` : undefined,
      author: authorMatch ? decodeJsonString(authorMatch) : undefined,
      content: content.slice(0, 2000),
      postedAt: timeMatch ? new Date(parseInt(timeMatch, 10) * 1000) : undefined,
    })
    if (posts.length >= 30) break
  }

  const members = membersWanted
    ? (html.match(/([\d.,]+\s*(?:[KM]\+?)?\s*(?:عضو|members?))/i)?.[1] ??
       html.match(/"member_count":\{"count":(\d+)\}/)?.[1] ??
       undefined)
    : undefined

  if (!posts.length) {
    return { posts: [], status: "EMPTY", note: "الصفحة اتحملت بس مفيش منشورات متعرف عليها المحلل — فيسبوك غيّر شكل الصفحة", membersText: members }
  }
  return { posts, status: "OK", membersText: members }
}

/** مسار Apify — الأكثر موثوقية لجروبات فيسبوك (مدفوع بالاستهلاك) */
async function fetchFacebookApify(groupUrl: string): Promise<FetchResult> {
  const token = process.env.APIFY_TOKEN
  if (!token) return { posts: [], status: "NEEDS_SESSION", note: "لا يوجد APIFY_TOKEN" }
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-groups-scraper/run-sync-get-dataset-items?token=${token}&timeout=110000`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startUrls: [{ url: groupUrl }], resultsLimit: 30, viewOption: "NEW_POSTS" }),
        signal: AbortSignal.timeout(120000),
      },
    )
    if (!res.ok) return { posts: [], status: "ERROR", note: `Apify رجع HTTP ${res.status}` }
    const items = (await res.json()) as Array<{
      text?: string; postUrl?: string; url?: string; author?: string; time?: string; postedAt?: string; facebookId?: string
    }>
    const posts: RawPost[] = items
      .filter((it) => (it.text ?? "").trim().length > 5)
      .slice(0, 30)
      .map((it) => ({
        externalId: it.facebookId ?? (it.postUrl ? hashId(it.postUrl) : undefined),
        url: it.postUrl ?? it.url,
        author: typeof it.author === "string" ? it.author : undefined,
        content: (it.text ?? "").slice(0, 2000),
        postedAt: it.postedAt ? new Date(it.postedAt) : undefined,
      }))
    if (!posts.length) return { posts: [], status: "EMPTY", note: "Apify رجع بدون منشورات" }
    return { posts, status: "OK" }
  } catch (err) {
    return { posts: [], status: "ERROR", note: `Apify فشل: ${err instanceof Error ? err.message.slice(0, 80) : "خطأ"}` }
  }
}

/**
 * مسار الستيلث (Camoufox): متصفح حقيقي مضاد للبصمة.
 * بيتفعل لما الجلب المباشر يفشل (NEEDS_SESSION/ERROR) — بيفتح صفحة الجروب
 * وبيستخرج المنشورات من الـDOM، وبيحقن كوكيز الجلسة لو لقا جدار دخول.
 */
async function fetchFacebookStealth(groupUrl: string): Promise<FetchResult> {
  const nav = await stealthNavigate({ url: groupUrl, wait_until: "domcontentloaded", timeout: 60_000, scroll_times: 4, session: "fb" })
  if (!nav.ok) {
    return { posts: [], status: "ERROR", note: `الستيلث: ${nav.error?.slice(0, 120) ?? "فشل"}` }
  }
  // جدار دخول؟ حقن كوكيز الجلسة وإعادة محاولة واحدة
  const finalUrl = nav.url ?? ""
  const loginWall = /login|checkpoint/i.test(finalUrl) || /تسجيل الدخول|log in to Facebook/i.test(nav.text ?? "")
  if (loginWall && process.env.FACEBOOK_SESSION_COOKIE) {
    const injected = await stealthInjectCookieHeader(process.env.FACEBOOK_SESSION_COOKIE)
    if (injected) {
      const retry = await stealthNavigate({ url: groupUrl, wait_until: "domcontentloaded", timeout: 60_000, scroll_times: 4, session: "fb" })
      if (retry.ok) {
        nav.url = retry.url
        nav.text = retry.text
      }
    }
  }
  if (/محتوى غير متوفر|content isn't available/i.test(nav.text ?? "")) {
    return { posts: [], status: "BLOCKED", note: "الستيلث: الجروب خاص أو محتواه غير متاح" }
  }
  const items = await stealthExtract({ selector: 'div[role="article"]', limit: 40, session: "fb" })
  const seen = new Set<string>()
  const posts: RawPost[] = []
  for (const raw of items.items ?? []) {
    const content = raw.replace(/\n{2,}/g, "\n").trim()
    if (content.length < 40) continue
    const key = hashId(content.slice(0, 200))
    if (seen.has(key)) continue
    seen.add(key)
    // أول سطر غالبًا اسم الكاتب أو الوقت — النص الكامل محفوظ للتصنيف
    posts.push({
      externalId: `cf:${key}`,
      url: groupUrl,
      content: content.slice(0, 2000),
    })
    if (posts.length >= 30) break
  }
  const members = (nav.text ?? "").match(/([\d.,]+\s*[KM]?\+?\s*(?:عضو|members?))/i)?.[1]
  if (!posts.length) {
    return {
      posts: [],
      status: "EMPTY",
      note: loginWall
        ? "الستيلث فتح الصفحة بس الجلسة مش قادرة تشوف الجروب"
        : "الستيلث فتح الجروب بس مفيش منشورات مقروءة في الـDOM",
      membersText: members,
    }
  }
  return { posts, status: "OK", note: "عبر الستيلث Camoufox", membersText: members }
}

export async function fetchFacebookGroup(externalId: string, groupUrl: string): Promise<FetchResult> {
  const direct = await fetchFacebookDirect(externalId, true).catch((err) => ({
    posts: [] as RawPost[],
    status: "ERROR" as FetchStatus,
    note: `فشل الاتصال: ${err instanceof Error ? err.message.slice(0, 80) : "خطأ"}`,
  }))
  // OK → خلص | BLOCKED → الجروب خاص (مش هيتحل بأداة تانية)
  // EMPTY/NEEDS_SESSION/ERROR → الستيلث الأول (مجاني ومحلي والجلسة حية فيه) وبعدين Apify
  if (direct.status === "OK" || direct.status === "BLOCKED") return direct
  // NEEDS_SESSION/ERROR → الستيلث الأول (مجاني ومحلي) وبعدين Apify
  const stealth = await fetchFacebookStealth(groupUrl)
  if (stealth.status === "OK") return stealth
  if (process.env.APIFY_TOKEN) {
    const apify = await fetchFacebookApify(groupUrl)
    if (apify.status === "OK") return apify
    return {
      posts: [],
      status: direct.status === "NEEDS_SESSION" ? "NEEDS_SESSION" : "ERROR",
      note: `${direct.note ?? ""}${stealth.note ? ` | ${stealth.note}` : ""}${apify.note ? ` | ${apify.note}` : ""}`.slice(0, 200),
    }
  }
  return {
    posts: [],
    status: direct.status === "NEEDS_SESSION" ? "NEEDS_SESSION" : "ERROR",
    note: `${direct.note ?? ""}${stealth.note ? ` | ${stealth.note}` : ""}`.slice(0, 200),
  }
}

// ══════════ Telegram (قنوات/جروبات عامة) ══════════

export async function fetchTelegram(handle: string): Promise<FetchResult> {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(handle)}`, {
    headers: { "User-Agent": UA, "Accept-Language": "ar,en;q=0.8" },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return { posts: [], status: "BLOCKED", note: `تليجرام رجع HTTP ${res.status}` }
  const html = await res.text()
  if (!/tgme_widget_message/.test(html)) {
    return { posts: [], status: "BLOCKED", note: "القناة غير عامة أو غير موجودة" }
  }
  const membersText = html.match(/([\d.,]+\s*(?:[KM]\+?)?\s*subscriber)/i)?.[1]
  const posts: RawPost[] = []
  const blocks = html.split(/<div class="tgme_widget_message /)
  for (const block of blocks.slice(1)) {
    const dataPost = block.match(/data-post="([^"]+)"/)?.[1] // channel/12345
    const textMatch = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1]
    const dt = block.match(/<time datetime="([^"]+)"/)?.[1]
    const author = block.match(/tgme_widget_message_from_author[^>]*>([\s\S]*?)<\/div>/)?.[1]
    if (!textMatch || textMatch.trim().length < 5) continue
    const content = stripHtml(textMatch)
    if (!content) continue
    posts.push({
      externalId: dataPost,
      url: dataPost ? `https://t.me/${dataPost}` : undefined,
      author: author ? stripHtml(author).split("\n")[0].split(",")[0].trim() || handle : handle,
      content: content.slice(0, 2000),
      postedAt: dt ? new Date(dt) : undefined,
    })
    if (posts.length >= 30) break
  }
  if (!posts.length) return { posts: [], status: "EMPTY", note: "القناة موجودة بس مفيش رسائل نصية حديثة" }
  return { posts, status: "OK", membersText }
}

// ══════════ Reddit (subreddits) ══════════

export async function fetchReddit(subreddit: string): Promise<FetchResult> {
  const res = await fetch(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=40`, {
    headers: { "User-Agent": "LeadOS-GroupMonitor/1.0 (lead intelligence)" },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return { posts: [], status: "BLOCKED", note: `ريديت رجع HTTP ${res.status}` }
  const data = (await res.json()) as {
    data?: {
      children?: Array<{
        data?: {
          id?: string; title?: string; selftext?: string; permalink?: string
          author?: string; created_utc?: number; subreddit_subscribers?: number
        }
      }>
    }
  }
  const children = data.data?.children ?? []
  const membersText = children[0]?.data?.subreddit_subscribers
    ? `${children[0].data.subreddit_subscribers} subscribers`
    : undefined
  const posts: RawPost[] = children
    .map((c) => c.data)
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({
      externalId: d.id,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : undefined,
      author: d.author ?? undefined,
      content: `${d.title ?? ""}\n${d.selftext ?? ""}`.trim().slice(0, 2000),
      postedAt: d.created_utc ? new Date(d.created_utc * 1000) : undefined,
    }))
    .filter((p) => p.content.length > 5)
  if (!posts.length) return { posts: [], status: "EMPTY", note: "مفيش منشورات حديثة" }
  return { posts, status: "OK", membersText }
}

// ══════════ X (مراقبة كلمات عبر البحث الحي) ══════════

/** جروب X هنا = "مراقبة كلمة مفتاحية" — بيتجاب منشورات الموقع عبر سلسلة البحث */
export async function fetchXKeyword(keyword: string): Promise<FetchResult> {
  const clean = keyword.replace(/^kw:/, "")
  const { results } = await agentWebSearch(`site:x.com ${clean} مصر`, 10, 7)
  const posts: RawPost[] = results
    .filter((r) => /x\.com\/.+\/status\//.test(r.url) || /twitter\.com\/.+\/status\//.test(r.url))
    .slice(0, 15)
    .map((r) => ({
      externalId: `x:${hashId(r.url)}`,
      url: r.url,
      author: r.host_name,
      content: `${r.name}\n${r.snippet}`.trim().slice(0, 2000),
      postedAt: parseSearchDate(r.date),
    }))
  if (!posts.length) return { posts: [], status: "EMPTY", note: "مفيش منشورات X جديدة على الكلمة دي الأسبوع ده" }
  return { posts, status: "OK" }
}

// ══════════ Dispatcher ══════════

export async function fetchGroupPosts(group: {
  platform: string
  externalId: string
  url: string
  name: string
}): Promise<FetchResult> {
  switch (group.platform) {
    case "FACEBOOK":
      return fetchFacebookGroup(group.externalId, group.url)
    case "TELEGRAM":
      return fetchTelegram(group.externalId)
    case "REDDIT":
      return fetchReddit(group.externalId)
    case "X":
      return fetchXKeyword(group.externalId)
    default:
      return { posts: [], status: "ERROR", note: `منصة غير مدعومة: ${group.platform}` }
  }
}

// ══════════ تحليل رابط جروب مُدخل ══════════

export interface ParsedGroup {
  platform: "FACEBOOK" | "TELEGRAM" | "REDDIT" | "X" | "OTHER"
  externalId: string
  url: string
}

/** يفهم أي رابط جروب/قناة ويرجع المنصة والمعرف والرابط الكانوني */
export function parseGroupInput(input: string, xKeyword?: string): ParsedGroup | null {
  const raw = input.trim()
  if (!raw) return null
  // مراقبة كلمات X يدويًا: "x:كلمة" أو platform=X
  const xKw = raw.match(/^x:(.+)/i)?.[1]?.trim() || xKeyword?.trim()
  if (xKw) {
    return {
      platform: "X",
      externalId: `kw:${xKw}`,
      url: `https://x.com/search?q=${encodeURIComponent(xKw)}&f=live`,
    }
  }
  let u: URL
  try { u = new URL(raw.startsWith("http") ? raw : `https://${raw}`) } catch { return null }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "").replace(/^mbasic\./, "")

  if (/(^|\.)facebook\.com$/.test(host)) {
    const m = u.pathname.match(/\/groups\/([^/?#]+)/)
    if (!m) return null
    return { platform: "FACEBOOK", externalId: m[1], url: `https://www.facebook.com/groups/${m[1]}` }
  }
  if (/(^|\.)t\.me$/.test(host) || /(^|\.)telegram\.me$/.test(host)) {
    const handle = u.pathname.split("/").filter(Boolean)[0]
    if (!handle) return null
    if (["s", "share", "joinchat", "proxy", "addlist", "iv"].includes(handle)) return null
    return { platform: "TELEGRAM", externalId: handle, url: `https://t.me/${handle}` }
  }
  if (/(^|\.)reddit\.com$/.test(host)) {
    const m = u.pathname.match(/\/r\/([A-Za-z0-9_]+)/)
    if (!m) return null
    return { platform: "REDDIT", externalId: m[1], url: `https://www.reddit.com/r/${m[1]}` }
  }
  return null
}
