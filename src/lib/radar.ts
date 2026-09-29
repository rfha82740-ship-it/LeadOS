// LeadOS — الرادار اللحظي (طلب المالك: صيد داخل الجروبات فوراً + تعليق آلي بروابط واتساب/تليجرام)
// الفكرة: منشور نُشر قبل دقائق + عليه ≤ 10 تعليقات = منافسة شبه صفر → نحتل التعليق الأول برابط واتساب زيزو
// الضوابط البشرية: فواصل عشوائية بين التعليقات + سقف يومي + ساعات نشاط + نصوص متغيرة بلا قوالب ثابتة
import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { stealthNavigate, stealthAct } from "@/lib/agent/stealth-browser"
import { buildPsychComment, COMMENT_ANGLES } from "@/lib/agent/zizo/psychology"
import { matchPlaybooks } from "@/lib/agent/zizo/expertise"
import { pickTactic, recordTacticUse, evolutionTick } from "@/lib/agent/zizo/evolution"
import { zizoConfigOf } from "@/lib/agent/zizo/services"

// ══════════ الإعدادات (بيئة قابلة للضبط) ══════════
const envInt = (k: string, d: number) => {
  const v = parseInt(process.env[k] ?? "", 10)
  return Number.isFinite(v) && v > 0 ? v : d
}
export const RADAR_CONFIG = {
  freshMinutes: envInt("RADAR_FRESH_MINUTES", 45), // المنشور لازم يكون نازل خلال المدة دي
  maxComments: envInt("RADAR_MAX_COMMENTS", 10), // أقصى تعليقات على المنشور (طلب المالك: 10)
  groupsPerCycle: envInt("RADAR_GROUPS_PER_CYCLE", 2), // جروبات في كل دورة — روتيتشن بطيء آمن
  groupCooldownMin: envInt("RADAR_GROUP_COOLDOWN_MIN", 4), // الجروب ميتمسحش مرتين قريبين
  commentMinGapMin: envInt("RADAR_COMMENT_MIN_GAP_MIN", 8), // أقل فاصل بين تعليقين (مفيش ورا بعض)
  commentMaxGapMin: envInt("RADAR_COMMENT_MAX_GAP_MIN", 16), // أقصى فاصل
  dailyCap: envInt("RADAR_DAILY_CAP", 18), // سقف تعليقات فيسبوك في اليوم
  maxPerGroupDaily: envInt("RADAR_MAX_PER_GROUP_DAILY", 2), // سقف لكل جروب في اليوم
  activeHourStart: envInt("RADAR_ACTIVE_HOUR_START", 9), // 9 صباحاً بالقاهرة
  activeHourEnd: envInt("RADAR_ACTIVE_HOUR_END", 23), // 11:30 مساءً بالقاهرة
  whatsapp: process.env.ZIZO_WHATSAPP ?? "201067804629",
  telegram: process.env.ZIZO_TELEGRAM ?? "12186496997",
}

// ══════════ كشف نية الخدمة اللحظية ══════════
const INTENT_VERBS = /محتاج|محتاجة|عايز|عاوز|مطلوب|بيدور|بندور|بدور|مين يعرف|حد يعرف|بديل|ترشيح|ينصحني|نصحتني|هحتاج|looking for|need(ed)? (a|an|recommend)|recommend/i
const SERVICE_KEYWORDS = /برمج|موقع إلكتروني|موقع الكتروني|ويب|website|تطبيق|موبايل اب|app|كاشير|POS|نظام محاسب|نظام إدارة|نظام ادارة|ERP|CRM|فواتير|متجر إلكتروني|متجر الكتروني|بيع أونلاين|بيع اونلاين|أتمتة|اتمتة|أوتوميشن|واتساب|تصميم|مصمم|لوجو|شعار|هوية بصرية|تسويق|إعلانات ممولة|اعلانات ممولة|إعلان|ماركتنج|marketing|SEO|سوشيال ميديا|مونتاج|فيديو دعائي/i

export interface InstantPost {
  externalId: string
  url: string
  author?: string
  content: string
  postedAt?: Date
  ageMinutes: number
  comments: number
  matched: string[]
  intentScore: number
}

