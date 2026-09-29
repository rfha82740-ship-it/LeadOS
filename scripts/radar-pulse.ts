// LeadOS — نبضة الرادار على الاستضافة (GitHub Actions): صفر تشغيل محلي
// بيتنفذ جوه workflow radar.yml: Camoufox service شغال على الـrunner نفسه
// (CAMOUFOX_URL=http://127.0.0.1:9797) + DATABASE_URL = Neon + كوكيز فيسبوك من Secrets.
// الدورة الواحدة = نفس كود الإنتاج الحرفي: radarCycle() — مسح جروبات فريش → ليدز لحظية
// → جدولة تعليقات بشرية → تنفيذ المستحق → نبضة تطور ذاتي.
// التشغيل: bunx tsx scripts/radar-pulse.ts [عدد الدورات] [بروز البادئة بالثواني]
// ملاحظة: ممنوع dotenv هنا — زي fb-scan-local.ts بالظبط (env فقط).
const CYCLES = Math.max(1, Number(process.argv[2] || "3"))
const BOOT_GRACE_S = Math.max(10, Number(process.argv[3] || "25"))

async function waitForCamoufox(): Promise<boolean> {
  const base = (process.env.CAMOUFOX_URL || "http://127.0.0.1:9797").replace(/\/$/, "")
  const deadline = Date.now() + BOOT_GRACE_S * 1000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        console.log("🦊 Camoufox service جاهزة")
        return true
      }
    } catch { /* لسه بتصحى */ }
    await new Promise((r) => setTimeout(r, 2500))
  }
  return false
}

async function main() {
  // 1) البيئة: على Actions بتيجي من Secrets مباشرة — ومفيش أي .env محلي هنا
  if (!process.env.DATABASE_URL) throw new Error("مفيش DATABASE_URL (لازم secret)")
  if (!process.env.FACEBOOK_SESSION_COOKIE) throw new Error("مفيش FACEBOOK_SESSION_COOKIE (لازم secret)")
  process.env.CAMOUFOX_URL = process.env.CAMOUFOX_URL || "http://127.0.0.1:9797"
  process.env.TZ = process.env.TZ || "Africa/Cairo"

  const online = await waitForCamoufox()
  if (!online) throw new Error(`Camoufox مش راد على ${process.env.CAMOUFOX_URL} — اتأكد إن الخدمة اتشغلت في الـworkflow`)

  // 2) حقن كوكيز فيسبوك في بروفايل المتصفح (نفس مسار أداة stealth_browse بالظبط)
  const { stealthInjectCookieHeader } = await import("../src/lib/agent/stealth-browser")
  const injected = await stealthInjectCookieHeader(process.env.FACEBOOK_SESSION_COOKIE)
  if (!injected) throw new Error("حقن كوكيز فيسبوك فشل — الجلسة مش هتشتغل")
  console.log("🍪 كوكيز فيسبوك اتحقنت في بروفايل Camoufox")

  // 3) الدورات — نفس radar-loop بس بعدد محدود مع تنفس بشري بين الدورات
  const { radarCycle } = await import("../src/lib/radar")
  let instant = 0, leads = 0, scheduled = 0, scanned = 0
  for (let c = 1; c <= CYCLES; c++) {
    const t0 = Date.now()
    try {
      const r = await radarCycle()
      scanned += r.scanned
      instant += r.instant
      leads += r.leads
      scheduled += r.scheduled
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`[دورة ${c}/${CYCLES} | ${secs}s] جروبات=${r.scanned} لحظية=${r.instant} ليدز=${r.leads} مجدول=${r.scheduled}`)
      for (const n of r.commentNotes.slice(0, 4)) console.log(`   ${n}`)
    } catch (err) {
      console.error(`[دورة ${c}] خطأ: ${err instanceof Error ? err.message.slice(0, 200) : err}`)
    }
    if (c < CYCLES) {
      const gapMs = 60_000 + Math.random() * 60_000 // نفس إيقاع radar-loop: 1-2 دقيقة
      console.log(`   😴 تنفس ${Math.round(gapMs / 1000)}s`)
      await new Promise((r) => setTimeout(r, gapMs))
    }
  }

  console.log(`== نبضة الرادار خلصت: جروبات=${scanned} لحظية=${instant} ليدز=${leads} مجدول=${scheduled} ==`)
  process.exit(0)
}

main().catch((err) => {
  console.error("❌ radar-pulse فشل:", err instanceof Error ? err.message : err)
  process.exit(1)
})
export {}
