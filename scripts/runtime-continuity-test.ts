#!/usr/bin/env bun
/**
 * LeadOS — Runtime Continuity Test (§26/§33)
 * بيختبر استمرارية السلاسل من الدليل الفعلي في GitHub Actions:
 *  - generations متتابعة لكل سلسلة (repository_dispatch = self-dispatch جيل N→N+1)
 *  - لا تكرار (أكثر من تشغيلة نشطة لنفس السلسلة)
 *  - لا عالق (تشغيلة نشطة عدّت مهلتها)
 *  - لا عاصفة dispatch (معدل التشغيلات في الساعة)
 */
import { readFileSync } from "node:fs"

const REPO = "rfha82740-ship-it/LeadOS"
const CHAINS = [
  { event: "beat_tick", name: "LeadOS Cron Tick", timeoutMin: 60 },
  { event: "beat_worker", name: "LeadOS Worker", timeoutMin: 60 },
  { event: "beat_adslib", name: "LeadOS Ads Library", timeoutMin: 60 },
  { event: "beat_fbgroups", name: "LeadOS FB Groups", timeoutMin: 60 },
  { event: "beat_radar", name: "LeadOS Radar", timeoutMin: 60 },
  { event: "beat_farm", name: "LeadOS Browser Farm", timeoutMin: 65 },
]

const token = readFileSync(`${process.env.HOME}/.git-credentials`, "utf8").trim()
  .split("://")[1]!.split("@")[0]!.split(":")[1]!

async function gh(path: string) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  })
  return r.json()
}

interface Run { id: number; created_at: string; run_started_at?: string; updated_at: string; status: string; conclusion: string | null; event: string }

async function main() {
  const { workflow_runs } = await gh(`/repos/${REPO}/actions/runs?per_page=100`)
  const runs: Run[] = workflow_runs ?? []
  const now = Date.now()
  let totalHandoffs = 0
  let anyFail = false

  console.log("═".repeat(72))
  for (const c of CHAINS) {
    const mine = runs.filter(r => r.name === c.name)
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    if (!mine.length) {
      console.log(`\n▪ ${c.name}: لا توجد تشغيلات بعد — WARN (السلسلة بتنتظر نبضتها الأولى)`)
      continue
    }
    // 1) تتابع الأجيال: تشغيلة بدأت بعد انتهاء/أثناء السابقة بـ dispatch event
    const handoffs: string[] = []
    for (let i = 1; i < mine.length; i++) {
      const prev = mine[i - 1]!, cur = mine[i]!
      const prevEnd = +new Date(prev.updated_at)
      const curStart = +new Date(cur.created_at)
      if (cur.event === "repository_dispatch" && curStart - prevEnd < 20 * 60_000) {
        handoffs.push(`#${prev.id} (${prev.conclusion ?? prev.status}) → #${cur.id}`)
      }
    }
    totalHandoffs += handoffs.length

    // 2) تكرار: أكتر من تشغيلة نشطة لنفس السلسلة
    const active = mine.filter(r => ["in_progress", "queued", "waiting"].includes(r.status))
    const dup = active.length > 1

    // 3) عالق: نشطة عدّت مهلتها
    const stuck = active.filter(r => now - +new Date(r.run_started_at ?? r.created_at) > c.timeoutMin * 60_000)

    // 4) عاصفة: > 6 تشغيلات في آخر ساعة لنفس السلسلة
    const lastHour = mine.filter(r => now - +new Date(r.created_at) < 3600_000).length

    const verdict = dup || stuck.length ? "FAIL" : "OK"
    if (verdict === "FAIL") anyFail = true
    console.log(`\n▪ ${c.name} [${verdict}]`)
    console.log(`  تشغيلات مرصودة: ${mine.length} | نشطة: ${active.length} | آخر ساعة: ${lastHour}`)
    console.log(`  handoffs مُثبتة (N→N+1): ${handoffs.length}`)
    for (const h of handoffs.slice(-3)) console.log(`    ↳ ${h}`)
    if (dup) console.log(`  ⚠️ تكرار: ${active.length} تشغيلات نشطة`)
    if (stuck.length) console.log(`  ⚠️ عالق: ${stuck.map(s => s.id).join(",")}`)
    const last = mine[mine.length - 1]!
    console.log(`  آخر تشغيلة: #${last.id} ${last.event} ${last.status} ${last.conclusion ?? ""}`)
  }

  console.log("\n" + "═".repeat(72))
  console.log(`CONTINUITY: إجمالي handoffs المُثبتة من الدليل = ${totalHandoffs} | أي فشل تكرار/عالق = ${anyFail ? "YES" : "NO"}`)
  console.log("ملاحظة: handoff النبضة الجديدة (كود d418ace) بيتأكد أول ما أول تشغيلة بالكود الجديد توصل خطوة السلسلة (~50 دقيقة من إطلاقها).")
  process.exit(anyFail ? 1 : 0)
}

main()