/** تحويل الأرقام العربية-الهندية لأرقام لاتينية */
function arabicDigitsToInt(s: string): number {
  const map: Record<string, string> = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" }
  const latin = s.replace(/[٠-٩]/g, (d) => map[d] ?? d)
  return parseInt(latin, 10)
}

/** قراءة عمر المنشور من نص فيسبوك ("٢٥ د" / "٣ س" / "1ي" / "يوم واحد") بالدقايق — null = غير معروف
 *  ملاحظة: البحث في أول 140 حرف فقط — الوقت بيكون في رأس المقال، وممكن نص المنشور نفسه يحتوي أرقام مضللة ("٦ ساعات شغل") */
export function parseAgeMinutes(text: string): number | null {
  const head = text.slice(0, 140)
  const m = head.match(/([٠-٩\d]+)\s*(ثانية|ثواني|دقيقة|دقائق|ساعة|ساعات|يوم|أيام|ايام|أسبوع|اسبوع|ث|د|س|ي)(?![\u0621-\u064Aa-zA-Z])/)
  if (m) {
    const n = arabicDigitsToInt(m[1])
    const unit = m[2]
    if (/ث/.test(unit)) return 0
    if (/د/.test(unit)) return n
    if (/س/.test(unit)) return n * 60
    return n * 24 * 60
  }
  if (/الآن|الان|just now|قبل لحظات/.test(head)) return 0
  if (/يوم واحد|من يوم|امس|أمس/.test(head)) return 24 * 60
  return null
}

/** سطور واجهة فيسبوك اللي بتتلخبط مع محتوى المنشور */
const UI_NOISE =
  /^(أعجبني|إعجاب|رد|ردود|مشاركة|تعليق باسم.*|تمت المشاركة.*|مجموعة عامة|مجموعة خاصة|أكثر|عرض المزيد|المزيد|رؤية المزيد|تعليقات|أرسال|أعلى نتيجة|أحدث|أكثر صلة|الجميع يمكنه الرد|مكتوب الآن|تم التعديل)$/

/** تنظيف نص المقال من ضجيج الواجهة — يرجع المحتوى الفعلي أو فاضي لو التعليق/عنصر واجهة */
export function cleanArticleText(raw: string): string {
  const lines = raw
    .replace(/\u200E|\u200F/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !UI_NOISE.test(l) && !/^[٠-٩0-9]{1,4}$/.test(l))
  // سطر الوقت/الكاتب في الرأس: اسم ثم وقت — نقطع أول سطرين لو فيهما وقت
  const joined = lines.join("\n")
  return joined
}

/** عدد التعليقات من نص المقال ("٥ تعليقات" / "3 comments" / "تعليق واحد") */
export function parseCommentCount(text: string): number {
  const m = text.match(/([٠-٩\d]+)\s*(تعليق|تعليقات|comments?)/i)
  if (m) return arabicDigitsToInt(m[1])
  if (/تعليق واحد|one comment/i.test(text)) return 1
  return 0 // منشور طازج مفيش عليه تعليقات ظاهرة
}

/** هل ده منشور نية خدمة لحظي؟ يرجع الدرجة والكلمات المتطابقة أو null */
export function matchInstantIntent(text: string): { score: number; matched: string[] } | null {
  const hasVerb = INTENT_VERBS.test(text)
  const hasService = SERVICE_KEYWORDS.test(text)
  if (!hasVerb || !hasService) return null
  const matched: string[] = []
  const verb = text.match(INTENT_VERBS)?.[0]
  const service = text.match(SERVICE_KEYWORDS)?.[0]
  if (verb) matched.push(verb.trim())
  if (service) matched.push(service.trim())
  // طول النص يوحي بطلب حقيقي مش مجرد ذكر عابر
  const substantive = text.length >= 40
  const score = substantive ? 85 : 60
  return { score, matched }
}

// ══════════ استخراج المنشورات من صفحة الجروب (eval على الـDOM) ══════════

interface ArticleData {
  link: string
  text: string
  author?: string
}

