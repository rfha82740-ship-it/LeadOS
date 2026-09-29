// LeadOS — Production Smoke Tests (طلب #34): اختبار حقيقي على نشر Vercel
// الاستخدام: bunx tsx scripts/prod-smoke.ts <base-url> [email] [password]
// النتايج بتتسجل PASS/FAIL لكل فحص — بدون تزوير: فشل = فشل.
import { PrismaClient } from "@prisma/client"

const BASE = (process.argv[2] ?? "").replace(/\/$/, "")
const EMAIL = process.argv[3] ?? ""
const PASSWORD = process.argv[4] ?? ""

let pass = 0
let fail = 0
function check(name: string, ok: boolean, note = "") {
  if (ok) { pass++; console.log(`✅ ${name}${note ? ` — ${note}` : ""}`) }
  else { fail++; console.log(`❌ ${name}${note ? ` — ${note}` : ""}`) }
}

async function main() {
  if (!BASE) { console.error("الاستخدام: bunx tsx scripts/prod-smoke.ts <base-url> [email] [password]"); process.exit(2) }
  console.log(`\n🚀 Smoke tests على: ${BASE}\n`)

  // 1) الصفحة الرئيسية
  const home = await fetch(BASE)
  check("GET /", home.status === 200, `HTTP ${home.status}`)

  // 2) endpoint محمي بدون جلسة → لازم 401
  const protectedRoute = await fetch(`${BASE}/api/leads`)
  check("GET /api/leads بدون جلسة → 401 (الحماية شغالة)", protectedRoute.status === 401, `HTTP ${protectedRoute.status}`)

  // 3) cron بدون سر → مرفوض
  const cronNoSecret = await fetch(`${BASE}/api/cron/tick`, { method: "POST" })
  check("POST /api/cron/tick بدون سر → مرفوض", cronNoSecret.status === 401 || cronNoSecret.status === 403, `HTTP ${cronNoSecret.status}`)

  // 4) قاعدة البيانات عبر endpoint حي
  const form = await fetch(`${BASE}/lead-form`)
  check("GET /lead-form (صفحة عامة)", form.status === 200, `HTTP ${form.status}`)

  // 5) تسجيل دخول (لو اتسلمت بيانات) + endpoints محمية بجلسة
  let cookie = ""
  if (EMAIL && PASSWORD) {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    check("POST /api/auth/login", login.status === 200, `HTTP ${login.status}`)
    const setCookie = login.headers.get("set-cookie") ?? ""
    cookie = setCookie.split(";")[0]

    const authedHeaders = { cookie }
    for (const [name, url] of [
      ["GET /api/overview (authenticated)", `${BASE}/api/overview`],
      ["GET /api/leads", `${BASE}/api/leads?take=1`],
      ["GET /api/skills", `${BASE}/api/skills`],
      ["GET /api/health (health center)", `${BASE}/api/health`],
      ["GET /api/queue", `${BASE}/api/queue?take=5`],
      ["GET /api/graph", `${BASE}/api/graph`],
      ["GET /api/radar", `${BASE}/api/radar?take=5`],
      ["GET /api/skills/workspace", `${BASE}/api/skills/workspace`],
      ["GET /api/system/stop (system state)", `${BASE}/api/system/stop`],
      ["GET /api/logs?type=audit", `${BASE}/api/logs?type=audit`],
      ["GET /api/farm/plan بدون مفتاح → 401", `${BASE}/api/farm/plan?platform=FACEBOOK`],
    ] as const) {
      try {
        const r = await fetch(url, { headers: authedHeaders })
        const expect401 = name.includes("بدون مفتاح")
        check(name, expect401 ? r.status === 401 : r.status === 200, `HTTP ${r.status}`)
      } catch (e) {
        check(name, false, e instanceof Error ? e.message.slice(0, 60) : "خطأ")
      }
    }
  } else {
    console.log("ℹ️ مفيش بيانات دخول — فحوص الجلسة اتخطت (شغّل تاني بالبريد وكلمة المرور بعد إنشاء الـAdmin)")
  }

  console.log(`\n═══ النتيجة: ${pass} PASS · ${fail} FAIL ═══\n`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error("💥", e); process.exit(2) })
