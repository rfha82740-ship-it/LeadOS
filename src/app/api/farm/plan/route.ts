// LeadOS — Farm Query Plan API: الجسر بين عقل المهارات (Vercel) ومزرعة المتصفح (GitHub Actions)
// تدفق التكامل (طلب #3): Vercel Skill Intelligence → منصات مختارة → تكتيكات → استعلامات
// مولّدة/متعلمة → payload آمن → GitHub Farm → تنفيذ → webhook ingest → SkillOutcome/SearchMemory.
//
// القواعد الصارمة:
// • المهارة توفر معرفة واستراتيجية فقط (استعلامات + تكتيكات) — التنفيذ الحقيقي بعمال المشروع الموثوقين.
// • لا كود خارجي، لا أوامر شبكة، لا أي شيء قابل للتنفيذ في الـpayload — نصوص استعلام بحتة.
// • كل استعلام يتحمل منشأ كاملًا: querySource (learned|tactic|ai|static) + skillId + skillKind + reason.
// • الفشل هنا آمن دائمًا: الـfarm يرجع لاستعلاماته الثابتة (fallback static queries).
import { db } from "@/lib/db"
import { json, jsonError } from "@/lib/api-helpers"
import { topLessons } from "@/lib/skills/learning"
import { gitSkillsTactics } from "@/lib/skills/gitskills"
import { hubTactics } from "@/lib/skills/hub"

export const maxDuration = 30

const KNOWN_PLATFORMS = new Set([
  "TELEGRAM", "REDDIT", "QUORA", "DISCORD", "EVENTS", "YOUTUBE", "TIKTOK", "LINKEDIN",
  "INSTAGRAM", "X", "FACEBOOK", "JOBS", "MARKETPLACE", "FREELANCE", "DIRECTORY",
])

/** فحص مفتاح الـingest — نفس عقد الـwebhook (x-api-key أو ?key=) */
function authorized(req: Request): boolean {
  const key = process.env.INGEST_API_KEY
  if (!key) return false
  const url = new URL(req.url)
  const provided =
    req.headers.get("x-api-key") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice(7)
      : undefined) ??
    url.searchParams.get("key") ?? undefined
  return provided === key
}

export async function GET(req: Request) {
  if (!authorized(req)) return jsonError("غير مصرح — مفتاح INGEST_API_KEY مطلوب", 401)
  const url = new URL(req.url)
  const platform = (url.searchParams.get("platform") ?? "").toUpperCase()
  const niche = (url.searchParams.get("niche") ?? "عملاء محتاجين خدمات رقمية في مصر").slice(0, 160)
  if (!KNOWN_PLATFORMS.has(platform)) return jsonError(`منصة غير معروفة: ${platform || "(فاضية)"}`, 400)

  const ws = await db.workspace.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } })
  if (!ws) return jsonError("لا يوجد workspace", 400)

  const planId = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const queries: Array<{ q: string; querySource: string; skillId: string; skillKind: string; reason: string }> = []
  const tactics: string[] = []

  try {
    // 1) الدروس المتعلمة الحقيقية (استعلامات جابت ليدز فعلًا للورشة) — أعلى مصدر
    const lessons = await topLessons(ws.id, platform, 3).catch(() => [] as string[])
    for (const q of lessons) {
      queries.push({ q, querySource: "learned", skillId: `lesson:${platform}`, skillKind: "CORE", reason: "درس مجرب — استعلام جاب ليدز قبل كده" })
    }

    // 2) تكتيكات المكتبتين العالميتين — معرفة استراتيجية (تعليمات فقط، لا تنفيذ)
    const [gitLines, hubLines] = await Promise.all([
      gitSkillsTactics(platform, niche, 3).catch(() => [] as string[]),
      hubTactics(platform, niche, 2).catch(() => [] as string[]),
    ])
    tactics.push(...gitLines, ...hubLines)

    // 3) استعلام مشتق من النيش بالعربية المصرية — بدون AI (الـendpoint سريع ومجاني،
    //    والـAI smith بيشتغل من النبضة ويغذي الدروس التي تصل هنا تلقائيًا)
    const nicheShort = niche.split(/\s+/).slice(0, 4).join(" ")
    if (nicheShort.length >= 6 && !queries.some((x) => x.q.includes(nicheShort))) {
      queries.push({ q: `${nicheShort} ${platformTitle(platform)}`, querySource: "plan", skillId: "plan:niche", skillKind: "WORKSPACE", reason: "مشتق من نيش المهمة الحالية" })
    }
  } catch {
    // أي فشل في العقل → الرد يفضل 200 مع قائمة فاضية — الفارم يفهم إنه يرجع للثابت
  }

  // سقف صارم: 6 استعلامات نصية بحتة — قصيرة وآمنة (بدون رموز تنفيذية)
  const safe = queries
    .filter((x) => x.q.length >= 6 && x.q.length <= 200)
    .filter((x) => !/[;|&$`<>{}]/.test(x.q))
    .slice(0, 6)

  // تدقيق المنشأ في سجل الاسترجاعات (43.10) — «ليه الفارم استخدم الاستعلامات دي؟»
  await db.skillRetrieval.create({
    data: {
      workspaceId: ws.id,
      objective: `[FARM_PLAN] ${platform} — ${niche}`,
      parsed: { platform, dataType: "leads", source: "farm-plan" },
      selected: safe.map((x) => ({ key: x.q.slice(0, 80), kind: x.skillKind, name: x.querySource, score: null })),
      rejected: [],
      reason: `خطة استعلامات للمزرعة: ${safe.length} استعلام (learned=${safe.filter((x) => x.querySource === "learned").length})`,
    },
  }).catch(() => undefined)

  return json({
    ok: true,
    planId,
    platform,
    selectedBy: "skill-intelligence",
    generatedAt: new Date().toISOString(),
    ttlMinutes: 30,
    queries: safe,
    tactics: tactics.slice(0, 5),
    note: "الاستعلامات معرفة فقط — التنفيذ بواسطة عمال المزرعة الموثوقين. فشل الخطة = استعلامات ثابتة.",
  })
}

function platformTitle(p: string): string {
  const map: Record<string, string> = {
    FACEBOOK: "facebook", LINKEDIN: "linkedin", X: "twitter", INSTAGRAM: "انستجرام",
    YOUTUBE: "youtube", TIKTOK: "tiktok", QUORA: "quora", DIRECTORY: "دليل أعمال",
    JOBS: "وظائف", MARKETPLACE: "اعلانات بيع", FREELANCE: "فريلانس", EVENTS: "معرض",
    DISCORD: "discord", TELEGRAM: "تليجرام", REDDIT: "reddit",
  }
  return map[p] ?? p.toLowerCase()
}