const EXTRACT_SCRIPT = `(() => {
  const arts = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 40);
  const out = [];
  for (const a of arts) {
    const linkEl = a.querySelector('a[href*="/posts/"], a[href*="story_fbid"], a[href*="permalink"]');
    const link = linkEl ? linkEl.href : '';
    const text = (a.innerText || '').slice(0, 1800);
    if (text.length < 30) continue;
    // اسم الكاتب: أول لينك جوا المقال لبروفايل
    const authorEl = a.querySelector('a[href*="/user/"], a[href*="profile.php"], h2 a, h3 a');
    out.push({ link, text, author: authorEl ? (authorEl.innerText || '').split('\\n')[0].slice(0, 60) : undefined });
  }
  return out;
})()`

export async function extractGroupArticles(session = "fb"): Promise<ArticleData[]> {
  const r = await stealthAct({ action: "eval", script: EXTRACT_SCRIPT, session })
  if (!r.ok || !Array.isArray(r.result)) return []
  return (r.result as ArticleData[]).filter((a) => a.text && a.text.length >= 30)
}

/** فحص جروب واحد بالمتصفح الستيلث — يعيد المنشورات اللحظية المؤهلة */
export async function radarScanGroup(group: { id: string; name: string; url: string; externalId: string }): Promise<{
  status: string
  posts: InstantPost[]
  note?: string
}> {
  const nav = await stealthNavigate({
    url: group.url,
    wait_until: "domcontentloaded",
    timeout: 90_000,
    scroll_times: 2,
    session: "fb",
  })
  if (!nav.ok) return { status: "ERROR", posts: [], note: nav.error?.slice(0, 140) }
  const text = nav.text ?? ""
  if (/تسجيل الدخول|log in to facebook|checkpoint/i.test(text) && text.length < 3000) {
    return { status: "NEEDS_SESSION", posts: [], note: "الجلسة مش قادرة تفتح الجروب" }
  }
  if (/محتوى غير متوفر|content isn't available/i.test(text)) {
    return { status: "BLOCKED", posts: [], note: "الجروب خاص/محتواه غير متاح" }
  }
  await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1800))) // نفس بشري: اهدى شوية قبل القراءة
  const articles = await extractGroupArticles()
  const now = Date.now()
  const posts: InstantPost[] = []
  const seen = new Set<string>()
  for (const a of articles) {
    // العمر من رأس النص الخام (سطر الكاتب والوقت) — المحتوى من النص المنظف
    const ageMin = parseAgeMinutes(a.text) ?? parseAgeMinutes(a.author ?? "") ?? 9999
    if (ageMin > RADAR_CONFIG.freshMinutes) continue
    const body = cleanArticleText(a.text)
    if (body.length < 40) continue // تعليق/عنصر واجهة — مش منشور
    const comments = parseCommentCount(a.text)
    if (comments > RADAR_CONFIG.maxComments) continue
    const intent = matchInstantIntent(body)
    if (!intent) continue
    const key = a.link || body.slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    // خُد أول 600 حرف كنص المنشور — يشمل الطلب
    const content = body.slice(0, 600)
    posts.push({
      externalId: a.link ? `fbp:${a.link.split("/posts/")[1]?.replace(/\/$/, "").split("?")[0] ?? a.link}` : `fbt:${body.slice(0, 80)}`,
      url: a.link || group.url,
      author: a.author,
      content,
      postedAt: new Date(now - ageMin * 60_000),
      ageMinutes: ageMin,
      comments,
      matched: intent.matched,
      intentScore: intent.score,
    })
    if (posts.length >= 5) break
  }
  return { status: "OK", posts, note: articles.length ? undefined : "مفيش مقالات مقروءة في الـDOM" }
}

// ══════════ الحفظ والتجنيد ══════════

