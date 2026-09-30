#!/usr/bin/env node
// LeadOS — Capacity Gate (Final Hardening #2): بوابة السعة المركزية
// الاستخدام في الـworkflows:  node scripts/capacity-gate.mjs --chain farm
//   exit 0 = اسمح بالـdispatch   |   exit 2 = أجّل (مش خطأ — tick هيحييها)   |   exit 1 = خطأ
// الاستخدام للعرض:  node scripts/capacity-gate.mjs --json   → حالة السعة الكاملة
// الصفر اعتماديات (node:fetch) — تشتغل في Actions وفي أي مكان.
import { readFileSync } from "node:fs"

const REPO = process.env.GITHUB_REPOSITORY || "rfha82740-ship-it/LeadOS"
const API = `https://api.github.com/repos/${REPO}`
// توكن: GITHUB_TOKEN في Actions، أو متغير GH_TOKEN خارجيًا
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""

const budget = JSON.parse(readFileSync(new URL("../.github/concurrency-budget.json", import.meta.url), "utf8"))

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} على ${path}`)
  return res.json()
}

async function stopExists() {
  try {
    const res = await fetch(`${API}/contents/.github/STOP`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    })
    return res.status === 200
  } catch { return false }
}

// عدّ التشغيلات النشطة لكل workflow (in_progress/queued/waiting) عبر صفحات كافية
export async function capacityState() {
  // استثناء التشغيلة الحالية من عدّ سلسلتها: من غير كده السلسلة بتحسب نفسها "نشطة"
  // ومش بقدر تشعّل الجيل التالي بنفسها أبدًا (self-dispatch ميت). الاستثناء ده آمن لأن
  // حماية التكرار باقية بكل طبقاتها: التشغيلات الأخرى نفس الworkflow بتتحسب + concurrency
  // groups بترتيب جوب واحد pending + المشرف من جهة السيرفر بيفحص active>0 مستقل.
  const selfRunId = Number(process.env.GITHUB_RUN_ID || 0)
  const perChain = {}
  for (const [event, c] of Object.entries(budget.chains)) perChain[event] = { ...c, event, active: 0 }
  let page = 1, seen = 0
  for (; page <= 4; page++) {
    const runs = await gh(`/actions/runs?per_page=100&page=${page}`)
    const list = runs.workflow_runs ?? []
    seen += list.length
    for (const r of list) {
      if (!["in_progress", "queued", "waiting"].includes(r.status)) continue
      if (selfRunId && r.id === selfRunId) continue
      // المطابقة الأدق بمسار ملف الـworkflow (r.path = .github/workflows/x.yml)، والبديل اسم التشغيل
      const entry = Object.values(perChain).find(c => r.path === `.github/workflows/${c.workflow}` || r.name === c.name || (r.name || "").endsWith(c.name))
      if (entry) entry.active++
    }
    if (list.length < 100) break
  }
  // العد بمستوى الجوب (حد GitHub=20 جوب): تشغيلة الفارم الواحدة = 15 جوب matrix، والباقي جوب واحد للتشغيلة
  const activeJobs = Object.values(perChain).reduce((s, c) => s + c.active * c.need, 0)
  const available = Math.max(0, budget.githubJobLimit - activeJobs)
  return { limit: budget.githubJobLimit, safetyMargin: budget.safetyMargin, runningQueued: activeJobs, activeRuns: Object.values(perChain).reduce((s, c) => s + c.active, 0), available, seen, perChain }
}

// قرار: اسمح/أجّل لسلسلة معينة
export function decide(state, event) {
  const chain = state.perChain[event]
  if (!chain) return { allow: false, reason: `chain غير معروفة: ${event}` }
  if (chain.active > 0) return { allow: false, defer: true, reason: `${chain.name} عندها ${chain.active} تشغيلة نشطة بالفعل — منع dispatch مكرر` }
  // فتحة أمان شرطية: لو كل السلاسل التانية حية (الحمولة القاعدية = الاحتياطي الفعلي) الفارم تنطلق بسعتها بالظبط؛
  // لو في سلاسل ميتة (بعد انقطاع) الفارم محتاجة need+margin عشان سيب مكان لإحيائها
  const others = Object.values(state.perChain).filter(c => c.event !== event)
  const deadOthers = others.filter(c => c.active === 0).length
  const need = chain.need + (chain.deferred && deadOthers > 0 ? state.safetyMargin : 0)
  if (state.available >= need) {
    return { allow: true, reason: `سعة كافية: ${state.available} فتحة ≥ ${need}${deadOthers > 0 ? ` (بينهم margin ${state.safetyMargin} — ${deadOthers} سلاسل ميتة)` : ""}` }
  }
  if (chain.critical) return { allow: true, reason: `سلسلة حرِجة — تُسمح حتى مع ضغط السعة (GitHub هيعمل queue لو لزم)` }
  return { allow: false, defer: true, reason: `سعة غير كافية: ${state.available} فتحة < ${need} مطلوبة — التأجيل وtick هيحييها` }
}

// ─── CLI ───
const isMain = process.argv[1] && process.argv[1].endsWith("capacity-gate.mjs")
if (isMain) {
  const args = process.argv.slice(2)
  try {
    const state = await capacityState()
    if (args.includes("--json")) {
      const withDecisions = Object.fromEntries(Object.keys(state.perChain).map(e => [e, decide(state, e)]))
      console.log(JSON.stringify({ ...state, decisions: withDecisions, stop: await stopExists() }, null, 2))
      process.exit(0)
    }
    const i = args.indexOf("--chain")
    const event = i >= 0 ? `beat_${args[i + 1]}` : null
    if (!event || !state.perChain[event]) { console.error("الاستخدام: node scripts/capacity-gate.mjs --chain farm|worker|tick|adslib|fbgroups|radar | --json"); process.exit(1) }
    if (await stopExists()) { console.log(`🛑 .github/STOP موجودة — ممنوع أي dispatch (${event})`); process.exit(2) }
    const d = decide(state, event)
    console.log(`${d.allow ? "✅" : "⏳"} [capacity-gate] ${event}: ${d.reason} | الجوب النشطة=${state.runningQueued}/${state.limit}`)
    process.exit(d.allow ? 0 : 2)
  } catch (err) {
    console.error(`❌ [capacity-gate] فشل: ${err instanceof Error ? err.message.slice(0, 160) : err}`)
    // سياسة fail-open محسوبة: فشل البوابة نفسها لا يقتل السلاسل الدائمة — tick هيعيد الفحص
    process.exit(0)
  }
}
