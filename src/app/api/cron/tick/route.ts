import { after } from "next/server"
import { processTick } from "@/lib/queue"
import { getSessionUser } from "@/lib/auth"
import { json, jsonError } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { scanDueGroups } from "@/lib/monitors/scan"
import { zizoTick } from "@/lib/agent/zizo/brain"
import { superviseChains } from "@/lib/supervisor"

/**
 * Orchestrator tick endpoint — designed for external cron (cron-job.org / Vercel Cron).
 * Auth: `x-cron-secret` header, `Authorization: Bearer <CRON_SECRET>` (Vercel Cron),
 * `?secret=` matching CRON_SECRET env, OR an authenticated session.
 *
 * آسنكرون: الرد بيروح فورًا للكرن الخارجي (مهلة cron-job.org = 30 ثانية، والنبضة الكاملة
 * ممكن تاخد دقيقة+ بعد ما الموجة الكاملة اشتغلت) — والشغل يكمل في الخلفية بعد الرد
 * (after / fluid compute). النتايج بتتسجل أصلًا: Job.result لكل جوبة + SearchJob.metadata
 * (adaptersUsed) — والملخص الكامل بيتكتب في اللوجز.
 * منذ إضافة «تحدي الجروبات»: نفس النبضة بتمسح كمان لحد 2 جروبات مستحقة.
 */
export const maxDuration = 120

async function handle(req: Request) {
  const url = new URL(req.url)
  const secret = process.env.CRON_SECRET
  const altSecret = process.env.CRON_SECRET_ALT // بديل آمن للتفعيل الخارجي — من غير تدوير السر الأساسي
  const authHeader = req.headers.get("authorization") ?? ""
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null
  const provided = req.headers.get("x-cron-secret") ?? bearer ?? url.searchParams.get("secret")
  const authorized =
    (secret && provided === secret) || (altSecret && provided === altSecret) || Boolean(await getSessionUser())
  if (!authorized) return jsonError("غير مصرح", 401)

  const maxJobs = Math.min(10, Number(url.searchParams.get("max") ?? 5))
  // المسح الشامل (؟full=1): جوبة اكتشاف لكل ورشة على الـ16 منصة كلهم دفعة واحدة
  // — لبذر فوري لكل المصادر. الاستخدام العادي (الكرن) من غيره — الدوران بالساعة كفاية
  const fullSweep = ["1", "true", "yes"].includes((url.searchParams.get("full") ?? "").toLowerCase())

  after(async () => {
    let result: Awaited<ReturnType<typeof processTick>>
    try {
      result = await processTick(maxJobs, { fullSweep })
    } catch (err) {
      console.error("[tick] processTick crashed:", err instanceof Error ? err.stack : err)
      return
    }

    // تحدي الجروبات: مسح مستحقين (cooldown 15 دقيقة بيمنع التكرار)
    let groupScan: { scanned: number; newPosts: number; details: string[] } | null = null
    try {
      const wsIds = await db.monitoredGroup.findMany({
        where: { status: { in: ["ACTIVE", "NEEDS_SESSION"] } },
        select: { workspaceId: true },
        distinct: ["workspaceId"],
        take: 2,
      })
      const details: string[] = []
      let scanned = 0
      let newPosts = 0
      for (const w of wsIds) {
        const outcomes = await scanDueGroups(w.workspaceId, 2)
        for (const o of outcomes) {
          scanned++
          newPosts += o.newPosts
          details.push(`${o.name}: ${o.newPosts} جديد (${o.status})`)
        }
      }
      groupScan = { scanned, newPosts, details }
    } catch (err) {
      groupScan = { scanned: 0, newPosts: 0, details: [`group scan error: ${err instanceof Error ? err.message.slice(0, 100) : "خطأ"}`] }
    }

    // زيزو — نبضة البيع: يرد على العملاء + يتابع الساكت + يبادر مع الليدز الحلوة
    // محادثة واحدة إضافية لكل tick لو في مبادرات، وسقف داخلي بيمنع الضغط
    let zizo: { replies: number; followups: number; outreaches: number; note: string } | null = null
    try {
      const wsIds = await db.workspace.findMany({ where: { isActive: true }, select: { id: true }, take: 3 })
      for (const w of wsIds) {
        const r = await zizoTick(w.id)
        if (r.replies || r.followups || r.outreaches) {
          zizo = zizo
            ? { replies: zizo.replies + r.replies, followups: zizo.followups + r.followups, outreaches: zizo.outreaches + r.outreaches, note: `${zizo.note} • ${r.note}` }
            : r
        }
      }
    } catch (err) {
      zizo = { replies: 0, followups: 0, outreaches: 0, note: `zizo error: ${err instanceof Error ? err.message.slice(0, 100) : "خطأ"}` }
    }

    console.log(`[tick] ${JSON.stringify({ at: new Date().toISOString(), ...result, groupScan, zizo })}`)

    // Supervisor المركزي: فحص سعة GitHub + إحياء السلاسل الميتة/المؤجلة (فشله لا يمس النبضة)
    try {
      const sup = await superviseChains()
      if (sup.revived.length || sup.error) console.log(`[supervisor] ${JSON.stringify(sup)}`)
      else console.log(`[supervisor] سليم — لا إحياء مطلوب (${sup.skipped.length} متخطاة)`)
    } catch (err) {
      console.error("[supervisor] crashed:", err instanceof Error ? err.message.slice(0, 120) : err)
    }
  })

  return json({ ok: true, at: new Date().toISOString(), async: true, maxJobs, full: fullSweep || undefined })
}

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}
