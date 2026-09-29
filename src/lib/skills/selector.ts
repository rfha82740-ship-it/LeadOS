// LeadOS — منتقي المهارات (Skill Selector) — «العقل اللي بيختار الاسكل المناسبة»
// 1) queriesForPlatform: دروس مجربة (SkillLesson) + الأشكال الثابتة للمنصة — الأقدم أقوى.
// 2) freshAiQueries: حدّاد استعلامات AI — بيولّد استعلامات جديدة بلغة المنصة لكل نيش
//    (بوتيرة مكتومة: منصة/24 ساعة) وبيحفظها دروس — النظام بيكبر مكتبته لوحده.
// 3) aiSelectPlatforms: إعادة ترتيب للموجة بالـAI (كتالوج المهارات + أرقام الأداء)
//    — throttled 30 دقيقة، وفشله بيرجع للأوزان المتعلمة فورًا.
import { aiChatJson, aiProviderStatus } from "@/lib/ai"
import { PLATFORM_QUERY_SHAPES, platformQueries } from "@/lib/discovery"
import { SKILL_BY_PLATFORM } from "./registry"
import { topLessons, recentAiLessonCount, saveAiLessons } from "./learning"
import { gitSkillsTactics, recordGitSkillUse } from "./gitskills"
import { hubTactics, recordHubSkillUse } from "./hub"

/** استعلامات منصة لجوب: الدروس المجربة الأول — بعدين الأشكال الثابتة — dedup */
export async function queriesForPlatform(wsId: string, platform: string, baseQuery: string, max = 4): Promise<string[]> {
  const lessons = await topLessons(wsId, platform, 2).catch(() => [] as string[])
  const staticQ = platformQueries(platform, baseQuery)
  const out: string[] = []
  for (const q of [...lessons, ...staticQ]) {
    const t = q.trim()
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
    if (out.length >= max) break
  }
  return out.length ? out : [baseQuery]
}

/** throttling داخل العملية (serverless instance) — وتيرة توليد معقولة */
let lastAiQueriesAt = 0
let lastAiSelectAt = 0
const AI_QUERIES_GAP_MS = 10 * 60_000 // توليد استعلامات: كل 10 دقايق على الأقل
const AI_SELECT_GAP_MS = 30 * 60_000 // إعادة ترتيب الموجة: كل 30 دقيقة على الأقل

/** هل فيه عقل متاح أصلًا؟ (مفاتيح dahl/NVIDIA أو طوارئ z-ai) */
export function aiAvailable(): boolean {
  const st = aiProviderStatus()
  return Boolean(st.dahl.active || st.hasKey)
}

/**
 * حدّاد استعلامات AI: 3 استعلامات جديدة بلغة المنصة للنيش — بيتحفظوا دروس source=ai
 * بتشتغل مرة كل 10 دقايق + منصة واحدة كل 24 ساعة (كوتة التعلم) — والفشل صامت.
 */
export async function freshAiQueries(
  wsId: string,
  niche: string,
  platform: string,
): Promise<string[] | null> {
  if (Date.now() - lastAiQueriesAt < AI_QUERIES_GAP_MS) return null
  const skill = SKILL_BY_PLATFORM[platform]
  if (!skill) return null
  if (!PLATFORM_QUERY_SHAPES[platform] && platform !== "GOOGLE_MAPS" && platform !== "WEB") return null
  const recent = await recentAiLessonCount(wsId, platform).catch(() => 99)
  if (recent >= 3) return null // المنصة دي اتولّدت ليها استعلامات حديثة — نسيب الباقي
  const shapes = PLATFORM_QUERY_SHAPES[platform]?.seeds ?? []
  // ═══ تكتيكات المكتبتين العالميتين (GitSkills 3.8M + ClawHub المنسّقة): الأنسب للمنصة/النيش يدخل البرومبت ═══
  const gitLines = await gitSkillsTactics(platform, niche, 3).catch(() => [] as string[])
  const hubLines = await hubTactics(platform, niche, 2).catch(() => [] as string[])
  const tactics = [...gitLines, ...hubLines]
  if (gitLines.length) recordGitSkillUse(gitLines.map((t) => t.replace(/^\- \[GitSkills\] ([^:]+):.*$/, "$1"))).catch(() => undefined)
  if (hubLines.length) recordHubSkillUse(hubLines.map((t) => t.replace(/^\- \[ClawHub\] ([^:]+):.*$/, "$1"))).catch(() => undefined)
  const result = await aiChatJson<{ queries?: string[] }>(
    [
      {
        role: "system",
        content:
          `أنت حدّاد استعلامات بحث في LeadOS. مهمتك: اكتب 3 استعلامات بحث جوجل جديدة ومختلفة بلغة المنصة "${platform}". ` +
          `وصف المنصة: ${skill.description.slice(0, 200)}\n` +
          (shapes.length ? `أمثلة على لغة المنصة (قلّد الأسلوب لكن ابتكر كلمات جديدة): ${shapes.join(" | ")}\n` : "") +
          (tactics.length ? `تكتيكات مجربة من المكتبتين العالميتين (GitSkills 3.8M + ClawHub) (استلهم منها زوايا بحث جديدة):\n${tactics.join("\n")}\n` : "") +
          `النيش المستهدف: «${niche}» (سوق مصري، عربي مصري طبيعي).\n` +
          `قواعد صارمة: استعلام من 3-6 كلمات، من غير site: ومن غير علامات ترقيم، ومن غير تكرار للأمثلة حرفيًا. ` +
          `ارجع JSON فقط: {"queries":["استعلام1","استعلام2","استعلام3"]}`,
      },
      { role: "user", content: `النيش: ${niche}` },
    ],
    { workspaceId: wsId, runType: "SKILL_QUERIES", temperature: 0.4, maxTokens: 300, task: "research" },
  )
  const queries = [...new Set((result?.queries ?? []).map((q) => String(q).trim()).filter((q) => q.length >= 6 && q.length <= 200))].slice(0, 3)
  if (!queries.length) return null
  lastAiQueriesAt = Date.now()
  await saveAiLessons(wsId, platform, queries, niche).catch(() => undefined)
  return queries
}

