// LeadOS — Queue Stress على Neon (Postgres حقيقي) — نسخة إنتاجية من test-queue-stress
// بتستخدم client مولّد من schema.production.prisma (postgres) — الكلينت المحلي sqlite مش هيقبل postgres URL
// آلية المطالبة نفسها منخوطة حرفيًا من claimJobs (src/lib/queue.ts): findMany مرشح → updateMany شرطي
// (UPDATE ... WHERE status IN (QUEUED,RETRYING)) — الذرّية هنا ضمانة Postgres read-committed نفسها.
// الاستخدام: DATABASE_URL=<neon> npx tsx scripts/test-queue-stress-prod.ts
import { randomUUID } from "node:crypto"
import { PrismaClient } from "../node_modules/prisma-prod-client"

const MARKER = `stress-${randomUUID().slice(0, 8)}`
const WORKER_ID_BASE = "stress-worker"
let pass = 0, fail = 0
function check(ok: boolean, label: string, note = "") {
  if (ok) { pass++; console.log(`✅ ${label}${note ? ` — ${note}` : ""}`) }
  else { fail++; console.log(`❌ ${label}${note ? ` — ${note}` : ""}`) }
}

/** نسخة حرفية من claimJobs — نفس الاستعلام والشرط والأمر الواحد */
async function claimJobs(db: PrismaClient, limit: number) {
  const jobs = await db.job.findMany({
    where: { status: { in: ["QUEUED", "RETRYING"] }, scheduledAt: { lte: new Date() } },
    orderBy: [{ priority: "desc" }, { scheduledAt: "asc" }],
    take: limit,
  })
  const claimed: string[] = []
  for (const job of jobs) {
    const updated = await db.job.updateMany({
      where: { id: job.id, status: { in: ["QUEUED", "RETRYING"] } },
      data: { status: "RUNNING", startedAt: new Date(), lockedAt: new Date(), attempts: { increment: 1 } },
    })
    if (updated.count > 0) claimed.push(job.id)
  }
  return db.job.findMany({ where: { id: { in: claimed } } })
}

async function main() {
  const db = new PrismaClient()
  const ws = await db.workspace.findFirst({ where: { isActive: true } })
  if (!ws) throw new Error("لا ورشة نشطة على Neon")
  console.log(`🔌 Neon متصلة — ورشة ${ws.id.slice(0, 8)}`)
  const mk = (kind: string, priority: number, scheduledAt = new Date()) => ({
    workspaceId: ws.id, type: "DISCOVERY", status: "QUEUED", priority, scheduledAt,
    payload: { marker: MARKER, kind } as never, errorMessage: MARKER,
  })

  // ─── 0) ترتيب الأولوية ───
  await db.job.createMany({ data: [mk("urgent", 101), mk("urgent", 101), mk("normal", 100), mk("normal", 100)] })
  const first = await claimJobs(db, 2)
  check(first.every(j => j.priority === 101), "ترتيب الأولوية: العاجلة تُطالَب أولًا", first.map(j => j.priority).join(","))

  // ─── 1) 60 عادية + 10 عاجلة + 10 مستقبلية → مزاد 8 مطالبين متزامنين ───
  const future = new Date(Date.now() + 3600_000)
  const rows: ReturnType<typeof mk>[] = []
  for (let i = 0; i < 60; i++) rows.push(mk("normal", 100))
  for (let i = 0; i < 10; i++) rows.push(mk("urgent", 101))
  for (let i = 0; i < 10; i++) rows.push(mk("future", 100, future))
  await db.job.createMany({ data: rows })
  const ready = await db.job.count({ where: { errorMessage: MARKER, scheduledAt: { lte: new Date() } } })
  console.log(`جهزت 80 جوب اختبارية على Neon (marker=${MARKER}) — ${ready} جاهزة للمطالبة`)

  const claimedBy: Record<string, string> = {}
  let doubleClaim = 0
  const nonMarkerTouched = new Set<string>()
  const claimer = async (wid: string) => {
    for (let round = 0; round < 6; round++) {
      const got = await claimJobs(db, 5)
      for (const j of got) {
        if (j.errorMessage !== MARKER) { nonMarkerTouched.add(j.id); continue }
        if (claimedBy[j.id] && claimedBy[j.id] !== wid) doubleClaim++
        claimedBy[j.id] = wid
      }
      await new Promise(r => setTimeout(r, 15))
    }
  }
  await Promise.all(Array.from({ length: 8 }, (_, k) => claimer(`${WORKER_ID_BASE}-${k}`)))
  const uniqueClaimed = Object.keys(claimedBy).length
  check(doubleClaim === 0, "لا مطالبة مزدوجة تحت 8 مطالبين متزامنين (Postgres)", `${doubleClaim} تعارض على ${uniqueClaimed} جوب`)
  check(uniqueClaimed <= ready, "لا مطالبة زائدة عن الجاهزة", `${uniqueClaimed}/${ready}`)
  const futureUntouched = await db.job.count({ where: { errorMessage: MARKER, status: "QUEUED", scheduledAt: { gt: new Date() } } })
  check(futureUntouched === 10, "الجوب المستقبلية (scheduledAt+) ما اتنفذت", `${futureUntouched}/10 لسه QUEUED`)

  // ─── 2) استرداد العالقة ───
  const statusDist = await db.job.groupBy({ by: ["status"], where: { errorMessage: MARKER }, _count: true })
  console.log(`   📊 توزيع الحالات قبل فحص العالقة: ${statusDist.map(s => `${s.status}=${s._count}`).join(" ")}`)
  await db.job.updateMany({
    where: { errorMessage: MARKER, status: "RUNNING" },
    data: { lockedAt: new Date(Date.now() - 30 * 60_000) },
  })
  const runningMarker = await db.job.count({ where: { errorMessage: MARKER, status: "RUNNING" } })
  const requeued = await db.job.updateMany({
    where: { errorMessage: MARKER, status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "QUEUED", lockedAt: null },
  })
  check(requeued.count === runningMarker && runningMarker > 0, "العالقة (lockedAt قديم) رجعت QUEUED", `${requeued.count}/${runningMarker} جوب`)
  const revived = await claimJobs(db, 3)
  check(revived.length === 3, "الجوب المستردة قابلة للمطالبة تاني", `${revived.length}/3`)

  // ─── تنظيف ───
  const del = await db.job.deleteMany({ where: { errorMessage: MARKER } })
  let restored = 0
  for (const id of nonMarkerTouched) {
    await db.job.updateMany({ where: { id, status: "RUNNING" }, data: { status: "QUEUED", lockedAt: null } })
    restored++
  }
  console.log(`🧹 تنظيف: ${del.count} جوب اختبارية اتمسحت${restored ? ` + استعادة ${restored} جوب حقيقية` : ""}`)
  await db.$disconnect()
  console.log(`\n═══ النتيجة: ${pass} PASS · ${fail} FAIL ═══`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error("فشل:", e instanceof Error ? e.message.slice(0, 200) : e); process.exit(1) })