/** يكتب المنشورات اللحظية: GroupPost + ليد فوري + مهمة/تعليق مجدول. يرجع ملخص */
export async function ingestInstantPosts(
  wsId: string,
  group: { id: string; name: string; url: string },
  posts: InstantPost[],
): Promise<{ created: number; leads: number; commentsScheduled: number }> {
  let created = 0
  let leads = 0
  let commentsScheduled = 0
  for (const p of posts) {
    const existing = await db.groupPost.findFirst({ where: { groupId: group.id, externalId: p.externalId }, select: { id: true } })
    if (existing) continue
    let gp
    try {
      gp = await db.groupPost.create({
        data: {
          groupId: group.id,
          externalId: p.externalId,
          url: p.url,
          author: p.author,
          content: p.content,
          postedAt: p.postedAt,
          score: p.intentScore,
          matchedKeywords: p.matched as Prisma.InputJsonValue,
          status: "QUALIFIED",
        },
      })
    } catch {
      continue
    }
    created++

    // ليد فوري (نيتة عالية — نازل من دقائق)
    const author = p.author?.trim() || "صاحب منشور"
    try {
      const business = await db.business.create({
        data: { workspaceId: wsId, name: author, country: "Egypt" },
      })
      const lead = await db.lead.create({
        data: {
          workspaceId: wsId,
          businessId: business.id,
          status: "NEW",
          leadSourceType: "SOCIAL",
          intent: "VERY_HIGH",
          intentScore: 95,
          urgencyScore: 95,
          serviceNeeds: p.matched,
          summary: `${author}: ${p.content.slice(0, 160)}`,
          whyNow: `منشور طازج (${p.ageMinutes} دقيقة) بـ${p.comments} تعليقات — كلمات: ${p.matched.join("، ")} — جروب: ${group.name}`,
          contentLinks: { create: [] },
        },
      })
      await db.leadSource.create({
        data: { leadId: lead.id, sourceType: "SOCIAL", sourceUrl: p.url, label: `رادار لحظي — ${group.name}` },
      })
      leads++

      // المجدول البشري: تعليق آلي على فيسبوك فقط (الجلسة عندنا) — الباقي مهمة يداوية
      const delayMin = RADAR_CONFIG.commentMinGapMin - 4 + Math.floor(Math.random() * 5) // 4-8 دقايق: لسه "فوري" بس مش ميت
      await db.job.create({
        data: {
          workspaceId: wsId,
          type: "FB_COMMENT",
          priority: 90,
          scheduledAt: new Date(Date.now() + delayMin * 60_000),
          payload: {
            leadId: lead.id,
            groupPostId: gp.id,
            postId: p.externalId,
            postUrl: p.url,
            groupUrl: group.url,
            groupName: group.name,
            author,
            postText: p.content.slice(0, 400),
            matched: p.matched,
          } as Prisma.InputJsonValue,
        },
      })
      commentsScheduled++
      await db.task.create({
        data: {
          workspaceId: wsId,
          leadId: lead.id,
          title: `⚡ رادار: تعليق مجدول على منشور ${author} (${p.ageMinutes} د)`,
          description: `${p.url}\nالكلمات: ${p.matched.join("، ")}`,
          status: "TODO",
          dueAt: new Date(Date.now() + delayMin * 60_000),
          priority: 80,
        },
      })
    } catch {
      // الليد فشل — المنشور اتحفظ وسيبقاه للتقييم اليدوي
    }
  }
  return { created, leads, commentsScheduled }
}

// ══════════ المجدول البشري + منفّذ التعليقات ══════════

function cairoNow(): { hour: number; minute: number; dayStart: Date } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === "hour")?.value ?? 0) % 24
  const minute = Number(parts.find(p => p.type === "minute")?.value ?? 0)
  // لحظة منتصف ليل القاهرة الحقيقية (UTC) = الآن − (المنقضي من اليوم القاهري)
  const dayStart = new Date(now.getTime() - (hour * 60 + minute) * 60_000)
  return { hour, minute, dayStart }
}

const rnd = (min: number, max: number) => min + Math.random() * (max - min)

export interface CommentJob {
  id: string
  workspaceId: string
  scheduledAt: Date
  payload: {
    leadId?: string
    postUrl?: string
    groupUrl?: string
    groupName?: string
    author?: string
    postText?: string
    matched?: string[]
  }
}

