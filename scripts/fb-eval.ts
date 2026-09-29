// تقييم أداء جروبات فيسبوك — «مين بينزل عليه ومين عقيم» — يعمل على GitHub Actions
// env-first: DATABASE_URL من GitHub Secret (أو .tokens محليًا كاحتياط)
// 1) activityScore = بوستات آخر 7 أيام × 20 (سقف 100) — بيتحدث لكل جروب
// 2) إيقاف تلقائي PAUSED: جروب عمره >3 أيام، اتمسح فعلًا، ومعملش ولا بوست في حياته
// 3) لوحة صدارة المنتِجين في لوج الووركفلو — مرئية من صفحة التشغيلة
async function main() {
  const fs = require("fs")
  if (!process.env.DATABASE_URL) {
    const line = fs
      .readFileSync(`${process.cwd()}/scripts/deploy/.tokens`, "utf8")
      .split("\n")
      .find((l: string) => l.startsWith("DATABASE_URL="))
    if (!line) throw new Error("مفيش DATABASE_URL في env ولا .tokens")
    process.env.DATABASE_URL = line.split("=").slice(1).join("=").replace(/^"|"$/g, "")
  }
  const { db } = await import("../src/lib/db")
  const dbx = db as any
  const ws = await dbx.workspace.findFirst({ select: { id: true } })
  if (!ws) throw new Error("مفيش ورشة")

  const rows: Array<{
    id: string; name: string; status: string; postCount: number
    created: Date; lastscan: Date | null; posts7: number; qual7: number
  }> = await dbx.$queryRawUnsafe(`
    SELECT g.id, g.name, g.status, g."postCount",
           g."createdAt" AS created, g."lastScannedAt" AS lastscan,
           COUNT(p.id) FILTER (WHERE p."createdAt" > NOW() - INTERVAL '7 days') AS posts7,
           COUNT(p.id) FILTER (WHERE p."createdAt" > NOW() - INTERVAL '7 days' AND p.status = 'QUALIFIED') AS qual7
    FROM "MonitoredGroup" g
    LEFT JOIN "GroupPost" p ON p."groupId" = g.id
    WHERE g."workspaceId" = $1
    GROUP BY g.id`, ws.id)

  const active = rows.filter((r) => r.status === "ACTIVE")
  console.log(`📊 تقييم ${rows.length} جروب (${active.length} ACTIVE)`)

  let paused = 0
  for (const r of rows) {
    const act = Math.min(100, Number(r.posts7) * 20)
    await dbx.$executeRawUnsafe(
      `UPDATE "MonitoredGroup" SET "activityScore" = $1 WHERE id = $2`, act, r.id,
    )
    const olderThan3d = Date.now() - new Date(r.created).getTime() > 3 * 86400_000
    const wasScanned = r.lastscan && Date.now() - new Date(r.lastscan).getTime() > 30 * 60_000
    if (r.status === "ACTIVE" && Number(r.posts7) === 0 && Number(r.postCount) === 0 && olderThan3d && wasScanned) {
      await dbx.$executeRawUnsafe(
        `UPDATE "MonitoredGroup" SET status = 'PAUSED', "statusNote" = $1 WHERE id = $2`,
        "إيقاف تلقائي: عمره أكثر من 3 أيام واتمسح ومعملش أي بوست — بيرجع من اللوحة لو اتنشط",
        r.id,
      )
      paused++
      console.log(`  ⏸ عقيم كليًا: ${String(r.name).slice(0, 50)}`)
    }
  }

  const top = [...rows]
    .sort((a, b) => (Number(b.qual7) * 100 + Number(b.posts7)) - (Number(a.qual7) * 100 + Number(a.posts7)))
    .slice(0, 5)
  console.log("🏆 المنتِجون (آخر 7 أيام):")
  for (const t of top) {
    console.log(`   ${Number(t.qual7) > 0 ? "💎" : "▪️"} ${String(t.name).slice(0, 48)} | بوستات: ${t.posts7} | مؤهل: ${t.qual7}`)
  }
  const producing = rows.filter((r) => Number(r.posts7) > 0).length
  console.log(`== الملخص: ${producing}/${rows.length} جروب بينتج | إيقاف تلقائي: ${paused} ==`)
}

main().catch((e) => {
  console.error("❌", (e && e.message) || e)
  process.exit(1)
})