/**
 * إعادة ترتيب الموجة بالـAI: إيه المنصات الأنسب للنيش ده النهاردة؟
 * بيقرا كتالوج المهارات + أرقام الأداء ويرجع أفضل k — بدون أرقام أداء بيرجع null بسرعة.
 */
export async function aiSelectPlatforms(
  wsId: string,
  niche: string,
  candidates: string[],
  k: number,
  stats?: Record<string, { leads: number; runs: number; weight: number }>,
): Promise<string[] | null> {
  if (Date.now() - lastAiSelectAt < AI_SELECT_GAP_MS) return null
  if (!candidates.length) return null
  // ═══ خريطة المهارات: أعلى تكتيكات المكتبتين العالميتين المرتبطة بالمرشحين تظهر في القائمة ═══
  const gitTacticLines = await gitSkillsTactics("", niche, 3).catch(() => [] as string[])
  const hubTacticLines = await hubTactics("", niche, 2).catch(() => [] as string[])
  const tacticLines = [...gitTacticLines, ...hubTacticLines]
  if (gitTacticLines.length) recordGitSkillUse(gitTacticLines.map((t) => t.replace(/^\- \[GitSkills\] ([^:]+):.*$/, "$1"))).catch(() => undefined)
  if (hubTacticLines.length) recordHubSkillUse(hubTacticLines.map((t) => t.replace(/^\- \[ClawHub\] ([^:]+):.*$/, "$1"))).catch(() => undefined)
  const lines = candidates
    .map((p) => {
      const skill = SKILL_BY_PLATFORM[p]
      if (!skill) return null
      const st = stats?.[p]
      const perf = st ? ` — leads=${st.leads} runs=${st.runs} وزن=${st.weight.toFixed(2)}` : ""
      return `- ${p}: ${skill.description.slice(0, 120)}${perf}`
    })
    .filter(Boolean)
  if (!lines.length) return null
  const result = await aiChatJson<{ picks?: string[]; reason?: string }>(
    [
      {
        role: "system",
        content:
          `أنت منتقي مصادر صيد عملاء في LeadOS. اختار أفضل ${k} مصادر من القائمة لصيد عملاء للنيش: «${niche}». ` +
          `فكر تجاري: مصدر فيه نية شراء صريحة وقريبة من النيش يفضل على مصدر عام، والمصادر اللي أرقامها صفر من فترة طويلة عطّلها شوية. ` +
          `ارجع JSON فقط: {"picks":["PLATFORM1","PLATFORM2"],"reason":"سطر واحد"} — المفاتيح من القائمة حرفيًا.`,
      },
      { role: "user", content: lines.join("\n") + (tacticLines.length ? `\n\nتكتيكات من المكتبتين العالميتين (GitSkills 3.8M مهارة + ClawHub منسّقة) ذات صلة بالنيش (اعتبارها في الاختيار):\n${tacticLines.join("\n")}` : "") },
    ],
    { workspaceId: wsId, runType: "SKILL_SELECT", temperature: 0.2, maxTokens: 250, task: "reason" },
  )
  if (!result?.picks?.length) return null
  const valid = result.picks.map((p) => String(p).toUpperCase()).filter((p) => candidates.includes(p))
  lastAiSelectAt = Date.now()
  return [...new Set(valid)].slice(0, k)
}