/**
 * معالجة التعليقات المستحقة بضوابط بشرية صارمة:
 * ساعات نشاط، سقف يومي، سقف لكل جروب، فاصل أدنى من آخر تعليق — لو الضابط مش تحقق يتأجل مش يتلغي
 */
export async function processDueComments(wsId: string, max = 2): Promise<{ done: number; deferred: number; notes: string[] }> {
  const notes: string[] = []
  let done = 0
  let deferred = 0
  const { hour, dayStart } = cairoNow()
  const inActiveHours = hour >= RADAR_CONFIG.activeHourStart && (hour < RADAR_CONFIG.activeHourEnd || (hour === RADAR_CONFIG.activeHourEnd && new Date().getMinutes() <= 30))

  // تعليقات النهارده الناجحة
  const todays = await db.job.findMany({
    where: { workspaceId: wsId, type: "FB_COMMENT", status: "SUCCESS", createdAt: { gte: dayStart } },
    select: { scheduledAt: true, completedAt: true, payload: true },
  })
  if (todays.length >= RADAR_CONFIG.dailyCap) {
    return { done: 0, deferred: 0, notes: [`السقف اليومي اتخطى (${todays.length}/${RADAR_CONFIG.dailyCap}) — مفيش تعليقات لحد بكرة`] }
  }
  // آخر تعليق ناجح فعلاً (لضمان الفاصل الأدنى)
  const lastSuccessAt = todays
    .map((j) => j.completedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0]

  const due = await db.job.findMany({
    where: { workspaceId: wsId, type: "FB_COMMENT", status: { in: ["QUEUED", "RETRYING"] }, scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: max,
  })
  if (!due.length) return { done: 0, deferred: 0, notes }

  for (const job of due) {
    const payload = job.payload as CommentJob["payload"]
    const defer = async (minutes: number, reason: string) => {
      await db.job.update({ where: { id: job.id }, data: { scheduledAt: new Date(Date.now() + minutes * 60_000), status: "RETRYING" } })
      deferred++
      notes.push(`⏱ مؤجل ${Math.round(minutes)}د: ${reason}`)
    }

    if (!inActiveHours) {
      await defer(45, "خارج ساعات النشاط (9ص-11:30م بالقاهرة)")
      continue
    }
    if (lastSuccessAt) {
      const gapMin = (Date.now() - lastSuccessAt.getTime()) / 60_000
      if (gapMin < RADAR_CONFIG.commentMinGapMin) {
        await defer(RADAR_CONFIG.commentMinGapMin - gapMin + rnd(1, 4), `الفاصل البشري (${Math.round(gapMin)}د من آخر تعليق)`)
        continue
      }
    }
    // سقف الجروب اليومي (عدّ في الذاكرة — SQLite مش بيدعم فلترة JSON بـpath)
    const groupName = payload.groupName ?? ""
    const perGroup = todays.filter((j) => (j.payload as { groupName?: string } | null)?.groupName === groupName).length
    if (perGroup >= RADAR_CONFIG.maxPerGroupDaily) {
      await defer(90, `سقف الجروب (${groupName.slice(0, 30)}) — ${perGroup} التعليقات النهاردة`)
      continue
    }

    // الركن النفسي: افتراضي معتمد (لو المالك وافق على مقترح) 70% — الباقي اختيار موزّع بالمتعلم
    const cfg = zizoConfigOf((await db.workspace.findUnique({ where: { id: wsId }, select: { settings: true } }))?.settings)
    const angleIds = COMMENT_ANGLES.map((a) => a.id)
    const angle =
      cfg.defaultCommentAngle && Math.random() < 0.7
        ? cfg.defaultCommentAngle
        : await pickTactic(wsId, "comment", angleIds)
    await recordTacticUse(wsId, "comment", angle)

    // التنفيذ الفعلي — تعليق نفسي بشري بالركن المختار + خبرة سوقية من playbook المجال
    const expertHook = matchPlaybooks(payload.postText ?? "")[0]?.hook
    const { text, angle: usedAngle } = buildPsychComment(payload.postText ?? "", payload.matched ?? [], angle, expertHook)
    const result = await postFacebookComment(payload.postUrl ?? "", text)
    if (result.ok) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "SUCCESS", completedAt: new Date(), result: { message: `commented: ${text.slice(0, 80)}`, note: result.note, angle: usedAngle } as Prisma.InputJsonValue },
      })
      done++
      notes.push(`✅ تعليق اتنشر على ${payload.author ?? "?"} (${groupName.slice(0, 30)})`)
      if (payload.leadId) {
        await db.note.create({
          data: {
            workspaceId: wsId,
            leadId: payload.leadId,
            body: `زيزو علّق آلياً: «${text.slice(0, 200)}» — ${result.note ?? ""}`,
          },
        }).catch(() => undefined)
        await db.lead.update({ where: { id: payload.leadId }, data: { status: "CONTACTED" } }).catch(() => undefined)
      }
      await db.groupPost.update({ where: { id: String((job.payload as { groupPostId?: string }).groupPostId ?? "") }, data: { status: "CONVERTED" } }).catch(() => undefined)
      // نوم بشري بعد كل تعليق (تقرير الدورة — التنفيذ التاني متأخر أصلاً بالجدولة)
      await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 4_000))
    } else {
      const attempts = job.attempts + 1
      const permanent = attempts >= job.maxAttempts
      await db.job.update({
        where: { id: job.id },
        data: {
          status: permanent ? "FAILED" : "RETRYING",
          attempts,
          completedAt: permanent ? new Date() : null,
          errorMessage: (result.note ?? "فشل غير معروف").slice(0, 300),
          scheduledAt: new Date(Date.now() + rnd(10, 25) * 60_000),
        },
      })
      notes.push(`${permanent ? "❌" : "🔁"} ${payload.author ?? "?"}: ${(result.note ?? "فشل").slice(0, 80)}`)
    }
  }
  return { done, deferred, notes }
}

// ══════════ النصوص البشرية — بيتولدوا من وحدة علم النفس (أركان نفسية متغيرة) ══════════

/** صياغة تعليق نفسي بشري (توافقية مع الاختبارات القديمة) */
export function buildHumanComment(postText: string, matched: string[]): string {
  return buildPsychComment(postText, matched).text
}

// ══════════ نشر التعليق عبر الستيلث ══════════

/** يفتح رابط المنشور ويكتب التعليق بكتابة تدريجية بشرية وينشر
 *  (المنطق المجرّب حياً: retry للصندوق + focus بـeval + كتابة insertText حرف بحرف + Enter) */
export async function postFacebookComment(
  postUrl: string,
  text: string,
): Promise<{ ok: boolean; note?: string }> {
  if (!postUrl || !postUrl.startsWith("http")) return { ok: false, note: "رابط منشور ناقص" }
  const nav = await stealthNavigate({ url: postUrl, wait_until: "domcontentloaded", timeout: 60_000, scroll_times: 0, session: "fb" })
  if (!nav.ok) return { ok: false, note: `فشل فتح المنشور: ${nav.error?.slice(0, 80)}` }
  // قراءة "بشرية" قبل التفاعل — وأيضاً استنى لحد ما صندوق التعليق يظهر بعد الهايدريشن
  let boxReady = false
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2_500 + Math.random() * 1_500))
    const probe = await stealthAct({
      action: "eval",
      session: "fb",
      script: `(() => { const el = document.querySelector('div[role="textbox"][contenteditable="true"], textarea[name="comment_text"]'); return el ? true : false })()`,
    })
    if (probe.ok && probe.result === true) { boxReady = true; break }
  }
  if (!boxReady) return { ok: false, note: "صندوق التعليق ما ظهرش — الجلسة وقعت أو الصفحة غيّرت شكلها" }
  // focus بشري عبر eval (click الآلي بيفشل على العناصر المتغيرّة)
  const focus = await stealthAct({
    action: "eval",
    session: "fb",
    script: `(() => { const el = document.querySelector('div[role="textbox"][contenteditable="true"], textarea[name="comment_text"]'); if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); el.click(); return true })()`,
  })
  if (!focus.ok || focus.result !== true) return { ok: false, note: "صندوق التعليق مش بياخد الفوكس" }
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 1_300))
  // كتابة تدريجية بشرية: حرف حرف بفواصل عشوائية عبر execCommand (بيشتغل مع محرر فيسبوك)
  const typeScript = `(async () => {
    const el = document.querySelector('div[role="textbox"][contenteditable="true"], textarea[name="comment_text"]');
    if (!el) return false;
    el.focus();
    const txt = ${JSON.stringify(text)};
    for (const ch of txt) {
      document.execCommand('insertText', false, ch);
      await new Promise(r => setTimeout(r, 25 + Math.random() * 110));
    }
    return true;
  })()`
  const typed = await stealthAct({ action: "eval", script: typeScript, session: "fb" })
  if (!typed.ok || typed.result !== true) return { ok: false, note: "الكتابة فشلت — صندوق التعليق مش مقبول إدخال" }
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 1_500))
  // النشر: Enter من الكيبورد (سلوك مستخدم عادي)
  await stealthAct({ action: "press", key: "Enter", session: "fb" })
  await new Promise((r) => setTimeout(r, 3_500))
  // تحقق: النص ظهر في الصفحة؟
  const verify = await stealthAct({ action: "eval", session: "fb", script: `document.body.innerText.includes(${JSON.stringify(text.slice(0, 40))})` })
  if (verify.ok && verify.result === true) return { ok: true, note: "التعليق ظاهر على المنشور" }
  return { ok: true, note: "اتنشر (مش متأكدين من الظهور في الفحص — غالباً تمام)" }
}

// ══════════ دورة الرادار الكاملة ══════════

/** دورة واحدة: مسح الجروبات المستحقة + معالجة التعليقات المستحقة */
export async function radarCycle(wsId?: string): Promise<{ scanned: number; instant: number; leads: number; scheduled: number; commentNotes: string[] }> {
  const ws = wsId ?? (await db.workspace.findFirst({ select: { id: true } }))?.id
  if (!ws) return { scanned: 0, instant: 0, leads: 0, scheduled: 0, commentNotes: ["مفيش ورشة"] }

  const cooldown = new Date(Date.now() - RADAR_CONFIG.groupCooldownMin * 60_000)
  const groups = await db.monitoredGroup.findMany({
    where: { workspaceId: ws, platform: "FACEBOOK", status: { in: ["ACTIVE", "NEEDS_SESSION"] }, OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: cooldown } }] },
    orderBy: [{ activityScore: "desc" }, { lastScannedAt: "asc" }],
    take: RADAR_CONFIG.groupsPerCycle,
  })

  let instant = 0
  let leads = 0
  let scheduled = 0
  for (const g of groups) {
    const r = await radarScanGroup({ id: g.id, name: g.name, url: g.url, externalId: g.externalId })
    await db.monitoredGroup.update({
      where: { id: g.id },
      data: { lastScannedAt: new Date(), status: r.status === "OK" ? "ACTIVE" : r.status === "NEEDS_SESSION" ? "NEEDS_SESSION" : r.status === "BLOCKED" ? "BLOCKED" : g.status, statusNote: r.note?.slice(0, 200) ?? null },
    })
    if (r.posts.length) {
      const ing = await ingestInstantPosts(ws, { id: g.id, name: g.name, url: g.url }, r.posts)
      instant += ing.created
      leads += ing.leads
      scheduled += ing.commentsScheduled
    }
    // تنفس بشري بين الجروبات
    await new Promise((res) => setTimeout(res, 2_000 + Math.random() * 3_000))
  }

  const comments = await processDueComments(ws, 2)

  // نبضة التطور الذاتي: تعلم من نتايج التعليقات (مقفولة جوه بمعدل 25 دقيقة + برومبت الإعدادات)
  const cfg = zizoConfigOf((await db.workspace.findUnique({ where: { id: ws }, select: { settings: true } }))?.settings)
  if (cfg.selfEvolution) await evolutionTick(ws).catch(() => undefined)

  return { scanned: groups.length, instant, leads, scheduled, commentNotes: comments.notes }
}
